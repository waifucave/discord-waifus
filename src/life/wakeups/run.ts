// Her wakeups at work (Living cast spec §30.2, §30.4): watches matched against each message she can
// see, pages polled, and what her code's runs leave behind (state, errors, a wakeup disabled).
//
// Watches: only messages in a watch's places (or anywhere she can read, "everywhere"); never her own.
// An object filter (`{from, words, any, place}`, or a list of them: any matches) costs nothing; a
// function filter `(msg, state) => boolean | string` runs in the sandbox once per such message, every
// function of hers for one message in one request. `true` fires, a string fires and is the wake's
// line (≤ 200 characters), anything else doesn't. `once` (default) removes the watch at its first
// fire; a repeating one fires at most once per 10 minutes and `life.maxWatchFiresPerDay` times a day
// (its function still runs, so its state stays current). A message posted before the watch ended
// still counts when it is handled later (catch-up).
//
// Errors are never silent: a run that throws, hits a limit or leaves a state over 4 KiB counts one;
// a good run resets the count; at 3 in a row the wakeup is disabled (`disabled` in her file, with the
// reason) and she gets a `wakeup_error` wake, which goes through like a reminder.

import { createHash } from "node:crypto";
import type { ResolvedWatchBinding, Wake, WakeupSide } from "../../shared/schemas/life.js";
import { onceKey, type HomeStore } from "../home/homeStore.js";
import { EVENT_LIMITS, sandboxErrorText, type Sandbox, type SandboxCallResult } from "../sandbox/index.js";
import { wordBoundaryIncludes } from "../text.js";
import { functionSourceOf, MAX_STATE_BYTES, untilOf, type WakeupEntry } from "./file.js";
import { currentState, dropState, setState } from "./state.js";
import { mayHaveSeenDm } from "./privacy.js";

export const WATCH_MIN_SPACING_MS = 10 * 60_000;
/** Errors in a row that disable a wakeup (§30.2). */
export const MAX_ERRORS_IN_A_ROW = 3;
/** Why a wakeup stopped, as kept in her file and her wake. */
export const MAX_REASON_CHARS = 300;
/** A function's string return, as shown in her wake (§30.2). */
export const MAX_RETURN_CHARS = 200;
/** A message's text as her filter sees it. */
export const MAX_FILTER_TEXT_CHARS = 4_000;
const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
/** Page fetches per waifu per day: her 3 pages checked every hour (§30.6). */
export const PAGE_FETCHES_PER_DAY = 72;

/** One message as intake hands it to her watches. */
export type WakeupMessage = {
  placeKey: string;
  /** Her handle for the place (`bake-club/#general`, `dm/kevin`), asked only when a function filter will see it. */
  handle: () => Promise<string>;
  authorId: string;
  fromName: string;
  isWaifu: boolean;
  /** Rendered body (mentions as names); "(removed)" for a forgotten person's. */
  text: string;
  mentionsMe: boolean;
  repliesToMe: boolean;
  /** The message is hers (never matches). */
  own: boolean;
  /** A forgotten person's (or unreadable forget records): no id, name, files or `from` match reach her. */
  removed?: boolean;
  createdAt?: string;
  messageId?: string;
  files?: Array<{ name: string; size?: number }>;
  /** Its ref (`#k3`), asked only when a function filter will see it. */
  ref?: () => Promise<string | undefined>;
};

export type FiredWakeup = { id: string; note: string; matched?: string };

export type WakeupRunContext = {
  store: HomeStore;
  sandbox: Sandbox;
  now: Date;
  timeZone: string;
};

/** What matched for an object filter: the word, "any message", or the person's name. */
export function bindingMatch(binding: ResolvedWatchBinding, message: Pick<WakeupMessage, "placeKey" | "authorId" | "text" | "removed">): string | undefined {
  if (binding.placeKey && binding.placeKey !== message.placeKey) return undefined;
  if (binding.fromUserId && (message.removed === true || binding.fromUserId !== message.authorId)) return undefined;
  if (binding.words && binding.words.length > 0) {
    const word = binding.words.find((candidate) => wordBoundaryIncludes(message.text, candidate));
    if (!word) return undefined;
    return word;
  }
  if (binding.anyMessage) return "any message";
  if (binding.fromUserId) return binding.fromName ? `from ${binding.fromName}` : "from them";
  return binding.placeKey ? "any message" : undefined;
}

