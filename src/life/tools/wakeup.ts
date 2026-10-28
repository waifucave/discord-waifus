// `Wakeup(script)` (Living cast spec §30): one tool for every wakeup. The script is JavaScript she
// writes, run once in the sandbox (500 ms, no host access) with five functions:
//
//   at(when, note)                     once: "fri 18:00", "2026-10-30 18:00", "18:00", "in 45m"
//   every(when, note)                  repeating: "day 09:00", "weekday 08:30", "mon,fri 18:30", a cron
//   watch(places, filter, options, note)   a message passes filter (an object or her function)
//   page(url, check, options, note)    a web page: {contains}, "changes" or her function
//   cancel(id)
//
// Each call adds one wakeup to `~/life/wakeups.json` (or cancels one). The calls are only recorded
// while the script runs; then each is checked (line numbers are hers), her functions are checked for
// closures and compiled, and the whole change is saved through her HomeStore, all or nothing: any
// error refuses the script with its line and nothing is saved.

import { createHash } from "node:crypto";
import { z } from "zod";
import { checkEnvFor } from "../home/index.js";
import { HomeError } from "../home/homeStore.js";
import { lifeDisplay, WAKEUPS_FILE } from "../home/pathRules.js";
import { appendIntent } from "../lifeStore.js";
import { REGISTRATION_LIMITS, sandboxErrorText, sharedSandbox } from "../sandbox/index.js";
import { checkEntry, entryRecord, summaryOf, type WakeupCheckContext, type WakeupEntry } from "../wakeups/file.js";
import { nextTimes } from "../wakeups/schedule.js";
import { occurrencesText } from "../wakeups/when.js";
import { resolvePlace } from "../places.js";
import { DREAM_LIFE_REFUSED, storeOf } from "./files.js";
import { parseInput, toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

export const MAX_SCRIPT_CHARS = 20_000;
/** Most calls one script may make (adds and cancels). */
export const MAX_SCRIPT_CALLS = 40;
const MAX_CALLS_JSON_BYTES = 256 * 1024;

/** The functions her script sees: each records its call (with the line it came from). */
export const WAKEUP_PRELUDE = `
const __calls = [];
// Read out with JSON.stringify as it was before her script (she may replace it).
const __finish = (function (stringify) { return function () { return stringify(__calls); }; })(JSON.stringify);
function __line() {
  var match = /\\(script:(\\d+)/.exec(new Error().stack || "");
  return match ? Number(match[1]) : 0;
}
function __value(value, depth) {
  if (typeof value === "function") return { "$function": Function.prototype.toString.call(value) };
  if (value === undefined) return { "$undefined": true };
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map(function (item) { return __value(item, depth + 1); });
  if (value && typeof value === "object") {
    var out = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = __value(value[key], depth + 1);
    return out;
  }
  return value;
}
function __record(fn, args) {
  if (__calls.length >= ${MAX_SCRIPT_CALLS}) throw new RangeError("a script can make at most ${MAX_SCRIPT_CALLS} calls");
  __calls.push({ fn: fn, line: __line(), args: Array.prototype.map.call(args, function (arg) { return __value(arg, 0); }) });
}
function at(when, note) { __record("at", arguments); }
function every(when, note) { __record("every", arguments); }
function watch(places, filter, options, note) { __record("watch", arguments); }
function page(url, check, options, note) { __record("page", arguments); }
function cancel(id) { __record("cancel", arguments); }
`;

const Input = z.object({ script: z.string().min(1).max(MAX_SCRIPT_CHARS) });

type Call = { fn: "at" | "every" | "watch" | "page" | "cancel"; line: number; args: unknown[] };

const SIGNATURES: Record<Call["fn"], string> = {
  at: "at(when, note)",
  every: "every(when, note)",
  watch: "watch(places, filter, options, note)",
  page: "page(url, check, options, note)",
  cancel: "cancel(id)"
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isUndefined = (value: unknown) => value === undefined || (isRecord(value) && value["$undefined"] === true && Object.keys(value).length === 1);
const fnSource = (value: unknown): string | undefined => (isRecord(value) && typeof value["$function"] === "string" ? value["$function"] : undefined);

/** A recorded value with its functions as source text; a function where none may be is an error. */
function plain(value: unknown, where: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (isUndefined(value)) return { ok: true, value: undefined };
  if (fnSource(value) !== undefined) return { ok: false, error: `${where} can't be a function` };
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const inner = plain(item, where);
      if (!inner.ok) return inner;
      out.push(inner.value);
    }
    return { ok: true, value: out };
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const checked = plain(inner, where);
      if (!checked.ok) return checked;
      if (checked.value !== undefined) out[key] = checked.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value };
}

