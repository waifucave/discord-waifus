// Forget in the Living cast archive (spec §7.5, owner decision D-b): a best-effort scrub of one
// person across `user/.archive/living-cast/`, the retired data L1 moved aside (nothing reads it, but
// it is still the person's data on this host).
//
// - The owner's forget-user scrubs everything: archived conversation ledgers and context-engine
//   contexts, the director's, stage manager's and reviewer's histories and sessions, the memory
//   store copy (`memories.json`), the memory folder (pending observations, dream cursor) and the
//   migration's omitted lines (`notes-omitted/`). Archived DM conversations with the person go whole.
// - A waifu's own scrub (a DM `/forget everything`, or her part of any forget) takes her slice: her
//   records in `memories.json`, her `notes-omitted/<id>.json`, her pending observations and her
//   archived DM conversation with the person.
//
// What is dropped: any record (an array item or a map entry) authored by the person or about them
// (an author/user/subject id field), or whose own text names them (the user id, `<@id>`, or a name
// only they have, as a whole word, diacritics folded). A memory record's dropped id also drops its
// omitted lines. Names come from the caller's identity plus the subjects of archived memory records
// with the person's id, minus every name another subject or a waifu has and every weak name.
//
// Never touched: `providers.json` (keys) and `models/` (model choices, no people). Files that do not
// parse are left as they are and counted (`unreadable`); other file types are counted as `skipped`.

import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../backend/logger.js";
import { LIVING_CAST_ARCHIVE_DIR } from "../backend/migrationSteps/livingCastModels.js";
import { atomicWriteJson, atomicWriteText } from "../storage/atomic.js";
import { foldName, isWeakName, namesSomeone } from "./text.js";

export type ArchiveScrubResult = { files: number; removed: number; unreadable: number; skipped: number };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const PERSON_ID_KEYS = new Set(["userId", "authorId", "discordUserId", "fromUserId", "dmUserId", "targetUserId", "speakerId", "memberId", "subjectId"]);
const PERSON_HOLDERS = new Set(["origin", "author", "user", "member", "from", "target", "speaker"]);
const PERSON_LISTS = new Set(["subjects", "participants", "people", "mentions", "userIds", "authorIds", "mentionedUserIds"]);
const NEVER_SCRUB = new Set(["providers.json", "models"]);

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

type Matcher = { userId: string; names: string[] };

function textNames(text: string, match: Matcher): boolean {
  return text.includes(match.userId) || match.names.some((name) => namesSomeone(text, name));
}

function idField(object: JsonObject, userId: string, keys: ReadonlySet<string>): boolean {
  return Object.entries(object).some(([key, value]) => typeof value === "string" && keys.has(key) && value === userId);
}

/** A record authored by or about the person, or whose own text names them. */
function aboutPerson(record: JsonObject, match: Matcher): boolean {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      if (PERSON_ID_KEYS.has(key) && value === match.userId) return true;
      if (textNames(value, match)) return true;
    } else if (isObject(value) && PERSON_HOLDERS.has(key)) {
      if (idField(value, match.userId, new Set([...PERSON_ID_KEYS, "id"]))) return true;
    } else if (Array.isArray(value) && PERSON_LISTS.has(key)) {
      if (value.some((item) => item === match.userId || (isObject(item) && idField(item, match.userId, new Set([...PERSON_ID_KEYS, "id"]))))) return true;
    }
  }
  return false;
}

/** Drops records about the person anywhere in a JSON document (never the document itself). */
function scrubJson(node: Json, match: Matcher, counter: { removed: number }): Json {
  if (Array.isArray(node)) {
    const kept: Json[] = [];
    for (const item of node) {
      if ((typeof item === "string" && textNames(item, match)) || (isObject(item) && aboutPerson(item, match))) {
        counter.removed += 1;
        continue;
      }
      kept.push(scrubJson(item, match, counter));
    }
    return kept;
  }
  if (isObject(node)) {
    const kept: JsonObject = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.includes(match.userId) || (typeof value === "string" && textNames(value, match)) || (isObject(value) && aboutPerson(value, match))) {
        counter.removed += 1;
        continue;
      }
      kept[key] = scrubJson(value, match, counter);
    }
    return kept;
  }
  return node;
}

