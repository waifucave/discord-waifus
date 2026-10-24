// Forget in a life (Living cast spec §7.5): a best-effort scrub of one person.
//
//   0. collect identity first, before any DM data goes: the user id and every name we have for them
//      (conversation cache authors, the guild directory, DM state, watches, her DM handle unless it
//      is a `user-<tail>` placeholder). The names are stored with the queued scrub, so a scrub that
//      runs later (a restart, the DM rate limit) still knows them. Names are split: `names` only
//      this person has (removed in step 5) and `sharedNames` (another member or a waifu has them,
//      or they are three characters or fewer, or a generic word: steps 2–4 use them, step 5 only
//      lists their matches for review). Matching is whole-word with Latin diacritics folded both
//      ways (José / jose);
//   1. DM data (the caller: `dmForget` / `forgetUser`; the owner's forget also records
//      `user/people/forgotten.json`);
//   2. summary without the person: her turn is aborted, the compaction summary is written with no
//      kept turns and every name listed for omission (empty on failure); the new epoch waits
//      (`pendingEpochStart`) while the per-waifu lock is held;
//   3. other state: wakes and pending notices, watches from the person or bound to their DM or to
//      words naming them, reminder notes, her DM read cursor and handle, maintenance.jsonl lines,
//      the host's recent web queries naming them, and her slice of the Living cast archive;
//   4. notes scrub: a maintenance session told to remove everything about the person (a failed
//      session keeps the scrub queued, so it runs again);
//   5. start the epoch (MEMORY.md re-read, places re-listed, every old epoch log deleted) and verify:
//      a note marked as the person's own (`<!-- user:<id> -->`), or a `people/` note whose heading is
//      a name only they have, is deleted whole (with its MEMORY.md links); a `people/` note headed by
//      a shared name is listed for review. Then notes, summary and the new system snapshot are
//      searched: id lines are removed; a bullet or heading naming them by a unique name goes whole
//      (a removed heading lists the rest of the note for review), prose loses the sentences that
//      name them; shared-name matches are listed as needsReview (persisted in
//      `life/needs-review.json` for the owner).
//
// `/forget conversation` runs steps 0–2 for the DM only, then starts the epoch at once, so the old
// log goes too. A DM user's `/forget` (either scope) runs at most once per 6 hours per user; inside
// the window it is queued for her nightly maintenance and her turn is never aborted (§7.3).
//
// The owner's forget-user first queues an `owner_forget` pending scrub (with the identity) for
// every waifu with a life folder or notes, then runs and clears them. A scrub that fails, or that
// could not run because no cast runtime was up (Discord offline), stays queued and runs when her
// life next starts.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../backend/logger.js";
import { listWaifus } from "../orchestration/stores/config.js";
import { readDmFloor, readDmState } from "../orchestration/dm/dmStore.js";
import { queuePendingScrub, type PendingScrub, type PendingScrubSource } from "../orchestration/dm/forgotten.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeState } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { atomicWriteJson } from "../storage/atomic.js";
import { conversationKey } from "../orchestration/context/keys.js";
import { memberDisplayName } from "../discord/directoryView.js";
import { scrubArchive } from "./archiveScrub.js";
import { compactLife, currentHarness, startEpoch } from "./compaction.js";
import type { LifeDeps } from "./deps.js";
import {
  appendMaintenanceReport,
  pruneOldEpochLogs,
  readLifeFile,
  readLifeLog,
  readLifeState,
  scrubMaintenanceReports,
  setReadCursor,
  updateLifeFile,
  updateLifeState
} from "./lifeStore.js";
import { lifeModelOf } from "./lifeLoop.js";
import { runNotesSession, scrubInstruction } from "./maintenance.js";
import { markedUserIds, MEMORY_INDEX, Notes } from "./notes.js";
import { lifeDir } from "./paths.js";
import { collectPlaces, dropPlaceHandles } from "./places.js";
import { scrubSearchUsage } from "./search.js";
import { foldName, isGenericName, isWeakName, namesSomeone } from "./text.js";
import { scrubWakeQueue } from "./wakeQueue.js";

export const DM_SCRUB_RATE_MS = 6 * 3_600_000;
/** At most this many review lines are kept per scrub, and in `needs-review.json`. */
const MAX_REVIEW_LINES = 50;
const MAX_REVIEW_FILE = 200;

