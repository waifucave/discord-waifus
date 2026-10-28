// `~/life/wakeups.json` (Living cast spec §30.3): every wakeup she has, one JSON array, one entry
// per line. It replaces `reminders.json` and `watches.json`. She may Read/Write/Edit it (and the
// `Wakeup` tool adds to it); every write runs these checks, including compiling each of her
// functions in the sandbox, and a failed check refuses the write with the exact problem:
//
//   error: wakeups.json line 7, column 3: expected "," or "]"
//   error: wakeups.json entry w3: until is in the past
//
// Entries:
//   {"id": "t4", "kind": "at", "when": "2026-10-30 18:00", "note": "…"}
//   {"id": "t5", "kind": "every", "when": "weekday 08:30", "note": "…"}
//   {"id": "w3", "kind": "watch", "places": "bake-club/#general", "filter": {"from": "Mina", "words": ["brownie"]},
//    "options": {"until": "2026-10-30 18:00", "once": true}, "note": "…"}
//   {"id": "w4", "kind": "watch", "places": "everywhere", "filter": "(msg, state) => …", "options": {…}, "note": "…", "state": {…}}
//   {"id": "p1", "kind": "page", "url": "https://…", "check": {"contains": "in stock"}, "options": {"every": "6h", "until": "…"}, "note": "…"}
//
// A new entry may leave out `id`; `at`'s `when` may be any `at()` time and `options.for` a duration:
// both are written back as local times, and the file is rewritten (one entry per line). The ids are
// `t<n>` (timed), `w<n>` (watch) and `p<n>` (page), never reused while a wake could still be queued.

import { createHash } from "node:crypto";
import type { ResolvedWatchBinding, WakeupSide } from "../../shared/schemas/life.js";
import { dayTimeText, parseLocalDateTime } from "../clock.js";
import { syntaxProblem, type CheckFailure, type PersonResolution } from "../home/specialFiles.js";
import type { SandboxCompileResult } from "../sandbox/index.js";
import { checkFunctionSource } from "./functionSource.js";
import { durationText, localMinute, parseAt, parseDuration, parseEvery } from "./when.js";

export const WAKEUPS_FILE_NAME = "wakeups.json";
export const MAX_TIMED = 20;
export const MAX_WAKEUP_WATCHES = 10;
export const MAX_PAGES = 3;
/** Her wakeups file as she (or the owner) writes it, and as the app saves her code's state into it. */
export const MAX_WAKEUPS_FILE_BYTES = 60 * 1024;
/**
 * What the app may make of it: the 4 KiB above hers is for stop reasons (`disabled`, each at most
 * `MAX_REASON_JSON_BYTES` as JSON, at most 13 watches and pages), so a disable is always written.
 */
export const WAKEUPS_FILE_HARD_BYTES = 64 * 1024;
export const MAX_REASON_JSON_BYTES = 290;
export const MAX_NOTE_CHARS = 200;
export const MAX_STATE_BYTES = 4 * 1024;
export const MAX_FILTER_OBJECTS = 5;
export const MAX_WORDS = 10;
export const MAX_WORD_CHARS = 60;
export const MAX_PLACES = 10;
export const AT_MIN_AHEAD_MS = 5 * 60_000;
export const AT_MAX_AHEAD_MS = 30 * 24 * 3_600_000;
export const WATCH_MAX_MS = 7 * 24 * 3_600_000;
export const PAGE_MIN_EVERY_MS = 3_600_000;
export const MAX_URL_CHARS = 2_000;
export const MAX_CONTAINS_CHARS = 200;
const MINUTE_SLACK_MS = 60_000;

export type WakeupKind = "at" | "every" | "watch" | "page";
export type ObjectFilter = { from?: string; words?: string[]; any?: boolean; place?: string };
export type PageCheck = { contains: string } | "changes" | string;

/** One wakeup as her file holds it (validated). */
export type WakeupEntry = {
  id: string;
  kind: WakeupKind;
  /** at: a local minute; every: her repeating time as written. */
  when?: string;
  /** watch: a handle, a list of handles, or "everywhere". */
  places?: string | string[];
  /** watch: an object filter, a list of them (any matches), or a function's source. */
  filter?: ObjectFilter | ObjectFilter[] | string;
  url?: string;
  check?: PageCheck;
  options?: { until?: string; once?: boolean; every?: string };
  note: string;
  state?: Record<string, unknown>;
  /** Why it stopped (three errors in a row, §30.2); a disabled wakeup never runs. */
  disabled?: string;
};