/** One JSON document without the records about a person (the migration's memory folder filter). */
export function scrubJsonForPerson(value: unknown, userId: string, names: readonly string[] = []): { value: unknown; removed: number } {
  const counter = { removed: 0 };
  const next = scrubJson(value as Json, { userId, names: names.filter((name) => !isWeakName(name)) }, counter);
  return { value: next, removed: counter.removed };
}

/** The user ids a memory record is about (subjects and DM provenance). */
function memoryUserIds(record: JsonObject): string[] {
  const ids: string[] = [];
  if (Array.isArray(record.subjects)) for (const subject of record.subjects) if (isObject(subject) && typeof subject.discordUserId === "string") ids.push(subject.discordUserId);
  if (isObject(record.origin) && typeof record.origin.userId === "string") ids.push(record.origin.userId);
  return ids;
}

async function readJson(file: string): Promise<{ ok: true; value: Json } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, "utf8")) as Json };
  } catch {
    return { ok: false };
  }
}

async function isDir(target: string): Promise<boolean> {
  return lstat(target).then((info) => info.isDirectory(), () => false);
}

/** Every regular file under `dir` (links are never followed), relative to the archive root. */
async function walk(root: string, relative = ""): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = relative ? path.join(relative, entry.name) : entry.name;
    if (!relative && NEVER_SCRUB.has(entry.name)) continue;
    if (entry.isDirectory()) out.push(...(await walk(root, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** Names usable for removal: the caller's plus archived subjects' names for the id, minus anything shared or weak. */
function archiveNames(memories: Json | undefined, userId: string, given: readonly string[], avoid: readonly string[]): string[] {
  const mine = new Set(given);
  const others = new Set(avoid.map(foldName));
  const records = isObject(memories) && Array.isArray(memories.memories) ? memories.memories : [];
  for (const record of records) {
    if (!isObject(record) || !Array.isArray(record.subjects)) continue;
    for (const subject of record.subjects) {
      if (!isObject(subject) || typeof subject.name !== "string") continue;
      if (subject.discordUserId === userId) mine.add(subject.name);
      else others.add(foldName(subject.name));
    }
  }
  return [...mine].filter((name) => !isWeakName(name) && !others.has(foldName(name)));
}

export type ArchiveScrubInput = {
  userId: string;
  /** Names only this person has (the forget identity's `names`). */
  names?: readonly string[];
  /** Names other people or waifus also have: never used to remove anything. */
  avoidNames?: readonly string[];
  /** Only this waifu's slice (her own scrub); omitted = the whole archive (the owner's forget-user). */
  waifuId?: string;
  logger?: Pick<Logger, "warn">;
};

export async function scrubArchive(dataRoot: string, input: ArchiveScrubInput): Promise<ArchiveScrubResult> {
  const root = path.join(dataRoot, LIVING_CAST_ARCHIVE_DIR);
  const result: ArchiveScrubResult = { files: 0, removed: 0, unreadable: 0, skipped: 0 };
  if (!(await isDir(root))) return result;
  const { userId } = input;
  const memoriesRead = await readJson(path.join(root, "memories.json"));
  const match: Matcher = { userId, names: archiveNames(memoriesRead.ok ? memoriesRead.value : undefined, userId, input.names ?? [], input.avoidNames ?? []) };
  const mine = (record: JsonObject) => !input.waifuId || record.waifuId === input.waifuId;

  // Archived DM conversations with the person go whole (hers only, for her slice).
  for (const key of await readdir(path.join(root, "conversations")).catch(() => [] as string[])) {
    if (key.startsWith(`dm_${userId}_`) && (!input.waifuId || key === `dm_${userId}_${input.waifuId}`)) {
      await rm(path.join(root, "conversations", key), { recursive: true, force: true });
      result.removed += 1;
    }
  }

  // The memory store copy first: a dropped record's id also drops its omitted lines.
  const droppedRecords = new Set<string>();
  if (memoriesRead.ok && isObject(memoriesRead.value) && Array.isArray(memoriesRead.value.memories)) {
    const records = memoriesRead.value.memories;
    const kept = records.filter((record) => {
      if (!isObject(record) || !mine(record)) return true;
      const about = memoryUserIds(record).includes(userId) || aboutPerson(record, match);
      if (about && typeof record.id === "string") droppedRecords.add(record.id);
      return !about;
    });
    if (kept.length !== records.length) {
      result.removed += records.length - kept.length;
      result.files += 1;
      await atomicWriteJson(path.join(root, "memories.json"), { ...memoriesRead.value, memories: kept });
    }
  } else if (!memoriesRead.ok && (await lstat(path.join(root, "memories.json")).then(() => true, () => false))) {
    result.unreadable += 1;
  }

  const files = (await walk(root)).filter((file) => file !== "memories.json" && !file.startsWith(`conversations${path.sep}dm_${userId}_`));
  for (const file of files) {
    const full = path.join(root, file);
    const segments = file.split(path.sep);
    if (input.waifuId) {
      // Her slice: her omitted lines and the memory folder's records that are hers.
      const omittedFile = segments[0] === "notes-omitted" && segments.length === 2;
      const memoryFolder = segments[0] === "memory";
      if (!omittedFile && !memoryFolder) continue;
      if (omittedFile && file !== path.join("notes-omitted", `${input.waifuId.replace(/[^A-Za-z0-9._-]/gu, "-")}.json`)) continue;
    }
    if (file.endsWith(".jsonl")) {
      const raw = await readFile(full, "utf8").catch(() => undefined);
      if (raw === undefined) {
        result.unreadable += 1;
        continue;
      }
      let removed = 0;
      const lines = raw.split("\n").filter((line) => {
        if (!line.trim()) return true;
        let parsed: Json;
        try {
          parsed = JSON.parse(line) as Json;
        } catch {
          if (!textNames(line, match)) return true;
          removed += 1;
          return false;
        }
        const drop = isObject(parsed) ? mine(parsed) && aboutPerson(parsed, match) : textNames(line, match);
        if (drop) removed += 1;
        return !drop;
      });
      if (removed > 0) {
        result.removed += removed;
        result.files += 1;
        await atomicWriteText(full, lines.join("\n"));
      }
      continue;
    }
    if (!file.endsWith(".json")) {
      result.skipped += 1;
      continue;
    }
    const read = await readJson(full);
    if (!read.ok) {
      result.unreadable += 1;
      input.logger?.warn("An archived file could not be read; the forget scrub left it as it is", { file: path.posix.join(...segments) });
      continue;
    }
    const counter = { removed: 0 };
    let next: Json;
    if (segments[0] === "notes-omitted" && isObject(read.value) && Array.isArray(read.value.omitted)) {
      const omitted = read.value.omitted.filter((line) => {
        const drop = isObject(line) && ((typeof line.recordId === "string" && droppedRecords.has(line.recordId)) || aboutPerson(line, match));
        if (drop) counter.removed += 1;
        return !drop;
      });
      next = { ...read.value, omitted };
    } else if (input.waifuId) {
      // The memory folder, her slice: only records that carry her waifu id.
      next = scrubOwned(read.value, match, input.waifuId, counter);
    } else {
      next = scrubJson(read.value, match, counter);
    }
    if (counter.removed > 0) {
      result.removed += counter.removed;
      result.files += 1;
      await atomicWriteJson(full, next);
    }
  }
  return result;
}

/** Records of `waifuId` about the person, in any list of the document. */
function scrubOwned(node: Json, match: Matcher, waifuId: string, counter: { removed: number }): Json {
  if (Array.isArray(node)) {
    return node.flatMap((item) => {
      if (isObject(item) && item.waifuId === waifuId && (memoryUserIds(item).includes(match.userId) || aboutPerson(item, match))) {
        counter.removed += 1;
        return [];
      }
      return [scrubOwned(item, match, waifuId, counter)];
    });
  }
  if (isObject(node)) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, scrubOwned(value, match, waifuId, counter)]));
  return node;
}
