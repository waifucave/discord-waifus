// The per-waifu wake queue (Living cast spec §4.6): `user/waifus/<id>/life/wakes.json`.
//
// - `immediate`: wakes waiting for her next turn (≤ 200 entries; beyond that, a wake for a place
//   that already has an entry merges into it as a counter).
// - `deferred`: what arrived while she slept or was over her daily budget: per-place counters (with
//   the morning summary's message lines, §23: a DM's messages and a room's messages that addressed
//   her, the newest 50 per place) plus every reminder and watch match with its note. Never dropped;
//   released as one `morning` wake.
// - `held`: wakes held while she is busy (§21.4), released together at her next phone check or the
//   busy block's end (scheduler); they never start a turn while held.
// - `userWakes`: the per-user wake limit's last-hour timestamps (§4.4 guard 3); `quiet`: the
//   "+N more from Kevin" lines that ride along with the next turn without starting one.

import { randomBytes } from "node:crypto";
import type { DeferredPlace, Wake, WakeMessage, WakeQueue, WakeReason } from "../shared/schemas/life.js";
import type { StorageService } from "../storage/storageService.js";
import { readLifeFile, updateLifeFile } from "./lifeStore.js";
import { joinMessages, messagesOf } from "./wakeMessages.js";

export const MAX_IMMEDIATE_WAKES = 200;
/** At most this many held wakes (§21.4): past it a wake joins one of the same place, else the oldest goes. */
export const MAX_HELD_WAKES = 200;
/** What forget leaves of her own note (a reminder's, a watch's) that named the person. */
export const REMOVED_TEXT = "(removed)";
const HOUR_MS = 3_600_000;

/** Wake reasons that count as direct mentions in the morning batch. */
export const MENTION_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "role", "everyone"]);
/** Direct wakes (§5.2 unsent-reply check). */
export const DIRECT_REASONS: ReadonlySet<WakeReason> = new Set(["mention", "name", "role", "dm", "owner"]);

