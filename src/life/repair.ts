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
//   "unknown whether this was sent" (never "not sent"); Write and Edit are idempotent by content and
//   re-checked on disk, a Wakeup by what it added and cancelled (the digest it wrote just before
//   saving; the old ScheduleWake and WatchFor by their note); a Bash call says whether its changes
//   were saved.
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
import { availabilityFor } from "./busy.js";
import { parseStrictJson } from "./home/specialFiles.js";
import { specialJsonFile } from "./home/pathRules.js";
import { wakeupChangeDigest } from "./tools/wakeup.js";
import { safeJournalName } from "./home/homeStore.js";
import { patchJournalId } from "./tools/files.js";
import { stripCopiedHeader } from "./outbound.js";
import { selfAuthorIds } from "./people.js";
import { resolvePlace } from "./places.js";
import { contentDigest, sendCallSteps } from "./tools/messages.js";
import { scriptSends, sendLabel, type ScriptSend } from "./tools/sendScript.js";
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
    if (call.name === "SendMessage" && typeof input["script"] === "string" && input["place"] === undefined && waifu) return recoverSendCalls(deps, waifu, intent);
    if (call.name === "Edit" && typeof input["script"] === "string") return recoverPatches(call, intent, recoveredChanges);
    if ((call.name === "SendMessage" || call.name === "send_message") && intent.done.resultRef && typeof input["place"] === "string") {
      const place = await resolvePlace(deps.storage, waifuId, input["place"]);
      // A script's done line names every message it sent (§27.1).
      const ids = intent.done.resultRef.split(",").filter(Boolean);
      // A script that stopped part way (a wait, an error) sent its first messages: the rest were not.
      const sends = scriptSends(sendCallSteps(input, deps.config().life.send.maxFiles) ?? []);
      const notSent = sends.slice(ids.length).map((send) => `not sent: ${sendLabel(send)}`);
      let head = "sent (recovered)";
      if (place) {
        const refs = await assignConversationRefs(deps.storage, place.placeKey as never, ids, deps.now());
        if (ids.every((id) => refs.has(id))) head = `sent ${ids.map((id) => `#${refs.get(id)}`).join(" ")} (recovered)`;
      }
      return { text: [head, ...notSent].join("\n"), isError: false };
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
  switch (call.name) {
    case "SendMessage":
    case "send_message": {
      if (typeof input["script"] === "string" && input["place"] === undefined && waifu) return recoverSendCalls(deps, waifu, intent);
      if (typeof input["place"] !== "string" || !waifu) return { text: "[interrupted] not sent", isError: true };
      const steps = sendCallSteps(input, deps.config().life.send.maxFiles);
      const place = await resolvePlace(deps.storage, waifuId, input["place"]);
      if (!place || !steps) return { text: "[interrupted] not sent", isError: true };
      return recoverScript(deps, waifu, place, scriptSends(steps), intent.lines);
    }
    case "Write": {
      const p = await resolvePath(input["file_path"]);
      const current = await fileText(input["file_path"]);
      const content = input["content"];
      // A wakeups file the app gave new ids to (and rewrote in its own layout) still holds what she
      // wrote: the same entries, ids aside. Any other file must match exactly.
      const done = current !== undefined && typeof content === "string" && (current === content || (p !== undefined && specialJsonFile(p) !== undefined && sameEntriesIgnoringIds(current, content)));
      return done ? { text: `wrote ${String(input["file_path"])} (recovered)`, isError: false } : { text: "[interrupted] not written", isError: true };
    }
    case "Edit": {
      if (typeof input["script"] === "string") return recoverPatches(call, intent, recoveredChanges);
      const current = await fileText(input["file_path"]);
      const oldText = input["old_string"];
      const newText = input["new_string"];
      const done = current !== undefined && typeof newText === "string" && current.includes(newText) && (typeof oldText !== "string" || !current.includes(oldText) || newText.includes(oldText));
      return done ? { text: `edited ${String(input["file_path"])} (recovered)`, isError: false } : { text: "[interrupted] not edited", isError: true };
    }
    case "Wakeup": {
      // The digest it wrote just before saving: what it added (kind and note) and cancelled. Nothing
      // else changes her file before boot repair, so the file shows whether the save went through.
      // A script's calls (§32: up to 4) each wrote one; they ran in order, so the first not saved
      // is where it stopped.
      const digests = intent.lines.flatMap((line) => (line.contentDigest?.startsWith("add:") ? [line.contentDigest] : []));
      if (digests.length === 0 || !store) return { text: "[interrupted] not saved", isError: true };
      const { entries } = await store.readWakeups();
      const have = new Map(entries.map((entry) => [wakeupChangeDigest([entry], []).slice("add:".length, "add:".length + 16), entry.id] as const));
      const parts: string[] = [];
      for (const digest of digests) {
        const [addPart = "", cancelPart = ""] = digest.split(";");
        const wanted = addPart.slice("add:".length).split(",").filter(Boolean);
        const cancelled = cancelPart.slice("cancel:".length).split(",").filter(Boolean);
        const saved = wanted.every((hash) => have.has(hash)) && cancelled.every((id) => !entries.some((entry) => entry.id === id));
        if (!saved) {
          parts.push("[interrupted] the rest was not saved");
          break;
        }
        const ids = wanted.map((hash) => have.get(hash)!);
        parts.push([ids.length > 0 ? `set ${ids.join(", ")}` : "", cancelled.length > 0 ? `cancelled ${cancelled.join(", ")}` : ""].filter(Boolean).join("; "));
      }
      if (parts[0]?.startsWith("[interrupted]")) return { text: "[interrupted] not saved", isError: true };
      return { text: `${parts.filter((part) => !part.startsWith("[interrupted]")).join("; ")} (recovered)${parts.some((part) => part.startsWith("[interrupted]")) ? "\n[interrupted] the rest was not saved" : ""}`, isError: false };
    }
    case "ScheduleWake":
    case "WatchFor": {
      // A call from before §30 (its file became ~/life/wakeups.json): found by its note, and a
      // one-off reminder also by the time it asked for.
      const entries = store ? (await store.readWakeups()).entries : [];
      const kinds = call.name === "WatchFor" ? ["watch"] : ["at", "every"];
      const at = call.name === "ScheduleWake" && typeof input["at"] === "string" && !input["repeat"] ? input["at"] : undefined;
      const found = entries.find((entry) => kinds.includes(entry.kind) && entry.note === input["note"] && (at === undefined || (entry.kind === "at" && entry.when === at)));
      return found ? { text: `${call.name === "WatchFor" ? "watching" : "set"} ${found.id} (recovered)`, isError: false } : { text: "[interrupted] not set", isError: true };
    }
    default:
      return { text: "[interrupted]", isError: true };
  }
}