/** Her script's recorded calls, checked: what comes out of the sandbox is never trusted as it is. */
function callsOf(text: string): Call[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_SCRIPT_CALLS) return undefined;
  const calls: Call[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item["fn"] !== "string" || !Object.hasOwn(SIGNATURES, item["fn"]) || !Array.isArray(item["args"])) return undefined;
    const line = typeof item["line"] === "number" && Number.isInteger(item["line"]) && item["line"] > 0 ? item["line"] : 0;
    calls.push({ fn: item["fn"] as Call["fn"], line, args: item["args"] as unknown[] });
  }
  return calls;
}

/** One call as the entry it adds (no id), or the id it cancels. */
function recordOf(call: Call): { ok: true; add?: Record<string, unknown>; cancel?: string } | { ok: false; error: string } {
  const sig = SIGNATURES[call.fn];
  const args = call.args;
  const note = (index: number): { ok: true; value: string | undefined } | { ok: false; error: string } => {
    const value = args[index];
    if (isUndefined(value)) return { ok: true, value: undefined };
    return typeof value === "string" ? { ok: true, value } : { ok: false, error: `${sig}: note is text` };
  };
  if (call.fn === "cancel") {
    const id = args[0];
    if (typeof id !== "string" || !/^[twp]\d{1,6}$/u.test(id.trim())) return { ok: false, error: `${sig}: give the wakeup's id, like "w3"` };
    return { ok: true, cancel: id.trim() };
  }
  if (call.fn === "at" || call.fn === "every") {
    if (typeof args[0] !== "string") return { ok: false, error: `${sig}: when is text, like ${call.fn === "at" ? '"fri 18:00" or "in 2h"' : '"weekday 08:30"'}` };
    const text = note(1);
    if (!text.ok) return text;
    if (args.length > 2) return { ok: false, error: `${sig} takes two arguments` };
    return { ok: true, add: { kind: call.fn, when: args[0], ...(text.value !== undefined ? { note: text.value } : {}) } };
  }
  if (args.length > 4) return { ok: false, error: `${sig} takes four arguments` };
  const options = plain(args[2], "options");
  if (!options.ok) return { ok: false, error: `${sig}: ${options.error}` };
  if (options.value === undefined) {
    return { ok: false, error: `${sig}: options is required, like ${call.fn === "watch" ? '{for: "2h"}' : '{every: "6h", for: "3d"}'}` };
  }
  const text = note(3);
  if (!text.ok) return text;
  if (call.fn === "watch") {
    const places = plain(args[0], "places");
    if (!places.ok) return { ok: false, error: `${sig}: ${places.error}` };
    const source = fnSource(args[1]);
    const filter = source !== undefined ? { ok: true as const, value: source } : plain(args[1], "filter");
    if (!filter.ok) return { ok: false, error: `${sig}: ${filter.error}` };
    if (typeof filter.value === "string" && source === undefined) return { ok: false, error: `${sig}: filter is an object like {from: "Mina"} or a function (msg, state) => …` };
    return { ok: true, add: { kind: "watch", places: places.value, filter: filter.value, options: options.value, ...(text.value !== undefined ? { note: text.value } : {}) } };
  }
  if (typeof args[0] !== "string") return { ok: false, error: `${sig}: url is text, like "https://example.com/shop"` };
  const source = fnSource(args[1]);
  const check = source !== undefined ? { ok: true as const, value: source } : plain(args[1], "check");
  if (!check.ok) return { ok: false, error: `${sig}: ${check.error}` };
  if (typeof check.value === "string" && source === undefined && check.value !== "changes") return { ok: false, error: `${sig}: check is {contains: "text"}, "changes" or a function (page, state) => …` };
  return { ok: true, add: { kind: "page", url: args[0], check: check.value, options: options.value, ...(text.value !== undefined ? { note: text.value } : {}) } };
}

