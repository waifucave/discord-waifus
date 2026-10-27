// The transcript store (Living cast spec §18.2): one shared, read-only record of what was said in
// every conversation a waifu is in, kept forever (T1: only a forget and Discord deletes remove lines).
//
//   user/transcripts/store.json                      {startedAt}: no line older than this is written
//   user/transcripts/<conversationKey>/<day>.jsonl   one line per message, days in the host time zone
//   user/transcripts/<conversationKey>/meta.json     {floor?, removed?, deleted?}: a DM forget floor, the ids
//                                                    a forget removed (never written again) and the ids a
//                                                    Discord delete removed (kept a day: a stale REST page)
//   user/transcripts/access/<waifuId>.json           per room conversation, the intervals she was cast there
//
// Every write of a conversation goes through one in-process queue per conversation (like the image
// index). A new line that sorts after the day's last line is appended (the common case); an edit, a
// delete, an out-of-order gap fill and every forget rewrite the day file atomically. A crash in the
// middle of an append can leave a torn last line: readers skip lines that do not parse, the next
// append starts on a new line, and the next rewrite of that day drops it. Access files have a queue
// per waifu. An in-memory cache per conversation (its meta, and per recent day the ids and the last
// line, checked against the files' size and time) keeps an append to one stat, no parse.
//
// Pure storage: nothing here knows Discord or the life; the writer (`writer.ts`) feeds it and her
// view (`view.ts`) renders it.

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveDataPath } from "../../config/paths.js";
import { atomicWriteJson, atomicWriteText } from "../../storage/atomic.js";
import { compareIds } from "../../discord/rawMessage.js";
import { parseConversationKey } from "../../orchestration/context/keys.js";
import { localDayKey } from "../clock.js";

export const TRANSCRIPTS_DIR = ["user", "transcripts"] as const;
export const ACCESS_DIR = "access";
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;

export const TranscriptLineSchema = z.object({
  /** The Discord message id. */
  id: z.string().min(1),
  /** Its ref (§22.1: assigned when the line is written; lines written before 3.3.0 have none). */
  ref: z.string().optional(),
  /** When it was written (ISO). */
  at: z.string().min(1),
  authorId: z.string().min(1),
  /** The author's display name at the time. */
  author: z.string(),
  /** Set when a waifu wrote it: which one. */
  waifu: z.string().optional(),
  /** The message it replies to (an id; rendered as its ref or its author). */
  reply: z.string().optional(),
  /** The text as rendered for her (mentions as names, custom emoji as `:name:`). */
  text: z.string(),
  /** Attachment names. */
  files: z.array(z.string()).optional(),
  edited: z.literal(true).optional(),
  /** User ids the message mentions (forget matches them). */
  mentions: z.array(z.string()).optional()
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

export type TranscriptInterval = { from: string; to?: string };
export type TranscriptAccess = { conversations: Record<string, TranscriptInterval[]> };

export type TranscriptEnv = { dataRoot: string; timeZone: string };

// ---- paths -------------------------------------------------------------------------------------------

export function transcriptsRoot(dataRoot: string): string {
  return resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR);
}

function conversationDir(dataRoot: string, key: string): string {
  if (!parseConversationKey(key)) throw new Error(`Invalid conversation key: ${String(key)}`);
  return resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR, key);
}

function dayPath(dataRoot: string, key: string, day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) throw new Error(`Invalid day: ${day}`);
  return path.join(conversationDir(dataRoot, key), `${day}.jsonl`);
}

function accessPath(dataRoot: string, waifuId: string): string {
  if (!/^[A-Za-z0-9._:-]+$/u.test(waifuId) || /^\.+$/u.test(waifuId)) throw new Error(`Invalid waifu id: ${waifuId}`);
  return resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR, ACCESS_DIR, `${waifuId}.json`);
}

/** The local day (host time zone) a line belongs to. */
export function transcriptDay(at: string | Date, timeZone: string): string {
  return localDayKey(typeof at === "string" ? new Date(at) : at, timeZone);
}

// ---- queues ------------------------------------------------------------------------------------------

const queues = new Map<string, Promise<unknown>>();

/** Runs `task` after everything queued before it under the same name (per data root). */
export function enqueueTranscript<T>(dataRoot: string, name: string, task: () => Promise<T>): Promise<T> {
  const id = `${dataRoot}\u0000${name}`;
  const previous = queues.get(id) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(id, tail);
  void tail.then(() => {
    if (queues.get(id) === tail) queues.delete(id);
  });
  return run;
}

