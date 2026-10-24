// Boot repair (Living cast spec §5.7), per waifu, before anything else runs:
//
// - a torn last log line is dropped (the log is rewritten without it);
// - a last assistant message with tool calls but no results gets synthetic results. For a
//   side-effect intent without its `done` line: a `send_message` is checked against every message
//   of hers in the conversation since the intent time, by the digest of the final content recorded
//   just before the Discord call (else by its text with mentions and emoji set aside): found →
//   `sent #ref (recovered)`, not found → `[interrupted] not sent`, the conversation unreadable →
//   "unknown whether this was sent" (never "not sent"); note, schedule and watch writes are
//   idempotent by content and re-checked on disk. Then `[system] interrupted by a restart`;
// - `status: turn` is reset to idle and the turn's wakes go back to the queue.
// Nothing is ever sent twice by the repair itself.

import { createHash } from "node:crypto";
import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { assignConversationRefs } from "../discord/refStore.js";
import { readWaifu } from "../orchestration/stores/config.js";
import type { LifeIntent, LifeLogLine } from "../shared/schemas/life.js";
import { timeLine } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { appendLifeLog, compactIntents, lifeLogTorn, readIntents, readLifeFile, readLifeLog, readLifeState, rewriteLifeLog, updateLifeState } from "./lifeStore.js";
import { Notes } from "./notes.js";
import { stripCopiedHeader } from "./outbound.js";
import { selfAuthorIds } from "./people.js";
import { resolvePlace } from "./places.js";
import { contentDigest } from "./tools/messages.js";
import { requeueWakes } from "./wakeQueue.js";
import { dmFloorAt } from "../orchestration/dm/dmStore.js";

export const RESTART_NOTE = "[system] interrupted by a restart";

type Call = { id: string; name: string; input: unknown };

function argsDigest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 32);
}

export const UNCERTAIN_SEND = "[interrupted] it is unknown whether this was sent; read the place before sending it again";

/** Content compared loosely: mentions, channel links and custom emoji (resolved by Discord) set aside, spaces collapsed. */
function loose(content: string): string {
  return content
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|<@[^>\s]+>|:\w+:/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

async function recoverCall(
  deps: LifeDeps,
  waifuId: string,
  call: Call,
  intent: { start?: LifeIntent; done?: LifeIntent; lines: LifeIntent[] }
): Promise<{ text: string; isError: boolean }> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const waifu = await readWaifu(deps.storage, waifuId).catch(() => undefined);
  if (intent.done) {
    if (call.name === "send_message" && intent.done.resultRef && typeof input["place"] === "string") {
      const place = await resolvePlace(deps.storage, waifuId, input["place"]);
      if (place) {
        const refs = await assignConversationRefs(deps.storage, place.placeKey as never, [intent.done.resultRef], deps.now());
        const ref = refs.get(intent.done.resultRef);
        if (ref) return { text: `sent #${ref} (recovered)`, isError: false };
      }
      return { text: "sent (recovered)", isError: false };
    }
    return { text: "done (recovered)", isError: false };
  }
  if (!intent.start) return { text: "[interrupted]", isError: true };
  const notes = new Notes(deps.storage, waifuId);
  switch (call.name) {
    case "send_message": {
      if (typeof input["place"] !== "string" || typeof input["text"] !== "string" || !waifu) return { text: "[interrupted] not sent", isError: true };
      const place = await resolvePlace(deps.storage, waifuId, input["place"]);
      if (!place) return { text: "[interrupted] not sent", isError: true };
      // The digest of the final content (written just before the Discord call) matches the message
      // even when Discord's side rewrote mentions or emoji; the loose text compare is the fallback.
      const digests = new Set(intent.lines.flatMap((line) => (line.contentDigest ? [line.contentDigest] : [])));
      const self = await selfAuthorIds(deps.storage, waifu);
      const wanted = loose(stripCopiedHeader(input["text"], [waifu.name, waifu.displayName]));
      // Every message after the intent (not only the newest page): a busy room may have moved on.
      const since = Math.min(...intent.lines.map((line) => Date.parse(line.at)));
      let messages;
      try {
        if (!deps.discord()) throw new Error("Discord is not connected");
        messages = (await deps.conversations.fetchSince({ conversation: place.ref, afterMessageId: dmFloorAt(new Date(since - 2_000)), maxMessages: 500 })).messages;
      } catch {
        // Unknown is not "not sent": she must look before sending again.
        return { text: UNCERTAIN_SEND, isError: true };
      }
      const found = messages.find((message) => self.includes(message.authorId) && (digests.has(contentDigest(message.content)) || loose(message.content) === wanted));
      if (!found) return { text: "[interrupted] not sent", isError: true };
      const refs = await assignConversationRefs(deps.storage, place.placeKey as never, [found.id], deps.now());
      return { text: `sent #${refs.get(found.id) ?? "?"} (recovered)`, isError: false };
    }
    case "write_note": {
      const current = typeof input["path"] === "string" ? await notes.read(input["path"]).catch(() => undefined) : undefined;
      return current !== undefined && current === input["content"] ? { text: `written ${String(input["path"])} (recovered)`, isError: false } : { text: "[interrupted] not written", isError: true };
    }
    case "edit_note": {
      const current = typeof input["path"] === "string" ? await notes.read(input["path"]).catch(() => undefined) : undefined;
      const done = current !== undefined && typeof input["replace"] === "string" && current.includes(input["replace"]) && (typeof input["find"] !== "string" || !current.includes(input["find"]) || input["replace"].includes(input["find"]));
      return done ? { text: `edited ${String(input["path"])} (recovered)`, isError: false } : { text: "[interrupted] not edited", isError: true };
    }
    case "delete_note": {
      const current = typeof input["path"] === "string" ? await notes.read(input["path"]).catch(() => undefined) : undefined;
      return current === undefined ? { text: `deleted ${String(input["path"])} (recovered)`, isError: false } : { text: "[interrupted] not deleted", isError: true };
    }
    case "schedule_wake": {
      const file = await readLifeFile(deps.storage, waifuId, "schedule");
      const found = file.reminders.find((reminder) => reminder.note === input["note"] && Date.parse(reminder.createdAt) >= Date.parse(intent.start!.at) - 1_000);
      return found ? { text: `set ${found.id} (recovered)`, isError: false } : { text: "[interrupted] not set", isError: true };
    }
    case "watch_for": {
      const file = await readLifeFile(deps.storage, waifuId, "watches");
      const found = file.watches.find((watch) => watch.note === input["note"] && Date.parse(watch.createdAt) >= Date.parse(intent.start!.at) - 1_000);
      return found ? { text: `watching ${found.id} (recovered)`, isError: false } : { text: "[interrupted] not set", isError: true };
    }
    case "cancel_watch": {
      const file = await readLifeFile(deps.storage, waifuId, "watches");
      return file.watches.some((watch) => watch.id === input["id"]) ? { text: "[interrupted] not cancelled", isError: true } : { text: `cancelled ${String(input["id"])} (recovered)`, isError: false };
    }
    case "cancel_wake": {
      const file = await readLifeFile(deps.storage, waifuId, "schedule");
      return file.reminders.some((reminder) => reminder.id === input["id"]) ? { text: "[interrupted] not cancelled", isError: true } : { text: `cancelled ${String(input["id"])} (recovered)`, isError: false };
    }
    default:
      return { text: "[interrupted]", isError: true };
  }
}

