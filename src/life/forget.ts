// Forget in a life (Living cast spec §7.5): a best-effort scrub of one person.
//
//   0. collect identity first: the user id and every name we have for them (conversation cache
//      authors, the guild directory, DM state, watches, her DM handle);
//   1. DM data (the caller: `dmForget` / `forgetUser`; the owner's forget also records
//      `user/people/forgotten.json`);
//   2. summary without the person: abort her turn, write the compaction summary with no kept turns
//      and the person listed for omission (empty on failure); the new epoch waits (`pendingEpochStart`)
//      while the per-waifu lock is held;
//   3. other state: wakes and pending notices, watches from the person, reminder notes, her DM read
//      cursor and handle, maintenance.jsonl lines;
//   4. notes scrub: a maintenance session told to remove everything about the person;
//   5. start the epoch (MEMORY.md re-read, places re-listed, every old epoch log deleted) and verify:
//      notes, summary and the new system snapshot are searched for the id and each collected name
//      (≥ 3 characters, whole word). Id matches are removed; name-only matches are removed when the
//      name is unambiguous (no other known member or waifu has it), otherwise listed as needsReview.
//
// `/forget conversation` runs steps 0–2 only. A DM user's `/forget everything` runs step 2 at most
// once per 6 hours per user; later requests queue steps 2–5 as a pending scrub (§7.3).
//
// The owner's forget-user first queues an `owner_forget` pending scrub for every waifu with a life
// or notes, then runs and clears them. A scrub that fails, or that could not run because no cast
// runtime was up (Discord offline), stays queued and runs when her life next starts.

import type { Logger } from "../backend/logger.js";
import { listWaifus } from "../orchestration/stores/config.js";
import { readDmFloor, readDmState } from "../orchestration/dm/dmStore.js";
import { queuePendingScrub, type PendingScrub } from "../orchestration/dm/forgotten.js";
import type { WaifuConfig } from "../shared/schemas/domain.js";
import type { LifeState } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { conversationKey } from "../orchestration/context/keys.js";
import { memberDisplayName } from "../discord/directoryView.js";
import { compactLife, currentHarness, startEpoch } from "./compaction.js";
import type { LifeDeps } from "./deps.js";
import { lifeStateExists, readLifeFile, readLifeLog, readLifeState, scrubMaintenanceReports, setReadCursor, updateLifeFile, updateLifeState, appendMaintenanceReport } from "./lifeStore.js";
import { lifeModelOf } from "./lifeLoop.js";
import { runNotesSession, scrubInstruction } from "./maintenance.js";
import { Notes } from "./notes.js";
import { collectPlaces, dropPlaceHandles } from "./places.js";
import { normalizeName, wordBoundaryIncludes } from "./text.js";
import { scrubWakeQueue } from "./wakeQueue.js";

export const DM_SCRUB_RATE_MS = 6 * 3_600_000;

export type ForgetIdentity = {
  userId: string;
  /** Names that only this person has (searched and removed). */
  names: string[];
  /** Names another known member or a waifu also has (matches go to needsReview). */
  sharedNames: string[];
};

export type ForgetScrubResult = {
  waifuId: string;
  removedLines: number;
  removedSentences: number;
  needsReview: Array<{ where: string; line: string }>;
  /** Steps 2–5 were queued as a pending scrub (the DM rate limit). */
  queued?: boolean;
};

/** Waifus with something of a person to scrub: a life or notes. */
export async function waifusWithLife(storage: StorageService): Promise<WaifuConfig[]> {
  const out: WaifuConfig[] = [];
  for (const waifu of await listWaifus(storage).catch(() => [] as WaifuConfig[])) {
    if ((await lifeStateExists(storage, waifu.id)) || (await new Notes(storage, waifu.id).exists())) out.push(waifu);
  }
  return out;
}

/** The owner's forget-user, before any scrub runs: one `owner_forget` pending scrub per life. */
export async function queueOwnerScrubs(storage: StorageService, userId: string, at: Date, o: { logger?: Pick<Logger, "warn"> } = {}): Promise<Array<{ waifu: WaifuConfig; scrub: PendingScrub }>> {
  const queued: Array<{ waifu: WaifuConfig; scrub: PendingScrub }> = [];
  for (const waifu of await waifusWithLife(storage)) {
    await queuePendingScrub(storage, waifu.id, userId, at, { source: "owner_forget", ...(o.logger ? { logger: o.logger } : {}) });
    queued.push({ waifu, scrub: { userId, at: at.toISOString(), source: "owner_forget" } });
  }
  return queued;
}

