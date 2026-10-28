// Her code's sandbox, the host side (Living cast spec §30.1): one long-lived worker thread per
// process runs QuickJS (sandboxWorker.ts); requests go to it one at a time. Each run has its own
// limits (CPU by the interrupt handler, memory, stack); a limit hit or a crash restarts the worker
// before the next request, and a worker that does not answer in time (its own deadline missed) is
// terminated: her code never blocks or harms the host. Only JSON text crosses.

import { Worker } from "node:worker_threads";
import type {
  SandboxCall,
  SandboxCallResult,
  SandboxCompileResult,
  SandboxError,
  SandboxLimits,
  SandboxRequest,
  SandboxResponse,
  SandboxRunResult,
  SandboxStep
} from "./sandboxWorker.js";

export type { SandboxCall, SandboxCallResult, SandboxCompileResult, SandboxError, SandboxLimits, SandboxRunResult, SandboxStep };

/** One filter or check run (an event): 50 ms of CPU, 16 MiB, 64 KiB of stack (§30.1). */
export const EVENT_LIMITS: SandboxLimits = { timeMs: 50, memoryBytes: 16 * 1024 * 1024, stackBytes: 64 * 1024 };
/** The script run when she calls `Wakeup`, and a compile check: 500 ms. */
export const REGISTRATION_LIMITS: SandboxLimits = { timeMs: 500, memoryBytes: 16 * 1024 * 1024, stackBytes: 64 * 1024 };
/** The worker's own heap (its JavaScript; QuickJS's memory is WebAssembly, bounded per run). */
export const SANDBOX_HEAP_MB = 64;
/** A request the worker has not answered this long past its runs' budgets ends the worker. */
export const SANDBOX_GRACE_MS = 2_000;

type Pending = { request: SandboxRequest; resolve(response: SandboxResponse): void };

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
    const response = await this.send({ id: 0, op: "run", steps, limits: o.limits ?? REGISTRATION_LIMITS, clock: this.clockAt(o) });
    return response.op === "run" ? response.result : { ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox gave a wrong answer" } };
  }

  /** Calls functions (each in its own fresh context) with JSON arguments. */
  async call(calls: SandboxCall[], o: { limits?: SandboxLimits; timeZone?: string; now?: Date } = {}): Promise<SandboxCallResult[]> {
    if (calls.length === 0) return [];
    const response = await this.send({ id: 0, op: "call", calls, limits: o.limits ?? EVENT_LIMITS, clock: this.clockAt(o) });
    return response.op === "call" ? response.results : calls.map(() => ({ ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox gave a wrong answer" } }));
  }

  /** Whether each source evaluates to a function (a syntax error comes back with its line). */
  async compile(sources: string[], o: { timeZone?: string; now?: Date } = {}): Promise<SandboxCompileResult[]> {
    if (sources.length === 0) return [];
    const response = await this.send({ id: 0, op: "compile", sources, limits: REGISTRATION_LIMITS, clock: this.clockAt(o) });
    return response.op === "compile" ? response.results : sources.map(() => ({ ok: false, error: { kind: "error", name: "InternalError", message: "the sandbox gave a wrong answer" } }));
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

  private send(request: SandboxRequest): Promise<SandboxResponse> {
    return new Promise((resolve) => {
      this.queue.push({ request: { ...request, id: this.nextId++ }, resolve });
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
    worker.on("message", (message: SandboxResponse | { id: number; fatal: string }) => {
      if (this.worker !== worker || !this.busy || this.busy.pending.request.id !== message.id) return;
      const { pending, timer } = this.busy;
      clearTimeout(timer);
      this.busy = undefined;
      this.cold = false;
      if ("fatal" in message) {
        this.restart(worker);
        pending.resolve(failed(pending.request, { kind: "error", name: "InternalError", message: "the sandbox stopped unexpectedly" }));
      } else {
        // A limit hit leaves QuickJS's memory in an unknown state: a fresh worker for the next run.
        if (message.limitHit) this.restart(worker);
        pending.resolve(message);
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
        busy.pending.resolve(failed(busy.pending.request, { kind: "memory", name: "InternalError", message: "the sandbox stopped" }));
      }
      this.pump();
    };
    worker.on("error", lost);
    worker.on("exit", lost);
    this.worker = worker;
    return worker;
  }

  private restart(worker: Worker): void {
    if (this.worker === worker) this.worker = undefined;
    void worker.terminate().catch(() => undefined);
  }

  private pump(): void {
    if (this.busy || this.queue.length === 0) return;
    const pending = this.queue.shift()!;
    if (this.closed) {
      pending.resolve(failed(pending.request, { kind: "error", name: "InternalError", message: "the sandbox is closed" }));
      this.pump();
      return;
    }
    const worker = this.ensureWorker();
    const runs = pending.request.op === "call" ? pending.request.calls.length : pending.request.op === "compile" ? pending.request.sources.length : 1;
    // The worker's first request also loads QuickJS (a few ms; more under load).
    const budget = pending.request.limits.timeMs * runs + SANDBOX_GRACE_MS + (this.cold ? 10_000 : 0);
    const timer = setTimeout(() => {
      if (this.busy?.pending !== pending) return;
      this.busy = undefined;
      this.restart(worker);
      pending.resolve(failed(pending.request, { kind: "time", name: "InternalError", message: "interrupted" }));
      this.pump();
    }, budget);
    timer.unref?.();
    this.busy = { pending, timer };
    worker.postMessage(pending.request);
  }
}

function failed(request: SandboxRequest, error: SandboxError): SandboxResponse {
  if (request.op === "run") return { id: request.id, op: "run", result: { ok: false, error }, limitHit: true };
  if (request.op === "call") return { id: request.id, op: "call", results: request.calls.map(() => ({ ok: false, error })), limitHit: true };
  return { id: request.id, op: "compile", results: request.sources.map(() => ({ ok: false, error })), limitHit: true };
}

/** The process's sandbox (one worker for every waifu; started on first use). */
let shared: Sandbox | undefined;
export function sharedSandbox(): Sandbox {
  shared ??= new Sandbox();
  return shared;
}
