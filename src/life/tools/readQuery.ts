// ReadMessages' freeform query (Living cast spec §22.2): terms in any order, `key:value` or
// `key value`, case-insensitive.
//
//   before|after|around <anchor>   anchors: `#ref`, `2026-10-25 17:02`, `2026-10-25` (that day),
//                                  `17:02` (today), `yesterday 17:02` (also `today` / `yesterday`
//                                  alone: that day); before + after make a range
//   max:N                          messages per place, 1–100 (default 15; 50 for a range)
//   people:Name, Name              only these authors (as shown in chat; `you` = herself)
//   search:words, other words      alternatives; every word of one must appear (whole words)
//
// Names and words compare case- and accent-insensitively. Pure: no I/O.

import { instantOfLocal, localParts, nextLocalMidnight, parseLocalDateTime } from "../clock.js";

export type Anchor =
  | { kind: "ref"; ref: string }
  | { kind: "time"; at: Date }
  | { kind: "day"; day: string; start: Date; end: Date };

export type ReadQuery = {
  before?: Anchor;
  after?: Anchor;
  around?: Anchor;
  max?: number;
  /** Folded names (`you` stays `you`). */
  people?: string[];
  /** Alternatives, each a list of folded words. */
  search?: string[][];
};

export type ParsedQuery = { ok: true; query: ReadQuery } | { ok: false; error: string };

export const DEFAULT_MAX = 15;
export const DEFAULT_RANGE_MAX = 50;
export const MAX_MESSAGES = 100;

/** The three-line summary every query error ends with. */
export const QUERY_SYNTAX = [
  "query terms, in any order: before|after|around <#ref | 2026-10-25 17:02 | 2026-10-25 | 17:02 | yesterday 17:02> (before + after = a range)",
  "max:N (1–100 per place) · people:Name, Name (you = yourself) · search:words, other words (any one; every word of it must appear)",
  'example: query "around #k3 max:10", or place "everywhere" with query "people:Kevin search:exam, test after 2026-10-20"'
].join("\n");

const KEYS = ["before", "after", "around", "max", "people", "search"] as const;
type Key = (typeof KEYS)[number];