/** Step 0: the person's id and names. */
export async function collectIdentity(deps: LifeDeps, waifu: WaifuConfig, userId: string): Promise<ForgetIdentity> {
  const places = await collectPlaces(deps.storage, waifu.id);
  const mine = new Set<string>();
  const others = new Set<string>();
  const add = (set: Set<string>, name: string | undefined) => {
    const trimmed = name?.trim();
    if (trimmed && trimmed.length >= 3) set.add(trimmed);
  };
  for (const place of places) {
    for (const message of deps.conversations.bufferedMessages(place.ref)) {
      add(message.authorId === userId ? mine : others, message.authorName);
    }
  }
  for (const guildId of new Set(places.flatMap((place) => (place.guildId ? [place.guildId] : [])))) {
    for (const member of await deps.directory.members(guildId).catch(() => [])) {
      const target = member.userId === userId ? mine : others;
      add(target, memberDisplayName(member));
      add(target, member.username);
      add(target, member.globalDisplayName);
    }
  }
  const dmState = await readDmState(deps.storage, userId, waifu.id).catch(() => undefined);
  add(mine, dmState?.userDisplayName);
  for (const watch of (await readLifeFile(deps.storage, waifu.id, "watches")).watches) {
    for (const binding of watch.bindings) if (binding.fromUserId === userId) add(mine, binding.fromName);
  }
  const dmKey = conversationKey({ kind: "dm", waifuId: waifu.id, userId });
  const handles = await readLifeFile(deps.storage, waifu.id, "handles");
  for (const [handle, key] of Object.entries(handles.handles)) {
    if (key === dmKey && handle.startsWith("dm/")) add(mine, handle.slice(3).replace(/-\d+$/, "").replace(/-/g, " "));
  }
  for (const other of await listWaifus(deps.storage).catch(() => [])) {
    add(others, other.name);
    add(others, other.displayName);
  }
  const otherKeys = new Set([...others].map(normalizeName));
  const names: string[] = [];
  const sharedNames: string[] = [];
  for (const name of mine) (otherKeys.has(normalizeName(name)) ? sharedNames : names).push(name);
  return { userId, names: [...new Set(names)], sharedNames: [...new Set(sharedNames)] };
}

function mentionsPerson(text: string, identity: ForgetIdentity, o: { shared?: boolean } = {}): boolean {
  if (text.includes(identity.userId)) return true;
  const names = o.shared ? [...identity.names, ...identity.sharedNames] : identity.names;
  return names.some((name) => wordBoundaryIncludes(text, name));
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
  const outcome = await compactLife(deps, {
    waifu,
    state,
    lines,
    summaryRoute: state.modelRoute ? (deps.catalog().models.find((entry) => entry.providerId === state.modelRoute!.providerId && entry.modelId === state.modelRoute!.modelId) ?? model) : model,
    ...(state.modelRoute?.effort ? { effort: state.modelRoute.effort } : {}),
    nextHarness: harness,
    reason: "forget",
    keepTurns: 0,
    omit: { deleted: [], people: identity.names.length > 0 ? identity.names : [`<@${identity.userId}>`] },
    deferEpoch: true,
    emptySummaryOnFailure: true,
    ...(signal ? { signal } : {})
  });
  // The summary is checked by the verification step too; a line naming the id never survives.
  return outcome.state;
}

/** Step 3: wakes, notices, watches, reminders, DM cursor and handle, maintenance lines. */
export async function scrubOtherState(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity): Promise<number> {
  const dmKey = conversationKey({ kind: "dm", waifuId: waifu.id, userId: identity.userId });
  const mentions = (text: string) => mentionsPerson(text, identity);
  let removed = await scrubWakeQueue(deps.storage, waifu.id, { userId: identity.userId, placeKeys: new Set([dmKey]), mentions });
  await updateLifeState(deps.storage, waifu.id, (current) => {
    const pendingNotices = current.pendingNotices.filter((notice) => !mentions(notice));
    removed += current.pendingNotices.length - pendingNotices.length;
    return { ...current, pendingNotices };
  });
  await updateLifeFile(deps.storage, waifu.id, "watches", (file) => {
    const watches = file.watches
      .filter((watch) => !watch.bindings.some((binding) => binding.fromUserId === identity.userId || binding.placeKey === dmKey))
      .map((watch) => (mentions(watch.note) ? { ...watch, note: "" } : watch));
    removed += file.watches.length - watches.length;
    return { ...file, watches };
  });
  await updateLifeFile(deps.storage, waifu.id, "schedule", (file) => {
    const reminders = file.reminders.filter((reminder) => !mentions(reminder.note));
    removed += file.reminders.length - reminders.length;
    return { ...file, reminders };
  });
  const floor = await readDmFloor(deps.storage, identity.userId, waifu.id).catch(() => undefined);
  await setReadCursor(deps.storage, waifu.id, dmKey, floor, deps.now());
  removed += await dropPlaceHandles(deps.storage, waifu.id, dmKey);
  removed += await scrubMaintenanceReports(deps.storage, waifu.id, (line) => mentions(line));
  return removed;
}