export function newWakeId(): string {
  return `w${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

function mergeInto(existing: Wake, wake: Wake): Wake {
  const reasons = [...(existing.reasons ?? [existing.reason])];
  if (!reasons.includes(wake.reason)) reasons.push(wake.reason);
  // Still a chime-in only while no plain detector pick joined it.
  const { chimeIn, ...rest } = existing;
  // Both wakes' messages, each line keeping its own reasons (§20).
  const joined = joinMessages([messagesOf(existing), messagesOf(wake)], (existing.earlier ?? 0) + (wake.earlier ?? 0));
  return {
    ...rest,
    ...(joined.messages.length > 0 ? { messages: joined.messages } : {}),
    ...(joined.earlier > 0 ? { earlier: joined.earlier } : {}),
    ...(chimeIn === true && (wake.reason !== "detector" || wake.chimeIn === true) ? { chimeIn: true } : {}),
    reasons,
    count: (existing.count ?? 1) + (wake.count ?? 1),
    ...(wake.messageId ? { messageId: wake.messageId } : {}),
    ...(wake.preview ? { preview: wake.preview } : {}),
    ...(wake.fromUserId ? { fromUserId: wake.fromUserId } : {}),
    ...(wake.fromName ? { fromName: wake.fromName } : {}),
    ...(wake.forAll ? { forAll: true } : {}),
    // A released wake keeps saying why it arrives now (§21.4), whichever of the two carried it.
    ...(!existing.released && wake.released ? { released: wake.released } : {}),
    at: wake.at
  };
}

/** Adds a wake to `immediate` (pure); a wake whose id is already queued (or held) is not added twice. */
export function withImmediate(queue: WakeQueue, wake: Wake): WakeQueue {
  if (queue.immediate.some((entry) => entry.id === wake.id) || queue.held.some((entry) => entry.id === wake.id)) return queue;
  if (queue.immediate.length >= MAX_IMMEDIATE_WAKES) {
    const index = queue.immediate.findIndex((entry) => entry.placeKey !== undefined && entry.placeKey === wake.placeKey);
    if (index >= 0) {
      const immediate = [...queue.immediate];
      immediate[index] = mergeInto(immediate[index]!, wake);
      return { ...queue, immediate };
    }
  }
  return { ...queue, immediate: [...queue.immediate, wake] };
}

export async function enqueueWake(storage: StorageService, waifuId: string, wake: Wake): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => withImmediate(queue, wake));
}

/**
 * A turn's wakes go back in front of the queue (it was interrupted, compacted away or never got to
 * answer them); ids already queued are not added twice.
 */
export async function requeueWakes(storage: StorageService, waifuId: string, wakes: readonly Wake[]): Promise<void> {
  if (wakes.length === 0) return;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const queued = new Set(queue.immediate.map((wake) => wake.id));
    let next: WakeQueue = { ...queue, immediate: [] };
    const seen = new Set<string>();
    for (const wake of [...wakes.filter((wake) => !queued.has(wake.id)), ...queue.immediate]) {
      if (seen.has(wake.id)) continue;
      seen.add(wake.id);
      next = withImmediate(next, wake);
    }
    return next;
  });
}

function emptyPlace(): DeferredPlace {
  return { mentions: 0, messages: 0, dms: 0, detector: 0, fromUserIds: [], names: {} };
}

/** Adds a wake to `deferred` (pure): counters for message wakes, the full entry for notes. */
export function withDeferred(queue: WakeQueue, wake: Wake, reason: "sleep" | "budget", now: Date): WakeQueue {
  if (queue.deferred.items.some((item) => item.id === wake.id)) return queue;
  const deferred = {
    ...queue.deferred,
    reason: queue.deferred.reason ?? reason,
    since: queue.deferred.since ?? now.toISOString(),
    places: { ...queue.deferred.places },
    items: [...queue.deferred.items]
  };
  // A `morning` batch deferred again (her budget ran out before she read it) is carried whole.
  // A DM wake that carried a watch match (§16.5) keeps its note too.
  const keepsNote = wake.reason === "reminder" || wake.reason === "watch" || wake.reason === "watch_timeout" || wake.reason === "owner" || wake.reason === "followup" || wake.reason === "morning" || wake.reasons?.includes("watch") === true;
  if (keepsNote) deferred.items.push(wake);
  if (wake.placeKey && (wake.reason !== "reminder" && wake.reason !== "followup")) {
    const place = { ...(deferred.places[wake.placeKey] ?? emptyPlace()) };
    const count = wake.count ?? 1;
    if (MENTION_REASONS.has(wake.reason)) place.mentions += count;
    else if (wake.reason === "dm") place.dms += count;
    else if (wake.reason === "detector") place.detector += count;
    if (wake.fromUserId && !place.fromUserIds.includes(wake.fromUserId)) place.fromUserIds = [...place.fromUserIds, wake.fromUserId];
    if (wake.fromUserId && wake.fromName) place.names = { ...place.names, [wake.fromUserId]: wake.fromName };
    // The morning summary's lines (§23): a DM's messages, a room's messages that addressed her.
    const lines = morningLinesOf(wake);
    if (lines.length > 0) {
      const joined = joinMessages([place.lines ?? [], lines], (place.earlier ?? 0) + (isDmKey(wake.placeKey) ? (wake.earlier ?? 0) : 0));
      place.lines = joined.messages;
      if (joined.earlier > 0) place.earlier = joined.earlier;
    }
    deferred.places[wake.placeKey] = place;
  }
  return { ...queue, deferred };
}

const isDmKey = (placeKey: string) => placeKey.startsWith("dm_");

/**
 * The messages of a deferred wake the morning summary lists (§23): in a DM every one, in a room
 * those that addressed her (their own reasons include a mention, reply, her name, a role or
 * `@everyone`). A line keeps id, sender, preview and reasons (a watch match has its own line).
 */
export function morningLinesOf(wake: Wake): WakeMessage[] {
  if (!wake.placeKey) return [];
  const dm = isDmKey(wake.placeKey);
  return messagesOf(wake).flatMap((message) => {
    if (!dm && !message.reasons.some((reason) => MENTION_REASONS.has(reason))) return [];
    const { matched: _matched, note: _note, ...line } = message;
    return [line];
  });
}

export async function deferWake(storage: StorageService, waifuId: string, wake: Wake, reason: "sleep" | "budget", now: Date): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => withDeferred(queue, wake, reason, now));
}

/**
 * Moves the immediate wakes `keep` rejects into `deferred` (her budget ran out after they were
 * queued, §4.4 guard 5); returns how many immediate wakes remain.
 */
export async function deferImmediate(storage: StorageService, waifuId: string, reason: "sleep" | "budget", now: Date, keep: (wake: Wake) => boolean): Promise<number> {
  let remaining = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const kept = queue.immediate.filter(keep);
    remaining = kept.length;
    if (kept.length === queue.immediate.length) return queue;
    let next: WakeQueue = { ...queue, immediate: kept };
    for (const wake of queue.immediate) if (!keep(wake)) next = withDeferred(next, wake, reason, now);
    // The deferred batch is released by the budget rule (her next local day), whatever paused it first.
    return { ...next, deferred: { ...next.deferred, reason } };
  });
  return remaining;
}

/** Marks the deferred batch as waiting for her budget (it is released on her next local day under budget). */
export async function deferForBudget(storage: StorageService, waifuId: string): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => (queue.deferred.reason === "budget" ? queue : { ...queue, deferred: { ...queue.deferred, reason: "budget" } }));
}

/**
 * Holds a wake while she is busy (§21.4): kept in `held` with `heldUntil` (and the block's `why`)
 * until the scheduler releases it. A wake whose id is already queued anywhere is not added again.
 */
export async function holdWake(storage: StorageService, waifuId: string, wake: Wake): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => withHeld(queue, wake));
}

/** Adds a held wake (pure), within `MAX_HELD_WAKES`. */
export function withHeld(queue: WakeQueue, wake: Wake): WakeQueue {
  if ([...queue.immediate, ...queue.held, ...queue.deferred.items].some((entry) => entry.id === wake.id)) return queue;
  if (queue.held.length >= MAX_HELD_WAKES) {
    const index = queue.held.findIndex((entry) => entry.placeKey !== undefined && entry.placeKey === wake.placeKey);
    if (index >= 0) {
      const held = [...queue.held];
      held[index] = { ...mergeInto(held[index]!, wake), heldUntil: held[index]!.heldUntil ?? wake.heldUntil! } as Wake;
      return { ...queue, held };
    }
    return { ...queue, held: [...queue.held.slice(queue.held.length - MAX_HELD_WAKES + 1), wake] };
  }
  return { ...queue, held: [...queue.held, wake] };
}

/**
 * Held wakes that come due inside her bed time (§21.6c) wait for the morning instead: they move to
 * `deferred` (reason `sleep`). Returns how many moved.
 */
export async function deferHeld(storage: StorageService, waifuId: string, now: Date): Promise<number> {
  let count = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    if (queue.held.length === 0) return queue;
    let next: WakeQueue = { ...queue, held: [] };
    for (const wake of queue.held) {
      const { heldUntil: _until, heldFor: _for, ...rest } = wake;
      next = withDeferred(next, rest, "sleep", now);
      count += 1;
    }
    return next;
  });
  return count;
}

/**
 * Releases held wakes (§21.4): `release` says, for each, how it is released (`undefined` keeps it
 * held). Released wakes go to `immediate` together, each marked with how it was released (the
 * notification's first line). Returns how many were released.
 */
export async function releaseHeld(storage: StorageService, waifuId: string, release: (wake: Wake) => NonNullable<Wake["released"]> | undefined): Promise<number> {
  let count = 0;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    if (queue.held.length === 0) return queue;
    const kept: Wake[] = [];
    let next: WakeQueue = { ...queue, held: [] };
    for (const wake of queue.held) {
      const how = release(wake);
      if (!how) {
        kept.push(wake);
        continue;
      }
      const { heldUntil: _until, heldFor: _for, ...rest } = wake;
      next = withImmediate(next, { ...rest, released: how });
      count += 1;
    }
    return count === 0 ? queue : { ...next, held: kept };
  });
  return count;
}

export function hasDeferred(queue: WakeQueue): boolean {
  return queue.deferred.items.length > 0 || Object.keys(queue.deferred.places).length > 0;
}

/**
 * Moves the deferred batch out (the caller turns it into a `morning` wake). With `expected` (the
 * batch the caller built the wake from, read before), nothing changes when the batch is no longer
 * that one (a wake was deferred meanwhile): `conflict` says so and the caller builds it again.
 */
export async function takeDeferred(
  storage: StorageService,
  waifuId: string,
  toWake: (deferred: WakeQueue["deferred"]) => Wake | undefined,
  expected?: WakeQueue["deferred"]
): Promise<{ wake: Wake | undefined; conflict: boolean }> {
  let released: Wake | undefined;
  let conflict = false;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    if (expected !== undefined && JSON.stringify(queue.deferred) !== JSON.stringify(expected)) {
      conflict = true;
      return queue;
    }
    if (!hasDeferred(queue)) {
      if (queue.deferred.reason === undefined && queue.deferred.since === undefined) return queue;
      return { ...queue, deferred: { places: {}, items: [] } };
    }
    released = toWake(queue.deferred);
    const cleared = { ...queue, deferred: { places: {}, items: [] } };
    return released ? withImmediate(cleared, released) : cleared;
  });
  return { wake: released, conflict };
}

/**
 * The lines of an earlier unread morning batch (pre-rendered) that belong to a forgotten DM or person:
 * every line naming the DM's handle as its place, and with `names` every line naming one of them as
 * its author (`from <name>`). A `· DMs:` header left with no DM line under it goes too.
 */
export function batchWithout(batch: readonly string[], o: { dmHandle?: string | undefined; names?: readonly string[] }): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const handle = o.dmHandle ? new RegExp(`(?:^\\s*· |· )${escape(o.dmHandle)}(?: ·|:|$)`, "iu") : undefined;
  const from = (o.names ?? []).filter(Boolean).map((name) => new RegExp(`(?:^|\\s)from ${escape(name.replace(/"/g, "'"))}(?= ·| "|$)`, "iu"));
  const kept = batch.filter((line) => !(handle?.test(line) || from.some((pattern) => pattern.test(line))));
  return kept.filter((line, index) => line.trim() !== "· DMs:" || /^ {4}· /u.test(kept[index + 1] ?? ""));
}

/**
 * Forget, at once (before the life scrub runs, which a DM user's rate limit can put off until her
 * dream): what waits for her morning from the person goes. Their DM's deferred place and items go
 * whole, and so do their lines in an earlier unread batch carried in `items`; elsewhere (with
 * `everything`) their kept lines and batch lines naming them as author go (the full scrub later
 * also takes quotes that name them).
 */
export async function dropDeferredOf(
  storage: StorageService,
  waifuId: string,
  o: { userId: string; dmKey: string; everything: boolean; dmHandle?: string; names?: readonly string[] }
): Promise<void> {
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const places: Record<string, DeferredPlace> = {};
    for (const [key, place] of Object.entries(queue.deferred.places)) {
      if (key === o.dmKey) continue;
      if (!o.everything || !place.lines) {
        places[key] = place;
        continue;
      }
      const { lines: all, ...rest } = place;
      const lines = all!.filter((line) => line.fromUserId !== o.userId);
      places[key] = { ...rest, ...(lines.length > 0 ? { lines } : {}) };
    }
    const items = queue.deferred.items
      .filter((item) => item.placeKey !== o.dmKey && !(o.everything && item.fromUserId === o.userId && item.reason !== "reminder"))
      .map((item) => {
        if (item.reason !== "morning" || !item.batch) return item;
        const batch = batchWithout(item.batch, { dmHandle: o.dmHandle, ...(o.everything ? { names: o.names ?? [] } : {}) });
        return batch.length === item.batch.length ? item : { ...item, batch };
      });
    const next = { ...queue.deferred, places, items };
    return JSON.stringify(next) === JSON.stringify(queue.deferred) ? queue : { ...queue, deferred: next };
  });
}

/**
 * The immediate wakes and quiet lines, left in the queue. A turn (its start, or a mid-turn fold)
 * records the wakes in her life state first and only then removes them with `takeWakes`, so a crash
 * between the two leaves them in both places (boot repair re-queues the turn's wakes by id, which
 * adds nothing twice) and never in neither.
 */
export async function peekImmediate(storage: StorageService, waifuId: string): Promise<{ wakes: Wake[]; quiet: WakeQueue["quiet"] }> {
  const queue = await readLifeFile(storage, waifuId, "wakes");
  return { wakes: queue.immediate, quiet: queue.quiet };
}

/**
 * Removes wakes a turn recorded (by id) and the quiet lines it showed (a line that grew since keeps
 * the difference).
 */
export async function takeWakes(storage: StorageService, waifuId: string, wakes: readonly Wake[], quiet: WakeQueue["quiet"]): Promise<void> {
  if (wakes.length === 0 && quiet.length === 0) return;
  const ids = new Set(wakes.map((wake) => wake.id));
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const shown = [...quiet];
    const left = queue.quiet.flatMap((line) => {
      const index = shown.findIndex((seen) => seen.userId === line.userId && seen.placeKey === line.placeKey);
      if (index < 0) return [line];
      const [seen] = shown.splice(index, 1);
      return line.count > seen!.count ? [{ ...line, count: line.count - seen!.count }] : [];
    });
    return { ...queue, immediate: queue.immediate.filter((wake) => !ids.has(wake.id)), quiet: left };
  });
}

