// Her reminder and watch files (Living cast spec §16.4, §16.5, T9): `~/schedule.json` and
// `~/watches.json` are JSON arrays she edits like any file. Every write — her Write/Edit, a Bash
// change set, the owner's API PUT — goes through these checks first; a failed check returns the
// exact problem and nothing is written:
//
//   error: watches.json line 7, column 3: expected "," or "]"
//   error: watches.json entry w3: timeout is in the past
//
// The parser is a small strict JSON reader of our own, so the messages say the same thing on every
// Node version. A new entry may leave out `id`; it gets the next free one and the file is rewritten
// with it (otherwise her text is kept byte for byte).

import { localParts, parseLocalDateTime } from "../clock.js";

export const MAX_REMINDERS = 20;
export const MAX_WATCHES = 10;
export const MAX_NOTE_CHARS = 200;
export const MAX_BINDINGS = 5;
export const MAX_WORDS = 10;
export const MAX_WORD_CHARS = 60;
export const REMINDER_MIN_AHEAD_MS = 5 * 60_000;
export const REMINDER_MAX_AHEAD_MS = 30 * 24 * 3_600_000;
export const WATCH_MAX_AHEAD_MS = 7 * 24 * 3_600_000;
/** Times are minutes: a time this close to a bound still counts as inside it. */
const MINUTE_SLACK_MS = 60_000;

// ---- a strict JSON reader with line and column ---------------------------------------------------

export type JsonPosition = { line: number; column: number };
export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: JsonPosition
  ) {
    super(message);
  }
}

/** Parses strict JSON (RFC 8259); errors carry the line and column of the problem. */
export function parseStrictJson(text: string): unknown {
  let index = 0;
  const position = (at: number): JsonPosition => {
    let line = 1;
    let column = 1;
    for (let i = 0; i < at && i < text.length; i += 1) {
      if (text[i] === "\n") {
        line += 1;
        column = 1;
      } else column += 1;
    }
    return { line, column };
  };
  const fail = (message: string, at = index): never => {
    throw new JsonSyntaxError(message, position(at));
  };
  const skip = () => {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\n" || text[index] === "\r")) index += 1;
  };
  const describe = (at: number) => (at >= text.length ? "the end of the file" : JSON.stringify(text[at]));
  const value = (depth: number): unknown => {
    if (depth > 64) fail("nested too deeply");
    skip();
    if (index >= text.length) fail("unexpected end of the file: expected a value");
    const char = text[index]!;
    if (char === "{") return object(depth);
    if (char === "[") return array(depth);
    if (char === '"') return string();
    if (char === "-" || (char >= "0" && char <= "9")) return number();
    for (const [word, result] of [["true", true], ["false", false], ["null", null]] as const) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return result;
      }
    }
    if (char === "'") fail("strings use double quotes (\")");
    return fail(`expected a value, found ${describe(index)}`);
  };
  const string = (): string => {
    const start = index;
    index += 1;
    let out = "";
    for (;;) {
      if (index >= text.length) fail("unterminated string", start);
      const char = text[index]!;
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\n" || char === "\r") fail("line break inside a string (write \\n instead)");
      if (char.charCodeAt(0) < 0x20) fail("control character inside a string");
      if (char === "\\") {
        const next = text[index + 1];
        const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (next !== undefined && simple[next] !== undefined) {
          out += simple[next];
          index += 2;
          continue;
        }
        if (next === "u") {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("invalid \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
          continue;
        }
        fail("invalid escape in a string");
      }
      out += char;
      index += 1;
    }
  };
  const number = (): number => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
    if (!match) return fail("invalid number");
    index += match[0].length;
    return Number(match[0]);
  };
  const array = (depth: number): unknown[] => {
    index += 1;
    const out: unknown[] = [];
    skip();
    if (text[index] === "]") {
      index += 1;
      return out;
    }
    for (;;) {
      out.push(value(depth + 1));
      skip();
      if (text[index] === ",") {
        index += 1;
        skip();
        if (text[index] === "]") fail('expected a value after ",", found "]" (a comma left behind?)');
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return out;
      }
      fail(index >= text.length ? 'unexpected end of the file: expected "," or "]"' : 'expected "," or "]"');
    }
  };
  const object = (depth: number): Record<string, unknown> => {
    index += 1;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    skip();
    if (text[index] === "}") {
      index += 1;
      return out;
    }
    for (;;) {
      skip();
      if (text[index] !== '"') fail(index >= text.length ? "unexpected end of the file: expected a field name" : 'expected a field name in double quotes');
      const keyAt = index;
      const key = string();
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(`the field "${key}" appears twice`, keyAt);
      skip();
      if (text[index] !== ":") fail('expected ":"');
      index += 1;
      out[key] = value(depth + 1);
      skip();
      if (text[index] === ",") {
        index += 1;
        skip();
        if (text[index] === "}") fail('expected a field after ",", found "}" (a comma left behind?)');
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return out;
      }
      fail(index >= text.length ? 'unexpected end of the file: expected "," or "}"' : 'expected "," or "}"');
    }
  };
  // A byte-order mark is fine; anything after the value is not.
  if (text.charCodeAt(0) === 0xfeff) index = 1;
  const result = value(0);
  skip();
  if (index < text.length) fail(`unexpected ${describe(index)} after the end of the value`);
  return result;
}

