// Her code's sandbox (Living cast spec §30.1), the worker side: QuickJS compiled to WebAssembly
// (`quickjs-emscripten`, exact pin) in its own worker thread. Every run gets a fresh QuickJS runtime
// and context with a CPU deadline (the interrupt handler, and the run timed as a whole), a memory
// limit and a stack limit, and sees only standard JavaScript built-ins: no `require`, no modules, no
// network, no file system, no timers, no host objects. Values cross as JSON text only, read out with
// built-ins captured before her code runs, and only short text leaves: errors, her string answers
// and her state are cut here (`MAX_*` below), so nothing she does can make a big answer.
//
// The worker is long-lived (one per process); the host restarts it after a crash or a limit hit.
// This file is the worker's entry, loaded by Node directly (type stripping from source, the compiled
// .js when installed), so it imports only npm packages and `node:` builtins.
//
// The asyncify build (`RELEASE_ASYNC`) is the path for §31's awaited host calls; this worker uses
// the sync build and keeps its requests generic (`run` steps, `call`, `compile`) so another op can
// be added beside them.

import { parentPort } from "node:worker_threads";
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSContext, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from "quickjs-emscripten";

export type SandboxLimits = {
  /** CPU budget of one run (the interrupt handler's deadline, and the run's whole time), ms. */
  timeMs: number;
  memoryBytes: number;
  stackBytes: number;
};

/** A run that finished but took longer than its budget plus this is a time limit hit. */
export const TIME_SLACK_MS = 25;
/** An error's message as it leaves the sandbox (her file and her wake carry it). */
export const MAX_ERROR_CHARS = 300;
export const MAX_ERROR_NAME_CHARS = 60;
/** A string answer (her wake's line is 200 characters; a little more, cut by the host). */
export const MAX_RESULT_UNITS = 402;
/** An argument's JSON after the call (her state is at most 4 KiB as UTF-8, so never more characters). */
export const MAX_ARG_CHARS = 4_096;
/** A `run`'s value (her script's recorded calls). */
export const MAX_RUN_VALUE_CHARS = 256 * 1024;

export type SandboxErrorKind = "time" | "memory" | "stack" | "error";
export type SandboxError = { kind: SandboxErrorKind; name: string; message: string; file?: string; line?: number };

/** One step of a `run`: code evaluated in the run's context, in order. */
export type SandboxStep = { code: string; file: string };

export type SandboxRequest =
  | { id: number; op: "run"; steps: SandboxStep[]; limits: SandboxLimits; clock: SandboxClock }
  | { id: number; op: "call"; calls: SandboxCall[]; limits: SandboxLimits; clock: SandboxClock }
  | { id: number; op: "compile"; sources: string[]; limits: SandboxLimits; clock: SandboxClock };

/** Her clock inside the sandbox: `Date` reads the app's time in her time zone. */
export type SandboxClock = { nowMs: number; timeZone: string };

/** A function (its source) called with JSON arguments; the arguments come back after the call (her `state`). */
export type SandboxCall = { source: string; file: string; args: string[] };

/** An argument after the call: its JSON text, or why it can't come back. */
export type SandboxArgAfter = string | { problem: "not-json" | "too-large" };

/** A run's value: the last step's value, which must be a string (JSON text). */
export type SandboxRunResult = { ok: true; value: string } | { ok: false; error: SandboxError };
/** A call: what it returned (`true`, a string, or null for anything else) and the arguments after it. */
export type SandboxCallResult = { ok: true; result: true | string | null; args: SandboxArgAfter[] } | { ok: false; error: SandboxError };
export type SandboxCompileResult = { ok: true } | { ok: false; error: SandboxError };

/** What the worker sends: a run starting, a run's result, the request's end, or a failure. */
export type SandboxMessage =
  | { id: number; progress: number }
  | { id: number; done: number; result: SandboxRunResult | SandboxCallResult | SandboxCompileResult }
  | { id: number; end: true }
  | { id: number; fatal: string };

// ---- her clock -----------------------------------------------------------------------------------
//
// QuickJS asks the C library for local time (`localtime_r`), which Emscripten answers with this
// isolate's own `Date`: only `getTimezoneOffset` (her zone) and `Date.now` (the app's clock, which
// the tests fix) are read. Patched here, in the worker's isolate only.

let zone = "UTC";
let clockBase = { appMs: Date.now(), realMs: performance.now() };
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function offsetMinutes(ms: number): number {
  let format = zoneFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    zoneFormats.set(zone, format);
  }
  if (!Number.isFinite(ms)) return 0;
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const asUtc = Date.UTC(parts["year"]!, parts["month"]! - 1, parts["day"]!, parts["hour"]!, parts["minute"]!, parts["second"]!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

Date.prototype.getTimezoneOffset = function getTimezoneOffset(this: Date): number {
  return -offsetMinutes(this.getTime());
};
Date.now = () => clockBase.appMs + Math.floor(performance.now() - clockBase.realMs);

function setClock(clock: SandboxClock): void {
  zone = clock.timeZone || "UTC";
  clockBase = { appMs: clock.nowMs, realMs: performance.now() };
}

// ---- runs ----------------------------------------------------------------------------------------

let modulePromise: Promise<QuickJSWASMModule> | undefined;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModule(RELEASE_SYNC);
  return modulePromise;
}

