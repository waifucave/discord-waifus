// Forget in a life (Living cast spec §7.5): a best-effort scrub of one person.
//
//   0. collect identity first, before any DM data goes: the user id and every name we have for them
//      (conversation cache authors, the guild directory, DM state, watches, her DM handle unless it
//      is a `user-<tail>` placeholder). The names are stored with the queued scrub, so a scrub that
//      runs later (a restart, the DM rate limit) still knows them. Names are split: `names` only
//      this person has and `sharedNames` (another member or a waifu has them, a note marked as
//      someone else's is headed by them, or they are weak: three characters or fewer, or a generic
//      or common chat word). Only the id and the unique names with word boundaries ("removable")
//      ever remove or blank text (steps 3 and 5); every other match is listed for review. The model
//      is told every name (steps 2 and 4). Matching is whole-word with Latin diacritics, stroke
//      letters and ligatures folded both ways (José / jose, Søren / soren);
//   1. DM data (the caller: `dmForget` / `forgetUser`; the owner's forget also records
//      `user/people/forgotten.json`);
//   2. summary without the person: her turn is aborted, the compaction summary is written with no
//      kept turns and every name listed for omission (empty on failure); the new epoch waits
//      (`pendingEpochStart`) while the per-waifu lock is held;
//   3. other state: their wakes and pending notices, watches from the person or bound to their DM
//      or to words naming them, her DM read cursor and handle, maintenance.jsonl and review lines,
//      the host's recent web queries naming them, and her slice of the Living cast archive.
//      Someone else's wake that names them keeps its place and loses the quote; her reminder or
//      watch note naming them becomes `(removed)`;
//   4. notes scrub: a maintenance session told to remove everything about the person (a failed
//      session keeps the scrub queued, so it runs again; without a model it is skipped, with one
//      review line, and the scrub completes);
//   5. start the epoch (MEMORY.md re-read, places re-listed, every old epoch log deleted) and verify:
//      a note marked as the person's own (`<!-- user:<id> -->`), or a `people/` note whose heading is
//      a name only they have, is deleted whole (with its MEMORY.md links); a `people/` note headed by
//      a shared name is listed for review. Then notes, summary and the new system snapshot are
//      searched: id lines are removed; a bullet or heading naming them by a removable name goes
//      whole (a removed heading lists the rest of the note for review), prose loses the sentences
//      that name them; inside a note marked as someone else's (or its MEMORY.md line) a name is
//      only listed; other matches are listed as needsReview (persisted, without repeats, in
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

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../backend/logger.js";
import { listWaifus } from "../orchestration/stores/config.js";
import { readDmFloor, readDmState } from "../orchestration/dm/dmStore.js";
import { queuePendingScrub, scrubForgetRecordCopies, type PendingScrub, type PendingScrubSource } from "../orchestration/dm/forgotten.js";
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
import { DM_REDACTED, isDmPlaceKey, isDmPlaceRef } from "./lifeView.js";
import { runNotesSession, scrubInstruction } from "./maintenance.js";
import { markedUserIds, MEMORY_INDEX, Notes } from "./notes.js";
import { lifeDir } from "./paths.js";
import { collectPlaces, dropPlaceHandles } from "./places.js";
import { scrubSearchUsage } from "./search.js";
import { foldName, hasNoWordBoundaries, isGenericName, isWeakName, namesSomeone } from "./text.js";
import { REMOVED_TEXT, scrubWakeQueue } from "./wakeQueue.js";

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

/** A line a forget only listed for the owner. `private`: it came from a private chat (D14). */
export type ReviewLine = { where: string; line: string; private?: true };

/**
 * A review line is private (D14) when it came from her summary or her wake queue (previews quote
 * other people's messages, DMs among them), from a watch bound to a DM, or when it names a DM place.
 * Private lines are shown only with a local `includePrivate`.
 */