/** `error: line 3: …; nothing was saved`. */
const refused = (line: number | undefined, problem: string): ToolOutput => toolError(`${line ? `line ${line}: ` : ""}${problem.replace(/^error:\s*/u, "")}; nothing was saved`);

/** The intent's digest of what the call adds (kind, time, note) and cancels, no note text, for boot repair. */
export function wakeupChangeDigest(add: ReadonlyArray<Pick<WakeupEntry, "kind" | "when" | "note">>, cancel: readonly string[]): string {
  const hash = (entry: Pick<WakeupEntry, "kind" | "when" | "note">) => createHash("sha256").update(`${entry.kind}\u0000${entry.when ?? ""}\u0000${entry.note}`, "utf8").digest("hex").slice(0, 16);
  return `add:${add.map(hash).join(",")};cancel:${cancel.join(",")}`;
}

async function wakeup(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(Input, input);
  if (!parsed.ok) return parsed.output;
  if (ctx.session === "dream") return toolError(DREAM_LIFE_REFUSED);
  const { deps } = ctx;
  const now = deps.now();
  const sandbox = sharedSandbox();
  const run = await sandbox.run(
    [
      { code: WAKEUP_PRELUDE, file: "prelude" },
      { code: parsed.value.script, file: "script" },
      { code: "__finish()", file: "calls" }
    ],
    { limits: REGISTRATION_LIMITS, timeZone: deps.timeZone, now }
  );
  if (!run.ok) {
    // A limit hit names no line (where it stopped is not where the problem is).
    const line = run.error.file === "script" && run.error.kind === "error" ? run.error.line : undefined;
    const problem = run.error.kind === "error" ? `${run.error.name}: ${run.error.message}` : sandboxErrorText(run.error, { what: "your script" });
    return refused(line, problem);
  }
  if (Buffer.byteLength(run.value, "utf8") > MAX_CALLS_JSON_BYTES) return refused(undefined, "the script's calls are too large");
  const calls = callsOf(run.value);
  if (!calls) return refused(undefined, "your script's calls couldn't be read (leave at(), every(), watch(), page(), cancel() and JSON as they are)");
  if (calls.length === 0) return toolError("the script made no calls; use at(), every(), watch(), page() or cancel()");
  const store = storeOf(ctx);
  const env = checkEnvFor(deps, ctx.waifu.id);
  const { entries: current, side } = await store.readWakeups();
  const checkCtx: WakeupCheckContext = {
    now,
    timeZone: deps.timeZone,
    previous: current,
    side,
    resolvePlace: async (handle) => (await resolvePlace(deps.storage, ctx.waifu.id, handle))?.placeKey,
    resolvePerson: env.resolvePerson,
    compile: (sources) => sandbox.compile(sources, { timeZone: deps.timeZone, now }),
    ...(env.pagesOff ? { pagesOff: true } : {})
  };
  const adds: Array<{ line: number; entry: WakeupEntry }> = [];
  const cancels: string[] = [];
  for (const call of calls) {
    const record = recordOf(call);
    if (!record.ok) return refused(call.line, record.error);
    if (record.cancel !== undefined) {
      if (!current.some((entry) => entry.id === record.cancel)) return refused(call.line, `cancel: there is no wakeup ${record.cancel}; see ~/life/wakeups.json`);
      if (!cancels.includes(record.cancel)) cancels.push(record.cancel);
      continue;
    }
    const checked = await checkEntry(record.add, checkCtx, undefined);
    if (!checked.ok) return refused(call.line, `${call.fn}: ${checked.problem}`);
    adds.push({ line: call.line, entry: checked.entry });
  }
  // Her functions compile (their own syntax errors, with lines).
  const coded = adds.filter((item) => typeof item.entry.filter === "string" || (typeof item.entry.check === "string" && item.entry.check !== "changes"));
  const compiled = await sandbox.compile(coded.map((item) => (typeof item.entry.filter === "string" ? item.entry.filter : (item.entry.check as string))), { timeZone: deps.timeZone, now });
  for (let index = 0; index < coded.length; index += 1) {
    const result = compiled[index];
    if (result && !result.ok) {
      const item = coded[index]!;
      const where = result.error.line !== undefined ? ` (line ${result.error.line} of it)` : "";
      return refused(item.line, `${item.entry.kind}: its ${item.entry.kind === "watch" ? "filter" : "check"}: ${result.error.name}: ${result.error.message}${where}`);
    }
  }
  const records = adds.map((item) => {
    const { id: _id, ...rest } = entryRecord(item.entry);
    return rest;
  });
  if (ctx.intent) await appendIntent(deps.storage, ctx.waifu.id, { ...ctx.intent, at: now.toISOString(), contentDigest: wakeupChangeDigest(adds.map((item) => item.entry), cancels) });
  let saved: Awaited<ReturnType<typeof store.applyWakeups>>;
  try {
    saved = await store.applyWakeups({ add: records, cancel: cancels }, { ...env, sandbox });
  } catch (error) {
    if (!(error instanceof HomeError)) throw error;
    // The combined file is her kept wakeups, then the new ones: a new one's entry number is its call.
    const kept = current.length - cancels.length;
    const message = error.message
      .replace(/^error: wakeups\.json entry (\d+): /u, (_match, n: string) => {
        const line = adds[Number(n) - kept - 1]?.line;
        return line ? `line ${line}: ` : `wakeup ${n}: `;
      })
      .replace(/^error: wakeups\.json has /u, "you'd have ");
    return refused(undefined, message);
  }
  const parts: string[] = [];
  if (saved.added.length > 0) parts.push(`set ${saved.added.map((entry) => summaryOf(entry, deps.timeZone)).join(", ")}`);
  if (saved.cancelled.length > 0) parts.push(`cancelled ${saved.cancelled.join(", ")}`);
  const lines = [`${parts.join("; ")} (in ${lifeDisplay(WAKEUPS_FILE)})`];
  for (const entry of saved.added) {
    const next = nextTimes(entry, now, deps.timeZone);
    if (next.length > 0) lines.push(`${entry.id} next: ${occurrencesText(next, deps.timeZone)}`);
  }
  return { content: lines.join("\n") };
}