export const PREFIX: Record<WakeupKind, "t" | "w" | "p"> = { at: "t", every: "t", watch: "w", page: "p" };

/** The source text of an entry's function (filter or check), if it has one. */
export function functionSourceOf(entry: Pick<WakeupEntry, "kind" | "filter" | "check">): string | undefined {
  if (entry.kind === "watch" && typeof entry.filter === "string") return entry.filter;
  if (entry.kind === "page" && typeof entry.check === "string" && entry.check !== "changes") return entry.check;
  return undefined;
}

/** The object filters of a watch (a list either way); undefined for a function filter. */
export function objectFilters(entry: Pick<WakeupEntry, "filter">): ObjectFilter[] | undefined {
  if (typeof entry.filter === "string" || entry.filter === undefined) return undefined;
  return Array.isArray(entry.filter) ? entry.filter : [entry.filter];
}

export function untilOf(entry: WakeupEntry, timeZone: string): Date | undefined {
  return entry.options?.until ? parseLocalDateTime(entry.options.until, timeZone) : undefined;
}

export const sha256Text = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// ---- canonical text -------------------------------------------------------------------------------

const FIELD_ORDER = ["id", "kind", "when", "places", "url", "filter", "check", "options", "note", "state", "disabled"] as const;

function spaced(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spaced).join(", ")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${spaced(inner)}`).join(", ")}}`;
  return JSON.stringify(value);
}

export function entryRecord(entry: WakeupEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) if (entry[key] !== undefined) out[key] = entry[key];
  return out;
}

/** Her file in the app's layout: one entry per line. */
export function wakeupsText(entries: readonly WakeupEntry[]): string {
  if (entries.length === 0) return "[]\n";
  return `[\n${entries.map((entry) => `  ${spaced(entryRecord(entry))}`).join(",\n")}\n]\n`;
}

// ---- checks ---------------------------------------------------------------------------------------

export type WakeupCheckContext = {
  now: Date;
  timeZone: string;
  /** The entries saved now (an unchanged past `when`/`until` is kept: it is due, not new). */
  previous: readonly WakeupEntry[];
  side: WakeupSide;
  resolvePlace(handle: string): Promise<string | undefined>;
  resolvePerson(name: string): Promise<PersonResolution>;
  /** Compiles function sources in the sandbox. */
  compile(sources: string[]): Promise<SandboxCompileResult[]>;
  /** The owner turned web fetching off: no new or changed page (an unchanged one may stay, unchecked). */
  pagesOff?: boolean;
};

/** What a checked entry needs beside the file: how its places and names resolved. */
export type ResolvedWakeup = { placeKeys?: string[]; filters?: ResolvedWatchBinding[] };

export type EntryCheck = { ok: true; entry: WakeupEntry; resolved: ResolvedWakeup; rewritten: boolean } | { ok: false; problem: string };

export type WakeupsCheck = { ok: true; entries: WakeupEntry[]; side: WakeupSide; text: string; rewritten: boolean } | CheckFailure;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const chars = (text: string) => [...text].length;
const ID_PATTERN = /^[twp]\d{1,6}$/u;

const KIND_FIELDS: Record<WakeupKind, readonly string[]> = {
  at: ["id", "kind", "when", "note", "disabled"],
  every: ["id", "kind", "when", "note", "disabled"],
  watch: ["id", "kind", "places", "filter", "options", "note", "state", "disabled"],
  page: ["id", "kind", "url", "check", "options", "note", "state", "disabled"]
};
const EXAMPLES: Record<WakeupKind, string> = {
  at: '{"kind": "at", "when": "2026-10-30 18:00", "note": "…"}',
  every: '{"kind": "every", "when": "weekday 08:30", "note": "…"}',
  watch: '{"kind": "watch", "places": "bake-club/#general", "filter": {"from": "Mina"}, "options": {"for": "2h"}, "note": "…"}',
  page: '{"kind": "page", "url": "https://…", "check": "changes", "options": {"every": "6h", "for": "3d"}, "note": "…"}'
};

