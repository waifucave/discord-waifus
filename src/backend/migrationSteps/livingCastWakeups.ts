// Living cast §30.3: `living-cast-wakeups-v1` (once). Her reminders and watches become her wakeups.
// Per waifu (`user/waifus/<id>/`):
// - `home/life/reminders.json` → `t` entries of `home/life/wakeups.json`: a reminder is an `at`, a
//   daily one an `every "day HH:MM"`, a weekly one an `every "<weekday> HH:MM"` (its `at` date's day);
//   the ids keep their numbers (`r4` → `t4`); an `every` counts from just before its saved time, so a
//   reminder due when the host comes back still fires.
// - `home/life/watches.json` → `w` entries (ids stay: `w3`): `timeout` becomes `options.until`, its
//   bindings an object filter: one binding is `places` = its place (else "everywhere") and a filter of
//   its `from`, `words` and `any_message` (`any`); several are a list of filters (each keeping its
//   place), on their places (all of them have one) or "everywhere"; none (a timer) is the filter `[]`.
// - The side files follow: `life/schedule-ids.json` and `life/watch-ids.json` become
//   `life/wakeup-ids.json` (id counters, each watch's resolved names and fires, the occurrences
//   already routed, which keep their wake ids: `w-reminder-r4-…` → `w-reminder-t4-…`).
// - The old files (and side files) are archived under `user/.archive/living-cast/wakeups/<id>/`.
// - A life whose epoch snapshot offers `WatchFor` or `ScheduleWake` gets a pending epoch start
//   (reason `tools`: summarised with the retired calls as text, no kept turns: a provider refuses a
//   history calling tools the request does not define).
//
// Her marker (`life/wakeups-v1.json`, outside her home; the app writes it too whenever it touches
// her home, through HomeStore) records the parts done (`convert`, `archive`, `epoch`), so a crash
// resumes where it stopped and a re-run after a lost ledger never converts a `reminders.json` she
// writes later (it is an ordinary file now). A waifu with nothing to convert and no life on the old
// tools gets no marker from here: a root without old files stays byte-identical. A file that does not
// read whole is left alone and the step reports itself incomplete.

import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { parseLocalDateTime } from "../../life/clock.js";
import { wakeupsText, type ObjectFilter, type WakeupEntry } from "../../life/wakeups/file.js";
import type { WakeupSide } from "../../shared/schemas/life.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { MigrationStepOutcome } from "../migrations.js";
import { archivePath } from "./livingCastArchive.js";
import { LegacyScheduleIdsSchema, LegacyWatchIdsSchema, readLegacyReminders, readLegacyWatches, type LegacyWatchIds } from "./legacySchemas.js";
import { isObject, readJsonFile } from "./memorySupport.js";

export const WAKEUPS_STEP_ID = "living-cast-wakeups-v1";
/** Her marker's name in her internal `life/` folder (`lifePaths.wakeupsMarker`). */
export const WAKEUPS_MARKER = "wakeups-v1.json";
const RETIRED_TOOLS = new Set(["WatchFor", "ScheduleWake"]);
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PARTS = ["convert", "archive", "epoch"] as const;
type Part = (typeof PARTS)[number];
type Marker = { version: 1; state: "converting" | "done"; parts?: Part[]; epoch?: boolean };

const key = (name: string) => name.normalize("NFC").toLowerCase();

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    return info.isFile();
  } catch {
    return false;
  }
}

/** A file in a folder as her disk compares names (`Reminders.json` is `reminders.json`). */
async function findName(dir: string, name: string): Promise<string | undefined> {
  const found = (await list(dir)).find((entry) => key(entry) === key(name));
  return found && (await isFile(path.join(dir, found))) ? path.join(dir, found) : undefined;
}

/** Text that reads whole as a JSON array (else the file is left alone). */
function wholeArray(text: string | undefined): boolean {
  if (text === undefined || !text.trim()) return true;
  try {
    return Array.isArray(JSON.parse(text));
  } catch {
    return false;
  }
}

const hhmm = (at: string) => at.slice(11, 16);