/** Waits for every queued transcript write (tests, shutdown). */
export async function settleTranscripts(): Promise<void> {
  while (queues.size > 0) await Promise.allSettled([...queues.values()]);
}

// ---- reading -----------------------------------------------------------------------------------------

function parseLines(raw: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    try {
      const parsed = TranscriptLineSchema.safeParse(JSON.parse(text));
      if (parsed.success) out.push(parsed.data);
    } catch {
      // a torn last line (a crash mid-append): skipped, dropped at the next rewrite
    }
  }
  return out;
}

export function compareLines(a: Pick<TranscriptLine, "at" | "id">, b: Pick<TranscriptLine, "at" | "id">): number {
  const ta = Date.parse(a.at);
  const tb = Date.parse(b.at);
  if (ta !== tb) return ta - tb;
  return compareIds(a.id, b.id);
}

/** One day of a conversation, oldest first (empty when there is none). */
export async function readTranscriptDay(dataRoot: string, key: string, day: string): Promise<TranscriptLine[]> {
  let raw: string;
  try {
    raw = await readFile(dayPath(dataRoot, key, day), "utf8");
  } catch {
    return [];
  }
  return parseLines(raw).sort(compareLines);
}

/** A stored line read without the schema (searches read many): the fields every line has, checked by type. */
function liteLine(value: unknown): TranscriptLine | undefined {
  if (!value || typeof value !== "object") return undefined;
  const line = value as Record<string, unknown>;
  if (typeof line.id !== "string" || typeof line.at !== "string" || typeof line.authorId !== "string" || typeof line.author !== "string" || typeof line.text !== "string") return undefined;
  return line as unknown as TranscriptLine;
}

/** One day for a search (§22.2): parsed without the schema, oldest first, with the bytes read. */
export async function readTranscriptDayLite(dataRoot: string, key: string, day: string): Promise<{ lines: TranscriptLine[]; bytes: number }> {
  let raw: string;
  try {
    raw = await readFile(dayPath(dataRoot, key, day), "utf8");
  } catch {
    return { lines: [], bytes: 0 };
  }
  const lines: TranscriptLine[] = [];
  for (const text of raw.split("\n")) {
    if (!text.trim()) continue;
    try {
      const line = liteLine(JSON.parse(text));
      if (line) lines.push(line);
    } catch {
      // a torn last line
    }
  }
  return { lines: lines.sort(compareLines), bytes: raw.length };
}

/** The newest line a conversation has (whoever could see it), or undefined. */
export async function newestTranscriptLine(dataRoot: string, key: string): Promise<TranscriptLine | undefined> {
  const days = await listTranscriptDays(dataRoot, key);
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const { lines } = await readTranscriptDayLite(dataRoot, key, days[index]!);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return undefined;
}

/** Whether the conversation already has this message's line (the cached day index: one stat). */
export async function transcriptHasLine(env: TranscriptEnv, key: string, line: Pick<TranscriptLine, "id" | "at">): Promise<boolean> {
  return (await dayIndex(env.dataRoot, key, transcriptDay(line.at, env.timeZone))).ids.has(line.id);
}

/**
 * The line a ref names in a conversation (§22.1: a ref pruned from `refs.json` still resolves while
 * its line exists), newest day first. Refs are not in day order (a gap fill writes new refs into
 * older days), so every day is looked at, each first as text (a day without the ref is not parsed).
 * `accept`: a line the reader may see (forgotten people, a DM floor).
 */
export async function findTranscriptRef(dataRoot: string, key: string, ref: string, accept: (line: TranscriptLine) => boolean = () => true): Promise<TranscriptLine | undefined> {
  if (!/^[0-9a-z]{2,8}$/u.test(ref)) return undefined;
  const needle = `"ref":"${ref}"`;
  const days = await listTranscriptDays(dataRoot, key);
  for (let index = days.length - 1; index >= 0; index -= 1) {
    let raw: string;
    try {
      raw = await readFile(dayPath(dataRoot, key, days[index]!), "utf8");
    } catch {
      continue;
    }
    if (!raw.includes(needle)) continue;
    for (const text of raw.split("\n")) {
      if (!text.includes(needle)) continue;
      try {
        const line = liteLine(JSON.parse(text));
        if (line?.ref === ref) return accept(line) ? line : undefined;
      } catch {
        // a torn line
      }
    }
  }
  return undefined;
}

