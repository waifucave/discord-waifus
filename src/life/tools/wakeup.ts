// `Wakeup` (Living cast spec §30, §32.2): one tool for every wakeup. Her script calls
// `tools.wakeup({ at, every, watch, page, cancel })`, each a list:
//
//   at:    [{ when, note }]          once: "fri 18:00", "2026-10-30 18:00", "18:00", "in 45m"
//   every: [{ when, note }]          repeating: "day 09:00", "weekday 08:30", "mon,fri 18:30", a cron
//   watch: [{ places, from?, words?, any?, filter?, for, once?, note }]   a message passes (an object
//                                    filter from `from`/`words`/`any`, or her `filter` function)
//   page:  [{ url, contains? | changes? | check?, every, for, note }]     a web page
//   cancel: [ids]
//
// Each item adds one wakeup to `~/life/wakeups.json` (or cancels one). A call is checked whole (her
// functions for closures, then compiled, then her file as it would be with everything the script
// staged): any error throws in her script naming the item (`watch[1]: …; nothing was saved`). §30's
// promise holds for the whole script (§32.3a): its calls are staged and saved once, through her
// HomeStore, when it ends without an error; a script that fails saves none, and its receipt says so.
// A call's result lists each new wakeup's id, kind and next times. At most 4 calls in one script.

import { createHash } from "node:crypto";
import { checkEnvFor } from "../home/index.js";
import { HomeError } from "../home/homeStore.js";
import { lifeDisplay, WAKEUPS_FILE } from "../home/pathRules.js";
import { appendIntent } from "../lifeStore.js";
import { sharedSandbox } from "../sandbox/index.js";
import { checkEntry, entryRecord, summaryOf, type WakeupCheckContext, type WakeupEntry } from "../wakeups/file.js";
import { nextTimes } from "../wakeups/schedule.js";
import { resolvePlace } from "../places.js";
import { DREAM_LIFE_REFUSED, storeOf } from "./files.js";
import { toolError, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";
import { familyLines, listArg, objectArg, runScriptTool, scriptSchema, ScriptError, type ScriptRun } from "./script.js";
import { dayTimeText } from "../clock.js";

/** Most items (adds and cancels) one call may have. */
export const MAX_SCRIPT_CALLS = 40;
/** tools.wakeup calls in one script. */
export const MAX_WAKEUP_CALLS = 4;
const MAX_CALLS_JSON_BYTES = 256 * 1024;

/** One item of her call as the entry it adds (no id yet), or the id it cancels, with where it is (`watch[1]`). */
type Item = { label: string; add?: Record<string, unknown>; cancel?: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fnSource = (value: unknown): string | undefined => (isRecord(value) && typeof value["$function"] === "string" ? value["$function"] : undefined);

/** A value from her script with no function in it (only `filter` and `check` may be one). */
function plain(value: unknown, where: string): unknown {
  if (fnSource(value) !== undefined) throw new ScriptError(`${where} can't be a function`, "TypeError");
  if (Array.isArray(value)) return value.map((item) => plain(item, where));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner, where)]));
  return value;
}

const FIELDS = {
  at: ["when", "note"],
  every: ["when", "note"],
  watch: ["places", "from", "words", "any", "filter", "for", "once", "note"],
  page: ["url", "contains", "changes", "check", "every", "for", "note"]
} as const;

const EXAMPLES = {
  at: '{ when: "fri 18:00", note: "…" }',
  every: '{ when: "weekday 08:30", note: "…" }',
  watch: '{ places: "bake-club/#general", from: "Kevin", for: "3h", note: "…" }',
  page: '{ url: "https://…", contains: "in stock", every: "6h", for: "3d", note: "…" }'
} as const;

