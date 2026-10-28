// Her tool script (Living cast spec §32.1), the worker side: one fresh worker thread per call, so a
// script that waits on the network or in a chat for a minute never holds up anyone else's code (the
// §30 filter sandbox is one shared worker taking requests in turn). QuickJS (the same
// `quickjs-emscripten` package as §30, its sync build) runs her program with these globals and
// nothing else of the host: `tools` (the calling tool's own functions, each taking one value and
// returning a promise; another tool's function throws a readable error naming that tool), `text()`
// (and `console.log`, the same).
//
// Why not the asyncify build: with it a host function can suspend QuickJS only from a call made
// through `evalCodeAsync`; the code after an `await` runs as a pending job through the synchronous
// `executePendingJobs`, where an asyncified call aborts the WebAssembly module. So host calls return
// QuickJS promises instead: each posts a request to the host and the driver loop below resolves its
// promise when the answer comes, then runs her pending jobs (one at a time, so nothing of hers runs
// once her program has ended). Several calls may be in flight at once (Promise.all).
//
// Limits: her own computing gets `cpuMs` in all (the interrupt handler's deadline moves on by the
// time spent waiting for the host; the host's watchdog does the same from the busy/idle messages
// below, for a native call QuickJS can't interrupt), plus memory and stack limits. What leaves is
// short text only: what she shows (cut by the host), a call's argument as JSON (refused past
// `maxArgChars` before it is copied out), the result and an error (300 characters). Values from the
// host enter through JSON.parse as it was before her code ran.
//
// This file is the worker's entry, loaded by Node directly (type stripping from source, the compiled
// .js when installed), so it imports only npm packages and `node:` builtins.

import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";

export type ToolScriptLimits = { cpuMs: number; memoryBytes: number; stackBytes: number; maxOutputChars: number; maxHostCalls: number; maxArgChars: number };
/**
 * What her script sees: `functions` on `tools` (snake_case names), `others` the functions of the other
 * tools (name → the error calling one throws), `legacy` old globals (name → the error calling one
 * throws: `search()` became `tools.web__run`).
 */
export type ToolScriptSurface = { functions: string[]; others: Record<string, string>; legacy: Record<string, string> };
export type ToolScriptInput = { script: string; limits: ToolScriptLimits; surface: ToolScriptSurface; clock: { nowMs: number; timeZone: string } };
export type ToolScriptErrorKind = "time" | "memory" | "stack" | "error";
export type ToolScriptError = { kind: ToolScriptErrorKind; name: string; message: string; line?: number };
/**
 * The run's end: her return value as it is shown (`text`, or an image result's `image` id; null for
 * nothing), whether she called `text()` at all, or her error. What she showed went out as it came.
 */
export type ToolScriptDone = { ok: true; value: string | null; image?: string; cut: boolean; shown: boolean } | { ok: false; error: ToolScriptError };

/**
 * Worker → host. `busy`/`idle`: her code runs / waits for the host, each stamped with this worker's
 * clock when it happened (`performance.timeOrigin + performance.now()`): the host sums her busy time
 * from these stamps, so a host busy with something else never adds to it.
 */
export type ToolWorkerMessage =
  | { t: "busy"; at: number }
  | { t: "idle"; at: number }
  | { t: "call"; call: number; fn: string; arg: string }
  | { t: "text"; text: string }
  | { t: "image"; id: string }
  | { t: "done"; result: ToolScriptDone };
/** Host → worker: a call's answer (its JSON), or its error (name and text). */
export type ToolHostReply = { t: "reply"; call: number; ok: true; value: string } | { t: "reply"; call: number; ok: false; name?: string; error: string };

export const MAX_ERROR_CHARS = 1_000;
const MAX_ERROR_NAME_CHARS = 60;
const MAX_IMAGE_ID_CHARS = 40;
const TIME_SLACK_MS = 25;
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError"]);

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

function errorOf(vm: QuickJSContext, handle: QuickJSHandle, timedOut: boolean): ToolScriptError {
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
  const kind: ToolScriptErrorKind =
    timedOut || (name === "InternalError" && message === "interrupted") ? "time" : name === "InternalError" && message === "out of memory" ? "memory" : name === "InternalError" && message === "stack overflow" ? "stack" : "error";
  return { kind, name: cut(name, MAX_ERROR_NAME_CHARS), message: cut(message, MAX_ERROR_CHARS), ...(where ? { line: Number(where[1]) } : {}) };
}

/**
 * Built before her code runs, from the built-ins as they are then: `tools`, `text` and the readers
 * the worker uses (`show` the text of a value, `parse` reads the host's JSON). She may replace
 * anything afterwards; that changes only what her own code sees. A function inside a call's argument
 * goes to the host as its source text (`{"$function": "…"}`, read with Function.prototype.toString
 * as it was), which only the Wakeup tool accepts.
 */