/** The end of a watch or page: `until` (a local minute) or `for` (a duration from now). */
function checkUntil(options: Record<string, unknown>, old: WakeupEntry | undefined, ctx: WakeupCheckContext, max: number): { ok: true; until: string; rewritten: boolean } | { ok: false; problem: string } {
  if (options["for"] !== undefined && options["until"] !== undefined) return { ok: false, problem: "give for or until in options, not both" };
  if (options["for"] !== undefined) {
    const duration = parseDuration(options["for"]);
    if (!duration.ok) return { ok: false, problem: `options.for: ${duration.error}` };
    if (duration.value > max) return { ok: false, problem: `options.for can be at most ${durationText(max)}` };
    const ends = new Date(Math.round((ctx.now.getTime() + duration.value) / 60_000) * 60_000);
    return { ok: true, until: localMinute(ends, ctx.timeZone), rewritten: true };
  }
  if (typeof options["until"] !== "string") return { ok: false, problem: 'options needs for (like "2h") or until (a local time like 2026-10-30 18:00)' };
  const until = options["until"];
  const ends = parseLocalDateTime(until, ctx.timeZone);
  if (!ends || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(until)) return { ok: false, problem: `options.until must be a local time like 2026-10-30 18:00, not ${JSON.stringify(until)}` };
  if (old?.options?.until !== until) {
    const ahead = ends.getTime() - ctx.now.getTime();
    if (ahead <= 0) return { ok: false, problem: "options.until is in the past" };
    if (ahead > max + MINUTE_SLACK_MS) return { ok: false, problem: `options.until can be at most ${durationText(max)} ahead` };
  }
  return { ok: true, until, rewritten: false };
}

async function checkObjectFilter(raw: unknown, index: number, oldResolved: ResolvedWatchBinding | undefined, oldFilter: ObjectFilter | undefined, ctx: WakeupCheckContext): Promise<{ ok: true; filter: ObjectFilter; resolved: ResolvedWatchBinding } | { ok: false; problem: string }> {
  const where = index >= 0 ? `filter ${index + 1}` : "filter";
  if (!isRecord(raw)) return { ok: false, problem: `${where} is an object like {"from": "Mina", "words": ["brownie"]}, a list of them, or a function` };
  const extra = Object.keys(raw).find((key) => !["from", "words", "any", "place"].includes(key));
  if (extra) return { ok: false, problem: `${where}: unknown field "${extra}" (a filter has from, words, any and place)` };
  const filter: ObjectFilter = {};
  const resolved: ResolvedWatchBinding = {};
  if (raw["place"] !== undefined) {
    if (typeof raw["place"] !== "string" || !raw["place"].trim()) return { ok: false, problem: `${where}: place is a place handle like bake-club/#general` };
    const placeKey = await ctx.resolvePlace(raw["place"]);
    if (!placeKey) return { ok: false, problem: `${where}: unknown place ${raw["place"]}; see places.md` };
    filter.place = raw["place"];
    resolved.placeKey = placeKey;
  }
  if (raw["from"] !== undefined) {
    if (typeof raw["from"] !== "string" || !raw["from"].trim() || raw["from"].length > 100) return { ok: false, problem: `${where}: from is a person's name (or <@id>)` };
    filter.from = raw["from"];
    if (oldFilter?.from === raw["from"] && oldResolved?.fromUserId) {
      resolved.fromUserId = oldResolved.fromUserId;
      if (oldResolved.fromName) resolved.fromName = oldResolved.fromName;
    } else {
      const person = await ctx.resolvePerson(raw["from"]);
      if (!person.ok) return { ok: false, problem: `${where}: ${person.error.replace(/^error:\s*/u, "")}` };
      resolved.fromUserId = person.userId;
      resolved.fromName = person.name;
    }
  }
  if (raw["words"] !== undefined) {
    const words = raw["words"];
    if (!Array.isArray(words) || words.length === 0 || words.length > MAX_WORDS) return { ok: false, problem: `${where}: words is a list of 1–${MAX_WORDS} words` };
    if (!words.every((word) => typeof word === "string" && word.trim() !== "" && chars(word) <= MAX_WORD_CHARS)) return { ok: false, problem: `${where}: each word is text of at most ${MAX_WORD_CHARS} characters` };
    filter.words = words as string[];
    resolved.words = (words as string[]).map((word) => word.trim());
  }
  if (raw["any"] !== undefined) {
    if (typeof raw["any"] !== "boolean") return { ok: false, problem: `${where}: any is true or false` };
    filter.any = raw["any"];
    if (raw["any"]) resolved.anyMessage = true;
  }
  if (filter.from === undefined && filter.words === undefined && filter.any !== true && filter.place === undefined) {
    return { ok: false, problem: `${where} needs from, words or any (any: true is any message)` };
  }
  return { ok: true, filter, resolved };
}

