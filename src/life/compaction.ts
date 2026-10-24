// Epochs and the life planner (Living cast spec §5.2, §5.4, §5.6).
//
// An epoch is one stretch of her life with a fixed system prompt (A + B) and an append-only log. A
// new epoch starts after a compaction: her model writes a summary for her future self (same request
// as a normal call, same tools and reasoning settings, plus one appended instruction; winter has no
// `toolChoice: none`, so the instruction asks for text only and tool calls are discarded), the last
// 3 complete turns are carried over with their opaque reasoning stripped, and A/B are rebuilt from
// the current configuration, notes and places.
//
// Triggers (checked between turns by the loop): estimated tokens ≥ triggerRatio × budget, log length
// ≥ `life.maxLogMessages`, a provider overflow (mid-turn too), a manual compact, a configuration
// change (A, tools or model), a forget scrub. `compaction.enabled = false` truncates at the same
// triggers without a summary.

import { randomBytes } from "node:crypto";
import { stripOpaque, type ContentBlockLike, type ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { CuratedModel } from "../models/catalog.js";
import { summarizeWithModel } from "../models/summarize.js";
import { COMPACTION_FAILURE_BACKOFF_MS } from "../orchestration/context/compaction.js";
import { listWaifus } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeLogLine, LifeModelRoute, LifeState } from "../shared/schemas/life.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { buildBlockA, harnessHash } from "./lifeHarness.js";
import { pruneOldEpochLogs, rewriteLifeLog, updateLifeState } from "./lifeStore.js";
import { Notes } from "./notes.js";
import { placesWithHandles, renderPlacesBlock } from "./places.js";
import { buildLifeRequest } from "./request.js";
import { offeredToolNames } from "./tools/index.js";

export const KEPT_TURNS = 3;

export type HarnessNow = { harness: string; tools: string[]; route: LifeModelRoute; hash: string };

export function routeOf(model: CuratedModel, effort?: string): LifeModelRoute {
  return { providerId: model.providerId, modelId: model.modelId, ...(effort ? { effort } : {}) };
}

/** Block A, the tools and the route as the configuration says right now. */
export async function currentHarness(deps: LifeDeps, waifu: WaifuConfig, model: CuratedModel): Promise<HarnessNow> {
  const places = await placesWithHandles(deps.storage, waifu.id);
  const nicknames = new Set<string>();
  if (waifu.botId) {
    for (const guildId of new Set(places.flatMap((place) => (place.guildId ? [place.guildId] : [])))) {
      const nick = deps.directory.memberName(guildId, waifu.botId);
      if (nick) nicknames.add(nick);
    }
  }
  const others = (await listWaifus(deps.storage).catch(() => []))
    .filter((other) => other.enabled && other.id !== waifu.id)
    .map((other) => ({ name: other.name, displayName: other.displayName }));
  const harness = buildBlockA(waifu, { serverNicknames: [...nicknames].sort(), others }, deps.timeZone);
  const tools = offeredToolNames(deps);
  const route = routeOf(model, waifu.model?.effort);
  return { harness, tools, route, hash: harnessHash(harness, tools, route) };
}