/** Case and accents folded (`José` → `jose`). */
export function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** The folded words of a text (letters and digits). */
export function wordsOf(text: string): string[] {
  return fold(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Every word of one alternative appears in `text` (whole words). */
export function matchesSearch(text: string, alternatives: readonly string[][]): boolean {
  const words = new Set(wordsOf(text));
  return alternatives.some((alternative) => alternative.every((word) => words.has(word)));
}

const ANCHOR_START = /^(?:#[0-9a-z]{2,8}\b|\d{4}-\d{2}-\d{2}\b|\d{1,2}:\d{2}\b|yesterday\b|today\b)/iu;
const TERM = /(^|\s)(before|after|around|max|people|search)(\s*:\s*|\s+)/giu;

function fail(problem: string): ParsedQuery {
  return { ok: false, error: `error: ${problem}\n${QUERY_SYNTAX}` };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The local date `shift` days from `now` ("2026-10-25"). */
function localDate(now: Date, timeZone: string, shift: number): string {
  const p = localParts(now, timeZone);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day + shift));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function dayAnchor(day: string, timeZone: string): Anchor | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!parseLocalDateTime(`${day} 00:00`, timeZone)) return undefined;
  const start = instantOfLocal(timeZone, year, month, date, 0, 0);
  return { kind: "day", day, start, end: nextLocalMidnight(start, timeZone) };
}

/** One anchor's text → the anchor (undefined when it is none). */
export function parseAnchor(raw: string, o: { now: Date; timeZone: string }): Anchor | undefined {
  const text = raw.trim().toLowerCase();
  const ref = /^#([0-9a-z]{2,8})$/u.exec(text);
  if (ref) return { kind: "ref", ref: ref[1]! };
  const relative = /^(yesterday|today)(?:\s+(\d{1,2}:\d{2}))?$/u.exec(text);
  if (relative) {
    const day = localDate(o.now, o.timeZone, relative[1] === "yesterday" ? -1 : 0);
    if (!relative[2]) return dayAnchor(day, o.timeZone);
    const at = parseLocalDateTime(`${day} ${relative[2]}`, o.timeZone);
    return at ? { kind: "time", at } : undefined;
  }
  if (/^\d{1,2}:\d{2}$/u.test(text)) {
    const at = parseLocalDateTime(`${localDate(o.now, o.timeZone, 0)} ${text}`, o.timeZone);
    return at ? { kind: "time", at } : undefined;
  }
  const dated = /^(\d{4}-\d{2}-\d{2})(?:[ t](\d{1,2}:\d{2}))?$/u.exec(text);
  if (dated) {
    if (!dated[2]) return dayAnchor(dated[1]!, o.timeZone);
    const at = parseLocalDateTime(`${dated[1]} ${dated[2]}`, o.timeZone);
    return at ? { kind: "time", at } : undefined;
  }
  return undefined;
}

/** The query's terms in order: where each key starts and its raw value. */
function terms(text: string): { lead: string; found: Array<{ key: Key; value: string }> } {
  const candidates: Array<{ key: Key; index: number; valueStart: number; colon: boolean }> = [];
  for (const match of text.matchAll(TERM)) {
    const index = match.index! + match[1]!.length;
    candidates.push({ key: match[2]!.toLowerCase() as Key, index, valueStart: match.index! + match[0].length, colon: match[3]!.includes(":") });
  }
  const accepted: typeof candidates = [];
  for (const candidate of candidates) {
    const current = accepted[accepted.length - 1];
    if (current && candidate.index < current.valueStart) continue;
    // Inside a people or search value, a word like "before" or "max" is part of it (`people:Max 5`,
    // `search:meet before lunch`) unless it starts a term: a `key:` form, or before/after/around
    // followed by an anchor.
    if (current && (current.key === "people" || current.key === "search") && !candidate.colon) {
      const anchorKey = candidate.key === "before" || candidate.key === "after" || candidate.key === "around";
      if (!anchorKey || !ANCHOR_START.test(text.slice(candidate.valueStart))) continue;
    }
    accepted.push(candidate);
  }
  const found = accepted.map((term, index) => ({ key: term.key, value: text.slice(term.valueStart, accepted[index + 1]?.index ?? text.length).trim() }));
  return { lead: text.slice(0, accepted[0]?.index ?? text.length).trim(), found };
}

export function parseReadQuery(text: string, o: { now: Date; timeZone: string }): ParsedQuery {
  const query: ReadQuery = {};
  const { lead, found } = terms(text);
  if (lead) return fail(`"${lead.slice(0, 60)}" is not a query term`);
  const seen = new Set<Key>();
  for (const { key, value } of found) {
    if (seen.has(key)) return fail(`${key} is given twice`);
    seen.add(key);
    if (!value) return fail(`${key} needs a value`);
    if (key === "max") {
      if (!/^\d+$/u.test(value) || Number(value) < 1 || Number(value) > MAX_MESSAGES) return fail(`max must be a whole number from 1 to ${MAX_MESSAGES}, not "${value.slice(0, 30)}"`);
      query.max = Number(value);
    } else if (key === "people") {
      const names = value.split(",").map((name) => fold(name.trim().replace(/^@/u, ""))).filter((name) => name.length > 0);
      if (names.length === 0) return fail("people needs at least one name");
      query.people = names;
    } else if (key === "search") {
      const alternatives = value.split(",").map(wordsOf).filter((words) => words.length > 0);
      if (alternatives.length === 0) return fail("search needs at least one word");
      query.search = alternatives;
    } else {
      const anchor = parseAnchor(value, o);
      if (!anchor) return fail(`"${value.slice(0, 40)}" is not an anchor for ${key}`);
      query[key] = anchor;
    }
  }
  if (query.around && (query.before || query.after)) return fail("around can't be combined with before or after");
  if (query.before && query.after) {
    const lo = anchorBounds(query.after).from;
    const hi = anchorBounds(query.before).to;
    if (lo !== undefined && hi !== undefined && lo >= hi) return fail("the range is empty: after must be earlier than before");
  }
  return { ok: true, query };
}

/** A time anchor's (or a day's) instants: `from` its start, `to` its end (refs have none here). */
export function anchorBounds(anchor: Anchor): { from?: number; to?: number } {
  if (anchor.kind === "time") return { from: anchor.at.getTime(), to: anchor.at.getTime() };
  if (anchor.kind === "day") return { from: anchor.start.getTime(), to: anchor.start.getTime() };
  return {};
}