type Verify = { removedLines: number; removedSentences: number; needsReview: Array<{ where: string; line: string }> };

/** Step 5's text pass: id lines removed; unambiguous name lines removed (sentence by sentence); shared names reviewed. */
export function scrubText(text: string, identity: ForgetIdentity, where: string, out: Verify): string {
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(identity.userId)) {
      out.removedLines += 1;
      continue;
    }
    if (identity.names.some((name) => wordBoundaryIncludes(line, name))) {
      const sentences = line.split(/(?<=[.!?])\s+/);
      const remaining = sentences.filter((sentence) => !identity.names.some((name) => wordBoundaryIncludes(sentence, name)));
      if (remaining.length === 0 || sentences.length === 1 || /^\s*-\s*\[/.test(line)) {
        out.removedLines += 1;
        continue;
      }
      out.removedSentences += sentences.length - remaining.length;
      kept.push(remaining.join(" "));
      continue;
    }
    if (identity.sharedNames.some((name) => wordBoundaryIncludes(line, name))) out.needsReview.push({ where, line: line.trim().slice(0, 300) });
    kept.push(line);
  }
  return kept.join("\n");
}

/** Step 5: start the epoch and verify notes, summary and the snapshot. */
export async function startEpochAndVerify(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity): Promise<Verify> {
  const out: Verify = { removedLines: 0, removedSentences: 0, needsReview: [] };
  const notes = new Notes(deps.storage, waifu.id);
  let notesChanged = false;
  for (const [path, text] of await notes.readAll()) {
    const scrubbed = scrubText(text, identity, `notes/${path}`, out);
    if (scrubbed !== text) {
      await notes.write(path, scrubbed);
      notesChanged = true;
    }
  }
  const state = await readLifeState(deps.storage, waifu.id);
  if (state.summary) {
    const summary = scrubText(state.summary, identity, "summary", out);
    if (summary !== state.summary) await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, summary: summary.trim() || null }));
  }
  const model = lifeModelOf(deps, waifu);
  if (model) {
    const harness = await currentHarness(deps, waifu, model);
    const current = await readLifeState(deps.storage, waifu.id);
    const started = await startEpoch(deps, waifu.id, { harness, summary: current.summary, kept: [], readIds: [], reason: "forget", summarized: true, strippedBlocks: 0, pruneAll: true });
    // The new snapshot is checked too; a match means the system prompt is rebuilt after the fix.
    const snapshot = started.systemSnapshot;
    if (snapshot) {
      const memory = scrubText(snapshot.memoryIndex, identity, "system prompt", out);
      const places = scrubText(snapshot.places, identity, "system prompt", out);
      if (memory !== snapshot.memoryIndex || places !== snapshot.places || notesChanged) {
        await updateLifeState(deps.storage, waifu.id, (state2) => ({ ...state2, systemSnapshot: state2.systemSnapshot ? { ...state2.systemSnapshot, memoryIndex: memory, places } : null }));
      }
    }
  } else {
    await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, pendingEpochStart: true }));
  }
  return out;
}

/** Steps 2–5 for one waifu (the caller holds her life lock and has aborted her turn). */
export async function scrubPerson(deps: LifeDeps, waifu: WaifuConfig, identity: ForgetIdentity, o: { signal?: AbortSignal; source: string }): Promise<ForgetScrubResult> {
  await summaryWithoutPerson(deps, waifu, identity, o.signal);
  await scrubOtherState(deps, waifu, identity);
  const model = lifeModelOf(deps, waifu);
  if (model) {
    await runNotesSession(deps, { waifu, model, instruction: scrubInstruction({ userId: identity.userId, names: identity.names }), kind: "scrub", ...(o.signal ? { signal: o.signal } : {}) });
  }
  const verify = await startEpochAndVerify(deps, waifu, identity);
  const now = deps.now();
  await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, scrubbedAt: { ...current.scrubbedAt, [identity.userId]: now.toISOString() } }));
  // The report keeps counts only: no names, no id.
  await appendMaintenanceReport(deps.storage, waifu.id, {
    at: now.toISOString(),
    kind: "forget",
    source: o.source,
    removedLines: verify.removedLines,
    removedSentences: verify.removedSentences,
    needsReview: verify.needsReview.length
  });
  deps.logger.info("Life forget scrub done", { category: "life", waifuId: waifu.id, removedLines: verify.removedLines, removedSentences: verify.removedSentences, needsReview: verify.needsReview.length });
  return { waifuId: waifu.id, ...verify };
}
