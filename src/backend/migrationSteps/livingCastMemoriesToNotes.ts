// Step `living-cast-memories-to-notes-v1` (Living cast spec §7.4): the retired memory store becomes
// each waifu's notes, in her home folder `home/` (§16.13: Living cast is unreleased, so the step
// writes there instead of the L2-era `notes/`). Deterministic, no model calls, and only for waifus
// that have neither `home/` nor an L2-era `notes/` (which `living-cast-home-v1` moves).
//
// - Active, unexpired records about a person go to `people/<name-slug>.md`, keyed by Discord user id
//   when known (another waifu by her id, else the name); two people whose names slug alike get
//   `<slug>-<last 4 of the id>.md`. A record about several people is written to each of their files.
//   Records only about the waifu herself go to `me.md`, the rest to `misc.md`. A DM-origin record
//   gets `(from a private chat with <name>)`. A person's own file carries `<!-- user:<id> -->`
//   under its heading, so a later forget deletes the file whole (§7.5 step 5).
// - Within a file: pinned first, then strength, then newest. Lines past the 16 KB note limit are
//   left out and listed in the archive. Beyond the 200-file limit (MEMORY.md included) the people
//   with the least total strength are merged into `people/others.md`; the notes' 1 MB total is kept
//   the same way (lowest-ranked files lose lines first).
// - `MEMORY.md`: one line per file, by total strength; beyond 150 lines (or its 16 KB) the rest are
//   summarised as `- …and N more people in people/`.
// - Forgotten people are left out entirely: everyone in `user/people/forgotten.json` (the owner's
//   forget-user) for every waifu, and the users of a waifu's pending scrubs
//   (`life/pending-scrubs.json`, a DM `/forget everything`) for her. Their records are not kept in
//   the archive either. An unreadable forget record fails the step (it is never read as "nobody").
// - `user/memories.json` (minus forgotten people), `user/memory/` (pending observations, dream
//   cursor; forgotten people's observations and keys left out first) and the omitted lines move to
//   `user/.archive/living-cast/`.
//
// Crash safety: each waifu's notes are written to `home.migrating/` and renamed into place, the
// archive copy is written before `user/memories.json` is removed (last), so a re-run after a crash
// finishes the job and a finished run leaves nothing for the next one to change.

import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "../../storage/atomic.js";
import { readForgottenPeople, readPendingScrubs } from "../../orchestration/dm/forgotten.js";
import { scrubJsonForPerson } from "../../life/archiveScrub.js";
import { MEMORY_INDEX, personMarker } from "../../life/home/memoryIndex.js";
import { slugify } from "../../life/places.js";
import { archivePath, moveToArchive } from "./livingCastArchive.js";
import { isObject, nonEmptyString, readJsonFile } from "./memorySupport.js";

const MEMORIES = path.join("user", "memories.json");
const MEMORY_DIR = path.join("user", "memory");
const INDEX_MAX_LINES = 150;
const INDEX_SUMMARY_CHARS = 60;
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;
// The L2 notes limits this step was written for (frozen: well inside her home's limits).
const MAX_NOTE_BYTES = 16 * 1024;
const MAX_NOTE_FILES = 200;
const MAX_NOTES_TOTAL_BYTES = 1024 * 1024;

type Subject = { discordUserId?: string; waifuId?: string; name: string };
type MemoryEntry = {
  id: string;
  waifuId: string;
  content: string;
  pinned: boolean;
  strength: number;
  updatedAt: string;
  subjects: Subject[];
  dmUserId?: string;
};
type Line = { record: MemoryEntry; text: string };
/** `userId`: the Discord user a person file is about (written as a marker the forget scrub finds). */
type NoteFile = { path: string; title: string; lines: Line[]; strength: number; userId?: string };
type Omitted = { path: string; recordId: string; line: string; why: "note_limit" | "notes_full" };