export function isPrivateReviewLine(item: { where?: unknown; line?: unknown; private?: unknown }): boolean {
  return item.private === true || item.where === "summary" || item.where === "wakes" || isDmPlaceRef(item.line);
}

/** The line as a view without private content: a private line keeps its place and loses its text. */
export function withoutPrivateReview<T extends ReviewLine>(item: T): T {
  return isPrivateReviewLine(item) ? { ...item, line: DM_REDACTED, private: true } : item;
}

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

/** Every name of the identity the model is told about (steps 2 and 4): unique and shared, never a generic word. */
export function scrubNames(identity: ForgetIdentity): string[] {
  return [...identity.names, ...identity.sharedNames].filter((name) => !isGenericName(name));
}

/**
 * The names that remove or blank text (steps 3 and 5): the unique ones, except a name in a script
 * without word boundaries (はな also matches はなし), whose matches are only listed for review.
 */
export function removableNames(identity: ForgetIdentity): string[] {
  return identity.names.filter((name) => !hasNoWordBoundaries(name) && !isWeakName(name));
}

/** The names whose matches are only listed for review: shared or weak ones, and unique ones without word boundaries. */
function reviewNames(identity: ForgetIdentity): string[] {
  const removable = new Set(removableNames(identity));
  return [...identity.sharedNames, ...identity.names.filter((name) => !removable.has(name))];
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
  // A note marked as someone else's (`<!-- user:<other id> -->`) is headed by their name: two
  // people called Kevin share the name, so forgetting one never removes text by it.
  for (const [notePath, text] of await new Notes(storage, waifu.id).readAll().catch(() => new Map<string, string>())) {
    if (notePath === MEMORY_INDEX) continue;
    const marked = markedUserIds(text);
    if (marked.length > 0 && !marked.includes(userId)) add("others", headingOf(text));
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
    return updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, summary: null, pendingEpochStart: true, pendingEpochReason: "forget" as const }));
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
 * Step 3: wakes, notices, watches, reminders, DM cursor and handle, maintenance lines, review
 * lines, recent web queries and her slice of the archive. What the person owns goes (their wakes,
 * their watches); someone else's entry that names them for certain (the id or a removable name)
 * keeps its place and loses the text (a wake's preview, a reminder's or watch's note). A shared or
 * weak name never removes anything: its matches are listed for review (`review`). `dmOnly`
 * (`/forget conversation`): only what belongs to the DM with the person (wakes and watches there,
 * the cursor at the floor).
 */
export async function scrubOtherState(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, o: { dmOnly?: boolean; review?: (item: ReviewLine) => void } = {}): Promise<number> {
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
  const names = removableNames(identity);
  const mentions = (text: string) => mentionsPerson(text, identity.userId, names);
  const uncertain = reviewNames(identity).filter((name) => !isGenericName(name));
  const review = (where: string) => (text: string, dm = false) => {
    if (o.review && uncertain.some((name) => namesSomeone(text, name))) o.review({ where, line: text.trim().slice(0, 300), ...(dm ? { private: true as const } : {}) });
  };
  let removed = await scrubWakeQueue(deps.storage, waifu.id, { userId: identity.userId, placeKeys: new Set([dmKey]), mentions, review: review("wakes") });
  await updateLifeState(deps.storage, waifu.id, (current) => {
    const pendingNotices = current.pendingNotices.filter((notice) => !mentions(notice));
    removed += current.pendingNotices.length - pendingNotices.length;
    // `scrubbedAt` loses what is past the DM forget window here too (an owner forget adds nothing).
    return { ...current, pendingNotices, scrubbedAt: recentScrubs(current.scrubbedAt, deps.now()) };
  });
  await updateLifeFile(deps.storage, waifu.id, "watches", (file) => {
    // A watch goes when its word names the person ("kevin's exam" for Kevin). A word that is only a
    // part of one of their names ("bake sale" in "Kevin from the Bake Sale") may be anyone's: listed.
    const namesThem = (word: string) => names.some((name) => namesSomeone(word, name));
    const partOfName = (word: string) => names.some((name) => namesSomeone(name, word));
    const watches = file.watches
      .filter((watch) => !watch.bindings.some((binding) => binding.fromUserId === identity.userId || binding.placeKey === dmKey || (binding.words ?? []).some(namesThem)))
      .map((watch) => {
        // A watch bound to a DM is private (D14): its review lines are too.
        const dm = watch.bindings.some((binding) => isDmPlaceKey(binding.placeKey));
        for (const binding of watch.bindings) {
          for (const word of binding.words ?? []) if (o.review && partOfName(word)) o.review({ where: "watches", line: word.trim().slice(0, 300), ...(dm ? { private: true as const } : {}) });
        }
        if (mentions(watch.note)) {
          removed += 1;
          return { ...watch, note: REMOVED_TEXT };
        }
        review("watches")(watch.note, dm);
        for (const binding of watch.bindings) for (const word of binding.words ?? []) if (!partOfName(word)) review("watches")(word, dm);
        return watch;
      });
    removed += file.watches.length - watches.length;
    return { ...file, watches };
  });
  // A reminder is hers: it stays and loses the text that names the person.
  await updateLifeFile(deps.storage, waifu.id, "schedule", (file) => {
    const reminders = file.reminders.map((reminder) => {
      if (mentions(reminder.note)) {
        removed += 1;
        return { ...reminder, note: REMOVED_TEXT };
      }
      review("reminders")(reminder.note);
      return reminder;
    });
    return { ...file, reminders };
  });
  removed += await scrubNeedsReview(deps.storage, waifu.id, mentions);
  // Her DM cursor goes whole: the conversation is gone, and the floor holds on the read path.
  await setReadCursor(deps.storage, waifu.id, dmKey, undefined, deps.now());
  removed += await dropPlaceHandles(deps.storage, waifu.id, dmKey);
  removed += await scrubMaintenanceReports(deps.storage, waifu.id, (line) => mentions(line));
  removed += await scrubSearchUsage(deps.storage, mentions);
  // Her slice of the archive is best effort: a file it cannot remove never stops her scrub (the
  // owner's forget job retries the whole archive and raises a notice when it gives up).
  try {
    const archived = await scrubArchive(deps.storage.dataRoot, { userId: identity.userId, names: identity.names, avoidNames: identity.sharedNames, waifuId: waifu.id, logger: deps.logger });
    removed += archived.removed;
  } catch (error) {
    deps.logger.warn("Her slice of the Living cast archive could not be scrubbed", { category: "life", waifuId: waifu.id, code: (error as NodeJS.ErrnoException)?.code ?? "error" });
  }
  // The kept copies of her unreadable pending-scrubs file lose the person too.
  removed += await scrubForgetRecordCopies(deps.storage, { userId: identity.userId, carries: mentions, waifuId: waifu.id }).catch(() => 0);
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
 * removable name goes whole (a removed heading lists the note for review), prose loses the
 * sentences that name them; shared-name matches are listed for review. `reviewOnly` (a note marked
 * as someone else's) and `protectedLine` (a `MEMORY.md` line linking such a note) only list name
 * matches for review: the id is proof, a name there is not.
 */
export function scrubText(
  text: string,
  identity: ForgetIdentity,
  where: string,
  out: Verify,
  o: { reviewOnly?: boolean; protectedLine?: (line: string) => boolean } = {}
): string {
  const kept: string[] = [];
  const removable = removableNames(identity);
  const uncertain = reviewNames(identity);
  const unique = (line: string) => removable.some((name) => namesSomeone(line, name));
  for (const line of text.split("\n")) {
    if (line.includes(identity.userId)) {
      out.removedLines += 1;
      continue;
    }
    if (unique(line) && (o.reviewOnly || o.protectedLine?.(line))) {
      review(out, { where, line: line.trim().slice(0, 300) });
      kept.push(line);
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
    if (uncertain.some((name) => namesSomeone(line, name))) review(out, { where, line: line.trim().slice(0, 300) });
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
  const state = await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, pendingEpochStart: true, pendingEpochReason: "forget" as const }));
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
  // Notes marked as someone else's: a name match there (or in the index line linking one) is
  // listed for review, never removed (two people may share the name).
  const othersNotes = [...all].flatMap(([notePath, text]) => {
    const marked = markedUserIds(text);
    return notePath !== MEMORY_INDEX && marked.length > 0 && !marked.includes(identity.userId) ? [notePath] : [];
  });
  const linksOthersNote = (line: string) => othersNotes.some((notePath) => line.includes(`](${notePath})`));
  for (const [notePath, text] of all) {
    const scrubbed = scrubText(text, identity, `notes/${notePath}`, out, notePath === MEMORY_INDEX ? { protectedLine: linksOthersNote } : { reviewOnly: othersNotes.includes(notePath) });
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
    const memory = scrubText(snapshot.memoryIndex, identity, "system prompt", out, { protectedLine: linksOthersNote });
    const places = scrubText(snapshot.places, identity, "system prompt", out);
    if (memory !== snapshot.memoryIndex || places !== snapshot.places || notesChanged) {
      await updateLifeState(deps.storage, waifu.id, (state2) => ({ ...state2, systemSnapshot: state2.systemSnapshot ? { ...state2.systemSnapshot, memoryIndex: memory, places } : null }));
    }
  }
  return out;
}

export const NEEDS_REVIEW_FILE = "needs-review.json";

const reviewKey = (item: unknown): string => {
  const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  return JSON.stringify([record.where, record.line]);
};

async function updateNeedsReview(storage: StorageService, waifuId: string, transform: (items: unknown[]) => unknown[]): Promise<void> {
  const relative = path.join(lifeDir(waifuId), NEEDS_REVIEW_FILE);
  await storage.withLocks([`life-needs-review:${waifuId}`], async () => {
    let raw: string;
    try {
      raw = await readFile(storage.dataPath(relative), "utf8");
    } catch {
      raw = "";
    }
    let items: unknown[] = [];
    try {
      const parsed = JSON.parse(raw) as { items?: unknown };
      if (Array.isArray(parsed.items)) items = parsed.items;
    } catch {
      // missing or unreadable: start over (the lines are hints, not records)
    }
    const next = transform(items);
    if (raw && JSON.stringify(next) === JSON.stringify(items)) return;
    if (!raw && next.length === 0) return;
    await atomicWriteJson(storage.dataPath(relative), { items: next });
  });
}

/**
 * Review lines for the owner (`life/needs-review.json`, newest 200; the dashboard shows them in
 * L3). A line already listed (same place, same text) moves to the end instead of repeating.
 */
export async function recordNeedsReview(storage: StorageService, waifuId: string, at: Date, source: string, lines: readonly ReviewLine[]): Promise<void> {
  if (lines.length === 0) return;
  const fresh = new Map<string, ReviewLine>();
  for (const line of lines) fresh.set(reviewKey(line), line);
  await updateNeedsReview(storage, waifuId, (items) =>
    [
      ...items.filter((item) => !fresh.has(reviewKey(item))),
      ...[...fresh.values()].map((line) => ({ at: at.toISOString(), source, ...line, ...(isPrivateReviewLine(line) ? { private: true } : {}) }))
    ].slice(-MAX_REVIEW_FILE)
  );
}

/** A review line as the dashboard shows it: `id` (a hash of where + line) names it for dismissal. */
export type NeedsReviewItem = { id: string; at: string; source: string; where: string; line: string; private?: true };

function reviewItemId(item: unknown): string {
  return createHash("sha256").update(reviewKey(item)).digest("hex").slice(0, 16);
}

/** The owner's review lines (newest last). A missing or unreadable file reads as none. */
export async function readNeedsReview(storage: StorageService, waifuId: string): Promise<NeedsReviewItem[]> {
  let raw: string;
  try {
    raw = await readFile(storage.dataPath(path.join(lifeDir(waifuId), NEEDS_REVIEW_FILE)), "utf8");
  } catch {
    return [];
  }
  let items: unknown[] = [];
  try {
    const parsed = JSON.parse(raw) as { items?: unknown };
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch {
    return [];
  }
  return items.flatMap((item): NeedsReviewItem[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.where !== "string" || typeof record.line !== "string") return [];
    return [
      {
        id: reviewItemId(item),
        at: typeof record.at === "string" ? record.at : "",
        source: typeof record.source === "string" ? record.source : "",
        where: record.where,
        line: record.line,
        // A line recorded before lines were marked is read by the same rule.
        ...(isPrivateReviewLine(record) ? { private: true as const } : {})
      }
    ];
  });
}

/** The owner dismissed a review line. Returns whether it was there. */
export async function dismissNeedsReview(storage: StorageService, waifuId: string, id: string): Promise<boolean> {
  let removed = false;
  await updateNeedsReview(storage, waifuId, (items) => {
    const kept = items.filter((item) => reviewItemId(item) !== id);
    removed = kept.length !== items.length;
    return kept;
  });
  return removed;
}

/** Forget (step 3): earlier review lines that carry the person go. Returns how many. */
async function scrubNeedsReview(storage: StorageService, waifuId: string, carries: (text: string) => boolean): Promise<number> {
  let removed = 0;
  await updateNeedsReview(storage, waifuId, (items) => {
    const kept = items.filter((item) => !Object.values(item && typeof item === "object" ? item : {}).some((value) => typeof value === "string" && carries(value)));
    removed = items.length - kept.length;
    return kept;
  });
  return removed;
}

export type ScrubPersonOutcome = ForgetScrubResult & { complete: boolean };

/** The one review line a scrub without a notes session leaves (she has no model). */
export const NOTES_SCRUB_SKIPPED = "(no notes session ran: she has no model; the checks below ran, but read her notes for anything else about them)";

/**
 * Steps 2–5 for one waifu (the caller holds her life lock and has aborted her turn). `complete`
 * is false when the notes scrub (step 4) failed: the caller keeps the scrub queued. Without a model
 * there is no notes session to wait for: it is recorded as skipped (one review line) and the
 * scrub completes, so it is not retried at every start.
 */
export async function scrubPerson(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, o: { signal?: AbortSignal; source: string }): Promise<ScrubPersonOutcome> {
  await summaryWithoutPerson(deps, waifu, identity, o.signal);
  const stateReview: ReviewLine[] = [];
  await scrubOtherState(deps, waifu, identity, { review: (item) => stateReview.push(item) });
  const model = lifeModelOf(deps, waifu);
  let complete = true;
  if (model) {
    const session = await runNotesSession(deps, { waifu, model, instruction: scrubInstruction({ userId: identity.userId, names: scrubNames(identity) }), kind: "scrub", ...(o.signal ? { signal: o.signal } : {}) });
    complete = session.ok;
    if (!session.ok) deps.logger.warn("Forget notes scrub failed; it stays queued and runs again", { category: "life", waifuId: waifu.id, error: session.error });
  }
  const verify = await startEpochAndVerify(deps, waifu, identity);
  if (!model) verify.needsReview.unshift({ where: "notes", line: NOTES_SCRUB_SKIPPED });
  for (const item of stateReview) if (verify.needsReview.length < MAX_REVIEW_LINES) verify.needsReview.push(item);
  const now = deps.now();
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
    ...(!model ? { notesScrub: "skipped" } : complete ? {} : { notesScrub: "pending" })
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