/**
 * The refs stored on the lines of these messages (`refs.json` may have pruned them): the day files
 * their times fall on are read once each.
 */
export async function transcriptRefsOf(env: TranscriptEnv, key: string, messages: ReadonlyArray<{ id: string; at: string }>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messages.length === 0) return out;
  const wanted = new Set(messages.map((message) => message.id));
  for (const day of new Set(messages.map((message) => transcriptDay(message.at, env.timeZone)))) {
    for (const line of (await readTranscriptDayLite(env.dataRoot, key, day)).lines) if (line.ref && wanted.has(line.id)) out.set(line.id, line.ref);
  }
  return out;
}

/** The day file's size and time (undefined when there is none). */
export async function transcriptDayStat(dataRoot: string, key: string, day: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(dayPath(dataRoot, key, day));
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

/** The days a conversation has, oldest first. */
export async function listTranscriptDays(dataRoot: string, key: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(conversationDir(dataRoot, key));
  } catch {
    return [];
  }
  return names.flatMap((name) => DAY_FILE.exec(name)?.[1] ?? []).sort();
}

/** Every conversation with a transcript folder. */
export async function listTranscriptConversations(dataRoot: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(transcriptsRoot(dataRoot));
  } catch {
    return [];
  }
  return names.filter((name) => name !== ACCESS_DIR && parseConversationKey(name) !== undefined).sort();
}

// ---- store.json and meta.json ------------------------------------------------------------------------

const startedCache = new Map<string, string>();

/** When the store started (written on first use): no line older than this is ever written. */
export async function transcriptsStartedAt(dataRoot: string, now: Date): Promise<string> {
  const cached = startedCache.get(dataRoot);
  if (cached) return cached;
  return enqueueTranscript(dataRoot, "store", async () => {
    const file = resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR, "store.json");
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { startedAt?: unknown };
      if (typeof parsed.startedAt === "string" && Number.isFinite(Date.parse(parsed.startedAt))) {
        startedCache.set(dataRoot, parsed.startedAt);
        return parsed.startedAt;
      }
    } catch {
      // first use (or unreadable: a new start time)
    }
    const startedAt = now.toISOString();
    await atomicWriteJson(file, { startedAt });
    startedCache.set(dataRoot, startedAt);
    return startedAt;
  });
}

/** The start time when one was written (no write). */
export async function readTranscriptsStartedAt(dataRoot: string): Promise<string | undefined> {
  const cached = startedCache.get(dataRoot);
  if (cached) return cached;
  try {
    const parsed = JSON.parse(await readFile(resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR, "store.json"), "utf8")) as { startedAt?: unknown };
    return typeof parsed.startedAt === "string" ? parsed.startedAt : undefined;
  } catch {
    return undefined;
  }
}

/** How long a Discord delete's id is remembered (a stale REST page or catch-up right after it). */
export const DELETED_MEMORY_MS = 86_400_000;

/** meta.json as stored. `removed` are a forget's ids (and, before deletes were kept apart, a delete's). */
type MetaFile = { floor?: string; removed?: string[]; deleted?: Record<string, string> };
/** meta.json as used. */
type Meta = { floor?: string; removed: Set<string>; deleted: Map<string, string> };

type FileStamp = { size: number; mtimeMs: number } | undefined;
type DayCache = { stamp: FileStamp; ids: Set<string>; last?: TranscriptLine; newline: boolean };
type ConversationCache = { meta?: { stamp: FileStamp; value: Meta }; days: Map<string, DayCache> };

const CACHED_CONVERSATIONS = 512;
const CACHED_DAYS = 4;
const conversationCache = new Map<string, ConversationCache>();

function cacheOf(dataRoot: string, key: string): ConversationCache {
  const id = `${dataRoot}\u0000${key}`;
  let entry = conversationCache.get(id);
  if (entry) {
    conversationCache.delete(id);
    conversationCache.set(id, entry);
    return entry;
  }
  entry = { days: new Map() };
  conversationCache.set(id, entry);
  if (conversationCache.size > CACHED_CONVERSATIONS) conversationCache.delete(conversationCache.keys().next().value!);
  return entry;
}

function dropCache(dataRoot: string, key: string): void {
  conversationCache.delete(`${dataRoot}\u0000${key}`);
}