type Fresh = { runtime: QuickJSRuntime; vm: QuickJSContext; timedOut: () => boolean; started: number; limits: SandboxLimits };

function fresh(module: QuickJSWASMModule, limits: SandboxLimits): Fresh {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const started = performance.now();
  // Her clock starts at the request's time for every run.
  clockBase.realMs = started;
  const deadline = started + limits.timeMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() > deadline) interrupted = true;
    return interrupted;
  });
  const vm = runtime.newContext();
  return { runtime, vm, timedOut: () => interrupted, started, limits };
}

/**
 * QuickJS checks its interrupt handler only between JavaScript steps, so one native call (a string
 * search over long strings) can run far past the deadline and still finish: every run is also timed
 * as a whole, and one over its budget (plus `TIME_SLACK_MS`) is a time limit hit like any other.
 */
function overTime(run: Fresh): boolean {
  return performance.now() - run.started > run.limits.timeMs + TIME_SLACK_MS;
}

const TIME_HIT: SandboxError = { kind: "time", name: "InternalError", message: "interrupted" };

function dispose(run: Fresh): void {
  try {
    run.vm.dispose();
  } catch {
    // a context left in a bad state by a limit hit: the worker is restarted after this run
  }
  try {
    run.runtime.dispose();
  } catch {
    // as above
  }
}

/** Text cut to `max` UTF-16 units (never inside a surrogate pair), with `…` when cut. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** A thrown value as a sandbox error: its kind (a limit, or her code's own error) and its line. */
function errorOf(vm: QuickJSContext, handle: QuickJSHandle, timedOut: boolean): SandboxError {
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
  const where = /\((\w[\w.-]*):(\d+)(?::\d+)?\)/u.exec(stack.slice(0, 2_000));
  const kind: SandboxErrorKind =
    timedOut || (name === "InternalError" && message === "interrupted") ? "time" : name === "InternalError" && message === "out of memory" ? "memory" : name === "InternalError" && message === "stack overflow" ? "stack" : "error";
  // Only a short error leaves the sandbox (her error text reaches her file and her wake).
  return { kind, name: cut(name, MAX_ERROR_NAME_CHARS), message: cut(message, MAX_ERROR_CHARS), ...(where ? { file: cut(where[1]!, 40), line: Number(where[2]) } : {}) };
}

function hostFailure(error: unknown): SandboxError {
  const message = cut(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS);
  // The WebAssembly side ran out of room (memory grown past what it can give): a memory limit.
  return { kind: /memory|allocat/iu.test(message) ? "memory" : "error", name: "InternalError", message };
}

function runSteps(module: QuickJSWASMModule, steps: readonly SandboxStep[], limits: SandboxLimits): SandboxRunResult {
  const run = fresh(module, limits);
  try {
    let last: string | undefined;
    for (const step of steps) {
      const result = run.vm.evalCode(step.code, step.file);
      if (result.error) {
        const error = errorOf(run.vm, result.error, run.timedOut());
        result.error.dispose();
        return { ok: false, error: overTime(run) ? TIME_HIT : error };
      }
      const type = run.vm.typeof(result.value);
      last = type === "string" ? run.vm.getString(result.value) : undefined;
      result.value.dispose();
      if (overTime(run)) return { ok: false, error: TIME_HIT };
    }
    if (last === undefined) return { ok: false, error: { kind: "error", name: "Error", message: "the run gave no text back" } };
    if (last.length > MAX_RUN_VALUE_CHARS) return { ok: false, error: { kind: "error", name: "RangeError", message: "what the run gave back is too large" } };
    return { ok: true, value: last };
  } catch (error) {
    return { ok: false, error: overTime(run) ? TIME_HIT : hostFailure(error) };
  } finally {
    dispose(run);
  }
}

/**
 * Her call's answer and arguments are read out with JavaScript's built-ins captured before her code
 * runs (she may replace `JSON.stringify`, `String.prototype.slice`, prototypes' `toJSON`…): `answer`
 * gives `true`, her string cut to `MAX_RESULT_UNITS`, or null; `arg` gives an argument's JSON text,
 * or 1 (not plain JSON) or 2 (over `MAX_ARG_CHARS`). Only primitives come back to the host.
 */
const READERS = `(function () {
  var stringify = JSON.stringify;
  var sliceOf = Function.prototype.call.bind(String.prototype.slice);
  return {
    answer: function (r) { return r === true ? true : typeof r === "string" ? sliceOf(r, 0, ${MAX_RESULT_UNITS}) : null; },
    arg: function (a) {
      var s;
      try { s = stringify(a); } catch (e) { return 1; }
      if (typeof s !== "string") return 1;
      return s.length > ${MAX_ARG_CHARS} ? 2 : s;
    }
  };
})()`;

