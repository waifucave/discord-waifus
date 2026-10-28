// Her `Web` script (Living cast spec §31.1), the worker side: one fresh worker thread per call, so a
// script that waits on the network for a minute never holds up anyone else's code (the §30 filter
// sandbox is one shared worker taking requests in turn). QuickJS (the same `quickjs-emscripten`
// package as §30, its sync build) runs her program with these functions and nothing else of the
// host: `search`, `open`, `print` (and `console.log`), and on a page `find`, `next`, `at`, `link`,
// `ask`.
//
// Why not the asyncify build: with it a host function can suspend QuickJS only from a call made
// through `evalCodeAsync`; the code after an `await` runs as a pending job through the synchronous
// `executePendingJobs`, where an asyncified call aborts the WebAssembly module. So web calls return
// QuickJS promises instead: each posts a request to the host and the driver loop below resolves its
// promise when the answer comes, then runs her pending jobs (one at a time, so nothing of hers runs
// once her program has ended). Several calls may be in flight at once (Promise.all).
//
// Limits: her own computing gets `cpuMs` in all (the interrupt handler's deadline moves on by the
// time spent waiting for the host; the host's watchdog does the same from the busy/idle messages
// below, for a native call QuickJS can't interrupt), plus memory and stack limits. Page windows and
// `find` are computed here over the page's text (never in the host's event loop: her RegExp can be
// slow), in the worker's own time. What leaves is short text only: prints (cut by the host), the
// result (cut here) and an error (300 characters). Values from the host enter through JSON.parse as
// it was before her code ran.
//
// This file is the worker's entry, loaded by Node directly (type stripping from source, the compiled
// .js when installed), so it imports only npm packages and `node:` builtins, and `webPage` through
// a computed dynamic import of its sibling file.

import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import type * as WebPageModule from "./webPage.js";

export type WebScriptLimits = { cpuMs: number; memoryBytes: number; stackBytes: number; maxOutputChars: number; maxHostCalls: number };
export type WebScriptInput = { script: string; limits: WebScriptLimits; clock: { nowMs: number; timeZone: string } };
export type WebScriptErrorKind = "time" | "memory" | "stack" | "error";
export type WebScriptError = { kind: WebScriptErrorKind; name: string; message: string; line?: number };
/** The run's end: what she returned (shown as text) or her error; prints went out as they came. */
export type WebScriptDone = { ok: true; value: string | null; cut: boolean } | { ok: false; error: WebScriptError };

/**
 * Worker → host. `busy`/`idle`: her code runs / waits for the host, each stamped with this worker's
 * clock when it happened (`performance.timeOrigin + performance.now()`): the host sums her busy time
 * from these stamps, so a host busy with something else never adds to it.
 */
export type WebWorkerMessage =
  | { t: "busy"; at: number }
  | { t: "idle"; at: number }
  | { t: "call"; call: number; fn: "search" | "open" | "ask"; args: string }
  | { t: "print"; text: string }
  | { t: "done"; result: WebScriptDone };
/** Host → worker: a call's answer (its JSON), or its error text. */
export type WebHostReply = { t: "reply"; call: number; ok: true; value: string } | { t: "reply"; call: number; ok: false; error: string };

export const MAX_ERROR_CHARS = 300;
const MAX_ERROR_NAME_CHARS = 60;
/** One call's arguments as JSON. */
export const MAX_CALL_ARGS_CHARS = 16_384;
/** One print's text (the host keeps 8,000 in all). */
const MAX_PRINT_CHARS = 8_200;
const TIME_SLACK_MS = 25;

// ---- her clock (as in sandboxWorker.ts: `Date` is the app's clock in her zone) ---------------------

