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
import { imageTextFor } from "../orchestration/context/images.js";
import { estimateTokens } from "../orchestration/context/tokens.js";
import { COMPACTION_FAILURE_BACKOFF_MS } from "../orchestration/context/compaction.js";
import { listWaifus, readWaifu } from "../orchestration/stores/config.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeLogLine, LifeModelRoute, LifeState } from "../shared/schemas/life.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { buildBlockA, harnessHash } from "./lifeHarness.js";
import { pruneOldEpochLogs, readLifeState, rewriteLifeLog, updateLifeState } from "./lifeStore.js";
import { homeStoreFor } from "./home/index.js";
import { memoryIndexForPrompt } from "./home/memoryIndex.js";
import { selfAuthorIds } from "./people.js";
import { placesWithHandles, renderPlacesBlock } from "./places.js";
import { buildLifeRequest, lifeBudget } from "./request.js";
import { lifeTool, modelTools, offeredToolNames } from "./tools/index.js";

export const KEPT_TURNS = 3;

export type HarnessNow = {
  harness: string;
  tools: string[];
  toolDescriptions: Record<string, string>;
  toolSchemas: Record<string, Record<string, unknown>>;
  route: LifeModelRoute;
  hash: string;
};

export function routeOf(model: CuratedModel, effort?: string): LifeModelRoute {
  return { providerId: model.providerId, modelId: model.modelId, ...(effort ? { effort } : {}) };
}

/** Block A, the tools and the route as the configuration says right now. */
export async function currentHarness(deps: LifeDeps, waifu: WaifuConfig, model: CuratedModel): Promise<HarnessNow> {
  const places = await placesWithHandles(deps.storage, waifu.id);
  const guildIds = [...new Set(places.flatMap((place) => (place.guildId ? [place.guildId] : [])))].sort();
  const nicknames = await serverNicknames(deps, waifu, guildIds);
  const others = (await listWaifus(deps.storage).catch(() => []))
    .filter((other) => other.enabled && other.id !== waifu.id)
    .map((other) => ({ name: other.name, displayName: other.displayName }));
  const harness = buildBlockA(waifu, { serverNicknames: nicknames, others }, deps.timeZone, { tmpRetentionDays: deps.config().life.tmp.retentionDays });
  const tools = offeredToolNames(deps);
  const route = routeOf(model, waifu.model?.effort);
  // The descriptions as configured now (Bash says whether python3 is there): kept in the epoch's
  // snapshot, so a setting change takes effect at a turn boundary through a compaction (§5.2).
  const defined = modelTools(tools, deps.config());
  const toolDescriptions = Object.fromEntries(defined.map((tool) => [tool.name, tool.description]));
  const toolSchemas = Object.fromEntries(defined.map((tool) => [tool.name, tool.inputSchema as Record<string, unknown>]));
  return {
    harness,
    tools,
    toolDescriptions,
    toolSchemas,
    route,
    hash: harnessHash(harness, tools.map((name) => `${name}:${toolDescriptions[name] ?? ""}:${JSON.stringify(toolSchemas[name] ?? {})}`), route)
  };
}

/**
 * Her bot's server nicknames from stable inputs (review M11): the guild directory's name for her
 * bot's member when it knows it, else the one recorded last time. A guild the directory has not
 * loaded yet (right after boot or a reconnect) never changes block A, so it never forces a
 * configuration compaction; a guild she has left drops out.
 */
async function serverNicknames(deps: LifeDeps, waifu: WaifuConfig, guildIds: readonly string[]): Promise<string[]> {
  if (!waifu.botId) return [];
  const ids = await selfAuthorIds(deps.storage, waifu);
  const known = (await readLifeState(deps.storage, waifu.id)).serverNicknames ?? {};
  const next: Record<string, string> = {};
  for (const guildId of guildIds) {
    const live = ids.map((id) => deps.directory.memberName(guildId, id)).find((name): name is string => Boolean(name));
    const nick = live ?? known[guildId];
    if (nick) next[guildId] = nick;
  }
  if (JSON.stringify(next) !== JSON.stringify(known)) {
    await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, ...(Object.keys(next).length > 0 ? { serverNicknames: next } : { serverNicknames: undefined }) }));
  }
  return [...new Set(Object.values(next))].sort();
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