/** A function's answer: fires (with its line when it returned a string) or not. */
function answerOf(result: true | string | null): { fires: boolean; matched?: string } {
  if (result === true) return { fires: true };
  if (typeof result === "string") {
    const line = result.replace(/\s+/gu, " ").trim();
    return { fires: true, ...(line ? { matched: [...line].length > MAX_RETURN_CHARS ? `${[...line].slice(0, MAX_RETURN_CHARS - 1).join("")}…` : line } : {}) };
  }
  return { fires: false };
}

/** One run of her code: its answer and new state, or the error that counts. */
export type CodeRun = { ok: true; fires: boolean; matched?: string; state?: Record<string, unknown> } | { ok: false; error: string };

/** A sandbox call's result for a filter or check whose second argument is her state. */
export function codeRunOf(result: SandboxCallResult | undefined, what: "filter" | "check", stateBefore: Record<string, unknown>): CodeRun {
  if (!result || typeof result !== "object") return { ok: false, error: `your ${what} gave no answer` };
  if (!result.ok) return { ok: false, error: result.error && typeof result.error === "object" ? sandboxErrorText(result.error, { what: `your ${what}` }) : `your ${what} failed` };
  // Nothing from the sandbox is trusted as it is: an answer is true, a string or null; her state comes
  // back as JSON text of a plain object of at most 4 KiB, or the run is an error that counts.
  const answer = result.result;
  if (answer !== true && answer !== null && typeof answer !== "string") return { ok: false, error: `your ${what} gave an answer that couldn't be read` };
  const notJson = { ok: false as const, error: `your ${what}'s state must be plain JSON` };
  if (!Array.isArray(result.args)) return notJson;
  const stateText: unknown = result.args[1];
  let state: Record<string, unknown> | undefined;
  if (stateText !== undefined) {
    if (typeof stateText === "object" && stateText !== null && (stateText as { problem?: unknown }).problem === "too-large") return { ok: false, error: `your ${what}'s state is over ${MAX_STATE_BYTES / 1024} KiB; keep less in it` };
    if (typeof stateText !== "string") return notJson;
    if (stateText !== JSON.stringify(stateBefore)) {
      if (Buffer.byteLength(stateText, "utf8") > MAX_STATE_BYTES) return { ok: false, error: `your ${what}'s state is over ${MAX_STATE_BYTES / 1024} KiB; keep less in it` };
      let parsed: unknown;
      try {
        parsed = JSON.parse(stateText);
      } catch {
        return notJson;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, error: `your ${what}'s state must stay an object` };
      state = parsed as Record<string, unknown>;
    }
  }
  return { ok: true, ...answerOf(answer), ...(state ? { state } : {}) };
}

/**
 * The wake for a wakeup her errors stopped: `- wakeup w4 stopped: TypeError: … (line 2)`. The error
 * of code that may have seen a DM (a private or an everywhere watch) may quote it: a DM wake (D14).
 */
export function wakeupErrorWake(id: string, error: string, now: Date, o: { dm?: boolean } = {}): Wake {
  return { id: `w-wakeup-error-${id}-${now.getTime().toString(36)}`, reason: "wakeup_error", watchId: id, note: `wakeup ${id} stopped: ${error}`, ...(o.dm ? { dm: true } : {}), at: now.toISOString() };
}

/**
 * Applies runs to her file and side file (under her home lock, by the caller's rewrite): errors
 * counted, a third in a row disables the wakeup, a good run resets the count and keeps its state.
 * Returns the error wakes to route. Only entries still there with the same code are touched.
 */
export function applyRuns(
  entries: WakeupEntry[],
  side: WakeupSide,
  runs: ReadonlyMap<string, { source: string | undefined; run: CodeRun }>,
  o: { dataRoot: string; waifuId: string; now: Date }
): { entries: WakeupEntry[]; side: WakeupSide; errorWakes: Wake[] } {
  const errors = { ...side.errors };
  const errorWakes: Wake[] = [];
  const next = entries.map((entry) => {
    const outcome = runs.get(entry.id);
    if (!outcome || functionSourceOf(entry) !== outcome.source || entry.disabled !== undefined) return entry;
    const { run } = outcome;
    if (run.ok) {
      delete errors[entry.id];
      if (run.state) setState(o.dataRoot, o.waifuId, entry.id, outcome.source, run.state, o.now.getTime());
      return entry;
    }
    const count = (errors[entry.id] ?? 0) + 1;
    if (count < MAX_ERRORS_IN_A_ROW) {
      errors[entry.id] = count;
      return entry;
    }
    delete errors[entry.id];
    // Bounded: the reason lives in her file (and her wake).
    const reason = [...run.error].length > MAX_REASON_CHARS ? `${[...run.error].slice(0, MAX_REASON_CHARS - 1).join("")}…` : run.error;
    errorWakes.push(wakeupErrorWake(entry.id, reason, o.now, { dm: mayHaveSeenDm(entry, side) }));
    return { ...entry, disabled: reason };
  });
  return { entries: next, side: { ...side, errors }, errorWakes };
}