/** Takes every immediate wake and quiet line at once. */
export async function takeImmediate(storage: StorageService, waifuId: string): Promise<{ wakes: Wake[]; quiet: WakeQueue["quiet"] }> {
  let wakes: Wake[] = [];
  let quiet: WakeQueue["quiet"] = [];
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    wakes = queue.immediate;
    quiet = queue.quiet;
    if (wakes.length === 0 && quiet.length === 0) return queue;
    return { ...queue, immediate: [], quiet: [] };
  });
  return { wakes, quiet };
}

export async function pendingWakeCount(storage: StorageService, waifuId: string): Promise<number> {
  return (await readLifeFile(storage, waifuId, "wakes")).immediate.length;
}

/**
 * §4.4 guard 3: records a direct/detector wake from `userId` unless the last hour already holds
 * `max` of them, in which case the wake becomes a "+N more" line. Returns whether it may start a turn.
 */
export async function admitUserWake(
  storage: StorageService,
  waifuId: string,
  o: { userId: string; name: string; placeKey?: string; max: number; now: Date }
): Promise<boolean> {
  let admitted = true;
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    const cutoff = o.now.getTime() - HOUR_MS;
    const userWakes: Record<string, string[]> = {};
    for (const [user, times] of Object.entries(queue.userWakes)) {
      const recent = times.filter((time) => Date.parse(time) > cutoff);
      if (recent.length > 0) userWakes[user] = recent;
    }
    const recent = userWakes[o.userId] ?? [];
    if (recent.length >= o.max) {
      admitted = false;
      const quiet = [...queue.quiet];
      const index = quiet.findIndex((line) => line.userId === o.userId && line.placeKey === o.placeKey);
      if (index >= 0) quiet[index] = { ...quiet[index]!, count: quiet[index]!.count + 1, name: o.name || quiet[index]!.name };
      else quiet.push({ userId: o.userId, name: o.name || "someone", count: 1, ...(o.placeKey ? { placeKey: o.placeKey } : {}) });
      return { ...queue, userWakes, quiet };
    }
    userWakes[o.userId] = [...recent, o.now.toISOString()];
    return { ...queue, userWakes };
  });
  return admitted;
}

