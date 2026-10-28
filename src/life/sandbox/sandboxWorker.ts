// Her code's sandbox (Living cast spec §30.1), the worker side: QuickJS compiled to WebAssembly
// (`quickjs-emscripten`, exact pin) in its own worker thread. Every run gets a fresh QuickJS runtime
// and context with a CPU deadline (the interrupt handler), a memory limit and a stack limit, and sees
// only standard JavaScript built-ins: no `require`, no modules, no network, no file system, no
// timers, no host objects. Values cross as JSON text only.
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
  /** CPU budget of one run (the interrupt handler's deadline), ms. */
  timeMs: number;
  memoryBytes: number;
  stackBytes: number;
};

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

/** A run's value: the last step's value, which must be a string (JSON text). */
export type SandboxRunResult = { ok: true; value: string } | { ok: false; error: SandboxError };
/** A call: what it returned (`true`, a string, or null for anything else) and the arguments after it, as JSON. */
export type SandboxCallResult = { ok: true; result: true | string | null; args: string[] } | { ok: false; error: SandboxError };
export type SandboxCompileResult = { ok: true } | { ok: false; error: SandboxError };

export type SandboxResponse =
  | { id: number; op: "run"; result: SandboxRunResult; limitHit: boolean }
  | { id: number; op: "call"; results: SandboxCallResult[]; limitHit: boolean }
  | { id: number; op: "compile"; results: SandboxCompileResult[]; limitHit: boolean };

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
Date.now = () => clockBase.appMs + Math.round(performance.now() - clockBase.realMs);

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

type Fresh = { runtime: QuickJSRuntime; vm: QuickJSContext; timedOut: () => boolean };

function fresh(module: QuickJSWASMModule, limits: SandboxLimits): Fresh {
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const deadline = performance.now() + limits.timeMs;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() > deadline) interrupted = true;
    return interrupted;
  });
  const vm = runtime.newContext();
  return { runtime, vm, timedOut: () => interrupted };
}

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
  const where = /\((\w[\w.-]*):(\d+)(?::\d+)?\)/u.exec(stack);
  const kind: SandboxErrorKind =
    timedOut || (name === "InternalError" && message === "interrupted") ? "time" : name === "InternalError" && message === "out of memory" ? "memory" : name === "InternalError" && message === "stack overflow" ? "stack" : "error";
  return { kind, name, message, ...(where ? { file: where[1]!, line: Number(where[2]) } : {}) };
}

function hostFailure(error: unknown): SandboxError {
  const message = error instanceof Error ? error.message : String(error);
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
        return { ok: false, error };
      }
      const type = run.vm.typeof(result.value);
      last = type === "string" ? run.vm.getString(result.value) : undefined;
      result.value.dispose();
    }
    return last === undefined ? { ok: false, error: { kind: "error", name: "Error", message: "the run gave no text back" } } : { ok: true, value: last };
  } catch (error) {
    return { ok: false, error: hostFailure(error) };
  } finally {
    dispose(run);
  }
}

/** Serialises a call's result and arguments inside the sandbox (only JSON leaves it). */
const AFTER_CALL = "(function (r, args) { return JSON.stringify([r === true || typeof r === 'string' ? r : null, args.map(function (a) { return JSON.stringify(a) })]) })";

function runCall(module: QuickJSWASMModule, call: SandboxCall, limits: SandboxLimits): SandboxCallResult {
  const run = fresh(module, limits);
  const handles: QuickJSHandle[] = [];
  const keep = (handle: QuickJSHandle) => {
    handles.push(handle);
    return handle;
  };
  try {
    const fn = run.vm.evalCode(`(${call.source}\n)`, call.file);
    if (fn.error) {
      const error = errorOf(run.vm, fn.error, run.timedOut());
      fn.error.dispose();
      return { ok: false, error };
    }
    keep(fn.value);
    if (run.vm.typeof(fn.value) !== "function") return { ok: false, error: { kind: "error", name: "TypeError", message: "it isn't a function", file: call.file, line: 1 } };
    const args: QuickJSHandle[] = [];
    for (const text of call.args) {
      const parsed = run.vm.evalCode(`JSON.parse(${JSON.stringify(text)})`, "args");
      if (parsed.error) {
        const error = errorOf(run.vm, parsed.error, run.timedOut());
        parsed.error.dispose();
        return { ok: false, error };
      }
      args.push(keep(parsed.value));
    }
    const result = run.vm.callFunction(fn.value, run.vm.undefined, ...args);
    if (result.error) {
      const error = errorOf(run.vm, result.error, run.timedOut());
      result.error.dispose();
      return { ok: false, error };
    }
    keep(result.value);
    const after = run.vm.evalCode(AFTER_CALL, "after");
    if (after.error) {
      const error = errorOf(run.vm, after.error, run.timedOut());
      after.error.dispose();
      return { ok: false, error };
    }
    keep(after.value);
    const list = keep(run.vm.newArray());
    args.forEach((arg, index) => run.vm.setProp(list, index, arg));
    const out = run.vm.callFunction(after.value, run.vm.undefined, result.value, list);
    if (out.error) {
      const error = errorOf(run.vm, out.error, run.timedOut());
      out.error.dispose();
      return { ok: false, error: { ...error, message: `${error.message} (its state must be plain JSON)` } };
    }
    const text = run.vm.getString(out.value);
    out.value.dispose();
    const [value, argsAfter] = JSON.parse(text) as [true | string | null, string[]];
    return { ok: true, result: value, args: argsAfter };
  } catch (error) {
    return { ok: false, error: hostFailure(error) };
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
      return { ok: false, error };
    }
    const type = run.vm.typeof(fn.value);
    fn.value.dispose();
    return type === "function" ? { ok: true } : { ok: false, error: { kind: "error", name: "TypeError", message: "it isn't a function", file: "filter", line: 1 } };
  } catch (error) {
    return { ok: false, error: hostFailure(error) };
  } finally {
    dispose(run);
  }
}

const isLimit = (error: SandboxError | undefined) => error !== undefined && error.kind !== "error";

async function handle(request: SandboxRequest): Promise<SandboxResponse> {
  const module = await quickjs();
  setClock(request.clock);
  if (request.op === "run") {
    const result = runSteps(module, request.steps, request.limits);
    return { id: request.id, op: "run", result, limitHit: !result.ok && isLimit(result.error) };
  }
  if (request.op === "call") {
    const results = request.calls.map((call) => runCall(module, call, request.limits));
    return { id: request.id, op: "call", results, limitHit: results.some((result) => !result.ok && isLimit(result.error)) };
  }
  const results = request.sources.map((source) => runCompile(module, source, request.limits));
  return { id: request.id, op: "compile", results, limitHit: results.some((result) => !result.ok && isLimit(result.error)) };
}

parentPort?.on("message", (request: SandboxRequest) => {
  handle(request).then(
    (response) => parentPort!.postMessage(response),
    (error: unknown) => parentPort!.postMessage({ id: request.id, fatal: error instanceof Error ? error.message : String(error) })
  );
});