/** The `msg` her function filters get (§30.2). */
async function messageObject(message: WakeupMessage): Promise<Record<string, unknown>> {
  const text = [...message.text];
  return {
    place: await message.handle(),
    from: message.fromName,
    fromId: message.removed ? null : message.authorId,
    isWaifu: message.isWaifu,
    text: text.length > MAX_FILTER_TEXT_CHARS ? text.slice(0, MAX_FILTER_TEXT_CHARS).join("") : message.text,
    mentionsMe: message.mentionsMe,
    repliesToMe: message.repliesToMe,
    ref: (await message.ref?.().catch(() => undefined)) ?? null,
    at: message.createdAt ?? null,
    files: (message.removed ? [] : (message.files ?? [])).map((file) => ({ name: file.name, ...(file.size !== undefined ? { size: file.size } : {}) }))
  };
}

/** Whether a watch looks at this place (its places, or everywhere). */
function watchesPlace(side: WakeupSide["watches"][string] | undefined, placeKey: string): boolean {
  if (!side) return false;
  return side.placeKeys === undefined || side.placeKeys.includes(placeKey);
}

/**
 * Her watches that fire for this message: her file and side file updated (once-watches removed,
 * fires recorded, her code's state and errors kept). Also the `wakeup_error` wakes of watches her
 * errors stopped.
 */
export async function fireWakeupWatches(
  ctx: WakeupRunContext,
  message: WakeupMessage,
  o: { maxFiresPerDay: number }
): Promise<{ fired: FiredWakeup[]; errorWakes: Wake[] }> {
  if (message.own) return { fired: [], errorWakes: [] };
  const nowMs = ctx.now.getTime();
  const posted = message.createdAt ? Date.parse(message.createdAt) : Number.NaN;
  // A message from before a watch ended still counts, however late it is handled.
  const messageMs = Number.isFinite(posted) ? Math.min(posted, nowMs) : nowMs;
  const { entries, side } = await ctx.store.readWakeups();
  const candidates = entries.filter(
    (entry) =>
      entry.kind === "watch" &&
      entry.disabled === undefined &&
      (untilOf(entry, ctx.timeZone)?.getTime() ?? 0) > messageMs &&
      watchesPlace(side.watches[entry.id], message.placeKey) &&
      !side.fired.includes(onceKey(entry))
  );
  if (candidates.length === 0) return { fired: [], errorWakes: [] };
  const answers = new Map<string, { fires: boolean; matched?: string }>();
  const runs = new Map<string, { source: string | undefined; run: CodeRun }>();
  const coded: Array<{ entry: WakeupEntry; source: string; state: Record<string, unknown> }> = [];
  for (const entry of candidates) {
    const source = functionSourceOf(entry);
    if (source !== undefined) {
      coded.push({ entry, source, state: currentState(ctx.store.storage.dataRoot, ctx.store.waifuId, entry, source) });
      continue;
    }
    // Object filters, any of them; an empty list never matches (a timer).
    const filters = side.watches[entry.id]?.filters ?? [];
    let matched: string | undefined;
    for (const filter of filters) {
      matched = bindingMatch(filter, message);
      if (matched) break;
    }
    if (matched !== undefined) answers.set(entry.id, { fires: true, matched });
  }
  if (coded.length > 0) {
    const msg = JSON.stringify(await messageObject(message));
    const results = await ctx.sandbox.call(
      coded.map((item) => ({ source: item.source, file: "filter", args: [msg, JSON.stringify(item.state)] })),
      { limits: EVENT_LIMITS, timeZone: ctx.timeZone, now: ctx.now }
    );
    coded.forEach((item, index) => {
      const run = codeRunOf(results[index], "filter", item.state);
      runs.set(item.entry.id, { source: item.source, run });
      if (run.ok && run.fires) answers.set(item.entry.id, { fires: true, ...(run.matched !== undefined ? { matched: run.matched } : {}) });
    });
  }
  const fired: FiredWakeup[] = [];
  let errorWakes: Wake[] = [];
  const dataRoot = ctx.store.storage.dataRoot;
  await ctx.store.rewriteWakeups((current, currentSide) => {
    const applied = applyRuns(current, currentSide, runs, { dataRoot, waifuId: ctx.store.waifuId, now: ctx.now });
    errorWakes = applied.errorWakes;
    const watches = { ...applied.side.watches };
    const firedKeys = [...applied.side.fired];
    const kept: WakeupEntry[] = [];
    for (const entry of applied.entries) {
      const answer = answers.get(entry.id);
      const was = candidates.find((candidate) => candidate.id === entry.id);
      // Fired only when it is still the same watch (an edit or a cancel in between wins).
      if (!answer?.fires || !was || functionSourceOf(was) !== functionSourceOf(entry) || entry.disabled !== undefined || firedKeys.includes(onceKey(entry))) {
        kept.push(entry);
        continue;
      }
      const fire: FiredWakeup = { id: entry.id, note: entry.note, ...(answer.matched !== undefined ? { matched: answer.matched } : {}) };
      if (entry.options?.once !== false) {
        fired.push(fire);
        delete watches[entry.id];
        firedKeys.push(onceKey(entry));
        dropState(dataRoot, ctx.store.waifuId, entry.id);
        continue;
      }
      const sideEntry = watches[entry.id] ?? { fires: [] };
      const fires = sideEntry.fires.filter((at) => nowMs - Date.parse(at) < DAY_MS);
      const last = fires.length > 0 ? Date.parse(fires[fires.length - 1]!) : undefined;
      if ((last !== undefined && nowMs - last < WATCH_MIN_SPACING_MS) || fires.length >= o.maxFiresPerDay) {
        kept.push(entry);
        continue;
      }
      watches[entry.id] = { ...sideEntry, fires: [...fires, ctx.now.toISOString()] };
      fired.push(fire);
      kept.push(entry);
    }
    return { entries: kept, side: { ...applied.side, watches, fired: firedKeys } };
  });
  return { fired, errorWakes };
}