/** Forget (§7.5 step 3): the person's wakes, previews, counters and quiet lines go. Returns how many entries changed. */
export async function scrubWakeQueue(
  storage: StorageService,
  waifuId: string,
  o: {
    userId: string;
    placeKeys: ReadonlySet<string>;
    /** Text that names the person for certain (their id or a name only they have). */
    mentions: (text: string) => boolean;
    /** Every text left in place: the caller lists uncertain matches (shared names) for review. */
    review?: (text: string) => void;
  }
): Promise<number> {
  let removed = 0;
  // Their messages in someone else's wake go; a quote of another message that names them goes (§20).
  const scrubMessages = (list: readonly WakeMessage[]): WakeMessage[] =>
    list.flatMap((message) => {
      if (message.fromUserId === o.userId) return [];
      const kept = { ...message };
      if (o.mentions(kept.preview)) kept.preview = REMOVED_TEXT;
      else o.review?.(kept.preview);
      if (kept.matched !== undefined && o.mentions(kept.matched)) delete kept.matched;
      if (kept.note !== undefined && o.mentions(kept.note)) kept.note = REMOVED_TEXT;
      return [kept];
    });
  await updateLifeFile(storage, waifuId, "wakes", (queue) => {
    // The person's own wakes (and their DM's) go; someone else's wake that mentions them keeps its
    // place in her queue, and only what it quoted goes (its preview, note, match or batch lines).
    const scrub = (wakes: readonly Wake[]): Wake[] =>
      wakes.flatMap((wake): Wake[] => {
        if (wake.fromUserId === o.userId || (wake.placeKey !== undefined && o.placeKeys.has(wake.placeKey))) {
          removed += 1;
          return [];
        }
        const next: Wake = { ...wake };
        let changed = false;
        if (next.messages) {
          const messages = scrubMessages(next.messages);
          if (JSON.stringify(messages) !== JSON.stringify(next.messages)) {
            changed = true;
            if (messages.length > 0) next.messages = messages;
            else delete next.messages;
          }
        }
        for (const field of ["preview", "note", "matched"] as const) {
          const text = next[field];
          if (text === undefined) continue;
          if (o.mentions(text)) {
            // Her note is kept as a marker (a reminder still fires); a quote just goes.
            if (field === "note") next.note = REMOVED_TEXT;
            else delete next[field];
            changed = true;
          } else o.review?.(text);
        }
        if (next.batch) {
          const batch = next.batch.filter((line) => !o.mentions(line));
          if (batch.length !== next.batch.length) {
            next.batch = batch;
            changed = true;
          }
          for (const line of batch) o.review?.(line);
        }
        if (changed) removed += 1;
        return [next];
      });
    const places: Record<string, DeferredPlace> = {};
    for (const [key, place] of Object.entries(queue.deferred.places)) {
      if (o.placeKeys.has(key)) {
        removed += 1;
        continue;
      }
      const names = { ...place.names };
      delete names[o.userId];
      const { lines: oldLines, ...rest } = place;
      // The morning summary's lines (§23) are scrubbed like a wake's messages.
      const lines = oldLines ? scrubMessages(oldLines) : undefined;
      if (oldLines && JSON.stringify(lines) !== JSON.stringify(oldLines)) removed += 1;
      places[key] = { ...rest, fromUserIds: place.fromUserIds.filter((id) => id !== o.userId), names, ...(lines && lines.length > 0 ? { lines } : {}) };
    }
    const quiet = queue.quiet.filter((line) => {
      const drop = line.userId === o.userId || (line.placeKey !== undefined && o.placeKeys.has(line.placeKey));
      if (drop) removed += 1;
      return !drop;
    });
    const userWakes = { ...queue.userWakes };
    delete userWakes[o.userId];
    return {
      ...queue,
      immediate: scrub(queue.immediate),
      held: scrub(queue.held),
      deferred: { ...queue.deferred, places, items: scrub(queue.deferred.items) },
      quiet,
      userWakes
    };
  });
  return removed;
}