function checkState(raw: unknown): { ok: true; state: Record<string, unknown> | undefined } | { ok: false; problem: string } {
  if (raw === undefined) return { ok: true, state: undefined };
  if (!isRecord(raw)) return { ok: false, problem: "state is an object (or left out)" };
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_STATE_BYTES) return { ok: false, problem: `state can be at most ${MAX_STATE_BYTES / 1024} KiB` };
  return { ok: true, state: raw };
}

/**
 * One entry, without its id (checked by the caller) and without compiling its function (done for
 * the whole file at once): the rules of §30.2 and §30.3. `old`: the saved entry with the same id.
 */
export async function checkEntry(raw: unknown, ctx: WakeupCheckContext, old: WakeupEntry | undefined): Promise<EntryCheck> {
  if (!isRecord(raw)) return { ok: false, problem: `each wakeup is an object, like ${EXAMPLES.at}` };
  const kind = raw["kind"];
  if (kind !== "at" && kind !== "every" && kind !== "watch" && kind !== "page") return { ok: false, problem: 'kind is "at", "every", "watch" or "page"' };
  const extra = Object.keys(raw).find((key) => !KIND_FIELDS[kind].includes(key));
  if (extra) return { ok: false, problem: `unknown field "${extra}" (a ${kind} wakeup has ${KIND_FIELDS[kind].join(", ")})` };
  if (raw["note"] !== undefined && typeof raw["note"] !== "string") return { ok: false, problem: "note is text (a few words to yourself)" };
  const note = (raw["note"] as string | undefined) ?? "";
  if (chars(note) > MAX_NOTE_CHARS) return { ok: false, problem: `note can be at most ${MAX_NOTE_CHARS} characters` };
  if (raw["disabled"] !== undefined && typeof raw["disabled"] !== "string" && raw["disabled"] !== true) return { ok: false, problem: "disabled is the reason it stopped (remove it to turn it back on)" };
  const sameKind = old?.kind === kind ? old : undefined;
  const entry: WakeupEntry = { id: typeof raw["id"] === "string" ? raw["id"] : "", kind, note };
  let rewritten = raw["note"] === undefined;
  const resolved: ResolvedWakeup = {};
  if (kind === "at") {
    const due = parseAt(raw["when"], ctx.now, ctx.timeZone);
    if (!due.ok) return { ok: false, problem: due.error };
    const when = localMinute(due.value, ctx.timeZone);
    // An unchanged time is kept even when it has passed (it is due, not new).
    if (sameKind?.when !== when) {
      const ahead = due.value.getTime() - ctx.now.getTime();
      if (ahead < 0) return { ok: false, problem: `${when} is in the past` };
      if (ahead < AT_MIN_AHEAD_MS - MINUTE_SLACK_MS) return { ok: false, problem: "at must be at least 5 minutes ahead" };
      if (ahead > AT_MAX_AHEAD_MS) return { ok: false, problem: "at can be at most 30 days ahead" };
    }
    entry.when = when;
    if (raw["when"] !== when) rewritten = true;
  } else if (kind === "every") {
    const spec = parseEvery(raw["when"]);
    if (!spec.ok) return { ok: false, problem: spec.error };
    entry.when = (raw["when"] as string).trim().replace(/\s+/gu, " ");
    if (entry.when !== raw["when"]) rewritten = true;
  } else if (kind === "watch") {
    const places = raw["places"];
    const list = places === "everywhere" ? undefined : typeof places === "string" ? [places] : Array.isArray(places) ? places : null;
    if (list === null || (list !== undefined && (list.length === 0 || list.length > MAX_PLACES || !list.every((handle) => typeof handle === "string" && handle.trim() !== "")))) {
      return { ok: false, problem: `places is a place handle, a list of up to ${MAX_PLACES}, or "everywhere"` };
    }
    if (list) {
      const keys: string[] = [];
      for (const handle of list as string[]) {
        const key = await ctx.resolvePlace(handle);
        if (!key) return { ok: false, problem: `unknown place ${handle}; see places.md` };
        if (!keys.includes(key)) keys.push(key);
      }
      resolved.placeKeys = keys;
    }
    entry.places = places as string | string[];
    const filter = raw["filter"];
    if (typeof filter === "string") {
      entry.filter = filter;
    } else {
      const items = Array.isArray(filter) ? filter : filter === undefined ? undefined : [filter];
      if (!items) return { ok: false, problem: 'filter is required: an object like {"from": "Mina"}, a list of them, or a function' };
      if (items.length > MAX_FILTER_OBJECTS) return { ok: false, problem: `a filter list has at most ${MAX_FILTER_OBJECTS} objects` };
      const oldFilters = sameKind ? objectFilters(sameKind) : undefined;
      const oldResolved = ctx.side.watches[entry.id]?.filters;
      const filters: ObjectFilter[] = [];
      const resolvedFilters: ResolvedWatchBinding[] = [];
      for (let index = 0; index < items.length; index += 1) {
        const checked = await checkObjectFilter(items[index], Array.isArray(filter) ? index : -1, oldResolved?.[index], oldFilters?.[index], ctx);
        if (!checked.ok) return checked;
        filters.push(checked.filter);
        resolvedFilters.push(checked.resolved);
      }
      entry.filter = Array.isArray(filter) ? filters : filters[0]!;
      resolved.filters = resolvedFilters;
    }
    if (!isRecord(raw["options"])) return { ok: false, problem: 'options is required: {"for": "2h"} (at most 7 days), and once (default true)' };
    const options = raw["options"];
    const unknown = Object.keys(options).find((key) => !["for", "until", "once"].includes(key));
    if (unknown) return { ok: false, problem: `options: unknown field "${unknown}" (a watch has for or until, and once)` };
    const until = checkUntil(options, sameKind, ctx, WATCH_MAX_MS);
    if (!until.ok) return until;
    if (options["once"] !== undefined && typeof options["once"] !== "boolean") return { ok: false, problem: "options.once is true or false" };
    entry.options = { until: until.until, once: options["once"] !== false };
    if (until.rewritten || options["once"] === undefined) rewritten = true;
  } else {
    const url = raw["url"];
    if (typeof url !== "string" || chars(url) > MAX_URL_CHARS || !/^https?:\/\//iu.test(url.trim())) return { ok: false, problem: "url is a web address starting with https://" };
    try {
      new URL(url.trim());
    } catch {
      return { ok: false, problem: "url is a web address starting with https://" };
    }
    entry.url = url.trim();
    const check = raw["check"];
    if (check === "changes" || typeof check === "string") entry.check = check;
    else if (isRecord(check) && Object.keys(check).length === 1 && typeof check["contains"] === "string") {
      if (!check["contains"].trim() || chars(check["contains"]) > MAX_CONTAINS_CHARS) return { ok: false, problem: `check.contains is text of 1–${MAX_CONTAINS_CHARS} characters` };
      entry.check = { contains: check["contains"] };
    } else return { ok: false, problem: 'check is {"contains": "text"}, "changes" or a function (page, state) => …' };
    if (!isRecord(raw["options"])) return { ok: false, problem: 'options is required: {"every": "6h", "for": "3d"} (every at least 1h, for at most 7 days)' };
    const options = raw["options"];
    const unknown = Object.keys(options).find((key) => !["for", "until", "every"].includes(key));
    if (unknown) return { ok: false, problem: `options: unknown field "${unknown}" (a page has every, and for or until)` };
    const every = parseDuration(options["every"]);
    if (!every.ok) return { ok: false, problem: `options.every: ${every.error}` };
    if (every.value < PAGE_MIN_EVERY_MS) return { ok: false, problem: "options.every is at least 1h" };
    const until = checkUntil(options, sameKind, ctx, WATCH_MAX_MS);
    if (!until.ok) return until;
    entry.options = { every: String(options["every"]).trim(), until: until.until };
    if (until.rewritten) rewritten = true;
    const unchanged = sameKind !== undefined && sameKind.url === entry.url && JSON.stringify(sameKind.check) === JSON.stringify(entry.check) && JSON.stringify(sameKind.options) === JSON.stringify(entry.options);
    if (ctx.pagesOff && !unchanged) return { ok: false, problem: "web pages can't be checked: the owner turned page fetching off" };
  }
  if (kind === "watch" || kind === "page") {
    const state = checkState(raw["state"]);
    if (!state.ok) return state;
    if (state.state !== undefined) entry.state = state.state;
  }
  const source = functionSourceOf(entry);
  if (source !== undefined) {
    const checked = checkFunctionSource(source);
    if (!checked.ok) return { ok: false, problem: `its ${kind === "watch" ? "filter" : "check"}: ${checked.error}${checked.line !== undefined ? ` (line ${checked.line})` : ""}` };
  }
  if (raw["disabled"] !== undefined) {
    // Changing its code (or its filter, check or times) turns a disabled wakeup back on.
    const changed = !sameKind || JSON.stringify(stripRuntime(sameKind)) !== JSON.stringify(stripRuntime(entry));
    if (changed && sameKind?.disabled !== undefined) rewritten = true;
    else entry.disabled = raw["disabled"] === true ? "stopped" : (raw["disabled"] as string);
  }
  return { ok: true, entry, resolved, rewritten };
}

/** An entry without what changes as it runs (its state and disabled reason). */
function stripRuntime(entry: WakeupEntry): Omit<WakeupEntry, "state" | "disabled"> {
  const { state: _state, disabled: _disabled, ...rest } = entry;
  return rest;
}

/** Next free number for an id prefix (above every id seen and the counter). */
function nextNumber(prefix: string, ids: Iterable<string>, counter: number): number {
  let next = Math.max(1, counter);
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

export function countsOf(entries: readonly Pick<WakeupEntry, "kind">[]): { timed: number; watches: number; pages: number } {
  return {
    timed: entries.filter((entry) => entry.kind === "at" || entry.kind === "every").length,
    watches: entries.filter((entry) => entry.kind === "watch").length,
    pages: entries.filter((entry) => entry.kind === "page").length
  };
}

export function capProblem(counts: { timed: number; watches: number; pages: number }): string | undefined {
  if (counts.timed > MAX_TIMED) return `${counts.timed} timed wakeups (at and every); at most ${MAX_TIMED}`;
  if (counts.watches > MAX_WAKEUP_WATCHES) return `${counts.watches} watches; at most ${MAX_WAKEUP_WATCHES}`;
  if (counts.pages > MAX_PAGES) return `${counts.pages} pages; at most ${MAX_PAGES}`;
  return undefined;
}

/**
 * Checks the whole file (§30.3) and works out what goes beside it: ids for new entries, each watch's
 * resolved places and names, each `every`'s start, and side entries of removed wakeups dropped.
 */
export async function checkWakeupsText(text: string, ctx: WakeupCheckContext): Promise<WakeupsCheck> {
  const file = WAKEUPS_FILE_NAME;
  if (text.trim() === "") return { ok: true, entries: [], side: sideFor([], new Map(), ctx), text, rewritten: false };
  if (Buffer.byteLength(text, "utf8") > MAX_WAKEUPS_FILE_BYTES) return { ok: false, error: `error: ${file} can be at most ${MAX_WAKEUPS_FILE_BYTES / 1024} KiB` };
  const parsed = syntaxProblem(file, text);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, error: `error: ${file} must be a JSON array of wakeups, like [${EXAMPLES.at}]` };
  const raw = parsed.value;
  const previous = new Map(ctx.previous.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const checked: Array<{ entry: WakeupEntry; resolved: ResolvedWakeup; hadId: boolean }> = [];
  let rewritten = false;
  for (let index = 0; index < raw.length; index += 1) {
    const item = raw[index];
    const id = isRecord(item) && typeof item["id"] === "string" ? item["id"].trim() : undefined;
    const name = id || `${index + 1}`;
    const fail = (problem: string): CheckFailure => ({ ok: false, error: `error: ${file} entry ${name}: ${problem}` });
    if (isRecord(item) && item["id"] !== undefined) {
      if (typeof item["id"] !== "string" || !ID_PATTERN.test(item["id"])) return fail("id must be like t4, w3 or p1 (or left out for a new one)");
      const kind = item["kind"];
      if ((kind === "at" || kind === "every" || kind === "watch" || kind === "page") && item["id"][0] !== PREFIX[kind]) return fail(`a ${kind} wakeup's id starts with ${PREFIX[kind]}`);
      if (seen.has(item["id"])) return fail(`the id ${item["id"]} is used twice`);
      seen.add(item["id"]);
    }
    const result = await checkEntry(item, ctx, id ? previous.get(id) : undefined);
    if (!result.ok) return fail(result.problem);
    if (result.rewritten) rewritten = true;
    checked.push({ entry: result.entry, resolved: result.resolved, hadId: id !== undefined });
  }
  const cap = capProblem(countsOf(checked.map((item) => item.entry)));
  if (cap) return { ok: false, error: `error: ${file} has ${cap}` };
  // Her functions compile in the sandbox (its syntax errors, with lines).
  const withSource = checked.filter((item) => functionSourceOf(item.entry) !== undefined);
  if (withSource.length > 0) {
    const results = await ctx.compile(withSource.map((item) => functionSourceOf(item.entry)!));
    for (let index = 0; index < withSource.length; index += 1) {
      const result = results[index];
      if (result && !result.ok) {
        const item = withSource[index]!;
        const what = item.entry.kind === "watch" ? "filter" : "check";
        const where = result.error.line !== undefined ? ` (line ${result.error.line})` : "";
        const message = result.error.kind === "time" ? "it took too long to compile" : `${result.error.name}: ${result.error.message}${where}`;
        return { ok: false, error: `error: ${file} entry ${item.entry.id || withSource.indexOf(item) + 1}: its ${what}: ${message}` };
      }
    }
  }
  // New entries get the next free id of their kind.
  const counters = { ...ctx.side.nextId };
  const allIds = [...seen, ...ctx.previous.map((entry) => entry.id)];
  for (const prefix of ["t", "w", "p"] as const) counters[prefix] = nextNumber(prefix, allIds, counters[prefix]);
  for (const item of checked) {
    if (item.hadId) continue;
    const prefix = PREFIX[item.entry.kind];
    while (seen.has(`${prefix}${counters[prefix]}`)) counters[prefix] += 1;
    item.entry.id = `${prefix}${counters[prefix]}`;
    counters[prefix] += 1;
    seen.add(item.entry.id);
    rewritten = true;
  }
  const entries = checked.map((item) => item.entry);
  const resolvedById = new Map(checked.map((item) => [item.entry.id, item.resolved]));
  const finalText = rewritten ? wakeupsText(entries) : text;
  // As saved (ids added, `for` written as `until`): her file stays within her cap.
  if (Buffer.byteLength(finalText, "utf8") > MAX_WAKEUPS_FILE_BYTES) return { ok: false, error: `error: ${file} can be at most ${MAX_WAKEUPS_FILE_BYTES / 1024} KiB` };
  const side = sideFor(entries, resolvedById, { ...ctx, side: { ...ctx.side, nextId: counters } });
  return { ok: true, entries, side: { ...side, sourceHash: sha256Text(finalText) }, text: finalText, rewritten };
}

/** The side file after a write: kept for unchanged wakeups, fresh for new or changed ones. */
function sideFor(entries: readonly WakeupEntry[], resolved: ReadonlyMap<string, ResolvedWakeup>, ctx: WakeupCheckContext): WakeupSide {
  const previous = new Map(ctx.previous.map((entry) => [entry.id, entry]));
  const side = ctx.side;
  const watches: WakeupSide["watches"] = {};
  const every: WakeupSide["every"] = {};
  const pages: WakeupSide["pages"] = {};
  const errors: WakeupSide["errors"] = {};
  for (const entry of entries) {
    const old = previous.get(entry.id);
    const sameCode = old !== undefined && functionSourceOf(old) === functionSourceOf(entry) && old.disabled !== undefined === (entry.disabled !== undefined);
    if (sameCode && side.errors[entry.id] !== undefined) errors[entry.id] = side.errors[entry.id]!;
    if (entry.kind === "watch") {
      const r = resolved.get(entry.id) ?? {};
      watches[entry.id] = { ...(r.placeKeys ? { placeKeys: r.placeKeys } : {}), ...(r.filters ? { filters: r.filters } : {}), fires: side.watches[entry.id]?.fires ?? [] };
    } else if (entry.kind === "every") {
      const kept = side.every[entry.id];
      every[entry.id] = kept && kept.when === entry.when ? kept : { when: entry.when!, since: ctx.now.toISOString() };
    } else if (entry.kind === "page") {
      const kept = side.pages[entry.id];
      const same = old?.kind === "page" && old.url === entry.url && JSON.stringify(old.check) === JSON.stringify(entry.check);
      if (kept && same) pages[entry.id] = kept;
    }
  }
  return { ...side, watches, every, pages, errors };
}

// ---- reading -------------------------------------------------------------------------------------

/**
 * Her saved entries, read leniently (a broken file reads as what it can: the checks keep it from
 * being saved broken; the app never rewrites a file it can't read whole).
 */
export function readWakeupEntries(text: string | undefined): WakeupEntry[] {
  if (!text?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): WakeupEntry[] => {
    if (!isRecord(raw) || typeof raw["id"] !== "string" || !ID_PATTERN.test(raw["id"])) return [];
    const kind = raw["kind"];
    if (kind !== "at" && kind !== "every" && kind !== "watch" && kind !== "page") return [];
    const entry: WakeupEntry = { id: raw["id"], kind, note: typeof raw["note"] === "string" ? raw["note"] : "" };
    if (typeof raw["when"] === "string") entry.when = raw["when"];
    if (typeof raw["places"] === "string" || Array.isArray(raw["places"])) entry.places = raw["places"] as string | string[];
    if (typeof raw["filter"] === "string" || isRecord(raw["filter"]) || Array.isArray(raw["filter"])) entry.filter = raw["filter"] as WakeupEntry["filter"];
    if (typeof raw["url"] === "string") entry.url = raw["url"];
    if (typeof raw["check"] === "string" || isRecord(raw["check"])) entry.check = raw["check"] as PageCheck;
    if (isRecord(raw["options"])) entry.options = raw["options"] as WakeupEntry["options"];
    if (isRecord(raw["state"])) entry.state = raw["state"];
    if (typeof raw["disabled"] === "string") entry.disabled = raw["disabled"];
    else if (raw["disabled"] === true) entry.disabled = "stopped";
    return [entry];
  });
}

/** True when every entry of the array read (the app never rewrites a file it would lose part of). */
export function readsWhole(text: string | undefined, entries: number): boolean {
  if (!text?.trim()) return true;
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) && value.length === entries;
  } catch {
    return false;
  }
}