export type ForgetIdentity = {
  userId: string;
  /** Names only this person has: removed in step 5. */
  names: string[];
  /** Names someone else has, or short or generic ones: steps 2–4 use them; step 5 lists matches for review. */
  sharedNames: string[];
};

export type ReviewLine = { where: string; line: string };

export type ForgetScrubResult = {
  waifuId: string;
  removedLines: number;
  removedSentences: number;
  /** Notes deleted whole (her notes about the person). */
  removedNotes?: number;
  needsReview: ReviewLine[];
  /** Steps 2–5 were queued as a pending scrub (the DM rate limit, or a failure). */
  queued?: boolean;
};

/** Every name of the identity that steps 2–4 use: unique and shared, never a generic word. */
export function scrubNames(identity: ForgetIdentity): string[] {
  return [...identity.names, ...identity.sharedNames].filter((name) => !isGenericName(name));
}

/** Two identities of one person: names in either's shared list stay shared. */
export function mergeIdentity(a: ForgetIdentity, b: Partial<Pick<ForgetIdentity, "names" | "sharedNames">>): ForgetIdentity {
  const shared = new Map<string, string>();
  for (const name of [...a.sharedNames, ...(b.sharedNames ?? [])]) shared.set(foldName(name), name);
  const unique = new Map<string, string>();
  for (const name of [...a.names, ...(b.names ?? [])]) if (!shared.has(foldName(name))) unique.set(foldName(name), name);
  return { userId: a.userId, names: [...unique.values()], sharedNames: [...shared.values()] };
}

/** Waifus with something of a person to scrub: a life folder (even only queued wakes) or notes. */
export async function waifusWithLife(storage: StorageService): Promise<WaifuConfig[]> {
  const out: WaifuConfig[] = [];
  for (const waifu of await listWaifus(storage).catch(() => [] as WaifuConfig[])) {
    const hasLife = await stat(storage.dataPath(lifeDir(waifu.id))).then((info) => info.isDirectory(), () => false);
    if (hasLife || (await new Notes(storage, waifu.id).exists())) out.push(waifu);
  }
  return out;
}

/**
 * The owner's forget-user, before any scrub runs and before the DM data goes: one `owner_forget`
 * pending scrub per life, with the identity collected now (`identityOf`, or the stored sources).
 */
export async function queueOwnerScrubs(
  storage: StorageService,
  userId: string,
  at: Date,
  o: { logger?: Pick<Logger, "warn">; identityOf?: (waifu: WaifuConfig) => Promise<ForgetIdentity> } = {}
): Promise<Array<{ waifu: WaifuConfig; scrub: PendingScrub; identity: ForgetIdentity }>> {
  const queued: Array<{ waifu: WaifuConfig; scrub: PendingScrub; identity: ForgetIdentity }> = [];
  for (const waifu of await waifusWithLife(storage)) {
    const identity = await (o.identityOf ?? ((candidate) => storedIdentity(storage, candidate, userId)))(waifu).catch(() => ({ userId, names: [], sharedNames: [] }));
    const scrub = await queuePendingScrub(storage, waifu.id, userId, at, {
      source: "owner_forget",
      names: identity.names,
      sharedNames: identity.sharedNames,
      ...(o.logger ? { logger: o.logger } : {})
    });
    queued.push({ waifu, scrub, identity });
  }
  return queued;
}

/** Names from a DM handle (`dm/kevin-2` → "kevin"); a `user-<tail>` placeholder is no name at all. */
function handleName(handle: string): string | undefined {
  const slug = handle.slice(3).replace(/-\d+$/u, "");
  if (!slug || slug === "user" || slug.startsWith("user-")) return undefined;
  return slug.replace(/-/gu, " ");
}

type NameSets = { mine: Set<string>; others: Set<string> };

function adder(sets: NameSets) {
  return (target: "mine" | "others", name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && [...trimmed].length >= 2) sets[target].add(trimmed);
  };
}