function newTurnId(): string {
  return `t${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

export { newTurnId };

/** Turn ids of the log in order of first appearance (lines without one are grouped as ""). */
function turnOrder(lines: readonly LifeLogLine[]): string[] {
  const order: string[] = [];
  for (const line of lines) {
    const id = line.turnId ?? "";
    if (line.kind === "compaction_boundary") continue;
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

const OMITTED = "[result omitted: deleted message]";

function contentHasImages(content: ContentBlockLike[]): boolean {
  return content.some((block) => (block as { type: string }).type === "life_image");
}

/** Kept turns' images render as text in the new epoch (its inline budget starts at zero). */
function imagesAsText(content: unknown[]): unknown[] {
  return content.map((block) => {
    const typed = block as { type?: string; mode?: unknown; content?: unknown };
    if (typed.type === "life_image") return { ...typed, mode: typed.mode === "inline" ? { text: "[image]" } : typed.mode };
    if (typed.type === "tool_result" && Array.isArray(typed.content)) return { ...typed, content: imagesAsText(typed.content) };
    return block;
  });
}

/**
 * The last `keep` complete turns, ready for a new epoch: assistant messages stripped of opaque
 * reasoning (winter `stripOpaque`), results that showed a deleted message replaced, images as text.
 */
export function keptTurnLines(
  lines: readonly LifeLogLine[],
  o: { keep: number; openTurnId?: string; deletedIds: ReadonlySet<string> }
): { kept: LifeLogLine[]; strippedBlocks: number; readIds: string[] } {
  if (o.keep <= 0) return { kept: [], strippedBlocks: 0, readIds: [] };
  const complete = turnOrder(lines).filter((id) => id !== "" && id !== o.openTurnId);
  const keepIds = new Set(complete.slice(-o.keep));
  let strippedBlocks = 0;
  const readIds = new Set<string>();
  const kept: LifeLogLine[] = [];
  for (const line of lines) {
    if (!line.turnId || !keepIds.has(line.turnId) || !line.message) continue;
    const message = line.message as unknown as ProviderMessageLike;
    if (line.kind === "assistant") {
      const stripped = stripOpaque(message);
      strippedBlocks += stripped.strippedBlocks + (stripped.nativeState ? Math.max(1, stripped.nativeState.items.length) : 0);
      const content = typeof stripped.content === "string" || stripped.content.length > 0 ? stripped.content : [{ type: "text" as const, text: "…" }];
      const { nativeState: _drop, ...rest } = message;
      kept.push({ ...line, message: { ...rest, content } as unknown as Record<string, unknown> });
      continue;
    }
    if (line.kind === "tool_results" && Array.isArray(message.content)) {
      const content = message.content.map((block) => {
        if (block.type !== "tool_result") return block;
        const ids = line.messageIds?.[block.tool_use_id] ?? [];
        if (ids.some((id) => o.deletedIds.has(id))) return { ...block, content: OMITTED };
        for (const id of ids) readIds.add(id);
        return block;
      });
      const next = contentHasImages(content as ContentBlockLike[]) || content.some((block) => block.type === "tool_result" && Array.isArray(block.content)) ? imagesAsText(content) : content;
      kept.push({ ...line, message: { ...message, content: next } as unknown as Record<string, unknown> });
      continue;
    }
    kept.push(line);
  }
  return { kept, strippedBlocks, readIds: [...readIds] };
}

/**
 * Starts a new epoch: A from the current configuration, B with the summary, MEMORY.md re-read and
 * places re-listed; the log starts with a boundary line and the kept turns.
 */
export async function startEpoch(
  deps: LifeDeps,
  waifuId: string,
  o: {
    harness: HarnessNow;
    summary: string | null;
    kept: LifeLogLine[];
    readIds: string[];
    reason: string;
    summarized: boolean;
    strippedBlocks: number;
    first?: boolean;
    pruneAll?: boolean;
  }
): Promise<LifeState> {
  const now = deps.now();
  const memoryIndex = await new Notes(deps.storage, waifuId).memoryIndexForPrompt();
  const places = renderPlacesBlock(await placesWithHandles(deps.storage, waifuId));
  let saved: LifeState | undefined;
  await updateLifeState(
    deps.storage,
    waifuId,
    async (current) => {
      const fromEpoch = current.epoch;
      const epoch = o.first && current.systemSnapshot === null ? current.epoch : current.epoch + 1;
      const boundary: LifeLogLine = {
        seq: 0,
        at: now.toISOString(),
        kind: "compaction_boundary",
        message: null,
        boundary: { fromEpoch, reason: o.reason, keptTurns: new Set(o.kept.map((line) => line.turnId)).size }
      };
      const lines = o.first && current.systemSnapshot === null ? [] : [boundary, ...o.kept];
      const sequenced = lines.map((line, seq) => ({ ...line, seq }));
      if (sequenced.length > 0 || !(o.first && current.systemSnapshot === null)) await rewriteLifeLog(deps.storage, waifuId, epoch, sequenced);
      return {
        ...current,
        epoch,
        epochStartedAt: now.toISOString(),
        status: current.status,
        summary: o.summary,
        systemSnapshot: { harnessHash: o.harness.hash, harness: o.harness.harness, memoryIndex, places, tools: o.harness.tools },
        modelRoute: o.harness.route,
        inlineImageCount: 0,
        inlineImageBytes: 0,
        shownImageKeys: [],
        readMessageIds: o.readIds,
        deletedReadIds: [],
        pendingEpochStart: false,
        epochStrippedThinkingBlocks: o.strippedBlocks,
        lastRequestTokens: undefined,
        ...(o.first && current.systemSnapshot === null
          ? {}
          : { lastCompaction: { at: now.toISOString(), reason: o.reason, summarized: o.summarized, fromEpoch } })
      };
    },
    now
  ).then((state) => (saved = state));
  await pruneOldEpochLogs(deps.storage, waifuId, saved!.epoch, { now, ...(o.pruneAll ? { all: true } : {}) }).catch(() => undefined);
  return saved!;
}

export const COMPACTION_INSTRUCTION =
  "[system] Time to summarise. Write notes for your future self about your life since the last summary: what happened in each place, who you talked to and how it went, plans and promises, open threads, things you meant to do. Carry over anything from your previous summary that still matters. Anything that should last longer belongs in your notes; this summary is replaced next time. Reply with text only; do not call any tool.";

export type CompactionOmissions = { deleted: string[]; people: string[] };

export function compactionInstruction(omit: CompactionOmissions): string {
  const lines = [COMPACTION_INSTRUCTION];
  if (omit.deleted.length > 0) lines.push(`Leave out these deleted messages entirely: ${omit.deleted.join("; ")}.`);
  if (omit.people.length > 0) lines.push(`Leave out everything about these people, who asked to be forgotten: ${omit.people.join(", ")}. Do not mention them at all.`);
  return lines.join("\n");
}

export type CompactionOutcome = { state: LifeState; summarized: boolean };

/**
 * Compacts her life: summary (unless disabled or truncating), then a new epoch unless `deferEpoch`
 * (the forget scrub starts it later, §7.5 step 2). `summaryRoute` is the route the old epoch ran on
 * (a model change compacts with the old model, §5.2).
 */
export async function compactLife(
  deps: LifeDeps,
  o: {
    waifu: WaifuConfig;
    state: LifeState;
    lines: readonly LifeLogLine[];
    summaryRoute: CuratedModel | undefined;
    effort?: string;
    nextHarness: HarnessNow;
    reason: string;
    keepTurns?: number;
    openTurnId?: string;
    truncate?: boolean;
    omit: CompactionOmissions;
    deferEpoch?: boolean;
    emptySummaryOnFailure?: boolean;
    signal?: AbortSignal;
  }
): Promise<CompactionOutcome> {
  const now = deps.now();
  const settings = deps.config().compaction;
  let summary: string | null = o.state.summary;
  let summarized = false;
  const canSummarize = settings.enabled && !o.truncate && o.summaryRoute !== undefined && o.state.systemSnapshot !== null;
  if (canSummarize) {
    try {
      const request = await buildLifeRequest(deps, { state: o.state, lines: o.lines, route: o.summaryRoute!, missing: "text", ...(o.signal ? { signal: o.signal } : {}) });
      const status = o.waifu.availability;
      const instruction = `${compactionInstruction(o.omit)}\n\n${timeLine({ now, timeZone: deps.timeZone, availability: status })}`;
      const result = await summarizeWithModel(deps.models, {
        route: { providerId: o.summaryRoute!.providerId, modelId: o.summaryRoute!.modelId },
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        ...(o.effort ? { effort: o.effort } : {}),
        cacheKey: `life:${o.waifu.id}`,
        ...(o.signal ? { signal: o.signal } : {}),
        attribution: { waifuId: o.waifu.id },
        instruction,
        model: o.summaryRoute!
      });
      if (result.text.trim()) {
        summary = result.text.trim();
        summarized = true;
      }
    } catch (error) {
      deps.logger.warn("Life compaction summary failed", { waifuId: o.waifu.id, reason: o.reason, message: error instanceof Error ? error.message : String(error) });
    }
    if (!summarized) {
      await updateLifeState(deps.storage, o.waifu.id, (current) => ({ ...current, compactionPausedUntil: new Date(now.getTime() + COMPACTION_FAILURE_BACKOFF_MS).toISOString() }), now);
    }
  }
  if (!summarized && o.emptySummaryOnFailure) summary = null;
  const { kept, strippedBlocks, readIds } = keptTurnLines(o.lines, {
    keep: o.keepTurns ?? KEPT_TURNS,
    ...(o.openTurnId ? { openTurnId: o.openTurnId } : {}),
    deletedIds: new Set(o.state.deletedReadIds)
  });
  if (o.deferEpoch) {
    const state = await updateLifeState(deps.storage, o.waifu.id, (current) => ({ ...current, summary, pendingEpochStart: true }), now);
    return { state, summarized };
  }
  const state = await startEpoch(deps, o.waifu.id, {
    harness: o.nextHarness,
    summary,
    kept,
    readIds,
    reason: o.reason,
    summarized,
    strippedBlocks
  });
  deps.logger.info("Life compacted", { category: "life", waifuId: o.waifu.id, reason: o.reason, summarized, epoch: state.epoch, keptLines: kept.length });
  return { state, summarized };
}