// ---- shared ----------------------------------------------------------------------------------------

export type CheckFailure = { ok: false; error: string };

function syntaxProblem(file: string, text: string): CheckFailure | { ok: true; value: unknown } {
  try {
    return { ok: true, value: parseStrictJson(text) };
  } catch (error) {
    if (error instanceof JsonSyntaxError) return { ok: false, error: `error: ${file} line ${error.position.line}, column ${error.position.column}: ${error.message}` };
    throw error;
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local minute as her files write it: `2026-10-25 18:00`. */
export function localMinuteText(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** The first whole local minute at or after `date` (so a "5 minutes from now" never comes early). */
export function ceilMinute(date: Date): Date {
  const ms = date.getTime();
  return new Date(Math.ceil(ms / 60_000) * 60_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One entry's name in messages: its id, else its position. */
function entryName(entry: unknown, index: number): string {
  const id = isRecord(entry) ? entry["id"] : undefined;
  return typeof id === "string" && id.trim() ? id.trim() : `${index + 1}`;
}

function unknownFields(entry: Record<string, unknown>, allowed: readonly string[]): string | undefined {
  return Object.keys(entry).find((key) => !allowed.includes(key));
}

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,19}$/u;

/** Next free number for ids like `r4` (above every existing one and the counter). */
function nextNumber(prefix: string, ids: readonly string[], counter: number): number {
  let next = Math.max(1, counter);
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`, "u").exec(id);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

/** `[{...}, …]` one entry per line, with spaces after `:` and `,` (the files' canonical look). */
export function formatEntries(entries: ReadonlyArray<Record<string, unknown>>): string {
  if (entries.length === 0) return "[]\n";
  return `[\n${entries.map((entry) => `  ${spaced(entry)}`).join(",\n")}\n]\n`;
}

function spaced(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spaced).join(", ")}]`;
  if (isRecord(value)) return `{${Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${spaced(inner)}`).join(", ")}}`;
  return JSON.stringify(value);
}

// ---- schedule.json (§16.4) ---------------------------------------------------------------------------

export type ReminderEntry = { id: string; at: string; repeat?: "daily" | "weekly"; note: string };

export type ScheduleCheckContext = {
  now: Date;
  timeZone: string;
  /** The entries saved now (an unchanged past `at` is allowed: it is due, not new). */
  previous: readonly ReminderEntry[];
  /** The id counter (ids are never reused while a reminder could still be queued). */
  nextId: number;
};

export type ScheduleCheck = { ok: true; entries: ReminderEntry[]; text: string; rewritten: boolean; nextId: number } | CheckFailure;

const REMINDER_FIELDS = ["id", "at", "repeat", "note"] as const;

export function checkScheduleText(text: string, ctx: ScheduleCheckContext): ScheduleCheck {
  const file = "schedule.json";
  if (text.trim() === "") return { ok: true, entries: [], text, rewritten: false, nextId: ctx.nextId };
  const parsed = syntaxProblem(file, text);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, error: `error: ${file} must be a JSON array of reminders, like [{"at": "2026-10-25 18:00", "note": "…"}]` };
  const raw = parsed.value;
  if (raw.length > MAX_REMINDERS) return { ok: false, error: `error: ${file} has ${raw.length} reminders; at most ${MAX_REMINDERS}` };
  const previous = new Map(ctx.previous.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  let needsIds = false;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const name = entryName(entry, index);
    const fail = (problem: string): CheckFailure => ({ ok: false, error: `error: ${file} entry ${name}: ${problem}` });
    if (!isRecord(entry)) return fail("each reminder is an object, like {\"at\": \"2026-10-25 18:00\", \"note\": \"…\"}");
    const extra = unknownFields(entry, REMINDER_FIELDS);
    if (extra) return fail(`unknown field "${extra}" (reminders have id, at, repeat and note)`);
    if (entry["id"] !== undefined) {
      if (typeof entry["id"] !== "string" || !ID_PATTERN.test(entry["id"])) return fail("id must be short, like r4");
      if (seen.has(entry["id"])) return fail(`the id ${entry["id"]} is used twice`);
      seen.add(entry["id"]);
    } else needsIds = true;
    if (typeof entry["at"] !== "string") return fail("at is required: a local time like 2026-10-25 18:00");
    const due = parseLocalDateTime(entry["at"], ctx.timeZone);
    if (!due || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(entry["at"])) return fail(`at must be a local time like 2026-10-25 18:00, not ${JSON.stringify(entry["at"])}`);
    const old = typeof entry["id"] === "string" ? previous.get(entry["id"]) : undefined;
    const unchanged = old !== undefined && old.at === entry["at"];
    if (!unchanged) {
      const ahead = due.getTime() - ctx.now.getTime();
      if (ahead < 0) return fail("at is in the past");
      if (ahead < REMINDER_MIN_AHEAD_MS - MINUTE_SLACK_MS) return fail("at must be at least 5 minutes ahead");
      if (ahead > REMINDER_MAX_AHEAD_MS) return fail("at can be at most 30 days ahead");
    }
    if (entry["repeat"] !== undefined && entry["repeat"] !== "daily" && entry["repeat"] !== "weekly") return fail('repeat is "daily" or "weekly" (or left out)');
    if (typeof entry["note"] !== "string") return fail("note is required (a few words to yourself)");
    if ([...entry["note"]].length > MAX_NOTE_CHARS) return fail(`note can be at most ${MAX_NOTE_CHARS} characters`);
    out.push(entry);
  }
  let next = nextNumber("r", [...seen, ...ctx.previous.map((entry) => entry.id)], ctx.nextId);
  const entries: ReminderEntry[] = [];
  const written: Array<Record<string, unknown>> = [];
  for (const entry of out) {
    let id = entry["id"] as string | undefined;
    if (id === undefined) {
      while (seen.has(`r${next}`)) next += 1;
      id = `r${next}`;
      next += 1;
      seen.add(id);
    }
    const { id: _drop, ...rest } = entry;
    written.push({ id, ...rest });
    entries.push({ id, at: entry["at"] as string, ...(entry["repeat"] ? { repeat: entry["repeat"] as "daily" | "weekly" } : {}), note: entry["note"] as string });
  }
  return { ok: true, entries, text: needsIds ? formatEntries(written) : text, rewritten: needsIds, nextId: next };
}

// ---- watches.json (§16.5) -----------------------------------------------------------------------------

export type WatchBindingEntry = { place?: string; from?: string; words?: string[]; any_message?: boolean };
export type WatchEntry = { id: string; timeout: string; once: boolean; note: string; when: WatchBindingEntry[] };

/** A binding as matching needs it: place and person resolved. */
export type ResolvedBinding = { placeKey?: string; fromUserId?: string; fromName?: string; words?: string[]; anyMessage?: boolean };

export type PersonResolution = { ok: true; userId: string; name: string } | { ok: false; error: string };

export type WatchesCheckContext = {
  now: Date;
  timeZone: string;
  previous: readonly WatchEntry[];
  /** How each saved binding resolved (kept for unchanged `from` names, so they never fail later). */
  previousResolved: ReadonlyMap<string, readonly ResolvedBinding[]>;
  nextId: number;
  resolvePlace(handle: string): Promise<string | undefined>;
  resolvePerson(name: string): Promise<PersonResolution>;
};

export type WatchesCheck =
  | { ok: true; entries: WatchEntry[]; resolved: Map<string, ResolvedBinding[]>; text: string; rewritten: boolean; nextId: number }
  | CheckFailure;

const WATCH_FIELDS = ["id", "timeout", "once", "note", "when"] as const;
const BINDING_FIELDS = ["place", "from", "words", "any_message"] as const;

export async function checkWatchesText(text: string, ctx: WatchesCheckContext): Promise<WatchesCheck> {
  const file = "watches.json";
  if (text.trim() === "") return { ok: true, entries: [], resolved: new Map(), text, rewritten: false, nextId: ctx.nextId };
  const parsed = syntaxProblem(file, text);
  if (!parsed.ok) return parsed;
  if (!Array.isArray(parsed.value)) return { ok: false, error: `error: ${file} must be a JSON array of watches, like [{"timeout": "2026-10-25 18:00", "note": "…", "when": []}]` };
  const raw = parsed.value;
  if (raw.length > MAX_WATCHES) return { ok: false, error: `error: ${file} has ${raw.length} watches; at most ${MAX_WATCHES}` };
  const previous = new Map(ctx.previous.map((entry) => [entry.id, entry]));
  const seen = new Set<string>();
  const kept: Array<{ entry: Record<string, unknown>; resolved: ResolvedBinding[] }> = [];
  let needsIds = false;
  for (let index = 0; index < raw.length; index += 1) {
    const entry = raw[index];
    const name = entryName(entry, index);
    const fail = (problem: string): CheckFailure => ({ ok: false, error: `error: ${file} entry ${name}: ${problem}` });
    if (!isRecord(entry)) return fail('each watch is an object, like {"timeout": "2026-10-25 18:00", "note": "…", "when": []}');
    const extra = unknownFields(entry, WATCH_FIELDS);
    if (extra) return fail(`unknown field "${extra}" (watches have id, timeout, once, note and when)`);
    if (entry["id"] !== undefined) {
      if (typeof entry["id"] !== "string" || !ID_PATTERN.test(entry["id"])) return fail("id must be short, like w3");
      if (seen.has(entry["id"])) return fail(`the id ${entry["id"]} is used twice`);
      seen.add(entry["id"]);
    } else needsIds = true;
    if (typeof entry["timeout"] !== "string") return fail("timeout is required: a local time like 2026-10-25 18:00");
    const ends = parseLocalDateTime(entry["timeout"], ctx.timeZone);
    if (!ends || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(entry["timeout"])) return fail(`timeout must be a local time like 2026-10-25 18:00, not ${JSON.stringify(entry["timeout"])}`);
    const old = typeof entry["id"] === "string" ? previous.get(entry["id"]) : undefined;
    if (!(old !== undefined && old.timeout === entry["timeout"])) {
      const ahead = ends.getTime() - ctx.now.getTime();
      if (ahead <= 0) return fail("timeout is in the past");
      if (ahead > WATCH_MAX_AHEAD_MS + MINUTE_SLACK_MS) return fail("timeout can be at most 7 days ahead");
    }
    if (entry["once"] !== undefined && typeof entry["once"] !== "boolean") return fail("once is true or false");
    if (typeof entry["note"] !== "string") return fail("note is required (a few words to yourself)");
    if ([...entry["note"]].length > MAX_NOTE_CHARS) return fail(`note can be at most ${MAX_NOTE_CHARS} characters`);
    const when = entry["when"] ?? [];
    if (!Array.isArray(when)) return fail("when is a list of bindings ([] for a timer)");
    if (when.length > MAX_BINDINGS) return fail(`when can have at most ${MAX_BINDINGS} bindings`);
    const resolved: ResolvedBinding[] = [];
    const oldResolved = typeof entry["id"] === "string" ? ctx.previousResolved.get(entry["id"]) : undefined;
    for (let b = 0; b < when.length; b += 1) {
      const binding = when[b];
      if (!isRecord(binding)) return fail("each binding is an object with place, from, words or any_message");
      const unknown = unknownFields(binding, BINDING_FIELDS);
      if (unknown) return fail(`unknown binding field "${unknown}" (bindings have place, from, words and any_message)`);
      const out: ResolvedBinding = {};
      if (binding["place"] !== undefined) {
        if (typeof binding["place"] !== "string" || !binding["place"].trim()) return fail("place is a place handle like bake-club/#general");
        const placeKey = await ctx.resolvePlace(binding["place"]);
        if (!placeKey) return fail(`unknown place ${binding["place"]}; see places.md`);
        out.placeKey = placeKey;
      }
      if (binding["from"] !== undefined) {
        if (typeof binding["from"] !== "string" || !binding["from"].trim() || binding["from"].length > 100) return fail("from is a person's name (or <@id>)");
        const before = old?.when[b];
        const reuse = before?.from === binding["from"] ? oldResolved?.[b] : undefined;
        if (reuse?.fromUserId) {
          out.fromUserId = reuse.fromUserId;
          if (reuse.fromName) out.fromName = reuse.fromName;
        } else {
          const person = await ctx.resolvePerson(binding["from"]);
          if (!person.ok) return fail(person.error.replace(/^error:\s*/u, ""));
          out.fromUserId = person.userId;
          out.fromName = person.name;
        }
      }
      if (binding["words"] !== undefined) {
        const words = binding["words"];
        if (!Array.isArray(words) || words.length === 0 || words.length > MAX_WORDS) return fail(`words is a list of 1–${MAX_WORDS} words`);
        if (!words.every((word) => typeof word === "string" && word.trim() !== "" && [...word].length <= MAX_WORD_CHARS)) return fail(`each word is text of at most ${MAX_WORD_CHARS} characters`);
        out.words = (words as string[]).map((word) => word.trim());
      }
      if (binding["any_message"] !== undefined) {
        if (typeof binding["any_message"] !== "boolean") return fail("any_message is true or false");
        if (binding["any_message"]) out.anyMessage = true;
      }
      if (out.placeKey === undefined && out.fromUserId === undefined && out.words === undefined && out.anyMessage !== true) {
        return fail("each binding needs a place, from, words or any_message");
      }
      resolved.push(out);
    }
    kept.push({ entry, resolved });
  }
  let next = nextNumber("w", [...seen, ...ctx.previous.map((entry) => entry.id)], ctx.nextId);
  const entries: WatchEntry[] = [];
  const written: Array<Record<string, unknown>> = [];
  const resolvedById = new Map<string, ResolvedBinding[]>();
  for (const { entry, resolved } of kept) {
    let id = entry["id"] as string | undefined;
    if (id === undefined) {
      while (seen.has(`w${next}`)) next += 1;
      id = `w${next}`;
      next += 1;
      seen.add(id);
    }
    const { id: _drop, ...rest } = entry;
    written.push({ id, ...rest });
    const when = ((entry["when"] as unknown[] | undefined) ?? []).map((binding) => {
      const b = binding as Record<string, unknown>;
      return {
        ...(typeof b["place"] === "string" ? { place: b["place"] } : {}),
        ...(typeof b["from"] === "string" ? { from: b["from"] } : {}),
        ...(Array.isArray(b["words"]) ? { words: b["words"] as string[] } : {}),
        ...(typeof b["any_message"] === "boolean" ? { any_message: b["any_message"] } : {})
      };
    });
    entries.push({ id, timeout: entry["timeout"] as string, once: entry["once"] !== false, note: entry["note"] as string, when });
    resolvedById.set(id, resolved);
  }
  return { ok: true, entries, resolved: resolvedById, text: needsIds ? formatEntries(written) : text, rewritten: needsIds, nextId: next };
}

/** Her saved entries, read leniently (a broken file reads as empty: the checks keep it from being saved broken). */
export function readScheduleEntries(text: string | undefined, timeZone: string): ReminderEntry[] {
  if (!text?.trim()) return [];
  try {
    const value = parseStrictJson(text);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ReminderEntry[] => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["at"] !== "string" || !parseLocalDateTime(entry["at"], timeZone)) return [];
      return [
        {
          id: entry["id"],
          at: entry["at"],
          ...(entry["repeat"] === "daily" || entry["repeat"] === "weekly" ? { repeat: entry["repeat"] } : {}),
          note: typeof entry["note"] === "string" ? entry["note"] : ""
        }
      ];
    });
  } catch {
    return [];
  }
}

export function readWatchEntries(text: string | undefined, timeZone: string): WatchEntry[] {
  if (!text?.trim()) return [];
  try {
    const value = parseStrictJson(text);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): WatchEntry[] => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["timeout"] !== "string" || !parseLocalDateTime(entry["timeout"], timeZone)) return [];
      const when = Array.isArray(entry["when"]) ? (entry["when"] as unknown[]).filter(isRecord) : [];
      return [
        {
          id: entry["id"],
          timeout: entry["timeout"],
          once: entry["once"] !== false,
          note: typeof entry["note"] === "string" ? entry["note"] : "",
          when: when.map((b) => ({
            ...(typeof b["place"] === "string" ? { place: b["place"] } : {}),
            ...(typeof b["from"] === "string" ? { from: b["from"] } : {}),
            ...(Array.isArray(b["words"]) ? { words: (b["words"] as unknown[]).filter((w): w is string => typeof w === "string") } : {}),
            ...(typeof b["any_message"] === "boolean" ? { any_message: b["any_message"] } : {})
          }))
        }
      ];
    });
  } catch {
    return [];
  }
}

/** The file rewritten by the app (an entry fired, moved to its next time, or timed out): canonical look. */
export function scheduleText(entries: readonly ReminderEntry[]): string {
  return formatEntries(entries.map((entry) => ({ id: entry.id, at: entry.at, ...(entry.repeat ? { repeat: entry.repeat } : {}), note: entry.note })));
}

export function watchesText(entries: readonly WatchEntry[]): string {
  return formatEntries(
    entries.map((entry) => ({
      id: entry.id,
      timeout: entry.timeout,
      once: entry.once,
      note: entry.note,
      when: entry.when.map((binding) => ({ ...binding }))
    }))
  );
}