async function stampOf(file: string): Promise<FileStamp> {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

const sameStamp = (a: FileStamp, b: FileStamp) => (a === undefined ? b === undefined : b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs);

function metaPath(dataRoot: string, key: string): string {
  return path.join(conversationDir(dataRoot, key), "meta.json");
}

async function readMeta(dataRoot: string, key: string): Promise<Meta> {
  const cache = cacheOf(dataRoot, key);
  const file = metaPath(dataRoot, key);
  const stamp = await stampOf(file);
  if (cache.meta && sameStamp(cache.meta.stamp, stamp)) return cache.meta.value;
  const value: Meta = { removed: new Set(), deleted: new Map() };
  if (stamp) {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as MetaFile;
      if (typeof parsed.floor === "string") value.floor = parsed.floor;
      if (Array.isArray(parsed.removed)) for (const id of parsed.removed) if (typeof id === "string") value.removed.add(id);
      if (parsed.deleted && typeof parsed.deleted === "object") {
        for (const [id, at] of Object.entries(parsed.deleted)) if (typeof at === "string") value.deleted.set(id, at);
      }
    } catch {
      // unreadable: nothing remembered (a forget writes it again)
    }
  }
  cache.meta = { stamp, value };
  return value;
}

async function writeMeta(dataRoot: string, key: string, meta: Meta): Promise<void> {
  // Discord deletes are remembered a day; a forget's ids and the floor for good.
  const cutoff = Date.now() - DELETED_MEMORY_MS;
  for (const [id, at] of meta.deleted) if (!(Date.parse(at) > cutoff)) meta.deleted.delete(id);
  const file = metaPath(dataRoot, key);
  const stored: MetaFile = {
    ...(meta.floor !== undefined ? { floor: meta.floor } : {}),
    ...(meta.removed.size > 0 ? { removed: [...meta.removed] } : {}),
    ...(meta.deleted.size > 0 ? { deleted: Object.fromEntries(meta.deleted) } : {})
  };
  await atomicWriteJson(file, stored);
  cacheOf(dataRoot, key).meta = { stamp: await stampOf(file), value: meta };
}

/** A Discord delete of this id within `DELETED_MEMORY_MS`. */
function recentlyDeleted(meta: Meta, id: string): boolean {
  const at = meta.deleted.get(id);
  return at !== undefined && Date.parse(at) > Date.now() - DELETED_MEMORY_MS;
}

/** The ids and last line of one day (cached; read again when the file changed underneath). */
async function dayIndex(dataRoot: string, key: string, day: string): Promise<DayCache> {
  const cache = cacheOf(dataRoot, key);
  const file = dayPath(dataRoot, key, day);
  const stamp = await stampOf(file);
  const cached = cache.days.get(day);
  if (cached && sameStamp(cached.stamp, stamp)) return cached;
  let raw = "";
  if (stamp) {
    try {
      raw = await readFile(file, "utf8");
    } catch {
      raw = "";
    }
  }
  const lines = parseLines(raw).sort(compareLines);
  const entry: DayCache = { stamp, ids: new Set(lines.map((line) => line.id)), ...(lines.length > 0 ? { last: lines[lines.length - 1]! } : {}), newline: raw.length === 0 || raw.endsWith("\n") };
  rememberDay(cache, day, entry);
  return entry;
}

function rememberDay(cache: ConversationCache, day: string, entry: DayCache): void {
  cache.days.delete(day);
  cache.days.set(day, entry);
  while (cache.days.size > CACHED_DAYS) cache.days.delete(cache.days.keys().next().value!);
}

/** A line at or below a DM forget floor (a snowflake made from the forget time). */
export function atOrBelowFloor(line: Pick<TranscriptLine, "id" | "at">, floor: string | undefined): boolean {
  if (floor === undefined) return false;
  if (/^\d+$/u.test(line.id) && /^\d+$/u.test(floor)) return compareIds(line.id, floor) <= 0;
  const floorTime = floorTimeMs(floor);
  return floorTime !== undefined && Date.parse(line.at) <= floorTime;
}

function floorTimeMs(floor: string): number | undefined {
  if (!/^\d{1,20}$/u.test(floor)) return undefined;
  return Number((BigInt(floor) >> 22n) + 1_420_070_400_000n);
}