/**
 * An Edit script a crash cut off (§32.2): each `apply_patch` wrote `patch:<n>` before its change set
 * and its line done after; a change set journalled under its id and finished at boot was saved too.
 * The patches run one after another, so nothing after the first one not saved was tried.
 */
function recoverPatches(call: Call, intent: { lines: LifeIntent[] }, recoveredChanges: ReadonlySet<string>): { text: string; isError: boolean } {
  const started = intent.lines.flatMap((line) => (line.line !== undefined && line.contentDigest === `patch:${line.line}` ? [line.line] : []));
  const done = new Set(intent.lines.flatMap((line) => (line.lineDone && line.line !== undefined ? [line.line] : [])));
  const saved: number[] = [];
  let notSaved: number | undefined;
  for (const n of started) {
    if (done.has(n) || recoveredChanges.has(safeJournalName(patchJournalId(call.id, n)))) saved.push(n);
    else {
      notSaved = n;
      break;
    }
  }
  if (saved.length === 0) return { text: "[interrupted] nothing was changed", isError: true };
  const head = `patch${saved.length === 1 ? "" : "es"} ${saved.join(", ")} saved (recovered)`;
  return { text: notSaved !== undefined ? `${head}\n[interrupted] patch ${notSaved} was not saved` : head, isError: false };
}