function parseRecord(raw: unknown): MemoryEntry | undefined {
  if (!isObject(raw)) return undefined;
  const id = nonEmptyString(raw.id);
  const waifuId = nonEmptyString(raw.waifuId);
  const content = nonEmptyString(raw.content)?.replace(/\s+/gu, " ").trim();
  if (!id || !waifuId || !content) return undefined;
  if ((raw.status ?? "active") !== "active") return undefined;
  const subjects: Subject[] = Array.isArray(raw.subjects)
    ? raw.subjects.flatMap((subject): Subject[] => {
        if (!isObject(subject)) return [];
        const name = nonEmptyString(subject.name);
        if (!name) return [];
        const discordUserId = nonEmptyString(subject.discordUserId);
        const subjectWaifuId = nonEmptyString(subject.waifuId);
        return [{ name, ...(discordUserId ? { discordUserId } : {}), ...(subjectWaifuId ? { waifuId: subjectWaifuId } : {}) }];
      })
    : [];
  const origin = isObject(raw.origin) ? raw.origin : {};
  const dmUserId = origin.dm === true ? nonEmptyString(origin.userId) : undefined;
  const strength = typeof raw.strength === "number" && Number.isFinite(raw.strength) ? raw.strength : 3;
  return {
    id,
    waifuId,
    content,
    pinned: raw.pinned === true,
    strength,
    updatedAt: nonEmptyString(raw.updatedAt) ?? nonEmptyString(raw.createdAt) ?? "",
    subjects,
    ...(dmUserId ? { dmUserId } : {})
  };
}

/** Expired short-term records (`expiresAt` in the past) are not carried over. */
function expired(raw: unknown, now: Date): boolean {
  const expiresAt = isObject(raw) ? nonEmptyString(raw.expiresAt) : undefined;
  return expiresAt !== undefined && Date.parse(expiresAt) <= now.getTime();
}

/** The user ids a raw record is about (subjects and DM provenance). */
function userIdsOf(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const ids: string[] = [];
  if (Array.isArray(raw.subjects)) {
    for (const subject of raw.subjects) {
      const id = isObject(subject) ? nonEmptyString(subject.discordUserId) : undefined;
      if (id) ids.push(id);
    }
  }
  const origin = isObject(raw.origin) ? raw.origin : undefined;
  const dmUser = origin ? nonEmptyString(origin.userId) : undefined;
  if (dmUser) ids.push(dmUser);
  return ids;
}

const byRank = (a: Line, b: Line) =>
  Number(b.record.pinned) - Number(a.record.pinned) ||
  b.record.strength - a.record.strength ||
  b.record.updatedAt.localeCompare(a.record.updatedAt) ||
  a.record.id.localeCompare(b.record.id);

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The heading, plus the person marker (`<!-- user:<id> -->`, spec §7.5 step 5) on a person's own file. */
function header(file: NoteFile): string {
  return `# ${file.title}\n${file.userId ? `${personMarker(file.userId)}\n` : ""}\n`;
}

function render(file: NoteFile): string {
  return `${header(file)}${file.lines.map((line) => `- ${line.text}`).join("\n")}\n`;
}

/** Keeps the lines that fit in `budget` bytes (in rank order); the rest are reported. */
function fit(file: NoteFile, budget: number, why: Omitted["why"], omitted: Omitted[]): void {
  const kept: Line[] = [];
  let size = bytes(header(file));
  for (const line of file.lines) {
    const cost = bytes(`- ${line.text}\n`);
    if (size + cost <= budget) {
      kept.push(line);
      size += cost;
    } else {
      omitted.push({ path: file.path, recordId: line.record.id, line: line.text, why });
    }
  }
  file.lines = kept;
  file.strength = kept.reduce((sum, line) => sum + line.record.strength, 0);
}

function summary(file: NoteFile): string {
  // The top line's own words (no private-chat suffix or "Name:" prefix).
  const first = file.lines[0]?.record.content ?? "";
  return first.length > INDEX_SUMMARY_CHARS ? `${first.slice(0, INDEX_SUMMARY_CHARS - 1).trimEnd()}…` : first;
}