function laterOf(a: string | undefined, b: string): string {
  if (a === undefined) return b;
  return compareIds(a, b) >= 0 ? a : b;
}

// ---- writing -----------------------------------------------------------------------------------------

async function writeDay(dataRoot: string, key: string, day: string, lines: readonly TranscriptLine[]): Promise<void> {
  const file = dayPath(dataRoot, key, day);
  const cache = cacheOf(dataRoot, key);
  if (lines.length === 0) {
    await rm(file, { force: true });
    cache.days.delete(day);
    return;
  }
  const sorted = [...lines].sort(compareLines);
  await atomicWriteText(file, sorted.map((line) => JSON.stringify(line)).join("\n") + "\n", { durable: false });
  rememberDay(cache, day, { stamp: await stampOf(file), ids: new Set(sorted.map((line) => line.id)), last: sorted[sorted.length - 1]!, newline: true });
}

export type AddOutcome = "added" | "exists" | "skipped";

/**
 * A message's line: appended (or inserted in order) unless the conversation already has it, a forget
 * or a Discord delete removed it, it is at or below the DM forget floor, or it is older than the store.
 */
export async function addTranscriptLine(env: TranscriptEnv, key: string, line: TranscriptLine, o: { startedAt?: string } = {}): Promise<AddOutcome> {
  return enqueueTranscript(env.dataRoot, `c:${key}`, async () => {
    if (o.startedAt !== undefined && Date.parse(line.at) < Date.parse(o.startedAt)) return "skipped";
    const meta = await readMeta(env.dataRoot, key);
    if (meta.removed.has(line.id) || recentlyDeleted(meta, line.id) || atOrBelowFloor(line, meta.floor)) return "skipped";
    const day = transcriptDay(line.at, env.timeZone);
    const index = await dayIndex(env.dataRoot, key, day);
    if (index.ids.has(line.id)) return "exists";
    const parsed = TranscriptLineSchema.parse(line);
    if (!index.last || compareLines(index.last, parsed) < 0) {
      const file = dayPath(env.dataRoot, key, day);
      await mkdir(path.dirname(file), { recursive: true });
      // After a torn last line (a crash mid-append) the new line starts on a line of its own.
      await appendFile(file, `${index.newline ? "" : "\n"}${JSON.stringify(parsed)}\n`, { mode: 0o600 });
      index.ids.add(parsed.id);
      index.last = parsed;
      index.newline = true;
      index.stamp = await stampOf(file);
      return "added";
    }
    await writeDay(env.dataRoot, key, day, [...(await readTranscriptDay(env.dataRoot, key, day)), parsed]);
    return "added";
  });
}

/**
 * An edit: the line is replaced (a message the store never had stays out). It is marked edited when
 * the message says so (its `editedAt`) or was before; an update that changes nothing (an embed
 * unfurl, a pin) writes nothing.
 */
export async function editTranscriptLine(env: TranscriptEnv, key: string, line: TranscriptLine): Promise<boolean> {
  return enqueueTranscript(env.dataRoot, `c:${key}`, async () => {
    const day = transcriptDay(line.at, env.timeZone);
    const lines = await readTranscriptDay(env.dataRoot, key, day);
    const index = lines.findIndex((existing) => existing.id === line.id);
    if (index < 0) return false;
    const current = lines[index]!;
    const { edited: _edited, ...rest } = line;
    const next: TranscriptLine = TranscriptLineSchema.parse({ ...rest, at: current.at, ...(rest.ref ?? current.ref ? { ref: rest.ref ?? current.ref } : {}), ...(line.edited || current.edited ? { edited: true } : {}) });
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    lines[index] = next;
    await writeDay(env.dataRoot, key, day, lines);
    return true;
  });
}

/**
 * Discord deletes: the lines go and their ids are remembered so a stale REST page never writes them
 * again. `hint` is a time near the message (its snowflake time) to find its day without a scan.
 */
