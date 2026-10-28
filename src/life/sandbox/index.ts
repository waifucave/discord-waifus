// Her code's sandbox, the host side (Living cast spec §30.1): one long-lived worker thread per
// process runs QuickJS (sandboxWorker.ts); requests go to it one at a time. Each run has its own
// limits (CPU by the interrupt handler and the run's whole time, memory, stack); a limit hit or a
// crash restarts the worker before the next request. The worker says when each run starts and sends
// each run's result as it ends, so the watchdog is per run: a run not done `RUN_GRACE_MS` past its
// budget (a native call QuickJS can't interrupt) ends the worker, counts as that run's time limit
// hit, and the runs after it go to a fresh worker. Her code never blocks or harms the host. Only
// short JSON text crosses.

import { Worker } from "node:worker_threads";
import type {
  SandboxArgAfter,
  SandboxCall,
  SandboxCallResult,
  SandboxCompileResult,
  SandboxError,
  SandboxLimits,
  SandboxMessage,
  SandboxRequest,
  SandboxRunResult,
  SandboxStep
} from "./sandboxWorker.js";

export type { SandboxArgAfter, SandboxCall, SandboxCallResult, SandboxCompileResult, SandboxError, SandboxLimits, SandboxRunResult, SandboxStep };

/** One filter or check run (an event): 50 ms of CPU, 16 MiB, 64 KiB of stack (§30.1). */
export const EVENT_LIMITS: SandboxLimits = { timeMs: 50, memoryBytes: 16 * 1024 * 1024, stackBytes: 64 * 1024 };
/** The script run when she calls `Wakeup`, and a compile check: 500 ms. */
export const REGISTRATION_LIMITS: SandboxLimits = { timeMs: 500, memoryBytes: 16 * 1024 * 1024, stackBytes: 64 * 1024 };
/** The worker's own heap (its JavaScript; QuickJS's memory is WebAssembly, bounded per run). */
export const SANDBOX_HEAP_MB = 64;
/** A run the worker has not finished this long past its budget ends the worker. */
export const RUN_GRACE_MS = 250;
/** Before its first run starts: a warm worker answers at once; a cold one loads QuickJS first. */
const START_MS = 1_000;
const COLD_START_MS = 10_000;

type AnyResult = SandboxRunResult | SandboxCallResult | SandboxCompileResult;
type Pending = {
  request: SandboxRequest;
  results: Array<AnyResult | undefined>;
  current: number | undefined;
  resolve(results: Array<AnyResult | undefined>): void;
};