/** Step 0 from what is on disk: DM state, watches, her DM handle, and every waifu's names. */
async function storedNames(storage: StorageService, waifu: WaifuConfig, userId: string, sets: NameSets): Promise<void> {
  const add = adder(sets);
  const dmState = await readDmState(storage, userId, waifu.id).catch(() => undefined);
  add("mine", dmState?.userDisplayName);
  for (const watch of (await readLifeFile(storage, waifu.id, "watches").catch(() => ({ watches: [] as never[] }))).watches) {
    for (const binding of watch.bindings) if (binding.fromUserId === userId) add("mine", binding.fromName);
  }
  const dmKey = conversationKey({ kind: "dm", waifuId: waifu.id, userId });
  const handles = await readLifeFile(storage, waifu.id, "handles").catch(() => ({ handles: {} as Record<string, string> }));
  for (const [handle, key] of Object.entries(handles.handles)) if (key === dmKey && handle.startsWith("dm/")) add("mine", handleName(handle));
  for (const other of await listWaifus(storage).catch(() => [])) {
    add("others", other.name);
    add("others", other.displayName);
  }
}

function partition(userId: string, sets: NameSets): ForgetIdentity {
  const others = new Set([...sets.others].map(foldName));
  const names = new Map<string, string>();
  const sharedNames = new Map<string, string>();
  // One spelling per folded name (the first seen): matching folds diacritics and case anyway.
  for (const name of sets.mine) {
    const key = foldName(name);
    const target = others.has(key) || isWeakName(name) ? sharedNames : names;
    if (!target.has(key)) target.set(key, name);
  }
  for (const key of sharedNames.keys()) names.delete(key);
  return { userId, names: [...names.values()], sharedNames: [...sharedNames.values()] };
}

/** Step 0 without a running cast (the offline owner forget): stored sources only. */
export async function storedIdentity(storage: StorageService, waifu: WaifuConfig, userId: string): Promise<ForgetIdentity> {
  const sets: NameSets = { mine: new Set(), others: new Set() };
  await storedNames(storage, waifu, userId, sets);
  return partition(userId, sets);
}

/** Step 0: the person's id and names. */
export async function collectIdentity(deps: LifeDeps, waifu: WaifuConfig, userId: string): Promise<ForgetIdentity> {
  const sets: NameSets = { mine: new Set(), others: new Set() };
  const add = adder(sets);
  const places = await collectPlaces(deps.storage, waifu.id);
  for (const place of places) {
    for (const message of deps.conversations.bufferedMessages(place.ref)) add(message.authorId === userId ? "mine" : "others", message.authorName);
  }
  for (const guildId of new Set(places.flatMap((place) => (place.guildId ? [place.guildId] : [])))) {
    for (const member of await deps.directory.members(guildId).catch(() => [])) {
      const target = member.userId === userId ? "mine" : "others";
      add(target, memberDisplayName(member));
      add(target, member.username);
      add(target, member.globalDisplayName);
    }
  }
  await storedNames(deps.storage, waifu, userId, sets);
  return partition(userId, sets);
}

function mentionsPerson(text: string, userId: string, names: readonly string[]): boolean {
  return text.includes(userId) || names.some((name) => namesSomeone(text, name));
}

/** Step 2: the summary without the person (no kept turns), epoch start deferred. */
export async function summaryWithoutPerson(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, signal?: AbortSignal): Promise<LifeState> {
  const state = await readLifeState(deps.storage, waifu.id);
  if (!state.systemSnapshot) return state;
  const lines = await readLifeLog(deps.storage, waifu.id, state.epoch);
  const model = lifeModelOf(deps, waifu);
  const harness = model ? await currentHarness(deps, waifu, model) : undefined;
  if (!harness) {
    return updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, summary: null, pendingEpochStart: true }));
  }
  const names = scrubNames(identity);
  const outcome = await compactLife(deps, {
    waifu,
    state,
    lines,
    summaryRoute: state.modelRoute ? (deps.catalog().models.find((entry) => entry.providerId === state.modelRoute!.providerId && entry.modelId === state.modelRoute!.modelId) ?? model) : model,
    ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
    nextHarness: harness,
    reason: "forget",
    keepTurns: 0,
    omit: { deleted: [], people: names.length > 0 ? names : [`<@${identity.userId}>`] },
    deferEpoch: true,
    emptySummaryOnFailure: true,
    ...(signal ? { signal } : {})
  });
  // The summary is checked by the verification step too; a line naming the id never survives.
  return outcome.state;
}

/**
 * Step 3: wakes, notices, watches, reminders, DM cursor and handle, maintenance lines, recent web
 * queries and her slice of the archive. `dmOnly` (`/forget conversation`): only what belongs to
 * the DM with the person (wakes and watches there, the cursor at the floor).
 */
