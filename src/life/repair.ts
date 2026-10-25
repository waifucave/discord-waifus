// Boot repair (Living cast spec §5.7), per waifu, before anything else runs:
//
// - a torn last log line is dropped (the log is rewritten without it);
// - a Bash change set journalled in `life/pending-changes/` is finished first (§16.9: each write is
//   atomic and by content, so finishing twice changes nothing);
// - a last assistant message with tool calls but no results gets synthetic results. For a
//   side-effect intent without its `done` line: a `SendMessage` is checked against every message
//   of hers in the conversation since the intent time, by the digest of the final content recorded
//   just before the Discord call (else by its text with mentions and emoji set aside): found →
//   `sent #ref (recovered)`, not found → `[interrupted] not sent`, the conversation unreadable →
//   "unknown whether this was sent" (never "not sent"); Write, Edit, ScheduleWake and WatchFor are
//   idempotent by content and re-checked on disk; a Bash call says whether its changes were saved.
//   Then `[system] interrupted by a restart`;
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
import { homeStoreFor } from "./home/index.js";
import { parseStrictJson, readScheduleEntries, readWatchEntries } from "./home/specialFiles.js";
import { SCHEDULE_FILE, specialJsonFile, WATCHES_FILE } from "./home/pathRules.js";
import { parseLocalDateTime } from "./clock.js";
import { safeJournalName } from "./home/homeStore.js";
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
  intent: { start?: LifeIntent; done?: LifeIntent; lines: LifeIntent[] },
  recoveredChanges: ReadonlySet<string> = new Set()
): Promise<{ text: string; isError: boolean }> {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const waifu = await readWaifu(deps.storage, waifuId).catch(() => undefined);
  if (intent.done) {
    if ((call.name === "SendMessage" || call.name === "send_message") && intent.done.resultRef && typeof input["place"] === "string") {
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
  if (call.name === "Bash") {
    // Its intent is written only for a non-empty change set; a journal finished above was saved.
    return recoveredChanges.has(safeJournalName(call.id))
      ? { text: "[interrupted by a restart] the command ran and its changes were saved", isError: false }
      : { text: "[interrupted] the command was stopped; nothing was saved", isError: true };
  }
  if (!intent.start) return { text: "[interrupted]", isError: true };
  const store = waifu ? homeStoreFor(deps, waifu) : undefined;
  // Her path as she wrote it, under her current slug (she may have been renamed since).
  const resolvePath = async (path: unknown) => {
    if (!store || typeof path !== "string") return undefined;
    const resolved = await store.resolveExisting(path);
    if (resolved.ok) return resolved.path;
    const renamed = await store.resolveExisting(path.replace(/^\/home\/[^/]+/u, `/home/${store.slug}`));
    return renamed.ok ? renamed.path : undefined;
  };
  const fileText = async (path: unknown) => {
    const p = await resolvePath(path);
    return p && store ? store.files.readText(p).catch(() => undefined) : undefined;
  };
  // A reminder or watch entry made by the call: its note, and its time within a minute of what the
  // call asked for (counted from the intent).
  const intentAt = Math.min(...[intent.start, ...intent.lines].flatMap((line) => (line ? [Date.parse(line.at)] : [])).filter(Number.isFinite));
  const near = (local: string, wanted: number | undefined) => {
    if (wanted === undefined) return true;
    const at = parseLocalDateTime(local, deps.timeZone)?.getTime();
    return at !== undefined && Math.abs(at - wanted) <= 90_000;
  };
  switch (call.name) {
    case "SendMessage":
    case "send_message": {
      if (typeof input["place"] !== "string" || !waifu) return { text: "[interrupted] not sent", isError: true };
      const sentText = typeof input["text"] === "string" ? input["text"] : "";
      const place = await resolvePlace(deps.storage, waifuId, input["place"]);
      if (!place) return { text: "[interrupted] not sent", isError: true };
      // The digest of the final content (written just before the Discord call) matches the message
      // even when Discord's side rewrote mentions or emoji; the loose text compare is the fallback.
      const digests = new Set(intent.lines.flatMap((line) => (line.contentDigest ? [line.contentDigest] : [])));
      const self = await selfAuthorIds(deps.storage, waifu);
      const wanted = loose(stripCopiedHeader(sentText, [waifu.name, waifu.displayName]));
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
    case "Write": {
      const p = await resolvePath(input["file_path"]);
      const current = await fileText(input["file_path"]);
      const content = input["content"];
      // A reminder or watch file the app gave new ids to (and rewrote in its own layout) still
      // holds what she wrote: the same entries, ids aside. Any other file must match exactly.
      const done = current !== undefined && typeof content === "string" && (current === content || (p !== undefined && specialJsonFile(p) !== undefined && sameEntriesIgnoringIds(current, content)));
      return done ? { text: `wrote ${String(input["file_path"])} (recovered)`, isError: false } : { text: "[interrupted] not written", isError: true };
    }
    case "Edit": {
      const current = await fileText(input["file_path"]);
      const oldText = input["old_string"];
      const newText = input["new_string"];
      const done = current !== undefined && typeof newText === "string" && current.includes(newText) && (typeof oldText !== "string" || !current.includes(oldText) || newText.includes(oldText));
      return done ? { text: `edited ${String(input["file_path"])} (recovered)`, isError: false } : { text: "[interrupted] not edited", isError: true };
    }
    case "ScheduleWake": {
      const entries = store ? readScheduleEntries(await fileText(`~/${SCHEDULE_FILE}`), deps.timeZone) : [];
      const wanted =
        typeof input["at"] === "string"
          ? parseLocalDateTime(input["at"], deps.timeZone)?.getTime()
          : typeof input["in_minutes"] === "number" && Number.isFinite(intentAt)
            ? intentAt + input["in_minutes"] * 60_000
            : undefined;
      const found = entries.find((reminder) => reminder.note === input["note"] && near(reminder.at, wanted));
      return found ? { text: `set ${found.id} (recovered)`, isError: false } : { text: "[interrupted] not set", isError: true };
    }
    case "WatchFor": {
      const entries = store ? readWatchEntries(await fileText(`~/${WATCHES_FILE}`), deps.timeZone) : [];
      const wanted = typeof input["timeout_minutes"] === "number" && Number.isFinite(intentAt) ? intentAt + input["timeout_minutes"] * 60_000 : undefined;
      const found = entries.find((watch) => watch.note === input["note"] && near(watch.timeout, wanted));
      return found ? { text: `watching ${found.id} (recovered)`, isError: false } : { text: "[interrupted] not set", isError: true };
    }
    default:
      return { text: "[interrupted]", isError: true };
  }
}

/** Both texts are JSON arrays with the same entries once `id` is set aside (her special files). */
function sameEntriesIgnoringIds(current: string, written: string): boolean {
  const entries = (text: string): string[] | undefined => {
    try {
      const value = parseStrictJson(text);
      if (!Array.isArray(value)) return undefined;
      return value.map((entry) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return JSON.stringify(entry);
        const { id: _id, ...rest } = entry as Record<string, unknown>;
        return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
      });
    } catch {
      return undefined;
    }
  };
  const a = entries(current);
  const b = entries(written);
  return a !== undefined && b !== undefined && a.length === b.length && a.every((entry, index) => entry === b[index]);
}

export type RepairOutcome = { tornLines: boolean; closedCalls: number; recovered: number; wasInTurn: boolean };

export async function repairLife(deps: LifeDeps, waifuId: string): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { tornLines: false, closedCalls: 0, recovered: 0, wasInTurn: false };
  // A Bash change set a crash left half applied is finished before anything reads her files.
  const owner = await readWaifu(deps.storage, waifuId).catch(() => undefined);
  const recoveredChanges = owner ? await homeStoreFor(deps, owner).recoverPendingChanges().catch(() => [] as string[]) : [];
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
      const recoveredSet = new Set(recoveredChanges);
      const results: ContentBlockLike[] = [];
      for (const call of calls) {
        const mine = intents.filter((intent) => intent.toolCallId === call.id && intent.argsDigest === argsDigest(call.input));
        const recovered = await recoverCall(deps, waifuId, call, { start: mine.find((intent) => !intent.done), done: mine.find((intent) => intent.done), lines: mine.filter((intent) => !intent.done) }, recoveredSet);
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