/** Her call's items, checked for shape (the rules of each wakeup are checkEntry's). */
function itemsOf(arg: unknown): Item[] {
  const o = objectArg("wakeup", arg, ["at", "every", "watch", "page", "cancel"], '{ at: [{ when: "fri 19:00", note: "ask Kevin how the exam went" }] }');
  const items: Item[] = [];
  for (const kind of ["at", "every", "watch", "page"] as const) {
    listArg("wakeup", kind, o[kind], MAX_SCRIPT_CALLS, { single: true }).forEach((raw, index) => {
      const label = `${kind}[${index}]`;
      if (!isRecord(raw)) throw new ScriptError(`${label} is an object, like ${EXAMPLES[kind]}`, "TypeError");
      const unknown = Object.keys(raw).find((key) => !(FIELDS[kind] as readonly string[]).includes(key));
      if (unknown !== undefined) throw new ScriptError(`${label}: unknown field ${JSON.stringify(unknown.slice(0, 40))} (it takes ${FIELDS[kind].join(", ")})`, "TypeError");
      const item = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null && value !== undefined));
      const note = item["note"];
      if (note !== undefined && typeof note !== "string") throw new ScriptError(`${label}: note is text`, "TypeError");
      const withNote = note !== undefined ? { note } : {};
      if (kind === "at" || kind === "every") {
        if (typeof item["when"] !== "string") throw new ScriptError(`${label}: when is text, like ${kind === "at" ? '"fri 18:00" or "in 2h"' : '"weekday 08:30"'}`, "TypeError");
        items.push({ label, add: { kind, when: item["when"], ...withNote } });
        return;
      }
      const options: Record<string, unknown> = {};
      if (item["for"] !== undefined) options["for"] = plain(item["for"], `${label}.for`);
      if (kind === "watch") {
        if (item["once"] !== undefined) options["once"] = plain(item["once"], `${label}.once`);
        const source = item["filter"] === undefined ? undefined : fnSource(item["filter"]);
        if (item["filter"] !== undefined && source === undefined) throw new ScriptError(`${label}: filter is your function (m, state) => true | "a line" | false; for names and words use from, words and any`, "TypeError");
        const objectFilter = Object.fromEntries((["from", "words", "any"] as const).filter((key) => item[key] !== undefined).map((key) => [key, plain(item[key], `${label}.${key}`)]));
        if (source !== undefined && Object.keys(objectFilter).length > 0) throw new ScriptError(`${label}: give a filter function or from/words/any, not both`, "TypeError");
        // No filter at all: a timer (§30's `[]`), nothing matches and its end wakes her.
        const filter = source ?? (Object.keys(objectFilter).length > 0 ? objectFilter : []);
        items.push({ label, add: { kind: "watch", places: plain(item["places"], `${label}.places`), filter, options, ...withNote } });
        return;
      }
      if (item["every"] !== undefined) options["every"] = plain(item["every"], `${label}.every`);
      const checks = (["contains", "changes", "check"] as const).filter((key) => item[key] !== undefined);
      if (checks.length !== 1) throw new ScriptError(`${label} needs one of contains: "text", changes: true or check: (page, state) => …`, "TypeError");
      let check: unknown;
      if (checks[0] === "contains") check = { contains: plain(item["contains"], `${label}.contains`) };
      else if (checks[0] === "changes") {
        if (item["changes"] !== true) throw new ScriptError(`${label}: changes is true`, "TypeError");
        check = "changes";
      } else {
        check = fnSource(item["check"]);
        if (check === undefined) throw new ScriptError(`${label}: check is your function (page, state) => true | "a line" | false`, "TypeError");
      }
      if (typeof item["url"] !== "string") throw new ScriptError(`${label}: url is text, like "https://example.com/shop"`, "TypeError");
      items.push({ label, add: { kind: "page", url: item["url"], check, options, ...withNote } });
    });
  }
  listArg("wakeup", "cancel", o["cancel"], MAX_SCRIPT_CALLS, { single: true }).forEach((id, index) => {
    if (typeof id !== "string" || !/^[twp]\d{1,6}$/u.test(id.trim())) throw new ScriptError(`cancel[${index}]: give the wakeup's id, like "w3"`, "TypeError");
    items.push({ label: `cancel[${index}]`, cancel: id.trim() });
  });
  if (items.length === 0) throw new ScriptError("tools.wakeup: give it at, every, watch, page or cancel", "TypeError");
  if (items.length > MAX_SCRIPT_CALLS) throw new ScriptError(`tools.wakeup: at most ${MAX_SCRIPT_CALLS} wakeups and cancels in one call`, "RangeError");
  if (Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_CALLS_JSON_BYTES) throw new ScriptError("tools.wakeup: what you gave it is too large", "RangeError");
  return items;
}

/** `watch[1]: …; nothing was saved`, her script's error. */
const refused = (label: string | undefined, problem: string): never => {
  throw new ScriptError(`${label ? `${label}: ` : ""}${problem.replace(/^error:\s*/u, "")}; nothing was saved`);
};

/** The intent's digest of what the call adds (kind, time, note) and cancels, no note text, for boot repair. */
export function wakeupChangeDigest(add: ReadonlyArray<Pick<WakeupEntry, "kind" | "when" | "note">>, cancel: readonly string[]): string {
  const hash = (entry: Pick<WakeupEntry, "kind" | "when" | "note">) => createHash("sha256").update(`${entry.kind}\u0000${entry.when ?? ""}\u0000${entry.note}`, "utf8").digest("hex").slice(0, 16);
  return `add:${add.map(hash).join(",")};cancel:${cancel.join(",")}`;
}

/** What a script's `tools.wakeup` calls staged: saved together when it ends without an error (§32.3a). */
type WakeupStage = { adds: Array<{ label: string; record: Record<string, unknown>; entry: WakeupEntry }>; cancels: string[] };