export async function scrubOtherState(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, o: { dmOnly?: boolean } = {}): Promise<number> {
  const dmKey = conversationKey({ kind: "dm", waifuId: waifu.id, userId: identity.userId });
  const floor = await readDmFloor(deps.storage, identity.userId, waifu.id).catch(() => undefined);
  if (o.dmOnly) {
    let removed = await scrubWakeQueue(deps.storage, waifu.id, { userId: "", placeKeys: new Set([dmKey]), mentions: () => false });
    await updateLifeFile(deps.storage, waifu.id, "watches", (file) => {
      const watches = file.watches.filter((watch) => !watch.bindings.some((binding) => binding.placeKey === dmKey));
      removed += file.watches.length - watches.length;
      return { ...file, watches };
    });
    await setReadCursor(deps.storage, waifu.id, dmKey, floor, deps.now());
    return removed;
  }
  const names = scrubNames(identity);
  const mentions = (text: string) => mentionsPerson(text, identity.userId, names);
  let removed = await scrubWakeQueue(deps.storage, waifu.id, { userId: identity.userId, placeKeys: new Set([dmKey]), mentions });
  await updateLifeState(deps.storage, waifu.id, (current) => {
    const pendingNotices = current.pendingNotices.filter((notice) => !mentions(notice));
    removed += current.pendingNotices.length - pendingNotices.length;
    return { ...current, pendingNotices };
  });
  await updateLifeFile(deps.storage, waifu.id, "watches", (file) => {
    const watches = file.watches
      .filter(
        (watch) =>
          !watch.bindings.some(
            (binding) => binding.fromUserId === identity.userId || binding.placeKey === dmKey || (binding.words ?? []).some((word) => names.some((name) => namesSomeone(word, name) || namesSomeone(name, word)))
          )
      )
      .map((watch) => (mentions(watch.note) ? { ...watch, note: "" } : watch));
    removed += file.watches.length - watches.length;
    return { ...file, watches };
  });
  await updateLifeFile(deps.storage, waifu.id, "schedule", (file) => {
    const reminders = file.reminders.filter((reminder) => !mentions(reminder.note));
    removed += file.reminders.length - reminders.length;
    return { ...file, reminders };
  });
  // Her DM cursor goes whole: the conversation is gone, and the floor holds on the read path.
  await setReadCursor(deps.storage, waifu.id, dmKey, undefined, deps.now());
  removed += await dropPlaceHandles(deps.storage, waifu.id, dmKey);
  removed += await scrubMaintenanceReports(deps.storage, waifu.id, (line) => mentions(line));
  removed += await scrubSearchUsage(deps.storage, (query) => query.includes(identity.userId) || identity.names.some((name) => namesSomeone(query, name)));
  const archived = await scrubArchive(deps.storage.dataRoot, { userId: identity.userId, names: identity.names, avoidNames: identity.sharedNames, waifuId: waifu.id, logger: deps.logger });
  removed += archived.removed;
  return removed;
}

type Verify = { removedLines: number; removedSentences: number; removedNotes: number; needsReview: ReviewLine[] };

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s/u;
const HEADING = /^\s*#{1,6}\s/u;

function review(out: Verify, item: ReviewLine): void {
  if (out.needsReview.length < MAX_REVIEW_LINES) out.needsReview.push(item);
}

/**
 * Step 5's text pass: id lines removed; a bullet, list item or heading naming the person by a
 * unique name goes whole (a removed heading lists the note for review), prose loses the sentences
 * that name them; shared-name matches are listed for review.
 */
export function scrubText(text: string, identity: ForgetIdentity, where: string, out: Verify): string {
  const kept: string[] = [];
  const unique = (line: string) => identity.names.some((name) => namesSomeone(line, name));
  for (const line of text.split("\n")) {
    if (line.includes(identity.userId)) {
      out.removedLines += 1;
      continue;
    }
    if (unique(line)) {
      if (HEADING.test(line)) {
        out.removedLines += 1;
        review(out, { where, line: "(a heading naming them was removed; check the rest of this note)" });
        continue;
      }
      const sentences = line.split(/(?<=[.!?])\s+/u);
      const remaining = sentences.filter((sentence) => !unique(sentence));
      if (remaining.length === 0 || sentences.length === 1 || BULLET.test(line)) {
        out.removedLines += 1;
        continue;
      }
      out.removedSentences += sentences.length - remaining.length;
      kept.push(remaining.join(" "));
      continue;
    }
    if (identity.sharedNames.some((name) => namesSomeone(line, name))) review(out, { where, line: line.trim().slice(0, 300) });
    kept.push(line);
  }
  return kept.join("\n");
}