const PRELUDE = `(function (host, out, outImage, surfaceJson) {
  "use strict";
  var parse = JSON.parse, stringify = JSON.stringify, ErrorOf = Error, TypeErrorOf = TypeError, ObjectOf = Object;
  var uncurry = Function.prototype.bind.bind(Function.prototype.call);
  var sourceOf = uncurry(Function.prototype.toString);
  var hasOwn = uncurry(Object.prototype.hasOwnProperty);
  var push = uncurry(Array.prototype.push), join = uncurry(Array.prototype.join);
  var surface = parse(surfaceJson);
  function replacer(key, value) { return typeof value === "function" ? { "$function": sourceOf(value) } : value; }
  // The error a failed call rejects with is made here, so its stack has her line.
  function call(fn, arg) {
    var json = stringify(arg === undefined ? null : arg, replacer);
    return host(fn, typeof json === "string" ? json : "null", new ErrorOf());
  }
  var tools = {};
  surface.functions.forEach(function (name) {
    tools[name] = ({ [name]: function (arg) {
      if (arguments.length > 1) throw new TypeErrorOf("tools." + name + " takes one argument");
      return call(name, arg);
    } })[name];
  });
  ObjectOf.keys(surface.others).forEach(function (name) {
    var message = surface.others[name];
    tools[name] = ({ [name]: function () { throw new TypeErrorOf(message); } })[name];
  });
  var legacy = {};
  ObjectOf.keys(surface.legacy).forEach(function (name) {
    var message = surface.legacy[name];
    legacy[name] = ({ [name]: function () { throw new TypeErrorOf(message); } })[name];
  });
  function imageId(value) {
    if (value === null || typeof value !== "object") return undefined;
    if (value.kind !== "image" || typeof value.image_id !== "string") return undefined;
    return value.image_id;
  }
  function show(value) {
    if (typeof value === "string") return value;
    if (value === undefined) return undefined;
    var text = stringify(value);
    return typeof text === "string" ? text : undefined;
  }
  var shown = false;
  function text() {
    shown = true;
    if (arguments.length === 1) {
      var id = imageId(arguments[0]);
      if (id !== undefined) { outImage(id); return; }
    }
    var parts = [];
    for (var i = 0; i < arguments.length; i++) { var s = show(arguments[i]); push(parts, s === undefined ? "undefined" : s); }
    out(join(parts, " "));
  }
  return {
    tools: tools,
    legacy: legacy,
    text: text,
    shown: function () { return shown; },
    image: function (value) { var id = imageId(value); return id === undefined ? null : id; },
    show: function (value) { var t = show(value); return typeof t === "string" ? t : null; },
    parse: function (json) { return parse(json); }
  };
})`;

