// Step `living-cast-home-v1` (Living cast spec §16.13): a development host's L2-era life layout
// becomes her own computer. Released hosts never had it (Living cast is unreleased), so on them the
// step changes nothing.
//
// Per waifu (`user/waifus/<id>/`):
// - `notes/` becomes her home folder `home/` (a rename). If both exist, `notes/` moves to the
//   archive (`user/.archive/living-cast/notes/<id>/`) and `home/` is kept as it is.
// - `life/schedule.json` (the app's reminder list) becomes `home/schedule.json` in her own format
//   (local `YYYY-MM-DD HH:MM` times in the host time zone), plus `life/schedule-ids.json` with the id
//   counter. `life/watches.json` becomes `home/watches.json` (local timeouts, `place` as her place
//   handle, `from` as the stored name, else `<@id>`) plus `life/watch-ids.json` with the resolved
//   bindings and fire times, hashed against the file written. Expired watches are dropped; a watch
//   whose place has no handle any more is dropped too (she could not name it). The originals move
//   to the archive (`user/.archive/living-cast/life/<id>/`). Her file already there (a re-run after
//   a crash) is kept; the side file is then built from the file on disk.
// - A life whose epoch snapshot still lists retired tools (`send_message`, `write_note`, …) gets a
//   pending epoch start (reason `reset`: her summary carries over, her old logs stay their usual 7
//   days), since the tool list changed (§5.2). Once that epoch has started, its snapshot lists the
//   new tools, so a re-run marks nothing.
// A file that cannot be parsed is left alone and the step reports itself incomplete.

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { L2ScheduleFileSchema, L2WatchesFileSchema } from "./legacySchemas.js";
import { atomicWriteJson, atomicWriteText } from "../../storage/atomic.js";
import { hostTimeZone } from "../../orchestration/context/timeFormat.js";
import { localMinuteText, scheduleText, watchesText, type WatchEntry } from "../../life/home/specialFiles.js";
import type { MigrationStepOutcome } from "../migrations.js";
import { moveInto, archivePath } from "./livingCastArchive.js";
import { isObject, readJsonFile } from "./memorySupport.js";

const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_WATCH_TIMEOUT_MS = 7 * 24 * 60 * 60_000;
/** Tool names of the L2 tool surface (§6), retired by §16. */
export const RETIRED_L2_TOOLS: ReadonlySet<string> = new Set([
  "read_messages",
  "send_message",
  "react",
  "watch_for",
  "list_watches",
  "cancel_watch",
  "schedule_wake",
  "list_schedule",
  "cancel_wake",
  "list_notes",
  "read_note",
  "write_note",
  "edit_note",
  "delete_note",
  "search_notes",
  "list_places",
  "web_search",
  "web_fetch"
]);

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false
  );
}

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Counts = { notes: number; schedule: number; watches: number; epochs: number; unreadable: number };