export const WAKEUP_DESCRIPTION = [
  "Set wakeups: moments that wake you later. Write a short JavaScript script calling these functions (each call adds one; several calls, for several places, are fine):",
  '- at(when, note): once, at "fri 18:00", "2026-10-30 18:00", "18:00" (today, else tomorrow), "in 45m" or "in 2h" (5 minutes to 30 days ahead).',
  '- every(when, note): repeating, "day 09:00", "weekday 08:30", "weekend 11:00", "mon,fri 18:30" or a cron like "0 20 1 * *" (steps of at least 15 minutes).',
  '- watch(places, filter, options, note): when a message in places (a place handle, a list of them, or "everywhere") passes filter: an object {from: "Mina", words: ["brownie"], any: true} (every field you set must match) or your own function (msg, state) => true | "a line to show" | false. msg is {place, from, fromId, isWaifu, text, mentionsMe, repliesToMe, ref, at, files}. options: {for: "2h"} (at most 7 days, required), once (default true). When it ends without firing you are told, so it also works as a timer.',
  '- page(url, check, options, note): checks a web page, check {contains: "in stock"}, "changes" or (page, state) => …, page is {url, status, title, text}; options {every: "6h", for: "3d"} (every at least 1h, for at most 7 days).',
  '- cancel(id): removes one, like cancel("w3").',
  "Your functions run on their own for each message or check: they can't use variables from outside them, only their arguments; state is an object they may change to remember things between runs. They get 50 ms each; one that fails three times in a row stops and you are told.",
  "Use it whenever you ask something or wait for news (watch for the answer, with a sensible for), when someone mentions plans (a wakeup to ask how it went), and now and then to check back in rooms you like. All of them are in ~/life/wakeups.json: look there before adding one you have, and edit that file to change them.",
  'Example: watch("bake-club/#general", {from: "Kevin"}, {for: "3h"}, "asked Kevin about saturday"); at("fri 19:00", "ask Kevin how his exam went")'
].join("\n");

export const wakeupTool: LifeTool = {
  name: "Wakeup",
  description: WAKEUP_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      script: { type: "string", maxLength: MAX_SCRIPT_CHARS, description: "JavaScript calling at(), every(), watch(), page() and cancel()." }
    },
    required: ["script"],
    additionalProperties: false
  },
  sideEffect: true,
  run: wakeup
};