function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./sandboxWorker${ext}`, import.meta.url);
}

/** How a sandbox error reads in her results: `TypeError: … (line 2)`, or the limit she hit. */
export function sandboxErrorText(error: SandboxError, o: { what?: string } = {}): string {
  const what = o.what ?? "your code";
  if (error.kind === "time") return `${what} took too long`;
  if (error.kind === "memory") return `${what} used too much memory`;
  if (error.kind === "stack") return `${what} recursed too deeply`;
  return `${error.name}: ${error.message}${error.line !== undefined ? ` (line ${error.line})` : ""}`;
}

const isLimit = (result: AnyResult | undefined) => result !== undefined && !result.ok && result.error.kind !== "error";
const TIME_HIT: SandboxError = { kind: "time", name: "InternalError", message: "interrupted" };

export class Sandbox {
  private worker: Worker | undefined;
  private queue: Pending[] = [];
  private busy: { pending: Pending; timer: ReturnType<typeof setTimeout> } | undefined;
  private nextId = 1;
  /** Workers started (tests: a restart after a limit hit). */
  starts = 0;
  private closed = false;
  /** The worker has not answered yet (its first request also loads QuickJS). */
  private cold = false;

  constructor(private readonly o: { now?: () => Date; timeZone?: string } = {}) {}

  private clock(timeZone?: string) {
    return { nowMs: (this.o.now?.() ?? new Date()).getTime(), timeZone: timeZone ?? this.o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone };
  }

  /** Runs steps in one fresh context; the last step's value (a string) comes back. */
  async run(steps: SandboxStep[], o: { limits?: SandboxLimits; timeZone?: string; now?: Date } = {}): Promise<SandboxRunResult> {
    const [result] = await this.all<SandboxRunResult>(1, () => ({ id: 0, op: "run", steps, limits: o.limits ?? REGISTRATION_LIMITS, clock: this.clockAt(o) }));
    return result!;
  }

  /** Calls functions (each in its own fresh context) with JSON arguments. */
  async call(calls: SandboxCall[], o: { limits?: SandboxLimits; timeZone?: string; now?: Date } = {}): Promise<SandboxCallResult[]> {
    return this.all<SandboxCallResult>(calls.length, (indexes) => ({ id: 0, op: "call", calls: indexes.map((index) => calls[index]!), limits: o.limits ?? EVENT_LIMITS, clock: this.clockAt(o) }));
  }

  /** Whether each source evaluates to a function (a syntax error comes back with its line). */
  async compile(sources: string[], o: { timeZone?: string; now?: Date } = {}): Promise<SandboxCompileResult[]> {
    return this.all<SandboxCompileResult>(sources.length, (indexes) => ({ id: 0, op: "compile", sources: indexes.map((index) => sources[index]!), limits: REGISTRATION_LIMITS, clock: this.clockAt(o) }));
  }

  /**
   * Every run's result: the runs a stopped worker never started are sent again (to a fresh worker),
   * so a run that had to be stopped costs only itself.
   */
  private async all<R extends AnyResult>(count: number, build: (indexes: number[]) => SandboxRequest): Promise<R[]> {
    const results: Array<R | undefined> = new Array(count).fill(undefined);
    let left = [...Array(count).keys()];
    while (left.length > 0) {
      const answers = await this.send(build(left));
      // A stop before any run started (a worker that never came up) fails them all.
      const started = answers.some((answer) => answer !== undefined);
      left.forEach((index, at) => {
        results[index] = (answers[at] ?? (started ? undefined : { ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox didn't start" } })) as R | undefined;
      });
      left = left.filter((index) => results[index] === undefined);
    }
    return results as R[];
  }

  private clockAt(o: { timeZone?: string; now?: Date }) {
    const clock = this.clock(o.timeZone);
    return o.now ? { ...clock, nowMs: o.now.getTime() } : clock;
  }

  /** Stops the worker; later requests start a new one unless closed for good. */
  async close(o: { forGood?: boolean } = {}): Promise<void> {
    if (o.forGood) this.closed = true;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private send(request: SandboxRequest): Promise<Array<AnyResult | undefined>> {
    const runs = request.op === "call" ? request.calls.length : request.op === "compile" ? request.sources.length : 1;
    return new Promise((resolve) => {
      this.queue.push({ request: { ...request, id: this.nextId++ }, results: new Array(runs).fill(undefined), current: undefined, resolve });
      this.pump();
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerUrl(), {
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: SANDBOX_HEAP_MB, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    worker.unref();
    this.starts += 1;
    this.cold = true;
    worker.on("message", (message: SandboxMessage) => {
      if (this.worker !== worker || !this.busy || this.busy.pending.request.id !== message.id) return;
      const busy = this.busy;
      const { pending } = busy;
      if ("progress" in message) {
        this.cold = false;
        pending.current = message.progress;
        this.arm(worker, pending, pending.request.limits.timeMs + RUN_GRACE_MS);
        return;
      }
      if ("done" in message) {
        pending.results[message.done] = message.result;
        return;
      }
      clearTimeout(busy.timer);
      this.busy = undefined;
      if ("fatal" in message) {
        this.restart(worker);
        pending.resolve(pending.results.map((result) => result ?? { ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox stopped unexpectedly" } }));
      } else {
        // A limit hit leaves QuickJS's memory in an unknown state: a fresh worker for the next run.
        if (pending.results.some(isLimit)) this.restart(worker);
        pending.resolve(pending.results);
      }
      this.pump();
    });
    const lost = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      const busy = this.busy;
      this.busy = undefined;
      if (busy) {
        clearTimeout(busy.timer);
        // The run it was on is the one that brought it down.
        const { pending } = busy;
        if (pending.current !== undefined && pending.results[pending.current] === undefined) pending.results[pending.current] = { ok: false, error: { kind: "memory", name: "InternalError", message: "the sandbox stopped" } };
        pending.resolve(pending.results);
      }
      this.pump();
    };
    worker.on("error", lost);
    worker.on("exit", lost);
    this.worker = worker;
    return worker;
  }

  /** (Re)starts the watchdog of the request in progress. */
  private arm(worker: Worker, pending: Pending, ms: number): void {
    if (this.busy?.pending !== pending) return;
    clearTimeout(this.busy.timer);
    const run = pending.current;
    const stop = () => {
      if (this.busy?.pending !== pending || pending.current !== run) return;
      this.busy = undefined;
      this.restart(worker);
      if (run !== undefined && pending.results[run] === undefined) pending.results[run] = { ok: false, error: TIME_HIT };
      pending.resolve(pending.results);
      this.pump();
    };
    // Messages already waiting (the run's result, the next run's start) are read first: a host that
    // was itself busy never blames her run for its own delay.
    const timer = setTimeout(() => setImmediate(stop), ms);
    timer.unref?.();
    this.busy.timer = timer;
  }

  private restart(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate().catch(() => undefined);
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) return;
    const pending = this.queue.shift()!;
    if (this.closed) {
      pending.resolve(pending.results.map(() => ({ ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox is closed" } })));
      this.pump();
      return;
    }
    const worker = this.ensureWorker();
    this.busy = { pending, timer: setTimeout(() => undefined, 0) };
    // Until its first run starts (the worker's first request also loads QuickJS).
    this.arm(worker, pending, (this.cold ? COLD_START_MS : START_MS) + RUN_GRACE_MS);
    worker.postMessage(pending.request);
  }
}

/** The process's sandbox (one worker for every waifu; started on first use). */
let shared: Sandbox | undefined;
export function sharedSandbox(): Sandbox {
  shared ??= new Sandbox();
  return shared;
}