export async function migrateLivingCastHome(dataRoot: string, o: { now?: () => Date; timeZone?: string } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const timeZone = o.timeZone ?? hostTimeZone();
  const counts: Counts = { notes: 0, schedule: 0, watches: 0, epochs: 0, unreadable: 0 };
  const waifusDir = path.join(dataRoot, "user", "waifus");
  for (const waifuId of await list(waifusDir)) {
    if (!WAIFU_ID.test(waifuId) || /^\.+$/u.test(waifuId)) continue;
    const waifuDir = path.join(waifusDir, waifuId);
    if (!(await stat(waifuDir).then((info) => info.isDirectory(), () => false))) continue;
    await markEpoch(waifuDir, now, counts);
    await moveNotes(dataRoot, waifuId, waifuDir, counts);
    await convertSchedule(dataRoot, waifuId, waifuDir, now, timeZone, counts);
    await convertWatches(dataRoot, waifuId, waifuDir, now, timeZone, counts);
  }
  const changed = counts.notes + counts.schedule + counts.watches + counts.epochs;
  const applied = changed > 0 ? `living-cast-home-${counts.notes}-${counts.schedule}-${counts.watches}-${counts.epochs}` : undefined;
  if (counts.unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${counts.unreadable} L2-era life file(s) could not be parsed` };
  return applied;
}

/** A pending epoch start for a life whose snapshot still lists the L2 tools. */
async function markEpoch(waifuDir: string, now: Date, counts: Counts): Promise<void> {
  const file = path.join(waifuDir, "life", "state.json");
  const read = await readJsonFile(file);
  if (read.kind === "invalid") counts.unreadable += 1;
  if (read.kind !== "ok" || !isObject(read.value)) return;
  const state = read.value;
  const snapshot = state.systemSnapshot;
  if (!isObject(snapshot) || !Array.isArray(snapshot.tools)) return;
  if (!snapshot.tools.some((name) => typeof name === "string" && RETIRED_L2_TOOLS.has(name))) return;
  if (state.pendingEpochStart === true) return;
  await atomicWriteJson(file, {
    ...state,
    revision: typeof state.revision === "number" ? state.revision + 1 : 1,
    updatedAt: now.toISOString(),
    pendingEpochStart: true,
    pendingEpochReason: "reset"
  });
  counts.epochs += 1;
}

async function moveNotes(dataRoot: string, waifuId: string, waifuDir: string, counts: Counts): Promise<void> {
  const notes = path.join(waifuDir, "notes");
  if (!(await exists(notes))) return;
  const home = path.join(waifuDir, "home");
  if (await exists(home)) await moveInto(notes, archivePath(dataRoot, "notes", waifuId));
  else await rename(notes, home);
  counts.notes += 1;
}

async function writeIfMissing(file: string, text: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteText(file, text);
  return text;
}

async function convertSchedule(dataRoot: string, waifuId: string, waifuDir: string, now: Date, timeZone: string, counts: Counts): Promise<void> {
  const old = path.join(waifuDir, "life", "schedule.json");
  const read = await readJsonFile(old);
  if (read.kind === "missing") return;
  const parsed = read.kind === "ok" ? L2ScheduleFileSchema.safeParse(read.value) : undefined;
  if (!parsed?.success) {
    counts.unreadable += 1;
    return;
  }
  const entries = parsed.data.reminders.slice(0, 20).map((reminder) => ({
    id: reminder.id,
    at: localMinuteText(new Date(reminder.dueAt), timeZone),
    ...(reminder.repeat ? { repeat: reminder.repeat } : {}),
    note: reminder.note
  }));
  await writeIfMissing(path.join(waifuDir, "home", "schedule.json"), scheduleText(entries));
  const ids = path.join(waifuDir, "life", "schedule-ids.json");
  if (!(await exists(ids))) await atomicWriteJson(ids, { nextId: parsed.data.nextId, fired: [] });
  await moveInto(old, archivePath(dataRoot, "life", waifuId, "schedule.json"));
  counts.schedule += 1;
}

async function convertWatches(dataRoot: string, waifuId: string, waifuDir: string, now: Date, timeZone: string, counts: Counts): Promise<void> {
  const old = path.join(waifuDir, "life", "watches.json");
  const read = await readJsonFile(old);
  if (read.kind === "missing") return;
  const parsed = read.kind === "ok" ? L2WatchesFileSchema.safeParse(read.value) : undefined;
  if (!parsed?.success) {
    counts.unreadable += 1;
    return;
  }
  const handlesRead = await readJsonFile(path.join(waifuDir, "life", "handles.json"));
  const primary: Record<string, unknown> = handlesRead.kind === "ok" && isObject(handlesRead.value) && isObject(handlesRead.value.primary) ? handlesRead.value.primary : {};
  const entries: WatchEntry[] = [];
  const side: Record<string, { bindings: unknown[]; fires: string[] }> = {};
  for (const watch of parsed.data.watches) {
    const expires = Date.parse(watch.expiresAt);
    if (!(expires > now.getTime())) continue;
    const when: WatchEntry["when"] = [];
    let placeless = false;
    for (const binding of watch.bindings) {
      const handle = binding.placeKey ? primary[binding.placeKey] : undefined;
      if (binding.placeKey && typeof handle !== "string") placeless = true;
      when.push({
        ...(typeof handle === "string" ? { place: handle } : {}),
        ...(binding.fromUserId ? { from: binding.fromName?.trim() || `<@${binding.fromUserId}>` } : {}),
        ...(binding.words?.length ? { words: [...binding.words] } : {}),
        ...(binding.anyMessage ? { any_message: true } : {})
      });
    }
    if (placeless || entries.length >= 10) continue;
    entries.push({ id: watch.id, timeout: localMinuteText(new Date(Math.min(expires, now.getTime() + MAX_WATCH_TIMEOUT_MS)), timeZone), once: watch.once, note: watch.note, when });
    side[watch.id] = { bindings: watch.bindings, fires: watch.fires };
  }
  const text = await writeIfMissing(path.join(waifuDir, "home", "watches.json"), watchesText(entries));
  const ids = path.join(waifuDir, "life", "watch-ids.json");
  if (!(await exists(ids))) {
    // Resolutions only for the watches the file on disk holds (it may be from an earlier run).
    const onDisk = new Set(entries.map((entry) => entry.id).filter((id) => text.includes(JSON.stringify(id))));
    const watches = Object.fromEntries(Object.entries(side).filter(([id]) => onDisk.has(id)));
    await atomicWriteJson(ids, { nextId: parsed.data.nextId, sourceHash: sha256(text), watches, fired: [] });
  }
  await moveInto(old, archivePath(dataRoot, "life", waifuId, "watches.json"));
  counts.watches += 1;
}