function runCall(module: QuickJSWASMModule, call: SandboxCall, limits: SandboxLimits): SandboxCallResult {
  const run = fresh(module, limits);
  const handles: QuickJSHandle[] = [];
  const keep = (handle: QuickJSHandle) => {
    handles.push(handle);
    return handle;
  };
  const failure = (handle: QuickJSHandle): SandboxCallResult => {
    const error = errorOf(run.vm, handle, run.timedOut());
    handle.dispose();
    return { ok: false, error: overTime(run) ? TIME_HIT : error };
  };
  try {
    // The readers first: nothing of hers has run yet.
    const readers = run.vm.evalCode(READERS, "after");
    if (readers.error) return failure(readers.error);
    keep(readers.value);
    const answer = keep(run.vm.getProp(readers.value, "answer"));
    const arg = keep(run.vm.getProp(readers.value, "arg"));
    const fn = run.vm.evalCode(`(${call.source}\n)`, call.file);
    if (fn.error) return failure(fn.error);
    keep(fn.value);
    if (run.vm.typeof(fn.value) !== "function") return { ok: false, error: { kind: "error", name: "TypeError", message: "it isn't a function", file: call.file, line: 1 } };
    const args: QuickJSHandle[] = [];
    for (const text of call.args) {
      const parsed = run.vm.evalCode(`JSON.parse(${JSON.stringify(text)})`, "args");
      if (parsed.error) return failure(parsed.error);
      args.push(keep(parsed.value));
    }
    const result = run.vm.callFunction(fn.value, run.vm.undefined, ...args);
    if (result.error) return failure(result.error);
    keep(result.value);
    const primitive = (handle: QuickJSHandle): string | number | true | null => {
      const type = run.vm.typeof(handle);
      if (type === "string") return run.vm.getString(handle);
      if (type === "number") return run.vm.getNumber(handle);
      if (type === "boolean") return run.vm.dump(handle) === true ? true : null;
      return null;
    };
    const answered = run.vm.callFunction(answer, run.vm.undefined, result.value);
    if (answered.error) return failure(answered.error);
    const value = primitive(keep(answered.value));
    const argsAfter: SandboxArgAfter[] = [];
    for (const handle of args) {
      const read = run.vm.callFunction(arg, run.vm.undefined, handle);
      if (read.error) return failure(read.error);
      const text = primitive(keep(read.value));
      argsAfter.push(typeof text === "string" ? text : { problem: text === 2 ? "too-large" : "not-json" });
    }
    if (overTime(run)) return { ok: false, error: TIME_HIT };
    return { ok: true, result: value === true || typeof value === "string" ? value : null, args: argsAfter };
  } catch (error) {
    return { ok: false, error: overTime(run) ? TIME_HIT : hostFailure(error) };
  } finally {
    for (const handle of handles.reverse()) {
      try {
        handle.dispose();
      } catch {
        // disposed with its context
      }
    }
    dispose(run);
  }
}

function runCompile(module: QuickJSWASMModule, source: string, limits: SandboxLimits): SandboxCompileResult {
  const run = fresh(module, limits);
  try {
    const fn = run.vm.evalCode(`(${source}\n)`, "filter");
    if (fn.error) {
      const error = errorOf(run.vm, fn.error, run.timedOut());
      fn.error.dispose();
      return { ok: false, error: overTime(run) ? TIME_HIT : error };
    }
    const type = run.vm.typeof(fn.value);
    fn.value.dispose();
    if (overTime(run)) return { ok: false, error: TIME_HIT };
    return type === "function" ? { ok: true } : { ok: false, error: { kind: "error", name: "TypeError", message: "it isn't a function", file: "filter", line: 1 } };
  } catch (error) {
    return { ok: false, error: overTime(run) ? TIME_HIT : hostFailure(error) };
  } finally {
    dispose(run);
  }
}

/**
 * One request: before each run the host is told which run starts (its watchdog is per run), and each
 * run's result is sent as soon as it is known, so a run the host had to stop costs only itself.
 */
async function handle(request: SandboxRequest, post: (message: SandboxMessage) => void): Promise<void> {
  const module = await quickjs();
  setClock(request.clock);
  const jobs: Array<() => SandboxRunResult | SandboxCallResult | SandboxCompileResult> =
    request.op === "run"
      ? [() => runSteps(module, request.steps, request.limits)]
      : request.op === "call"
        ? request.calls.map((call) => () => runCall(module, call, request.limits))
        : request.sources.map((source) => () => runCompile(module, source, request.limits));
  for (let index = 0; index < jobs.length; index += 1) {
    post({ id: request.id, progress: index });
    post({ id: request.id, done: index, result: jobs[index]!() });
  }
  post({ id: request.id, end: true });
}

parentPort?.on("message", (request: SandboxRequest) => {
  handle(request, (message) => parentPort!.postMessage(message)).catch((error: unknown) => parentPort!.postMessage({ id: request.id, fatal: cut(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS) }));
});