export async function deleteTranscriptLines(env: TranscriptEnv, key: string, ids: readonly string[], hint?: (id: string) => number | undefined): Promise<number> {
  if (ids.length === 0) return 0;
  return enqueueTranscript(env.dataRoot, `c:${key}`, async () => {
    const wanted = new Set(ids);
    const days = await listTranscriptDays(env.dataRoot, key);
    if (days.length === 0) return 0;
    const hinted = new Set<string>();
    for (const id of ids) {
      const at = hint?.(id);
      if (at === undefined) continue;
      for (const offset of [-1, 0, 1]) hinted.add(transcriptDay(new Date(at + offset * 86_400_000), env.timeZone));
    }
    const allHinted = ids.every((id) => hint?.(id) !== undefined);
    let removed = 0;
    for (const day of allHinted ? days.filter((candidate) => hinted.has(candidate)) : days) {
      const lines = await readTranscriptDay(env.dataRoot, key, day);
      const kept = lines.filter((line) => !wanted.has(line.id));
      if (kept.length === lines.length) continue;
      removed += lines.length - kept.length;
      await writeDay(env.dataRoot, key, day, kept);
    }
    const meta = await readMeta(env.dataRoot, key);
    const at = new Date().toISOString();
    for (const id of ids) meta.deleted.set(id, at);
    await writeMeta(env.dataRoot, key, meta);
    return removed;
  });
}

/**
 * A forget: every line `drop` matches goes from every day of the conversation, remembered as removed.
 * Returns how many went.
 */
export async function scrubTranscriptLines(env: TranscriptEnv, key: string, drop: (line: TranscriptLine) => boolean): Promise<number> {
  return enqueueTranscript(env.dataRoot, `c:${key}`, async () => {
    let removed = 0;
    const removedIds: string[] = [];
    for (const day of await listTranscriptDays(env.dataRoot, key)) {
      const lines = await readTranscriptDay(env.dataRoot, key, day);
      const kept = lines.filter((line) => !drop(line));
      if (kept.length === lines.length) continue;
      removed += lines.length - kept.length;
      for (const line of lines) if (drop(line)) removedIds.push(line.id);
      await writeDay(env.dataRoot, key, day, kept);
    }
    if (removedIds.length > 0) {
      const meta = await readMeta(env.dataRoot, key);
      for (const id of removedIds) meta.removed.add(id);
      await writeMeta(env.dataRoot, key, meta);
    }
    return removed;
  });
}

/**
 * A DM forget: the lines at or below the floor go and the floor is kept, so nothing at or below it is
 * ever written again (a REST catch-up included). Lines above it (a chat started after the forget) stay.
 */
export async function forgetTranscriptAtOrBelow(env: TranscriptEnv, key: string, floor: string): Promise<number> {
  return enqueueTranscript(env.dataRoot, `c:${key}`, async () => {
    // No transcript yet: nothing to remove, and the DM's own floor keeps old messages out of the feed.
    if (!(await stat(conversationDir(env.dataRoot, key)).then((info) => info.isDirectory(), () => false))) return 0;
    let removed = 0;
    for (const day of await listTranscriptDays(env.dataRoot, key)) {
      const lines = await readTranscriptDay(env.dataRoot, key, day);
      const kept = lines.filter((line) => !atOrBelowFloor(line, floor));
      if (kept.length === lines.length) continue;
      removed += lines.length - kept.length;
      await writeDay(env.dataRoot, key, day, kept);
    }
    const meta = await readMeta(env.dataRoot, key);
    const next = laterOf(meta.floor, floor);
    // The ids at or below the floor are covered by it now; those above it stay remembered.
    const above = (id: string) => !/^\d+$/u.test(id) || compareIds(id, next) > 0;
    await writeMeta(env.dataRoot, key, {
      floor: next,
      removed: new Set([...meta.removed].filter(above)),
      deleted: new Map([...meta.deleted].filter(([id]) => above(id)))
    });
    return removed;
  });
}

/** Whether a conversation has any transcript line. */
export async function hasTranscript(dataRoot: string, key: string): Promise<boolean> {
  return (await listTranscriptDays(dataRoot, key)).length > 0;
}

/** Removes a conversation's folder whole (a thread deleted on Discord keeps its transcript: not used for that). */
export async function removeTranscriptConversation(dataRoot: string, key: string): Promise<void> {
  await enqueueTranscript(dataRoot, `c:${key}`, async () => {
    await rm(conversationDir(dataRoot, key), { recursive: true, force: true });
    dropCache(dataRoot, key);
  });
}

// ---- access intervals --------------------------------------------------------------------------------