// ---- pages ---------------------------------------------------------------------------------------

/** What a page check gets (§30.2): the page as read by the SSRF-checked fetcher, no model call. */
export type PageObject = { url: string; status: number; title: string; text: string };
export const MAX_PAGE_TEXT_BYTES = 200 * 1024;

export type PageFetch = (url: string) => Promise<{ ok: true; page: PageObject } | { ok: false }>;

/** The page's title: its first Markdown heading, else its first line (the fetcher returns Markdown). */
export function pageTitle(text: string): string {
  const heading = /^#{1,3}\s+(.+)$/mu.exec(text)?.[1];
  const line = heading ?? text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim().slice(0, 200);
}

/** Text cut to the page cap (on a character boundary). */
export function cappedPageText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_PAGE_TEXT_BYTES) return text;
  return bytes.subarray(0, MAX_PAGE_TEXT_BYTES).toString("utf8").replace(/�$/u, "");
}

export const textHash = (text: string) => createHash("sha256").update(text.replace(/\s+/gu, " ").trim(), "utf8").digest("hex");

/**
 * Her pages due a check now (each `every` after its last check; the first check at the first tick
 * after it was set): fetched, checked, and the wakes to route (`watch` with the page's url, or
 * `wakeup_error`). A failed fetch waits for the next `every` and never counts as her error.
 */