let zone = "UTC";
let clockBase = { appMs: Date.now(), realMs: performance.now() };
let zoneFormat: Intl.DateTimeFormat | undefined;
function offsetMinutes(ms: number): number {
  zoneFormat ??= new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  if (!Number.isFinite(ms)) return 0;
  const parts: Record<string, number> = {};
  for (const part of zoneFormat.formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const asUtc = Date.UTC(parts["year"]!, parts["month"]! - 1, parts["day"]!, parts["hour"]!, parts["minute"]!, parts["second"]!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function errorOf(vm: QuickJSContext, handle: QuickJSHandle, timedOut: boolean): WebScriptError {
  let dumped: unknown;
  try {
    dumped = vm.dump(handle);
  } catch {
    dumped = undefined;
  }
  const record = typeof dumped === "object" && dumped !== null ? (dumped as Record<string, unknown>) : {};
  const name = typeof record["name"] === "string" ? record["name"] : "Error";
  const message = typeof record["message"] === "string" ? record["message"] : typeof dumped === "string" ? dumped : String(dumped);
  const stack = typeof record["stack"] === "string" ? record["stack"] : "";
  // `at f (script:3:9)` for a runtime error, `at script:3:9` for a syntax error.
  const where = /(?:\(|at )script:(\d+)/u.exec(stack.slice(0, 2_000));
  const kind: WebScriptErrorKind =
    timedOut || (name === "InternalError" && message === "interrupted") ? "time" : name === "InternalError" && message === "out of memory" ? "memory" : name === "InternalError" && message === "stack overflow" ? "stack" : "error";
  return { kind, name: cut(name, MAX_ERROR_NAME_CHARS), message: cut(message, MAX_ERROR_CHARS), ...(where ? { line: Number(where[1]) } : {}) };
}

/**
 * Built before her code runs, from the built-ins as they are then: her functions and the readers the
 * worker uses (`pageOf` makes a page with its methods, `show` the text of a value, `parse` reads the
 * host's JSON). She may replace anything afterwards; that changes only what her own code sees.
 */
const PRELUDE = `(function (host, pageOp, out) {
  "use strict";
  var parse = JSON.parse, stringify = JSON.stringify, StringOf = String, ErrorOf = Error;
  var uncurry = Function.prototype.bind.bind(Function.prototype.call);
  var sourceOf = uncurry(Object.getOwnPropertyDescriptor(RegExp.prototype, "source").get);
  var flagsOf = uncurry(Object.getOwnPropertyDescriptor(RegExp.prototype, "flags").get);
  var push = uncurry(Array.prototype.push), join = uncurry(Array.prototype.join);
  // The error a failed call rejects with is made here, so its stack has her line.
  function call(fn, args) { return host(fn, stringify(args), new ErrorOf()); }
  function query(q) {
    if (typeof q === "string") return { text: q };
    var source;
    try { source = sourceOf(q); } catch (e) { throw new TypeError("find takes text or a RegExp"); }
    return { regex: source, flags: StringOf(flagsOf(q)) };
  }
  function open(target, options) {
    var url = target !== null && typeof target === "object" && typeof target.url === "string" ? target.url : target;
    return call("open", [url, options === undefined ? null : options]);
  }
  function makePage(data) {
    var id = data.id, next = data.next;
    var page = { url: data.url, title: data.title, status: data.status, line: data.line, lines: data.lines, total: data.total, links: data.links, more: data.more };
    if (data.note) page.note = data.note;
    page.find = function find(q) { return parse(pageOp("find", id, stringify(query(q)))); };
    page.next = function next_() { return next === null ? null : makePage(parse(pageOp("at", id, stringify(next)))); };
    page.at = function at(line) { return makePage(parse(pageOp("at", id, stringify(line === undefined ? null : line)))); };
    page.link = function link(n, options) { return open(pageOp("link", id, stringify(n === undefined ? null : n)), options); };
    page.ask = function ask(question) { return call("ask", [id, question === undefined ? null : question]); };
    return page;
  }
  function show(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return undefined;
    var text = stringify(value);
    return typeof text === "string" ? text : undefined;
  }
  function print() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) { var s = show(arguments[i]); push(parts, s === undefined ? "undefined" : s); }
    out(join(parts, " "));
  }
  return {
    search: function search(q, options) { return call("search", [q === undefined ? null : q, options === undefined ? null : options]); },
    open: open,
    print: print,
    pageOf: function (json) { return makePage(parse(json)); },
    show: function (value) { var text = show(value); return typeof text === "string" ? text : null; },
    parse: function (json) { return parse(json); }
  };
})`;

async function main(input: WebScriptInput, post: (message: WebWorkerMessage) => void, replies: AsyncIterator<WebHostReply>): Promise<WebScriptDone> {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const pages = (await import(new URL(`./webPage${ext}`, import.meta.url).href)) as typeof WebPageModule;
  const module = await newQuickJSWASMModule(RELEASE_SYNC);
  zone = input.clock.timeZone || "UTC";
  Date.prototype.getTimezoneOffset = function getTimezoneOffset(this: Date): number {
    return -offsetMinutes(this.getTime());
  };
  Date.now = () => clockBase.appMs + Math.floor(performance.now() - clockBase.realMs);

  const { limits } = input;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const started = performance.now();
  clockBase = { appMs: input.clock.nowMs, realMs: started };
  let waited = 0;
  const used = () => performance.now() - started - waited;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (used() > limits.cpuMs) interrupted = true;
    return interrupted;
  });
  const overTime = () => used() > limits.cpuMs + TIME_SLACK_MS;
  const TIME_HIT: WebScriptError = { kind: "time", name: "InternalError", message: "interrupted" };
  const vm = runtime.newContext();

  const stored = new Map<string, WebPageModule.StoredPage>();
  const pending = new Map<number, { deferred: QuickJSDeferredPromise; fn: string; error: QuickJSHandle | undefined }>();
  let calls = 0;
  let ended = false;
  let printed = 0;
  const thrown = (name: string, message: string) => ({ error: vm.newError({ name, message: cut(message, MAX_ERROR_CHARS) }) });
  /** A string argument, refused when too long before it is copied out. */
  const stringArg = (handle: QuickJSHandle | undefined, max: number): string | undefined => {
    if (!handle || vm.typeof(handle) !== "string") return undefined;
    const length = vm.getNumber(vm.getProp(handle, "length"));
    if (!(length <= max)) return undefined;
    return vm.getString(handle);
  };

  const host = vm.newFunction("host", (fnHandle, argsHandle, errorHandle) => {
    if (ended) return thrown("Error", "the script has ended; web calls after it are not made");
    const fn = stringArg(fnHandle, 10);
    if (fn !== "search" && fn !== "open" && fn !== "ask") return thrown("TypeError", "unknown web call");
    const args = stringArg(argsHandle, MAX_CALL_ARGS_CHARS);
    if (args === undefined) return thrown("RangeError", `what you gave ${fn}() can't be sent: plain text, numbers and lists only, at most ${MAX_CALL_ARGS_CHARS} characters as JSON`);
    calls += 1;
    if (calls > limits.maxHostCalls) return thrown("RangeError", `a script can make at most ${limits.maxHostCalls} web calls`);
    const deferred = vm.newPromise();
    pending.set(calls, { deferred, fn, error: errorHandle && vm.typeof(errorHandle) === "object" ? errorHandle.dup() : undefined });
    post({ t: "call", call: calls, fn, args });
    return deferred.handle;
  });
  const pageOp = vm.newFunction("pageOp", (opHandle, idHandle, argHandle) => {
    const op = stringArg(opHandle, 10);
    const id = stringArg(idHandle, 40);
    const page = id === undefined ? undefined : stored.get(id);
    const arg = stringArg(argHandle, MAX_CALL_ARGS_CHARS);
    if (!page || arg === undefined) return thrown("TypeError", "that isn't a page you opened in this script");
    let value: unknown;
    try {
      value = JSON.parse(arg);
    } catch {
      return thrown("TypeError", "that can't be read");
    }
    try {
      if (op === "find") {
        const query = typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string"
          ? { text: (value as { text: string }).text }
          : typeof value === "object" && value !== null && typeof (value as { regex?: unknown }).regex === "string" && typeof (value as { flags?: unknown }).flags === "string"
            ? { regex: (value as { regex: string }).regex, flags: (value as { flags: string }).flags }
            : undefined;
        if (!query) return thrown("TypeError", "find takes text or a RegExp");
        return vm.newString(JSON.stringify(pages.findIn(page, query)));
      }
      if (op === "at") {
        if (typeof value !== "number" || !Number.isInteger(value)) return thrown("TypeError", "at takes a line number, like page.at(120)");
        return vm.newString(JSON.stringify(pages.windowAt(page, value)));
      }
      if (op === "link") return vm.newString(pages.linkUrl(page, value));
    } catch (error) {
      const name = error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError" : "TypeError";
      return thrown(name, error instanceof Error ? error.message : String(error));
    }
    return thrown("TypeError", "unknown page call");
  });
  const out = vm.newFunction("out", (textHandle) => {
    if (vm.typeof(textHandle) !== "string") return;
    const length = vm.getNumber(vm.getProp(textHandle, "length"));
    // The host keeps 8,000 characters in all; past that nothing more is copied out.
    if (printed > limits.maxOutputChars) return;
    const text = length > MAX_PRINT_CHARS ? cut(vm.getString(textHandle).slice(0, MAX_PRINT_CHARS + 1), MAX_PRINT_CHARS) : vm.getString(textHandle);
    printed += text.length + 1;
    post({ t: "print", text });
  });

  const finish = (result: WebScriptDone): WebScriptDone => {
    ended = true;
    return result;
  };
  const stamp = () => performance.timeOrigin + performance.now();
  try {
    post({ t: "busy", at: stamp() });
    const factory = vm.evalCode(PRELUDE, "prelude");
    if (factory.error) return finish({ ok: false, error: errorOf(vm, factory.error, interrupted) });
    const api = vm.callFunction(factory.value, vm.undefined, host, pageOp, out);
    factory.value.dispose();
    if (api.error) return finish({ ok: false, error: errorOf(vm, api.error, interrupted) });
    const pageOf = vm.getProp(api.value, "pageOf");
    const show = vm.getProp(api.value, "show");
    const parse = vm.getProp(api.value, "parse");
    for (const name of ["search", "open", "print"]) {
      const fn = vm.getProp(api.value, name);
      vm.setProp(vm.global, name, fn);
      if (name === "print") {
        const consoleObject = vm.newObject();
        vm.setProp(consoleObject, "log", fn);
        vm.setProp(vm.global, "console", consoleObject);
        consoleObject.dispose();
      }
      fn.dispose();
    }
    api.value.dispose();
    host.dispose();
    pageOp.dispose();
    out.dispose();

    // Her program, as the body of an async function on her own line numbers.
    const evaluated = vm.evalCode(`(async function () {${input.script}\n})()`, "script");
    if (evaluated.error) return finish({ ok: false, error: overTime() ? TIME_HIT : errorOf(vm, evaluated.error, interrupted) });
    const program = evaluated.value;
    for (;;) {
      // Her pending jobs, one at a time: once her program has settled nothing else of hers runs.
      let state = vm.getPromiseState(program);
      while (state.type === "pending") {
        const job = runtime.executePendingJobs(1);
        if (job.error) {
          const error = errorOf(vm, job.error, interrupted);
          job.error.dispose();
          return finish({ ok: false, error: overTime() ? TIME_HIT : error });
        }
        if (overTime()) return finish({ ok: false, error: TIME_HIT });
        state = vm.getPromiseState(program);
        if (job.value === 0) break;
      }
      if (state.type === "fulfilled") {
        ended = true;
        const shown = vm.callFunction(show, vm.undefined, state.value);
        state.value.dispose();
        if (shown.error) return finish({ ok: false, error: errorOf(vm, shown.error, interrupted) });
        const full = vm.typeof(shown.value) === "string" ? vm.getString(shown.value) : null;
        shown.value.dispose();
        if (overTime()) return finish({ ok: false, error: TIME_HIT });
        return finish({ ok: true, value: full === null ? null : full.slice(0, limits.maxOutputChars), cut: full !== null && full.length > limits.maxOutputChars });
      }
      if (state.type === "rejected") {
        ended = true;
        const error = errorOf(vm, state.error, interrupted);
        state.error.dispose();
        return finish({ ok: false, error: overTime() ? TIME_HIT : error });
      }
      // Waiting: for the host, or for nothing that will ever come.
      if (pending.size === 0) return finish({ ok: false, error: { kind: "error", name: "Error", message: "your script is waiting for something that never finishes" } });
      post({ t: "idle", at: stamp() });
      const waitStart = performance.now();
      const next = await replies.next();
      waited += performance.now() - waitStart;
      post({ t: "busy", at: stamp() });
      if (next.done) return finish({ ok: false, error: { kind: "error", name: "Error", message: "the script was stopped" } });
      const reply = next.value;
      const entry = pending.get(reply.call);
      if (!entry) continue;
      pending.delete(reply.call);
      if (!reply.ok) {
        const message = cut(String(reply.error), MAX_ERROR_CHARS);
        const error = entry.error ?? vm.newError({ name: "Error", message });
        if (entry.error) vm.setProp(error, "message", vm.newString(message));
        entry.deferred.reject(error);
        error.dispose();
      } else if (entry.fn === "open") {
        let window: string;
        try {
          const opened = JSON.parse(reply.value) as WebPageModule.OpenedPage & { line?: number };
          const page = pages.storePage(opened);
          stored.set(page.id, page);
          window = JSON.stringify(pages.windowAt(page, opened.line ?? 0));
        } catch (error) {
          const thrownError = vm.newError({ name: error instanceof RangeError ? "RangeError" : "Error", message: cut(error instanceof Error ? error.message : "the page can't be read", MAX_ERROR_CHARS) });
          entry.deferred.reject(thrownError);
          thrownError.dispose();
          entry.deferred.dispose();
          continue;
        }
        const page = vm.callFunction(pageOf, vm.undefined, vm.newString(window));
        if (page.error) {
          entry.deferred.reject(page.error);
          page.error.dispose();
        } else {
          entry.deferred.resolve(page.value);
          page.value.dispose();
        }
      } else {
        const value = vm.callFunction(parse, vm.undefined, vm.newString(reply.value));
        if (value.error) {
          entry.deferred.reject(value.error);
          value.error.dispose();
        } else {
          entry.deferred.resolve(value.value);
          value.value.dispose();
        }
      }
      if (reply.ok) entry.error?.dispose();
      entry.deferred.dispose();
      if (overTime()) return finish({ ok: false, error: TIME_HIT });
    }
  } catch (error) {
    const message = cut(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS);
    return finish({ ok: false, error: overTime() ? TIME_HIT : { kind: /memory|allocat/iu.test(message) ? "memory" : "error", name: "InternalError", message } });
  }
  // The worker ends after this run: the host terminates it, so nothing here is disposed.
}

/** Replies from the host as an async iterator (the driver loop waits on it). */
function replyQueue(): { push(reply: WebHostReply): void; iterator: AsyncIterator<WebHostReply> } {
  const queued: WebHostReply[] = [];
  let waiting: ((result: IteratorResult<WebHostReply>) => void) | undefined;
  return {
    push(reply) {
      if (waiting) {
        const resolve = waiting;
        waiting = undefined;
        resolve({ value: reply, done: false });
      } else queued.push(reply);
    },
    iterator: {
      next: () => {
        const reply = queued.shift();
        if (reply) return Promise.resolve({ value: reply, done: false });
        return new Promise((resolve) => (waiting = resolve));
      }
    }
  };
}

if (parentPort && workerData && typeof (workerData as { script?: unknown }).script === "string") {
  const port = parentPort;
  const queue = replyQueue();
  port.on("message", (message: WebHostReply) => {
    if (message && message.t === "reply") queue.push(message);
  });
  main(workerData as WebScriptInput, (message) => port.postMessage(message), queue.iterator).then(
    (result) => port.postMessage({ t: "done", result } satisfies WebWorkerMessage),
    (error: unknown) => port.postMessage({ t: "done", result: { ok: false, error: { kind: "error", name: "InternalError", message: cut(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS) } } } satisfies WebWorkerMessage)
  );
}