// ---- how a wakeup reads in her results -----------------------------------------------------------

export function placesText(places: WakeupEntry["places"]): string {
  if (places === undefined || places === "everywhere") return "everywhere";
  return typeof places === "string" ? places : places.join(", ");
}

/** `w4 (kingdom/#general, until Wed 28 Oct 14:02)`, `t5 (Fri 30 Oct 18:00)`, `p1 (every 6h, until Wed 4 Nov 14:00)`. */
export function summaryOf(entry: WakeupEntry, timeZone: string): string {
  const until = untilOf(entry, timeZone);
  const untilText = until ? `until ${dayTimeText(until, timeZone)}` : "";
  if (entry.kind === "at") {
    const due = entry.when ? parseLocalDateTime(entry.when, timeZone) : undefined;
    return `${entry.id} (${due ? dayTimeText(due, timeZone) : entry.when})`;
  }
  if (entry.kind === "every") return `${entry.id} (every ${entry.when})`;
  if (entry.kind === "watch") return `${entry.id} (${[Array.isArray(entry.filter) && entry.filter.length === 0 ? "timer" : placesText(entry.places), untilText, entry.options?.once === false ? "repeating" : ""].filter(Boolean).join(", ")})`;
  return `${entry.id} (${[`every ${entry.options?.every}`, untilText].filter(Boolean).join(", ")})`;
}