export async function checkPages(ctx: WakeupRunContext & { fetch: PageFetch; everyMs: (entry: WakeupEntry) => number | undefined }): Promise<Wake[]> {
  const nowMs = ctx.now.getTime();
  const { entries, side } = await ctx.store.readWakeups();
  const fetchedToday = side.pageFetches.filter((at) => nowMs - Date.parse(at) < DAY_MS);
  const due = entries
    .filter((entry) => {
      if (entry.kind !== "page" || entry.disabled !== undefined) return false;
      if ((untilOf(entry, ctx.timeZone)?.getTime() ?? 0) <= nowMs) return false;
      const every = ctx.everyMs(entry);
      if (every === undefined) return false;
      // Its own last check, or this URL's last fetch for any page (an edit or a new id is no new fetch).
      const last = Math.max(...[side.pages[entry.id]?.checkedAt, side.pageUrls[entry.url!]].map((at) => (at ? Date.parse(at) : Number.NEGATIVE_INFINITY)));
      return nowMs - last >= every;
    })
    .slice(0, Math.max(0, PAGE_FETCHES_PER_DAY - fetchedToday.length));
  if (due.length === 0) return [];
  const dataRoot = ctx.store.storage.dataRoot;
  const results = new Map<string, { source: string | undefined; check: WakeupEntry["check"]; url: string | undefined; page?: PageObject; run?: CodeRun; hash?: string; contains?: boolean }>();
  for (const entry of due) {
    const fetched = await ctx.fetch(entry.url!).catch(() => ({ ok: false as const }));
    const source = functionSourceOf(entry);
    const record: { source: string | undefined; check: WakeupEntry["check"]; url: string | undefined; page?: PageObject; run?: CodeRun; hash?: string; contains?: boolean } = { source, check: entry.check, url: entry.url };
    if (fetched.ok) {
      const page = { ...fetched.page, text: cappedPageText(fetched.page.text) };
      record.page = page;
      const fine = page.status >= 200 && page.status < 300;
      if (source !== undefined) {
        const state = currentState(dataRoot, ctx.store.waifuId, entry, source);
        const [result] = await ctx.sandbox.call([{ source, file: "check", args: [JSON.stringify(page), JSON.stringify(state)] }], { limits: EVENT_LIMITS, timeZone: ctx.timeZone, now: ctx.now });
        record.run = codeRunOf(result, "check", state);
      } else if (fine && entry.check === "changes") record.hash = textHash(page.text);
      else if (fine && typeof entry.check === "object") record.contains = page.text.toLowerCase().includes(entry.check.contains.toLowerCase());
    }
    results.set(entry.id, record);
  }
  const wakes: Wake[] = [];
  await ctx.store.rewriteWakeups((current, currentSide) => {
    const runs = new Map([...results].flatMap(([id, record]) => (record.run ? [[id, { source: record.source, run: record.run }] as const] : [])));
    const applied = applyRuns(current, currentSide, runs, { dataRoot, waifuId: ctx.store.waifuId, now: ctx.now });
    wakes.push(...applied.errorWakes);
    const pages = { ...applied.side.pages };
    // Every fetch counts, whatever became of its page meanwhile.
    const at = ctx.now.toISOString();
    const pageFetches = [...applied.side.pageFetches.filter((when) => nowMs - Date.parse(when) < DAY_MS), ...due.map(() => at)].slice(-PAGE_FETCHES_PER_DAY);
    const pageUrls = Object.fromEntries(Object.entries(applied.side.pageUrls).filter(([, when]) => nowMs - Date.parse(when) < WEEK_MS));
    for (const entry of due) pageUrls[entry.url!] = at;
    for (const entry of applied.entries) {
      const record = results.get(entry.id);
      // Only the page it checked (an edit in between starts over).
      if (!record || entry.url !== record.url || JSON.stringify(entry.check) !== JSON.stringify(record.check)) continue;
      const before = pages[entry.id] ?? {};
      const after: WakeupSide["pages"][string] = { ...before, checkedAt: ctx.now.toISOString() };
      let fire: { matched?: string } | undefined;
      if (record.run?.ok && record.run.fires && entry.disabled === undefined) fire = record.run.matched !== undefined ? { matched: record.run.matched } : {};
      if (record.hash !== undefined) {
        if (before.hash !== undefined && before.hash !== record.hash) fire = { matched: "the page changed" };
        after.hash = record.hash;
      }
      if (record.contains !== undefined) {
        if (record.contains && before.matched !== true && typeof entry.check === "object") fire = { matched: `the page has ${JSON.stringify(entry.check.contains)}` };
        after.matched = record.contains;
      }
      pages[entry.id] = after;
      if (fire && entry.disabled === undefined) {
        wakes.push({
          id: `w-page-${entry.id}-${nowMs.toString(36)}`,
          reason: "watch",
          watchId: entry.id,
          url: record.page?.url ?? entry.url!,
          ...(fire.matched !== undefined ? { matched: fire.matched } : {}),
          note: entry.note,
          wakeups: [{ id: entry.id, note: entry.note, ...(fire.matched !== undefined ? { matched: fire.matched } : {}) }],
          at: ctx.now.toISOString()
        });
      }
    }
    return { entries: applied.entries, side: { ...applied.side, pages, pageFetches, pageUrls } };
  });
  return wakes;
}