/**
 * A SendMessage script a crash cut off (§32.2): each `tools.send_message` call wrote its plan (place
 * and sends, lines numbered across the script) before its first Discord call, and `callDone` after
 * it. A finished call sent the messages with a done line and nothing else; the call that was running
 * is recovered message by message like a §27 script (digest, else loose text; unknown when Discord
 * can't be read). Calls ran one at a time: there is none after it.
 */
async function recoverSendCalls(
  deps: LifeDeps,
  waifu: NonNullable<Awaited<ReturnType<typeof readWaifu>>>,
  intent: { done?: LifeIntent; lines: LifeIntent[] }
): Promise<{ text: string; isError: boolean }> {
  const plans = intent.lines.flatMap((line) => (line.plan ? [line.plan] : [])).sort((a, b) => a.call - b.call);
  if (plans.length === 0) return { text: "[interrupted] not sent", isError: true };
  const doneIds = new Map(intent.lines.flatMap((line) => (line.lineDone && line.line !== undefined && line.resultRef ? [[line.line, line.resultRef] as const] : [])));
  const callsDone = new Set(intent.lines.flatMap((line) => (line.callDone !== undefined ? [line.callDone] : [])));
  const sentParts: string[] = [];
  const rest: string[] = [];
  let anySent = false;
  let unknown = false;
  for (const plan of plans) {
    const sends: ScriptSend[] = plan.sends.map((send) => ({ kind: "send", line: send.line, text: send.text, files: send.files.map((path) => ({ path, line: send.line })) }));
    const place = await resolvePlace(deps.storage, waifu.id, plan.place);
    if (intent.done || callsDone.has(plan.call) || !place) {
      const ids = sends.flatMap((send) => (doneIds.has(send.line) ? [doneIds.get(send.line)!] : []));
      if (ids.length > 0) {
        anySent = true;
        const refs = place ? await assignConversationRefs(deps.storage, place.placeKey as never, ids, deps.now()) : new Map<string, string>();
        sentParts.push(ids.every((id) => refs.has(id)) ? ids.map((id) => `#${refs.get(id)}`).join(" ") : `${ids.length} message${ids.length === 1 ? "" : "s"}`);
      }
      rest.push(...sends.filter((send) => !doneIds.has(send.line)).map((send) => `not sent: ${sendLabel(send)}`));
      continue;
    }
    const recovered = await recoverScript(deps, waifu, place, sends, intent.lines.filter((line) => line.line === undefined || sends.some((send) => send.line === line.line)));
    if (recovered.text === UNCERTAIN_SEND) unknown = true;
    if (!recovered.isError) {
      anySent = true;
      const [head = "", ...more] = recovered.text.split("\n");
      sentParts.push(head.replace(/^sent /u, "").replace(/ \(recovered\)/u, ""));
      rest.push(...more);
    } else rest.push(...sends.map((send) => `not sent: ${sendLabel(send)}`));
    break;
  }
  if (!anySent) return { text: unknown ? UNCERTAIN_SEND : "[interrupted] not sent", isError: true };
  return { text: [`sent ${sentParts.join(" ")} (recovered)`, ...rest].join("\n"), isError: false };
}

/**
 * A SendMessage call a crash cut off (§5.7, §27.1): each message of its script on its own. A line with
 * a done line was sent; a line whose intent (its final content's digest, written just before the
 * Discord call) is there is looked for among her messages since (else by its text with mentions and
 * emoji set aside); a line with neither was never tried, and nothing after it was. The conversation
 * unreadable: "unknown", never "not sent". Nothing is sent again here.
 */