async function main(input: ToolScriptInput, post: (message: ToolWorkerMessage) => void, replies: AsyncIterator<ToolHostReply>): Promise<ToolScriptDone> {
  const module = await newQuickJSWASMModule(RELEASE_SYNC);
  zone = input.clock.timeZone || "UTC";
  Date.prototype.getTimezoneOffset = function getTimezoneOffset(this: Date): number {
    return -offsetMinutes(this.getTime());
  };
  Date.now = () => clockBase.appMs + Math.floor(performance.now() - clockBase.realMs);

  const { limits, surface } = input;
  const allowed = new Set(surface.functions);
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
  const TIME_HIT: ToolScriptError = { kind: "time", name: "InternalError", message: "interrupted" };
  const vm = runtime.newContext();

  const pending = new Map<number, { deferred: QuickJSDeferredPromise; error: QuickJSHandle | undefined }>();
  let calls = 0;
  let ended = false;
  let shownChars = 0;
  const maxTextChars = limits.maxOutputChars + 200;
  const thrown = (name: string, message: string) => ({ error: vm.newError({ name, message: cut(message, MAX_ERROR_CHARS) }) });
  /** A string argument, refused when too long before it is copied out. */
  const stringArg = (handle: QuickJSHandle | undefined, max: number): string | undefined => {
    if (!handle || vm.typeof(handle) !== "string") return undefined;
    const length = vm.getNumber(vm.getProp(handle, "length"));
    if (!(length <= max)) return undefined;
    return vm.getString(handle);
  };

  const host = vm.newFunction("host", (fnHandle, argHandle, errorHandle) => {
    if (ended) return thrown("Error", "the script has ended; calls after it are not made");
    const fn = stringArg(fnHandle, 40);
    if (fn === undefined || !allowed.has(fn)) return thrown("TypeError", "unknown tool function");
    const arg = stringArg(argHandle, limits.maxArgChars);
    if (arg === undefined) return thrown("RangeError", `what you gave tools.${fn}() can't be sent: plain text, numbers, lists and objects only, at most ${limits.maxArgChars.toLocaleString("en-US")} characters as JSON`);
    calls += 1;
    if (calls > limits.maxHostCalls) return thrown("RangeError", `a script can make at most ${limits.maxHostCalls} tool calls`);
    const deferred = vm.newPromise();
    pending.set(calls, { deferred, error: errorHandle && vm.typeof(errorHandle) === "object" ? errorHandle.dup() : undefined });
    post({ t: "call", call: calls, fn, arg });
    return deferred.handle;
  });
  const out = vm.newFunction("out", (textHandle) => {
    if (vm.typeof(textHandle) !== "string") return;
    const length = vm.getNumber(vm.getProp(textHandle, "length"));
    // The host keeps `maxOutputChars` in all; past that nothing more is copied out.
    if (shownChars > limits.maxOutputChars) return;
    const text = length > maxTextChars ? cut(vm.getString(textHandle).slice(0, maxTextChars + 1), maxTextChars) : vm.getString(textHandle);
    shownChars += text.length + 1;
    post({ t: "text", text });
  });
  const outImage = vm.newFunction("outImage", (idHandle) => {
    const id = stringArg(idHandle, MAX_IMAGE_ID_CHARS);
    if (id !== undefined) post({ t: "image", id });
  });

  const finish = (result: ToolScriptDone): ToolScriptDone => {
    ended = true;
    return result;
  };
  const stamp = () => performance.timeOrigin + performance.now();
  try {
    post({ t: "busy", at: stamp() });
    const factory = vm.evalCode(PRELUDE, "prelude");
    if (factory.error) return finish({ ok: false, error: errorOf(vm, factory.error, interrupted) });
    const api = vm.callFunction(factory.value, vm.undefined, host, out, outImage, vm.newString(JSON.stringify(surface)));
    factory.value.dispose();
    if (api.error) return finish({ ok: false, error: errorOf(vm, api.error, interrupted) });
    const show = vm.getProp(api.value, "show");
    const image = vm.getProp(api.value, "image");
    const shownFn = vm.getProp(api.value, "shown");
    const parse = vm.getProp(api.value, "parse");
    const tools = vm.getProp(api.value, "tools");
    vm.setProp(vm.global, "tools", tools);
    tools.dispose();
    const text = vm.getProp(api.value, "text");
    vm.setProp(vm.global, "text", text);
    const consoleObject = vm.newObject();
    vm.setProp(consoleObject, "log", text);
    vm.setProp(vm.global, "console", consoleObject);
    consoleObject.dispose();
    text.dispose();
    const legacy = vm.getProp(api.value, "legacy");
    for (const name of Object.keys(surface.legacy)) {
      const fn = vm.getProp(legacy, name);
      vm.setProp(vm.global, name, fn);
      fn.dispose();
    }
    legacy.dispose();
    api.value.dispose();
    host.dispose();
    out.dispose();
    outImage.dispose();
    const calledText = (): boolean => {
      const result = vm.callFunction(shownFn, vm.undefined);
      if (result.error) {
        result.error.dispose();
        return false;
      }
      const value = vm.dump(result.value) === true;
      result.value.dispose();
      return value;
    };

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
        const shown = calledText();
        if (shown) {
          state.value.dispose();
          return finish({ ok: true, value: null, cut: false, shown: true });
        }
        // Nothing shown with text(): her return value is (an image result as the picture).
        const imageResult = vm.callFunction(image, vm.undefined, state.value);
        if (!imageResult.error && vm.typeof(imageResult.value) === "string") {
          const id = cut(vm.getString(imageResult.value), MAX_IMAGE_ID_CHARS);
          imageResult.value.dispose();
          state.value.dispose();
          return finish({ ok: true, value: null, image: id, cut: false, shown: false });
        }
        if (imageResult.error) imageResult.error.dispose();
        else imageResult.value.dispose();
        const shownValue = vm.callFunction(show, vm.undefined, state.value);
        state.value.dispose();
        if (shownValue.error) return finish({ ok: false, error: errorOf(vm, shownValue.error, interrupted) });
        const full = vm.typeof(shownValue.value) === "string" ? vm.getString(shownValue.value) : null;
        shownValue.value.dispose();
        if (overTime()) return finish({ ok: false, error: TIME_HIT });
        return finish({ ok: true, value: full === null ? null : full.slice(0, limits.maxOutputChars), cut: full !== null && full.length > limits.maxOutputChars, shown: false });
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
        const name = typeof reply.name === "string" && ERROR_NAMES.has(reply.name) ? reply.name : "Error";
        const error = entry.error ?? vm.newError({ name, message });
        if (entry.error) {
          vm.setProp(error, "message", vm.newString(message));
          vm.setProp(error, "name", vm.newString(name));
        }
        entry.deferred.reject(error);
        error.dispose();
      } else {
        const value = vm.callFunction(parse, vm.undefined, vm.newString(reply.value));
        if (value.error) {
          entry.deferred.reject(value.error);
          value.error.dispose();
        } else {
          entry.deferred.resolve(value.value);
          value.value.dispose();
        }
        entry.error?.dispose();
      }
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
function replyQueue(): { push(reply: ToolHostReply): void; iterator: AsyncIterator<ToolHostReply> } {
  const queued: ToolHostReply[] = [];
  let waiting: ((result: IteratorResult<ToolHostReply>) => void) | undefined;
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
  port.on("message", (message: ToolHostReply) => {
    if (message && message.t === "reply") queue.push(message);
  });
  main(workerData as ToolScriptInput, (message) => port.postMessage(message), queue.iterator).then(
    (result) => port.postMessage({ t: "done", result } satisfies ToolWorkerMessage),
    (error: unknown) => port.postMessage({ t: "done", result: { ok: false, error: { kind: "error", name: "InternalError", message: cut(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS) } } } satisfies ToolWorkerMessage)
  );
}