/**
 * Kept turns' images render as text in the new epoch (its inline budget starts at zero): the image's
 * OCR text frozen in (`textFor`, from the OCR cache), else the plain placeholder.
 */
function imagesAsText(content: unknown[], textFor: (key: string) => string): unknown[] {
  return content.map((block) => {
    const typed = block as { type?: string; mode?: unknown; content?: unknown; attachment?: { key?: string } };
    if (typed.type === "life_image") return { ...typed, mode: typed.mode === "inline" ? { text: textFor(typed.attachment?.key ?? "") } : typed.mode };
    if (typed.type === "tool_result" && Array.isArray(typed.content)) return { ...typed, content: imagesAsText(typed.content, textFor) };
    return block;
  });
}

/** Inline images in some log lines (to look their OCR text up before they are frozen as text). */
export function inlineImagesOf(lines: readonly LifeLogLine[]): Array<{ key: string; attachment: Record<string, unknown> }> {
  const out: Array<{ key: string; attachment: Record<string, unknown> }> = [];
  const visit = (block: unknown) => {
    const typed = block as { type?: string; mode?: unknown; content?: unknown; attachment?: Record<string, unknown> & { key?: string } };
    if (typed?.type === "life_image" && typed.mode === "inline" && typeof typed.attachment?.key === "string") out.push({ key: typed.attachment.key, attachment: typed.attachment });
    if (typed?.type === "tool_result" && Array.isArray(typed.content)) typed.content.forEach(visit);
  };
  for (const line of lines) {
    const content = (line.message as { content?: unknown } | null)?.content;
    if (Array.isArray(content)) content.forEach(visit);
  }
  return out;
}

/**
 * The last `keep` complete turns, ready for a new epoch: assistant messages stripped of opaque
 * reasoning (winter `stripOpaque`), results that showed a deleted message replaced, images as text
 * (their OCR text when `imageText` knows it).
 */
export function keptTurnLines(
  lines: readonly LifeLogLine[],
  o: { keep: number; openTurnId?: string; deletedIds: ReadonlySet<string>; imageText?: ReadonlyMap<string, string> }
): { kept: LifeLogLine[]; strippedBlocks: number; readIds: string[] } {
  const textFor = (key: string) => o.imageText?.get(key) ?? imageTextFor(undefined);
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
      const next = contentHasImages(content as ContentBlockLike[]) || content.some((block) => block.type === "tool_result" && Array.isArray(block.content)) ? imagesAsText(content, textFor) : content;
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
  const waifu = await readWaifu(deps.storage, waifuId).catch(() => ({ id: waifuId, name: waifuId }));
  const memoryIndex = await memoryIndexForPrompt(homeStoreFor(deps, waifu));
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
        systemSnapshot: { harnessHash: o.harness.hash, harness: o.harness.harness, memoryIndex, places, tools: o.harness.tools, toolDescriptions: o.harness.toolDescriptions, toolSchemas: o.harness.toolSchemas },
        modelRoute: o.harness.route,
        inlineImageCount: 0,
        inlineImageBytes: 0,
        shownImageKeys: [],
        readMessageIds: o.readIds,
        deletedReadIds: [],
        pendingEpochStart: false,
        pendingEpochReason: undefined,
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

/**
 * The epoch a forget (§7.5 step 2) or a deferred owner reset (§14.4) left to start. A forget's drops
 * every old log (its turns are in the scrubbed summary); a reset's keeps them the usual 7 days. A
 * tool-surface change (`tools`, §16.13) normally goes through `compactRetiredTools`; here it is a reset.
 */
export function startPendingEpoch(deps: LifeDeps, waifuId: string, state: LifeState, harness: HarnessNow): Promise<LifeState> {
  const reset = state.pendingEpochReason === "reset" || state.pendingEpochReason === "tools";
  return startEpoch(deps, waifuId, { harness, summary: state.summary, kept: [], readIds: [], reason: reset ? "reset" : "forget", summarized: !reset, strippedBlocks: 0, ...(reset ? {} : { pruneAll: true }) });
}

const FLAT_RESULT_CHARS = 2_000;
const FLAT_ARGS_CHARS = 200;

function flatArgs(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const parts = Object.values(input as Record<string, unknown>).map((value) => (typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)));
  const text = parts.join(" ").replace(/\s+/gu, " ").trim();
  return text.length > FLAT_ARGS_CHARS ? `${text.slice(0, FLAT_ARGS_CHARS)}…` : text;
}

