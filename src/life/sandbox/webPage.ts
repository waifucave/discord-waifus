// A page her `Web` calls opened (Living cast spec §31.1, §32.2), as she sees it: line windows of
// about 3,000 characters (`response_length` makes them 1,500 or 6,000), `find` over the lines, and
// the page's numbered links placed on the lines they appear in. Pure and without imports (the tool
// runs it in the host: `find` is plain text, never her RegExp).

/** A window holds about this many characters of the page (at least one line). */
export const WINDOW_CHARS = 3_000;
/** A line longer than this is cut in a window. */
export const MAX_WINDOW_LINE_CHARS = 3_000;
/** `find` gives at most this many matches. */
export const MAX_FIND_MATCHES = 20;
/** Each line of a match (the matching line and its context lines) is cut to this. */
export const FIND_LINE_CHARS = 300;
/** Her `find` text or RegExp source. */
export const MAX_FIND_QUERY_CHARS = 1_000;

export type PageLink = { n: number; text: string; url: string };

/** What the host sends for an opened page. */
export type OpenedPage = { id: string; url: string; title: string; status: number; text: string; links: Array<{ text: string; url: string }>; note?: string };

export type StoredPage = {
  id: string;
  url: string;
  title: string;
  status: number;
  lines: string[];
  links: PageLink[];
  /** Per line, the numbers of the links whose `](href)` is on it (in order, once each). */
  lineLinks: Map<number, number[]>;
  note?: string;
};

/** One window as her script gets it (plus `next`, the line after it, for `page.next()`). */
export type PageWindow = {
  id: string;
  url: string;
  title: string;
  status: number;
  line: number;
  lines: string;
  total: number;
  links: PageLink[];
  more: boolean;
  next: number | null;
  note?: string;
};

export type FindQuery = { text: string } | { regex: string; flags: string };
export type FindMatch = { line: number; text: string };

const cutText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Same URL for matching: no fragment. */
function urlKey(url: string): string {
  const hash = url.indexOf("#");
  return hash < 0 ? url : url.slice(0, hash);
}

export function storePage(opened: OpenedPage): StoredPage {
  const lines = opened.text.split(/\r?\n/u);
  const links: PageLink[] = opened.links.map((link, index) => ({ n: index + 1, text: link.text, url: link.url }));
  const byUrl = new Map<string, number>();
  for (const link of links) {
    if (!byUrl.has(link.url)) byUrl.set(link.url, link.n);
    const key = urlKey(link.url);
    if (!byUrl.has(key)) byUrl.set(key, link.n);
  }
  const lineLinks = new Map<number, number[]>();
  if (links.length > 0) {
    let base: URL | undefined;
    try {
      base = new URL(opened.url);
    } catch {
      base = undefined;
    }
    const href = /\]\(\s*<?([^)\s>]+)/gu;
    lines.forEach((line, index) => {
      if (!line.includes("](")) return;
      const found: number[] = [];
      for (const match of line.matchAll(href)) {
        let absolute: string;
        try {
          absolute = new URL(match[1]!, base).href;
        } catch {
          continue;
        }
        const n = byUrl.get(absolute) ?? byUrl.get(urlKey(absolute));
        if (n !== undefined && !found.includes(n)) found.push(n);
      }
      if (found.length > 0) lineLinks.set(index, found);
    });
  }
  return { id: opened.id, url: opened.url, title: opened.title, status: opened.status, lines, links, lineLinks, ...(opened.note ? { note: opened.note } : {}) };
}

const blank = (line: string) => line.trim() === "";