function parseAccess(value: unknown): TranscriptAccess {
  const out: TranscriptAccess = { conversations: {} };
  const conversations = value && typeof value === "object" ? (value as { conversations?: unknown }).conversations : undefined;
  if (!conversations || typeof conversations !== "object") return out;
  for (const [key, intervals] of Object.entries(conversations as Record<string, unknown>)) {
    if (!parseConversationKey(key) || !Array.isArray(intervals)) continue;
    const list = intervals.flatMap((entry): TranscriptInterval[] => {
      if (!entry || typeof entry !== "object") return [];
      const { from, to } = entry as { from?: unknown; to?: unknown };
      if (typeof from !== "string" || !Number.isFinite(Date.parse(from))) return [];
      return [{ from, ...(typeof to === "string" && Number.isFinite(Date.parse(to)) ? { to } : {}) }];
    });
    if (list.length > 0) out.conversations[key] = list;
  }
  return out;
}

/** Her room intervals (a DM is hers whole and is never listed here). */
export async function readTranscriptAccess(dataRoot: string, waifuId: string): Promise<TranscriptAccess> {
  try {
    return parseAccess(JSON.parse(await readFile(accessPath(dataRoot, waifuId), "utf8")));
  } catch {
    return { conversations: {} };
  }
}

/** Every waifu with an access file. */
export async function listAccessWaifuIds(dataRoot: string): Promise<string[]> {
  try {
    return (await readdir(resolveDataPath(dataRoot, ...TRANSCRIPTS_DIR, ACCESS_DIR))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

export async function updateTranscriptAccess(dataRoot: string, waifuId: string, transform: (access: TranscriptAccess) => TranscriptAccess | undefined): Promise<TranscriptAccess> {
  return enqueueTranscript(dataRoot, `a:${waifuId}`, async () => {
    const current = await readTranscriptAccess(dataRoot, waifuId);
    const next = transform(structuredClone(current));
    if (!next || JSON.stringify(next) === JSON.stringify(current)) return current;
    await atomicWriteJson(accessPath(dataRoot, waifuId), next);
    return next;
  });
}

/**
 * The cast of a room conversation right now: an interval opens (at `at`) for every cast waifu
 * without an open one, and closes (at `at`) for every waifu with an open one who is no longer cast.
 */
/**
 * Opens an interval for each waifu cast and without one (at `open`), closes the open interval of each
 * waifu no longer cast (at `close`, never before it began).
 */
export async function reconcileRoomAccess(dataRoot: string, key: string, castWaifuIds: readonly string[], at: Date | { open: Date; close: Date }, known: readonly string[]): Promise<void> {
  const openAt = at instanceof Date ? at : at.open;
  const closeAt = at instanceof Date ? at : at.close;
  const cast = new Set(castWaifuIds);
  for (const waifuId of new Set([...castWaifuIds, ...known])) {
    await updateTranscriptAccess(dataRoot, waifuId, (access) => {
      const intervals = access.conversations[key] ?? [];
      const open = intervals.find((interval) => interval.to === undefined);
      if (cast.has(waifuId) && !open) {
        access.conversations[key] = [...intervals, { from: openAt.toISOString() }];
        return access;
      }
      if (!cast.has(waifuId) && open) {
        open.to = new Date(Math.max(Date.parse(open.from), closeAt.getTime())).toISOString();
        return access;
      }
      return undefined;
    });
  }
}

/** True when `at` is inside one of the intervals. */
export function insideIntervals(intervals: readonly TranscriptInterval[], at: string): boolean {
  const time = Date.parse(at);
  return intervals.some((interval) => time >= Date.parse(interval.from) && (interval.to === undefined || time < Date.parse(interval.to)));
}

/** True when the local day overlaps one of the intervals. */
export function dayInsideIntervals(intervals: readonly TranscriptInterval[], day: string, timeZone: string, now: Date): boolean {
  return intervals.some((interval) => {
    const first = transcriptDay(interval.from, timeZone);
    const last = transcriptDay(interval.to ?? now.toISOString(), timeZone);
    return day >= first && day <= last;
  });
}

/** Drops conversations from every access file (a forget of a DM, or a removed conversation). */
export async function dropAccessConversations(dataRoot: string, keys: ReadonlySet<string>): Promise<void> {
  for (const waifuId of await listAccessWaifuIds(dataRoot)) {
    await updateTranscriptAccess(dataRoot, waifuId, (access) => {
      let changed = false;
      for (const key of Object.keys(access.conversations)) {
        if (!keys.has(key)) continue;
        delete access.conversations[key];
        changed = true;
      }
      return changed ? access : undefined;
    });
  }
}