/** A wakeup as her call's result shows it: its id, kind, what it is and its next times. */
function described(entry: WakeupEntry, now: Date, timeZone: string): Record<string, unknown> {
  const summary = summaryOf(entry, timeZone);
  const about = summary.startsWith(`${entry.id} (`) && summary.endsWith(")") ? summary.slice(entry.id.length + 2, -1) : summary;
  const next = nextTimes(entry, now, timeZone).map((date) => dayTimeText(date, timeZone));
  return { id: entry.id, kind: entry.kind, about, ...(next.length > 0 ? { next } : {}) };
}

/** `wakeups.json entry 7: …` of the combined file, named by the item it came from. */
function itemError(message: string, kept: number, adds: ReadonlyArray<{ label: string }>): string {
  return message
    .replace(/^error: wakeups\.json entry (\d+): /u, (_match, n: string) => {
      const label = adds[Number(n) - kept - 1]?.label;
      return label ? `${label}: ` : `wakeup ${n}: `;
    })
    .replace(/^error: wakeups\.json has /u, "you'd have ");
}

/**
 * One `tools.wakeup(…)` call: checked whole (with what the script's earlier calls staged: the caps,
 * the ids), and staged; nothing is saved until the script ends without an error. Returns what it
 * will set, with the ids it gets.
 */
async function wakeupCall(arg: unknown, ctx: ToolContext, stage: WakeupStage): Promise<Record<string, unknown>> {
  const { deps } = ctx;
  const now = deps.now();
  const sandbox = sharedSandbox();
  const items = itemsOf(arg);
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
  const adds: Array<{ label: string; record: Record<string, unknown>; entry: WakeupEntry }> = [];
  const cancels: string[] = [];
  for (const item of items) {
    if (item.cancel !== undefined) {
      if (cancels.includes(item.cancel) || stage.cancels.includes(item.cancel)) refused(item.label, `${item.cancel} is already cancelled in this script`);
      if (!current.some((entry) => entry.id === item.cancel)) refused(item.label, `there is no wakeup ${item.cancel}; see ~/life/wakeups.json`);
      cancels.push(item.cancel);
      continue;
    }
    const checked = await checkEntry(item.add, checkCtx, undefined);
    if (!checked.ok) refused(item.label, checked.problem);
    else {
      const { id: _id, ...record } = entryRecord(checked.entry);
      adds.push({ label: item.label, record, entry: checked.entry });
    }
  }
  // Her functions compile (their own syntax errors, with lines).
  const coded = adds.filter((item) => typeof item.entry.filter === "string" || (typeof item.entry.check === "string" && item.entry.check !== "changes"));
  const compiled = await sandbox.compile(coded.map((item) => (typeof item.entry.filter === "string" ? item.entry.filter : (item.entry.check as string))), { timeZone: deps.timeZone, now });
  for (let index = 0; index < coded.length; index += 1) {
    const result = compiled[index];
    if (result && !result.ok) {
      const item = coded[index]!;
      const where = result.error.line !== undefined ? ` (line ${result.error.line} of it)` : "";
      refused(item.label, `its ${item.entry.kind === "watch" ? "filter" : "check"}: ${result.error.name}: ${result.error.message}${where}`);
    }
  }
  // Checked as her file would be with everything the script staged (cancels first, so replacing one
  // at a cap works), without saving: its ids are the ones the save gives.
  const allAdds = [...stage.adds, ...adds];
  const allCancels = [...stage.cancels, ...cancels];
  let dry: Awaited<ReturnType<typeof store.applyWakeups>>;
  try {
    dry = await store.applyWakeups({ add: allAdds.map((item) => item.record), cancel: allCancels, dryRun: true }, { ...env, sandbox });
  } catch (error) {
    if (!(error instanceof HomeError)) throw error;
    return refused(undefined, itemError(error.message, current.length - allCancels.length, allAdds));
  }
  stage.adds.push(...adds);
  stage.cancels.push(...cancels);
  const mine = adds.length > 0 ? dry.added.slice(-adds.length) : [];
  return {
    ...(mine.length > 0 ? { set: mine.map((entry) => described(entry, now, deps.timeZone)) } : {}),
    ...(cancels.length > 0 ? { cancelled: cancels } : {}),
    saved: `when your script ends without an error (in ${lifeDisplay(WAKEUPS_FILE)})`
  };
}