/** The window starting at `start` (0-based; blank lines are skipped but keep their numbers). */
export function windowAt(page: StoredPage, start: number, windowChars: number = WINDOW_CHARS): PageWindow {
  const total = page.lines.length;
  if (!Number.isInteger(start) || start < 0 || start >= Math.max(total, 1)) {
    throw new RangeError(`the page has lines 0 to ${Math.max(total - 1, 0)}`);
  }
  const shown: string[] = [];
  const linkNs: number[] = [];
  let chars = 0;
  let index = start;
  for (; index < total; index += 1) {
    const raw = page.lines[index]!;
    if (blank(raw)) continue;
    const text = cutText(raw, MAX_WINDOW_LINE_CHARS);
    if (shown.length > 0 && chars + text.length > windowChars) break;
    shown.push(`${index}: ${text}`);
    chars += text.length + 1;
    for (const n of page.lineLinks.get(index) ?? []) if (!linkNs.includes(n)) linkNs.push(n);
  }
  let next: number | null = null;
  for (let rest = index; rest < total; rest += 1) {
    if (!blank(page.lines[rest]!)) {
      next = rest;
      break;
    }
  }
  return {
    id: page.id,
    url: page.url,
    title: page.title,
    status: page.status,
    line: start,
    lines: shown.join("\n"),
    total,
    links: linkNs.map((n) => page.links[n - 1]!),
    more: next !== null,
    next,
    ...(page.note && start === 0 ? { note: page.note } : {})
  };
}

/** A matched line cut around the match, so the match itself stays visible. */
function aroundMatch(line: string, at: number): string {
  if (line.length <= FIND_LINE_CHARS) return line;
  const from = Math.max(0, Math.min(at - 100, line.length - FIND_LINE_CHARS));
  const piece = line.slice(from, from + FIND_LINE_CHARS - 2);
  return `${from > 0 ? "…" : ""}${piece}${from + FIND_LINE_CHARS - 2 < line.length ? "…" : ""}`;
}

/** The query as a matcher: text is case-insensitive; a RegExp keeps her flags except g, y, d and v. */
export function matcherOf(query: FindQuery): (line: string) => number {
  if ("text" in query) {
    if (query.text.length === 0) throw new TypeError("find needs something to look for");
    if (query.text.length > MAX_FIND_QUERY_CHARS) throw new RangeError(`find takes at most ${MAX_FIND_QUERY_CHARS} characters`);
    const needle = query.text.toLowerCase();
    return (line) => line.toLowerCase().indexOf(needle);
  }
  if (query.regex.length > MAX_FIND_QUERY_CHARS) throw new RangeError(`find takes a RegExp of at most ${MAX_FIND_QUERY_CHARS} characters`);
  const flags = [...new Set(query.flags.split(""))].filter((flag) => "imsu".includes(flag)).join("");
  let regex: RegExp;
  try {
    regex = new RegExp(query.regex, flags);
  } catch (error) {
    throw new SyntaxError(`find: ${error instanceof Error ? error.message : "that RegExp can't be used"}`);
  }
  return (line) => {
    const match = regex.exec(line);
    return match ? match.index : -1;
  };
}

/** Lines that match, each with the non-blank line before and after it, at most 20. */
export function findIn(page: StoredPage, query: FindQuery): FindMatch[] {
  const matches = matcherOf(query);
  const found: FindMatch[] = [];
  const lines = page.lines;
  for (let index = 0; index < lines.length && found.length < MAX_FIND_MATCHES; index += 1) {
    const line = lines[index]!;
    if (blank(line)) continue;
    const at = matches(line);
    if (at < 0) continue;
    const before = index > 0 && !blank(lines[index - 1]!) ? cutText(lines[index - 1]!, FIND_LINE_CHARS) : undefined;
    const after = index + 1 < lines.length && !blank(lines[index + 1]!) ? cutText(lines[index + 1]!, FIND_LINE_CHARS) : undefined;
    found.push({ line: index, text: [before, aroundMatch(line, at), after].filter((part) => part !== undefined).join("\n") });
  }
  return found;
}

/** Link `n`'s URL (1-based, as `links` numbers them). */
export function linkUrl(page: StoredPage, n: unknown): string {
  if (typeof n !== "number" || !Number.isInteger(n)) throw new TypeError("link takes a link's number, like page.link(3)");
  const link = page.links[n - 1];
  if (!link) throw new RangeError(page.links.length === 0 ? "this page has no links" : `this page has links 1 to ${page.links.length}`);
  return link.url;
}