function flatResult(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block: Record<string, unknown>) => (block?.["type"] === "text" ? String(block["text"] ?? "") : block?.["type"] === "life_image" && typeof (block["mode"] as { text?: unknown })?.text === "string" ? String((block["mode"] as { text: string }).text) : "[image]"))
            .join("\n")
        : "";
  return text.length > FLAT_RESULT_CHARS ? `${text.slice(0, FLAT_RESULT_CHARS)}…` : text;
}

/**
 * Her log with every call of a tool the app no longer has (the L2 surface, §16.13) turned into plain
 * text, its result too (`[used read_note people/kevin.md]`, `[read_note result: …]`): a provider
 * refuses a history that calls tools the request does not define.
 */
export function flattenRetiredCalls(lines: readonly LifeLogLine[], isKnown: (name: string) => boolean = (name) => lifeTool(name) !== undefined): LifeLogLine[] {
  const retired = new Map<string, string>();
  return lines.map((line) => {
    const message = line.message as unknown as ProviderMessageLike | null;
    if (!message || !Array.isArray(message.content)) return line;
    let changed = false;
    const content = (message.content as unknown as Array<Record<string, unknown>>).map((block) => {
      if (block["type"] === "tool_use" && typeof block["name"] === "string" && !isKnown(block["name"])) {
        changed = true;
        retired.set(String(block["id"]), block["name"]);
        const args = flatArgs(block["input"]);
        return { type: "text", text: `[used ${block["name"]}${args ? ` ${args}` : ""}]` };
      }
      if (block["type"] === "tool_result" && retired.has(String(block["tool_use_id"]))) {
        changed = true;
        return { type: "text", text: `[${retired.get(String(block["tool_use_id"]))} result: ${flatResult(block["content"])}]` };
      }
      return block;
    });
    return changed ? { ...line, message: { ...(message as unknown as Record<string, unknown>), content } as unknown as Record<string, unknown> } : line;
  });
}

/**
 * The pending epoch of a tool-surface change (§16.13): her epoch is summarised like any compaction,
 * with the retired calls as text and no turns kept (they would call tools that are gone). Only a
 * failed summary falls back to the reset (her old summary carries over); an aborted one changes
 * nothing and runs again.
 */