async function recoverScript(
  deps: LifeDeps,
  waifu: NonNullable<Awaited<ReturnType<typeof readWaifu>>>,
  place: NonNullable<Awaited<ReturnType<typeof resolvePlace>>>,
  sends: readonly ScriptSend[],
  lines: readonly LifeIntent[]
): Promise<{ text: string; isError: boolean }> {
  // Before §27 a send's one digest line had no `line`: it is the first (and only) message's.
  const ofLine = (send: ScriptSend, index: number) => lines.filter((line) => line.line === send.line || (index === 0 && line.line === undefined && line.contentDigest !== undefined));
  type Outcome = { send: ScriptSend; id?: string; check?: { digests: Set<string>; wanted: string }; unknown?: boolean };
  const outcomes: Outcome[] = [];
  for (const [index, send] of sends.entries()) {
    const mine = ofLine(send, index);
    const done = mine.find((line) => line.lineDone && line.resultRef);
    if (done) {
      outcomes.push({ send, id: done.resultRef! });
      continue;
    }
    // The first message not known to be done is looked for (by its digest when the line got that
    // far, else by its text); sends run one after another, so nothing after it was tried.
    const digests = new Set(mine.flatMap((line) => (line.contentDigest ? [line.contentDigest] : [])));
    outcomes.push({ send, check: { digests, wanted: loose(stripCopiedHeader(send.text, [waifu.name, waifu.displayName])) } });
    break;
  }
  const checking = outcomes.filter((outcome) => outcome.check);
  if (checking.length > 0) {
    const self = await selfAuthorIds(deps.storage, waifu);
    // Every message after the intent (not only the newest page): a busy room may have moved on.
    const since = Math.min(...lines.map((line) => Date.parse(line.at)).filter(Number.isFinite));
    try {
      if (!deps.discord()) throw new Error("Discord is not connected");
      const messages = (await deps.conversations.fetchSince({ conversation: place.ref, afterMessageId: dmFloorAt(new Date(since - 2_000)), maxMessages: 500 })).messages;
      const known = new Set(outcomes.flatMap((outcome) => (outcome.id ? [outcome.id] : [])));
      for (const outcome of checking) {
        const found = messages.find((message) => self.includes(message.authorId) && !known.has(message.id) && (outcome.check!.digests.has(contentDigest(message.content)) || (outcome.check!.wanted !== "" && loose(message.content) === outcome.check!.wanted)));
        if (found) {
          outcome.id = found.id;
          known.add(found.id);
        }
      }
    } catch {
      for (const outcome of checking) outcome.unknown = true;
    }
  }
  const sentIds = outcomes.flatMap((outcome) => (outcome.id ? [outcome.id] : []));
  const unknown = outcomes.find((outcome) => outcome.unknown);
  if (sentIds.length === 0) return { text: unknown ? UNCERTAIN_SEND : "[interrupted] not sent", isError: true };
  const refs = await assignConversationRefs(deps.storage, place.placeKey as never, sentIds, deps.now());
  const parts = [`sent ${sentIds.map((id) => `#${refs.get(id) ?? "?"}`).join(" ")} (recovered)`];
  const rest = sends.slice(sentIds.length);
  if (unknown) parts.push(`it is unknown whether line ${unknown.send.line} was sent; read the place before sending it again`);
  const notSent = unknown ? rest.slice(1) : rest;
  return { text: [parts.join("; "), ...notSent.map((send) => `not sent: ${sendLabel(send)}`)].join("\n"), isError: false };
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
  const timeText = waifu ? timeLine({ now: deps.now(), timeZone: deps.timeZone, status: await availabilityFor(deps, waifu, deps.now(), state) }) : undefined;
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
        const recovered = await recoverCall(deps, waifuId, call, { start: mine.find((intent) => !intent.done && intent.line === undefined && intent.contentDigest === undefined) ?? mine.find((intent) => !intent.done), done: mine.find((intent) => intent.done), lines: mine.filter((intent) => !intent.done) }, recoveredSet);
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