/** The first Markdown heading's text. */
function headingOf(text: string): string | undefined {
  const match = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/mu.exec(text);
  return match?.[1];
}

/** Notes about the person deleted whole: marked as theirs, or a `people/` note headed by a name only they have. */
async function deletePersonNotes(notes: Notes, all: Map<string, string>, identity: ForgetIdentity, out: Verify): Promise<string[]> {
  const deleted: string[] = [];
  for (const [notePath, text] of all) {
    if (notePath === MEMORY_INDEX) continue;
    const marked = markedUserIds(text);
    const heading = headingOf(text);
    const folded = heading ? foldName(heading) : undefined;
    const theirs =
      marked.includes(identity.userId) ||
      (marked.length === 0 && notePath.startsWith("people/") && folded !== undefined && identity.names.some((name) => foldName(name) === folded));
    if (theirs) {
      await notes.delete(notePath);
      deleted.push(notePath);
      out.removedNotes += 1;
      continue;
    }
    if (marked.length === 0 && notePath.startsWith("people/") && folded !== undefined && identity.sharedNames.some((name) => foldName(name) === folded)) {
      review(out, { where: `notes/${notePath}`, line: `(a note headed "${heading!.slice(0, 80)}" may be about them)` });
    }
  }
  for (const notePath of deleted) all.delete(notePath);
  // Their links in MEMORY.md go with them.
  const index = all.get(MEMORY_INDEX);
  if (index !== undefined && deleted.length > 0) {
    const lines = index.split("\n");
    const kept = lines.filter((line) => !deleted.some((notePath) => line.includes(`](${notePath})`)));
    if (kept.length !== lines.length) {
      out.removedLines += lines.length - kept.length;
      all.set(MEMORY_INDEX, kept.join("\n"));
      await notes.write(MEMORY_INDEX, kept.join("\n"));
    }
  }
  return deleted;
}

/**
 * Starts her next epoch now (every old log deleted). Without a model there is no harness: the old
 * logs are deleted all the same and the epoch starts with her next turn.
 */
export async function startEpochNow(deps: LifeDeps, waifu: WaifuConfig, reason: string): Promise<LifeState | undefined> {
  const model = lifeModelOf(deps, waifu);
  if (model) {
    const harness = await currentHarness(deps, waifu, model);
    const current = await readLifeState(deps.storage, waifu.id);
    return startEpoch(deps, waifu.id, { harness, summary: current.summary, kept: [], readIds: [], reason, summarized: true, strippedBlocks: 0, pruneAll: true });
  }
  const state = await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, pendingEpochStart: true }));
  // Every log goes, the current epoch's too: its turns are in the summary, and the next turn starts a new epoch.
  await pruneOldEpochLogs(deps.storage, waifu.id, 0, { all: true }).catch(() => undefined);
  return state;
}

/** Step 5: start the epoch and verify notes, summary and the snapshot. */
export async function startEpochAndVerify(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity): Promise<Verify> {
  const out: Verify = { removedLines: 0, removedSentences: 0, removedNotes: 0, needsReview: [] };
  const notes = new Notes(deps.storage, waifu.id);
  const all = await notes.readAll();
  let notesChanged = (await deletePersonNotes(notes, all, identity, out)).length > 0;
  for (const [notePath, text] of all) {
    const scrubbed = scrubText(text, identity, `notes/${notePath}`, out);
    if (scrubbed !== text) {
      await notes.write(notePath, scrubbed);
      notesChanged = true;
    }
  }
  const state = await readLifeState(deps.storage, waifu.id);
  if (state.summary) {
    const summary = scrubText(state.summary, identity, "summary", out);
    if (summary !== state.summary) await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, summary: summary.trim() || null }));
  }
  const started = await startEpochNow(deps, waifu, "forget");
  // The new snapshot is checked too; a match means the system prompt is rebuilt after the fix.
  const snapshot = started?.systemSnapshot;
  if (snapshot && lifeModelOf(deps, waifu)) {
    const memory = scrubText(snapshot.memoryIndex, identity, "system prompt", out);
    const places = scrubText(snapshot.places, identity, "system prompt", out);
    if (memory !== snapshot.memoryIndex || places !== snapshot.places || notesChanged) {
      await updateLifeState(deps.storage, waifu.id, (state2) => ({ ...state2, systemSnapshot: state2.systemSnapshot ? { ...state2.systemSnapshot, memoryIndex: memory, places } : null }));
    }
  }
  return out;
}