export async function compactRetiredTools(
  deps: LifeDeps,
  o: { waifu: WaifuConfig; state: LifeState; lines: readonly LifeLogLine[]; summaryRoute: CuratedModel | undefined; effort?: string; nextHarness: HarnessNow; omit: CompactionOmissions; signal?: AbortSignal }
): Promise<CompactionOutcome> {
  const lines = flattenRetiredCalls(o.lines);
  return compactLife(deps, { ...o, lines, reason: "tools", keepTurns: 0, shrinkLastResults: false });
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

export type CompactionOutcome = { state: LifeState; summarized: boolean; aborted?: boolean };

export const RESULT_LEFT_OUT = "[result left out: too large to summarise]";

/**
 * The summary request's copy of the log when the log itself is over budget (§5.6 `budget` /
 * `overflow`): the last tool results (what pushed it over) are replaced by a placeholder, so the
 * summary call does not resend the over-budget request. The log is not changed.
 */
export function withoutLastResults(lines: readonly LifeLogLine[]): LifeLogLine[] {
  const index = lines.map((line) => line.kind).lastIndexOf("tool_results");
  if (index < 0) return [...lines];
  const line = lines[index]!;
  const message = line.message as unknown as ProviderMessageLike;
  if (!Array.isArray(message.content)) return [...lines];
  const content = message.content.map((block) => (block.type === "tool_result" ? { ...block, content: RESULT_LEFT_OUT } : block));
  const copy = [...lines];
  copy[index] = { ...line, message: { ...message, content } as unknown as Record<string, unknown> };
  return copy;
}

/** A rough size of some log lines in tokens (the same estimator as requests). */
function linesTokens(lines: readonly LifeLogLine[]): number {
  const messages = lines.flatMap((line) => (line.message ? [line.message as unknown as ProviderMessageLike] : []));
  return messages.length > 0 ? estimateTokens(messages, {}) : 0;
}

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
    /** The log is over budget: the summary request leaves the last tool results out (M1). */
    shrinkLastResults?: boolean;
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
      const summaryLines = o.shrinkLastResults ? withoutLastResults(o.lines) : o.lines;
      const request = await buildLifeRequest(deps, { state: o.state, lines: summaryLines, route: o.summaryRoute!, missing: "text", ...(o.signal ? { signal: o.signal } : {}) });
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
    // Aborted (pause, shutdown, a reload or reconnect): nothing changes, her log stays as it is and
    // the compaction runs again later. Only a genuine failure falls back to truncation.
    if (!summarized && o.signal?.aborted) {
      deps.logger.info("Life compaction interrupted; nothing changed", { category: "life", waifuId: o.waifu.id, reason: o.reason });
      return { state: await readLifeState(deps.storage, o.waifu.id), summarized: false, aborted: true };
    }
    if (!summarized) {
      await updateLifeState(deps.storage, o.waifu.id, (current) => ({ ...current, compactionPausedUntil: new Date(now.getTime() + COMPACTION_FAILURE_BACKOFF_MS).toISOString() }), now);
    }
  }
  if (!summarized && o.emptySummaryOnFailure) summary = null;
  // Images of kept turns are frozen as text: their OCR text when the OCR cache has it.
  const imageText = new Map<string, string>();
  for (const image of inlineImagesOf(o.lines)) {
    if (imageText.has(image.key)) continue;
    imageText.set(image.key, imageTextFor(await deps.ocr?.cachedText(image.attachment as never).catch(() => undefined)));
  }
  // The kept window shrinks (3 → 0 turns) while it alone would take more than half the compaction
  // trigger, so a new epoch never starts over budget (M2).
  const limit = o.summaryRoute ? 0.5 * settings.triggerRatio * lifeBudget(o.summaryRoute, deps.config().life.maxContextTokens) : Number.POSITIVE_INFINITY;
  let keep = o.keepTurns ?? KEPT_TURNS;
  const keptOf = (count: number) =>
    keptTurnLines(o.lines, { keep: count, ...(o.openTurnId ? { openTurnId: o.openTurnId } : {}), deletedIds: new Set(o.state.deletedReadIds), imageText });
  let keptResult = keptOf(keep);
  while (keep > 0 && linesTokens(keptResult.kept) > limit) {
    keep -= 1;
    keptResult = keptOf(keep);
  }
  const { kept, strippedBlocks, readIds } = keptResult;
  if (o.deferEpoch) {
    const state = await updateLifeState(deps.storage, o.waifu.id, (current) => ({ ...current, summary, pendingEpochStart: true, pendingEpochReason: "forget" as const }), now);
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