/** Her reminders and watches as wakeups, with what goes beside them. */
export function convertLegacy(o: {
  remindersText: string | undefined;
  watchesText: string | undefined;
  scheduleIds: { nextId: number; fired: string[]; recoveredAt?: string | undefined };
  watchIds: LegacyWatchIds;
  existing: readonly WakeupEntry[];
  timeZone: string;
  now: Date;
}): { entries: WakeupEntry[]; side: WakeupSide; unresolved: boolean } {
  const entries: WakeupEntry[] = [...o.existing];
  const taken = new Set(entries.map((entry) => entry.id));
  const next = { t: Math.max(1, o.scheduleIds.nextId), w: Math.max(1, o.watchIds.nextId), p: 1 };
  const freeId = (prefix: "t" | "w", wanted: string | undefined): string => {
    if (wanted && !taken.has(wanted)) {
      taken.add(wanted);
      const n = Number(wanted.slice(1));
      next[prefix] = Math.max(next[prefix], n + 1);
      return wanted;
    }
    while (taken.has(`${prefix}${next[prefix]}`)) next[prefix] += 1;
    const id = `${prefix}${next[prefix]}`;
    next[prefix] += 1;
    taken.add(id);
    return id;
  };
  const side: WakeupSide = { nextId: next, sourceHash: "", watches: {}, every: {}, pages: {}, pageFetches: [], pageUrls: {}, errors: {}, fired: [] };
  const renamed = new Map<string, string>();
  let unresolved = false;
  for (const reminder of readLegacyReminders(o.remindersText, o.timeZone)) {
    const number = /^r(\d{1,6})$/u.exec(reminder.id)?.[1];
    const id = freeId("t", number ? `t${number}` : undefined);
    if (reminder.id) renamed.set(reminder.id, id);
    const note = [...reminder.note].slice(0, 200).join("");
    if (!reminder.repeat) {
      entries.push({ id, kind: "at", when: reminder.at, note });
      continue;
    }
    const due = parseLocalDateTime(reminder.at, o.timeZone)!;
    const weekday = new Date(Date.UTC(Number(reminder.at.slice(0, 4)), Number(reminder.at.slice(5, 7)) - 1, Number(reminder.at.slice(8, 10)))).getUTCDay();
    const when = `${reminder.repeat === "daily" ? "day" : DAYS[weekday]} ${hhmm(reminder.at)}`;
    entries.push({ id, kind: "every", when, note });
    // Its saved time is its next occurrence: counting starts just before it.
    side.every[id] = { when, since: new Date(due.getTime() - 60_000).toISOString() };
  }
  for (const watch of readLegacyWatches(o.watchesText, o.timeZone)) {
    const number = /^w(\d{1,6})$/u.exec(watch.id)?.[1];
    const id = freeId("w", number ? `w${number}` : undefined);
    if (watch.id) renamed.set(watch.id, id);
    const resolved = o.watchIds.watches[watch.id]?.bindings ?? [];
    // A watch whose names were never resolved (a lost or older side file) is resolved again by the app.
    if (resolved.length !== watch.when.length) unresolved = true;
    const filterOf = (binding: (typeof watch.when)[number], keepPlace: boolean): ObjectFilter => {
      const filter: ObjectFilter = {};
      if (keepPlace && binding.place !== undefined) filter.place = binding.place;
      if (binding.from !== undefined) filter.from = binding.from;
      if (binding.words !== undefined && binding.words.length > 0) filter.words = binding.words;
      if (binding.any_message === true || (binding.from === undefined && !binding.words?.length)) filter.any = true;
      return filter;
    };
    let places: WakeupEntry["places"];
    let filter: WakeupEntry["filter"];
    let placeKeys: string[] | undefined;
    let filters = resolved.map((binding) => ({ ...binding }));
    if (watch.when.length === 0) {
      places = "everywhere";
      filter = [];
      filters = [];
    } else if (watch.when.length === 1) {
      const binding = watch.when[0]!;
      places = binding.place ?? "everywhere";
      filter = filterOf(binding, false);
      placeKeys = resolved[0]?.placeKey ? [resolved[0].placeKey] : undefined;
      if (filter.any && filters[0]) filters = [{ ...filters[0], anyMessage: true }];
    } else {
      const allPlaced = watch.when.every((binding) => binding.place !== undefined);
      places = allPlaced ? [...new Set(watch.when.map((binding) => binding.place!))] : "everywhere";
      filter = watch.when.map((binding) => filterOf(binding, true));
      placeKeys = allPlaced ? [...new Set(resolved.flatMap((binding) => (binding.placeKey ? [binding.placeKey] : [])))] : undefined;
      filters = filters.map((binding, index) => ((filter as ObjectFilter[])[index]?.any ? { ...binding, anyMessage: true } : binding));
    }
    entries.push({ id, kind: "watch", places, filter, options: { until: watch.timeout, once: watch.once }, note: [...watch.note].slice(0, 200).join("") });
    side.watches[id] = { ...(placeKeys && placeKeys.length > 0 ? { placeKeys } : {}), filters, fires: o.watchIds.watches[watch.id]?.fires ?? [] };
  }
  side.nextId = { ...next };
  // The occurrences already routed keep their wake ids under the new names.
  const byLength = [...renamed].sort((x, y) => y[0].length - x[0].length);
  const mapFired = (wakeId: string) => {
    for (const head of ["w-reminder-", "w-timeout-", "once-"]) {
      if (!wakeId.startsWith(head)) continue;
      const rest = wakeId.slice(head.length);
      for (const [old, to] of byLength) if (rest.startsWith(`${old}-`)) return `${head}${to}${rest.slice(old.length)}`;
    }
    return wakeId;
  };
  side.fired = [...o.scheduleIds.fired, ...o.watchIds.fired].map(mapFired).slice(-200);
  const lost = [o.scheduleIds.recoveredAt, o.watchIds.recoveredAt].filter((at): at is string => typeof at === "string").sort();
  if (lost.length > 0) side.recoveredAt = lost[lost.length - 1]!;
  return { entries, side, unresolved };
}