/** Saves what the script's calls staged, once, when it ended without an error; says what happened either way. */
async function saveStaged(ctx: ToolContext, stage: WakeupStage, run: ScriptRun, ok: boolean): Promise<void> {
  if (stage.adds.length === 0 && stage.cancels.length === 0) return;
  if (!ok) {
    run.receipts.push("wakeup: nothing saved (your script ended with an error, so none of its tools.wakeup calls were saved)");
    return;
  }
  const { deps } = ctx;
  const now = deps.now();
  const sandbox = sharedSandbox();
  const store = storeOf(ctx);
  const env = checkEnvFor(deps, ctx.waifu.id);
  const kept = (await store.readWakeups()).entries.length - stage.cancels.length;
  if (ctx.intent) await appendIntent(deps.storage, ctx.waifu.id, { ...ctx.intent, at: now.toISOString(), contentDigest: wakeupChangeDigest(stage.adds.map((item) => item.entry), stage.cancels) });
  let saved: Awaited<ReturnType<typeof store.applyWakeups>>;
  try {
    saved = await store.applyWakeups({ add: stage.adds.map((item) => item.record), cancel: stage.cancels }, { ...env, sandbox });
  } catch (error) {
    if (!(error instanceof HomeError)) {
      run.receipts.push(`wakeup: saving went wrong; read ${lifeDisplay(WAKEUPS_FILE)} to see what is set`);
      throw error;
    }
    const message = itemError(error.message, kept, stage.adds).replace(/^error:\s*/u, "");
    run.receipts.push(`wakeup: nothing saved (${message})`);
    throw new ScriptError(`tools.wakeup: ${message}; nothing was saved`);
  }
  const parts: string[] = [];
  if (saved.added.length > 0) parts.push(`set ${saved.added.map((entry) => summaryOf(entry, deps.timeZone)).join(", ")}`);
  if (saved.cancelled.length > 0) parts.push(`cancelled ${saved.cancelled.join(", ")}`);
  run.receipts.push(`wakeup: saved: ${parts.join("; ")} (in ${lifeDisplay(WAKEUPS_FILE)})`);
}

async function wakeup(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  if (ctx.session === "dream") return toolError(DREAM_LIFE_REFUSED);
  const stage: WakeupStage = { adds: [], cancels: [] };
  return runScriptTool(input, ctx, {
    tool: "Wakeup",
    functions: [{ name: "wakeup", max: MAX_WAKEUP_CALLS, maxArgChars: 128 * 1024, run: (arg) => wakeupCall(arg, ctx, stage) }],
    finish: (run, ok) => saveStaged(ctx, stage, run, ok)
  });
}

export const WAKEUP_DESCRIPTION = [
  `Set wakeups: moments that wake you later. ${familyLines("wakeup")}`,
  "tools.wakeup({ at, every, watch, page, cancel }), each a list you may leave out (one item adds one wakeup; many, for many places, are fine; cancels come first, so you can replace one). It returns each new wakeup's id, kind and next times; everything is saved together when your script ends without an error (an error saves none of it), and what was saved is listed after your output:",
  '- at: [{ when, note }]: once, at "fri 18:00", "2026-10-30 18:00", "18:00" (today, else tomorrow), "in 45m" or "in 2h" (5 minutes to 30 days ahead).',
  '- every: [{ when, note }]: repeating, "day 09:00", "weekday 08:30", "weekend 11:00", "mon,fri 18:30" or a cron like "0 20 1 * *" (steps of at least 15 minutes).',
  '- watch: [{ places, from, words, any, filter, for, once, note }]: when a message in places (a place handle, a list of them, or "everywhere") is from that person, has those words (any: true for any message; every field you set must match), or instead passes your own filter function (m, state) => true | "a line to show" | false, where m is { place, from, fromId, isWaifu, text, mentionsMe, repliesToMe, ref, at, files }. for: "2h" (at most 7 days, required); once (default true). When it ends without firing you are told, so it also works as a timer (leave out from, words, any and filter for a plain timer).',
  '- page: [{ url, contains, changes, check, every, for, note }]: checks a web page, with one of contains: "in stock", changes: true, or check: (page, state) => …, page is { url, status, title, text }; every: "6h" (at least 1h), for: "3d" (at most 7 days).',
  '- cancel: ["w3"]: removes wakeups by id.',
  "Your functions run on their own for each message or check: they can't use variables from outside them, only their arguments; state is an object they may change to remember things between runs. They get 50 ms each; one that fails three times in a row stops and you are told.",
  "Use it whenever you ask something or wait for news (watch for the answer, with a sensible for), when someone mentions plans (a wakeup to ask how it went), and now and then to check back in rooms you like. All of them are in ~/life/wakeups.json: look there before adding one you have, and change them there with Edit.",
  'Example: return await tools.wakeup({ watch: [{ places: "bake-club/#general", from: "Kevin", for: "3h", note: "asked Kevin about saturday" }], at: [{ when: "fri 19:00", note: "ask Kevin how his exam went" }] })'
].join("\n");

export const wakeupTool: LifeTool = {
  name: "Wakeup",
  description: WAKEUP_DESCRIPTION,
  inputSchema: scriptSchema("JavaScript calling tools.wakeup({ at, every, watch, page, cancel }) and text()."),
  sideEffect: true,
  run: wakeup
};