function renderIndex(files: NoteFile[]): string {
  const header = "# Memory\n";
  const lines: string[] = [];
  let size = bytes(header);
  const ranked = [...files].sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path));
  for (let index = 0; index < ranked.length; index += 1) {
    const file = ranked[index]!;
    const line = `- [${file.title.replace(/[[\]]/gu, "")}](${file.path}) — ${summary(file)}`;
    const left = ranked.length - index;
    const more = `- …and ${left - 1} more people in people/`;
    // Room is always left for the closing "…and N more" line.
    if (lines.length >= INDEX_MAX_LINES || size + bytes(`${line}\n`) + bytes(`${more}\n`) > MAX_NOTE_BYTES) {
      lines.push(`- …and ${left} more people in people/`);
      break;
    }
    lines.push(line);
    size += bytes(`${line}\n`);
  }
  return `${header}${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** The note files of one waifu (deterministic). */
export function notesForWaifu(
  waifuId: string,
  records: MemoryEntry[],
  /** Display names of her DM users (DM state), for DM-origin records about nobody else. */
  dmNames: ReadonlyMap<string, string> = new Map()
): { files: NoteFile[]; omitted: Omitted[] } {
  // Names: the newest record's spelling per person key.
  const names = new Map<string, { name: string; at: string }>();
  const keyOf = (subject: Subject) => (subject.discordUserId ? `u:${subject.discordUserId}` : subject.waifuId ? `w:${subject.waifuId}` : `n:${subject.name.toLowerCase()}`);
  for (const record of records) {
    for (const subject of record.subjects) {
      if (subject.waifuId === waifuId) continue;
      const key = keyOf(subject);
      const known = names.get(key);
      if (!known || record.updatedAt > known.at) names.set(key, { name: subject.name, at: record.updatedAt });
    }
  }
  for (const [userId, name] of dmNames) if (!names.has(`u:${userId}`)) names.set(`u:${userId}`, { name, at: "" });
  const nameOfUser = (userId: string) => names.get(`u:${userId}`)?.name;

  const people = new Map<string, Line[]>();
  const me: Line[] = [];
  const misc: Line[] = [];
  for (const record of records) {
    const dmName = record.dmUserId ? (record.subjects.find((subject) => subject.discordUserId === record.dmUserId)?.name ?? nameOfUser(record.dmUserId) ?? "someone") : undefined;
    const text = dmName ? `${record.content} (from a private chat with ${dmName})` : record.content;
    const others = [...new Set(record.subjects.filter((subject) => subject.waifuId !== waifuId).map(keyOf))];
    // A private-chat record about nobody else is about the person she was talking to.
    if (others.length === 0 && record.subjects.length === 0 && record.dmUserId) {
      others.push(`u:${record.dmUserId}`);
      if (!names.has(`u:${record.dmUserId}`)) names.set(`u:${record.dmUserId}`, { name: dmName ?? "someone", at: "" });
    }
    if (others.length > 0) {
      for (const key of others) people.set(key, [...(people.get(key) ?? []), { record, text }]);
    } else if (record.subjects.length > 0) {
      me.push({ record, text });
    } else {
      misc.push({ record, text });
    }
  }

  // File names: slug of the name; people whose names slug alike get the id's last 4 characters.
  const slugs = new Map<string, string>();
  const bySlug = new Map<string, string[]>();
  for (const key of [...people.keys()].sort()) {
    const name = names.get(key)?.name ?? "someone";
    const id = key.slice(2);
    const base = slugify(name) || `person-${id.slice(-4).toLowerCase().replace(/[^a-z0-9]/gu, "") || "x"}`;
    bySlug.set(base, [...(bySlug.get(base) ?? []), key]);
  }
  // `others` is reserved for the merged file. A lone name keeps the bare slug; people sharing it
  // get `-<last 4 of the id>` (a person known only by name keeps the bare slug when it is free), and
  // a remaining clash takes a counter.
  const taken = new Set<string>(["others"]);
  for (const [base, keys] of [...bySlug.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const shared = keys.length > 1;
    for (const key of [...keys].sort((a, b) => Number(b.startsWith("n:")) - Number(a.startsWith("n:")) || a.localeCompare(b))) {
      const tail = key.startsWith("n:") ? "" : key.slice(2).toLowerCase().replace(/[^a-z0-9]/gu, "").slice(-4);
      let slug = (!shared || !tail) && !taken.has(base) ? base : `${base}-${tail || "x"}`;
      for (let counter = 2; taken.has(slug); counter += 1) slug = `${base}-${tail || "x"}-${counter}`;
      taken.add(slug);
      slugs.set(key, slug);
    }
  }

  const omitted: Omitted[] = [];
  let files: NoteFile[] = [...people.entries()].map(([key, lines]) => ({
    path: `people/${slugs.get(key)}.md`,
    title: names.get(key)?.name ?? "Someone",
    ...(key.startsWith("u:") ? { userId: key.slice(2) } : {}),
    lines: [...lines].sort(byRank),
    strength: lines.reduce((sum, line) => sum + line.record.strength, 0)
  }));
  for (const file of files) fit(file, MAX_NOTE_BYTES, "note_limit", omitted);
  files = files.filter((file) => file.lines.length > 0);

  // The 200-file limit counts MEMORY.md, me.md, misc.md and people/others.md.
  const fixed = 1 + (me.length > 0 ? 1 : 0) + (misc.length > 0 ? 1 : 0);
  files.sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path));
  if (fixed + files.length > MAX_NOTE_FILES) {
    const keep = MAX_NOTE_FILES - fixed - 1;
    const merged = files.slice(keep);
    files = files.slice(0, keep);
    const lines = merged.flatMap((file) => file.lines.map((line) => ({ record: line.record, text: `${file.title}: ${line.text}` })));
    const others: NoteFile = { path: "people/others.md", title: "Others", lines: lines.sort(byRank), strength: 0 };
    fit(others, MAX_NOTE_BYTES, "note_limit", omitted);
    if (others.lines.length > 0) files.push(others);
  }
  for (const [lines, notePath, title] of [[me, "me.md", "Me"], [misc, "misc.md", "Misc"]] as const) {
    if (lines.length === 0) continue;
    const file: NoteFile = { path: notePath, title, lines: [...lines].sort(byRank), strength: 0 };
    fit(file, MAX_NOTE_BYTES, "note_limit", omitted);
    if (file.lines.length > 0) files.push(file);
  }

  // The notes' 1 MB total (with room for the index): the lowest-ranked files give way first.
  files.sort((a, b) => b.strength - a.strength || a.path.localeCompare(b.path));
  let budget = MAX_NOTES_TOTAL_BYTES - MAX_NOTE_BYTES;
  for (const file of files) {
    const size = bytes(render(file));
    if (size <= budget) {
      budget -= size;
      continue;
    }
    fit(file, Math.max(0, budget), "notes_full", omitted);
    budget -= file.lines.length > 0 ? bytes(render(file)) : 0;
  }
  files = files.filter((file) => file.lines.length > 0);
  return { files, omitted };
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}

async function waifuIds(dataRoot: string): Promise<string[]> {
  const dir = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ids: string[] = [];
  for (const entry of entries.sort()) {
    if (!WAIFU_ID.test(entry) || /^\.+$/u.test(entry)) continue;
    if (await exists(path.join(dir, entry, "waifu.json"))) ids.push(entry);
  }
  return ids;
}

/** Her DM users' last-seen display names (`user/dms/<userId>/<waifuId>.json`). */
async function dmDisplayNames(dataRoot: string, waifuId: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const dir = path.join(dataRoot, "user", "dms");
  let users: string[];
  try {
    users = await readdir(dir);
  } catch {
    return names;
  }
  for (const userId of users.sort()) {
    const read = await readJsonFile(path.join(dir, userId, `${waifuId}.json`)).catch(() => ({ kind: "missing" as const }));
    const name = read.kind === "ok" && isObject(read.value) ? nonEmptyString(read.value.userDisplayName) : undefined;
    if (name) names.set(userId, name);
  }
  return names;
}

/** Writes one waifu's notes into `home.migrating/`, then renames it to `home/`. */
async function writeNotes(dataRoot: string, waifuId: string, files: NoteFile[]): Promise<void> {
  const waifuDir = path.join(dataRoot, "user", "waifus", waifuId);
  const staging = path.join(waifuDir, "home.migrating");
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(staging, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await atomicWriteText(target, render(file));
  }
  await atomicWriteText(path.join(staging, MEMORY_INDEX), renderIndex(files));
  await rename(staging, path.join(waifuDir, "home"));
}

/**
 * The memory folder leaves out forgotten people before it moves to the archive: pending observations
 * about a forgotten user (or a user of her pending scrubs), and any other record or key naming a
 * forgotten user's id (the dream cursor's DM keys).
 */
async function leaveOutForgotten(memoryDir: string, forgotten: ReadonlySet<string>, leftOut: (raw: unknown) => boolean): Promise<void> {
  const users = [...forgotten];
  for (const name of (await readdir(memoryDir).catch(() => [] as string[])).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(memoryDir, name);
    const read = await readJsonFile(file);
    if (read.kind !== "ok") continue;
    let value: unknown = read.value;
    let removed = 0;
    if (name === "pending-observations.json" && isObject(value) && Array.isArray(value.observations)) {
      const observations = value.observations.filter((observation) => !leftOut(observation));
      removed += value.observations.length - observations.length;
      value = { ...value, observations };
    }
    for (const userId of users) {
      const scrubbed = scrubJsonForPerson(value, userId);
      removed += scrubbed.removed;
      value = scrubbed.value;
    }
    if (removed > 0) await atomicWriteJson(file, value);
  }
}

export async function migrateLivingCastMemoriesToNotes(dataRoot: string, o: { now?: () => Date } = {}): Promise<string | undefined> {
  const now = (o.now ?? (() => new Date()))();
  const read = await readJsonFile(path.join(dataRoot, MEMORIES));
  if (read.kind === "invalid" || (read.kind === "ok" && (!isObject(read.value) || !Array.isArray(read.value.memories)))) {
    throw new Error("user/memories.json is not a readable memory store; repair it to finish migrating memories to notes.");
  }
  const memoryDir = path.join(dataRoot, MEMORY_DIR);
  if (read.kind === "missing" && !(await exists(memoryDir))) return undefined;
  // Throws ForgetRecordCorruptError on an unreadable record: never treated as "nobody forgotten".
  const forgotten = new Set((await readForgottenPeople({ dataRoot })).map((entry) => entry.userId));
  const ids = await waifuIds(dataRoot);
  const scrubbed = new Map<string, Set<string>>();
  for (const waifuId of ids) scrubbed.set(waifuId, new Set((await readPendingScrubs({ dataRoot }, waifuId)).map((entry) => entry.userId)));
  const leftOut = (raw: unknown) => {
    const users = userIdsOf(raw);
    const waifuId = isObject(raw) ? nonEmptyString(raw.waifuId) : undefined;
    const pending = waifuId ? scrubbed.get(waifuId) : undefined;
    return users.some((userId) => forgotten.has(userId) || pending?.has(userId) === true);
  };
  let written = 0;
  if (read.kind === "ok") {
    const store = read.value as { memories: unknown[] } & Record<string, unknown>;

    // The archive copy first (without forgotten people), so nothing is lost if a write below fails.
    const archiveFile = archivePath(dataRoot, "memories.json");
    if (!(await exists(archiveFile))) await atomicWriteJson(archiveFile, { ...store, memories: store.memories.filter((raw) => !leftOut(raw)) });

    const omittedByWaifu: Record<string, Omitted[]> = {};
    for (const waifuId of ids) {
      const waifuDir = path.join(dataRoot, "user", "waifus", waifuId);
      if ((await exists(path.join(waifuDir, "home"))) || (await exists(path.join(waifuDir, "notes")))) continue;
      const records = store.memories
        .filter((raw) => !leftOut(raw) && !expired(raw, now))
        .map(parseRecord)
        
        .filter((record): record is MemoryEntry => record !== undefined && record.waifuId === waifuId);
      if (records.length === 0) continue;
      const { files, omitted } = notesForWaifu(waifuId, records, await dmDisplayNames(dataRoot, waifuId));
      if (omitted.length > 0) omittedByWaifu[waifuId] = omitted;
      await writeNotes(dataRoot, waifuId, files);
      written += 1;
    }
    for (const [waifuId, omitted] of Object.entries(omittedByWaifu)) {
      await atomicWriteJson(archivePath(dataRoot, "notes-omitted", `${waifuId.replace(/[^A-Za-z0-9._-]/gu, "-")}.json`), { waifuId, omitted });
    }
  }
  await leaveOutForgotten(memoryDir, forgotten, leftOut);
  const movedMemoryDir = await moveToArchive(dataRoot, MEMORY_DIR);
  if (read.kind === "ok") await rm(path.join(dataRoot, MEMORIES), { force: true });
  if (read.kind === "missing" && !movedMemoryDir) return undefined;
  return `living-cast-memories-to-notes-${written}`;
}