async function readMarker(file: string): Promise<Marker | undefined> {
  const read = await readJsonFile(file);
  if (read.kind !== "ok" || !isObject(read.value)) return undefined;
  const value = read.value;
  if (value.state !== "converting" && value.state !== "done") return undefined;
  return {
    version: 1,
    state: value.state,
    ...(Array.isArray(value.parts) ? { parts: value.parts.filter((part): part is Part => PARTS.includes(part as Part)) } : {}),
    ...(typeof value.epoch === "boolean" ? { epoch: value.epoch } : {})
  };
}

/** A life whose epoch offers the retired tools (its kept turns may call them). */
async function onOldTools(stateFile: string): Promise<boolean> {
  const read = await readJsonFile(stateFile);
  if (read.kind !== "ok" || !isObject(read.value) || !isObject(read.value.systemSnapshot)) return false;
  const tools = read.value.systemSnapshot.tools;
  return Array.isArray(tools) && tools.some((name) => typeof name === "string" && RETIRED_TOOLS.has(name));
}

async function archiveFile(dataRoot: string, waifuId: string, source: string, name: string): Promise<void> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; ; n += 1) {
    const target = archivePath(dataRoot, "wakeups", waifuId, n === 1 ? name : `${stem}-${n}${ext}`);
    if (await stat(target).then(() => true, () => false)) continue;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rename(source, target);
    return;
  }
}

/** Test hook: stop (throw) right after a part, as a crash there would. */
/** `written`: right after her new file is written, before the marker records `convert`. */
export type WakeupsCrash = "start" | "written" | Part;