export type RepairOutcome = { tornLines: boolean; closedCalls: number; recovered: number; wasInTurn: boolean };

export async function repairLife(deps: LifeDeps, waifuId: string): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { tornLines: false, closedCalls: 0, recovered: 0, wasInTurn: false };
  const state = await readLifeState(deps.storage, waifuId);
  outcome.wasInTurn = state.status === "turn";
  if (!state.systemSnapshot) {
    if (outcome.wasInTurn) await updateLifeState(deps.storage, waifuId, (current) => ({ ...current, status: "idle", currentTurn: undefined }));
    return outcome;
  }
  let lines = await readLifeLog(deps.storage, waifuId, state.epoch);
  if (await lifeLogTorn(deps.storage, waifuId, state.epoch)) {
    outcome.tornLines = true;
    await rewriteLifeLog(deps.storage, waifuId, state.epoch, lines);
  }
  const waifu = await readWaifu(deps.storage, waifuId).catch(() => undefined);
  const timeText = waifu ? timeLine({ now: deps.now(), timeZone: deps.timeZone, availability: waifu.availability }) : undefined;
  const last = lines[lines.length - 1];
  const message = (last?.message ?? undefined) as unknown as ProviderMessageLike | undefined;
  const append = async (kind: LifeLogLine["kind"], content: ContentBlockLike[]) => {
    const line: LifeLogLine = {
      seq: last ? last.seq + 1 : 0,
      at: deps.now().toISOString(),
      kind,
      ...(state.currentTurn?.id ?? last?.turnId ? { turnId: state.currentTurn?.id ?? last?.turnId } : {}),
      message: { role: "user", content } as unknown as Record<string, unknown>
    };
    await appendLifeLog(deps.storage, waifuId, state.epoch, [line]);
    lines = [...lines, line];
  };
  const tail: ContentBlockLike[] = [{ type: "text", text: RESTART_NOTE }, ...(timeText ? [{ type: "text" as const, text: timeText }] : [])];
  if (last?.kind === "assistant" && message && Array.isArray(message.content)) {
    const calls = message.content.filter((block): block is Extract<ContentBlockLike, { type: "tool_use" }> => block.type === "tool_use");
    if (calls.length > 0) {
      const intents = await readIntents(deps.storage, waifuId);
      const results: ContentBlockLike[] = [];
      for (const call of calls) {
        const mine = intents.filter((intent) => intent.toolCallId === call.id && intent.argsDigest === argsDigest(call.input));
        const recovered = await recoverCall(deps, waifuId, call, { start: mine.find((intent) => !intent.done), done: mine.find((intent) => intent.done), lines: mine.filter((intent) => !intent.done) });
        if (!recovered.isError) outcome.recovered += 1;
        outcome.closedCalls += 1;
        results.push({ type: "tool_result", tool_use_id: call.id, content: recovered.text, ...(recovered.isError ? { is_error: true } : {}) });
      }
      await append("tool_results", [...results, ...tail]);
    } else if (outcome.wasInTurn) {
      await append("system_note", tail);
    }
  } else if (outcome.wasInTurn) {
    await append("system_note", tail);
  }
  if (outcome.wasInTurn || outcome.closedCalls > 0) {
    // The interrupted turn's wakes go back to the queue: nothing she was woken for is lost (I4).
    if (outcome.wasInTurn) await requeueWakes(deps.storage, waifuId, state.currentTurn?.wakes ?? []);
    await updateLifeState(deps.storage, waifuId, (current) => ({ ...current, status: "idle", currentTurn: undefined, lastTurnEndedAt: deps.now().toISOString() }));
  }
  await compactIntents(deps.storage, waifuId, new Set()).catch(() => undefined);
  return outcome;
}