export const NEEDS_REVIEW_FILE = "needs-review.json";

/** Review lines for the owner (`life/needs-review.json`, newest 200; the dashboard shows them in L3). */
export async function recordNeedsReview(storage: StorageService, waifuId: string, at: Date, source: string, lines: readonly ReviewLine[]): Promise<void> {
  if (lines.length === 0) return;
  const relative = path.join(lifeDir(waifuId), NEEDS_REVIEW_FILE);
  await storage.withLocks([`life-needs-review:${waifuId}`], async () => {
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(await readFile(storage.dataPath(relative), "utf8")) as { items?: unknown };
      if (Array.isArray(parsed.items)) items = parsed.items;
    } catch {
      // missing or unreadable: start over (the lines are hints, not records)
    }
    const next = [...items, ...lines.map((line) => ({ at: at.toISOString(), source, ...line }))].slice(-MAX_REVIEW_FILE);
    await atomicWriteJson(storage.dataPath(relative), { items: next });
  });
}

export type ScrubPersonOutcome = ForgetScrubResult & { complete: boolean };

/**
 * Steps 2–5 for one waifu (the caller holds her life lock and has aborted her turn). `complete`
 * is false when the notes scrub (step 4) could not run or failed: the caller keeps the scrub queued.
 */
export async function scrubPerson(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, o: { signal?: AbortSignal; source: string }): Promise<ScrubPersonOutcome> {
  await summaryWithoutPerson(deps, waifu, identity, o.signal);
  await scrubOtherState(deps, waifu, identity);
  const model = lifeModelOf(deps, waifu);
  let complete = false;
  if (model) {
    const session = await runNotesSession(deps, { waifu, model, instruction: scrubInstruction({ userId: identity.userId, names: scrubNames(identity) }), kind: "scrub", ...(o.signal ? { signal: o.signal } : {}) });
    complete = session.ok;
    if (!session.ok) deps.logger.warn("Forget notes scrub failed; it stays queued and runs again", { category: "life", waifuId: waifu.id, error: session.error });
  }
  const verify = await startEpochAndVerify(deps, waifu, identity);
  const now = deps.now();
  await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, scrubbedAt: recentScrubs({ ...current.scrubbedAt, [identity.userId]: now.toISOString() }, now) }));
  await recordNeedsReview(deps.storage, waifu.id, now, o.source, verify.needsReview);
  // The report keeps counts only: no names, no id.
  await appendMaintenanceReport(deps.storage, waifu.id, {
    at: now.toISOString(),
    kind: "forget",
    source: o.source,
    removedLines: verify.removedLines,
    removedSentences: verify.removedSentences,
    removedNotes: verify.removedNotes,
    needsReview: verify.needsReview.length,
    ...(complete ? {} : { notesScrub: "pending" })
  });
  deps.logger.info("Life forget scrub done", { category: "life", waifuId: waifu.id, removedLines: verify.removedLines, removedSentences: verify.removedSentences, removedNotes: verify.removedNotes, needsReview: verify.needsReview.length, complete });
  return { waifuId: waifu.id, removedLines: verify.removedLines, removedSentences: verify.removedSentences, removedNotes: verify.removedNotes, needsReview: verify.needsReview, complete, ...(complete ? {} : { queued: true }) };
}

/** `scrubbedAt` keeps only the DM rate window (6 hours): an older entry is a trace of the person and nothing more. */
export function recentScrubs(scrubbedAt: Readonly<Record<string, string>>, now: Date): Record<string, string> {
  return Object.fromEntries(Object.entries(scrubbedAt).filter(([, at]) => now.getTime() - Date.parse(at) < DM_SCRUB_RATE_MS));
}

/** True while a DM user's last forget is inside the 6-hour window. */
export function insideDmScrubWindow(state: Pick<LifeState, "scrubbedAt">, userId: string, now: Date): boolean {
  const last = state.scrubbedAt[userId];
  return last !== undefined && now.getTime() - Date.parse(last) < DM_SCRUB_RATE_MS;
}

export type { PendingScrubSource };