export async function migrateLivingCastWakeups(dataRoot: string, o: { now?: () => Date; timeZone?: string; crashAfter?: WakeupsCrash } = {}): Promise<MigrationStepOutcome> {
  const now = (o.now ?? (() => new Date()))();
  const timeZone = o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const counts = { converted: 0, archived: 0, epochs: 0, unreadable: 0, markers: 0 };
  const root = path.join(dataRoot, "user", "waifus");
  for (const id of await list(root)) {
    if (!WAIFU_ID.test(id) || /^\.+$/u.test(id)) continue;
    const dir = path.join(root, id);
    if (!(await stat(dir).then((info) => info.isDirectory(), () => false))) continue;
    const lifeDir = path.join(dir, "life");
    const markerFile = path.join(lifeDir, WAKEUPS_MARKER);
    let marker = await readMarker(markerFile);
    if (marker?.state === "done") continue;
    const homeLife = path.join(dir, "home", "life");
    const remindersFile = await findName(homeLife, "reminders.json");
    const watchesFile = await findName(homeLife, "watches.json");
    const remindersText = remindersFile ? await readFile(remindersFile, "utf8").catch(() => undefined) : undefined;
    const watchesText = watchesFile ? await readFile(watchesFile, "utf8").catch(() => undefined) : undefined;
    if (!marker) {
      const oldTools = await onOldTools(path.join(lifeDir, "state.json"));
      if (!remindersFile && !watchesFile && !oldTools) continue;
      marker = { version: 1, state: "converting", parts: [], epoch: oldTools };
      await mkdir(lifeDir, { recursive: true, mode: 0o700 });
      await atomicWriteJson(markerFile, marker);
      counts.markers += 1;
      if (o.crashAfter === "start") throw new Error("crash after start");
    }
    const done = new Set(marker.parts ?? []);
    const finish = async (part: Part) => {
      done.add(part);
      marker = { ...marker!, parts: PARTS.filter((entry) => done.has(entry)) };
      await atomicWriteJson(markerFile, marker);
      if (o.crashAfter === part) throw new Error(`crash after ${part}`);
    };
    if (!done.has("convert")) {
      if (!wholeArray(remindersText) || !wholeArray(watchesText)) {
        counts.unreadable += 1;
        continue;
      }
      if (remindersFile || watchesFile) {
        const sideRead = async (name: string) => {
          const read = await readJsonFile(path.join(lifeDir, name));
          return read.kind === "ok" ? read.value : {};
        };
        const scheduleIds = LegacyScheduleIdsSchema.safeParse(await sideRead("schedule-ids.json"));
        const watchIds = LegacyWatchIdsSchema.safeParse(await sideRead("watch-ids.json"));
        const wakeupsFile = path.join(homeLife, "wakeups.json");
        // Until the marker records `convert`, a wakeups.json there is this step's own unfinished
        // write (the app writes the marker as done before it ever writes one): converted again from
        // the old files, never added to.
        const existing: WakeupEntry[] = [];
        const converted = convertLegacy({
          remindersText,
          watchesText,
          scheduleIds: scheduleIds.success ? scheduleIds.data : { nextId: 1, fired: [] },
          watchIds: watchIds.success ? watchIds.data : LegacyWatchIdsSchema.parse({}),
          existing,
          timeZone,
          now
        });
        const text = wakeupsText(converted.entries);
        await mkdir(homeLife, { recursive: true, mode: 0o700 });
        // No source hash when some watch lacks its resolution: the scheduler's first tick resolves the file again.
        const sourceHash = converted.unresolved ? "" : createHash("sha256").update(text, "utf8").digest("hex");
        await atomicWriteJson(path.join(lifeDir, "wakeup-ids.json"), { ...converted.side, sourceHash });
        await writeText(wakeupsFile, text);
        if (o.crashAfter === "written") throw new Error("crash after written");
        counts.converted += 1;
      }
      await finish("convert");
    }
    if (!done.has("archive")) {
      for (const file of [remindersFile, watchesFile]) if (file && (await isFile(file))) {
        await archiveFile(dataRoot, id, file, path.basename(file));
        counts.archived += 1;
      }
      for (const name of ["schedule-ids.json", "watch-ids.json"]) {
        const file = path.join(lifeDir, name);
        if (await isFile(file)) {
          await archiveFile(dataRoot, id, file, name);
          counts.archived += 1;
        }
      }
      await finish("archive");
    }
    if (!done.has("epoch")) {
      if (marker.epoch) {
        if (!(await markEpoch(path.join(lifeDir, "state.json"), now, counts))) continue;
      }
      await finish("epoch");
    }
    await atomicWriteJson(markerFile, { version: 1, state: "done" } satisfies Marker);
  }
  const changed = counts.converted + counts.archived + counts.epochs + counts.markers;
  const applied = changed > 0 ? `living-cast-wakeups-${counts.converted}-${counts.archived}-${counts.epochs}` : undefined;
  if (counts.unreadable > 0) return { ...(applied ? { applied } : {}), incomplete: `${counts.unreadable} reminder or watch file(s) could not be parsed` };
  return applied;
}

/** Her new file, written atomically (temp file, then rename), like the app writes her files. */
async function writeText(file: string, text: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

/** A life on the old tools starts a new epoch before her next turn (summarised, no kept turns). */
async function markEpoch(file: string, now: Date, counts: { epochs: number; unreadable: number }): Promise<boolean> {
  const read = await readJsonFile(file);
  if (read.kind === "invalid") {
    counts.unreadable += 1;
    return false;
  }
  if (read.kind !== "ok" || !isObject(read.value) || !isObject(read.value.systemSnapshot)) return true;
  const state = read.value;
  // An epoch start already pending keeps no turns either.
  if (state.pendingEpochStart === true) return true;
  await atomicWriteJson(file, {
    ...state,
    revision: typeof state.revision === "number" ? state.revision + 1 : 1,
    updatedAt: now.toISOString(),
    pendingEpochStart: true,
    pendingEpochReason: "tools"
  });
  counts.epochs += 1;
  return true;
}
