import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";

class LayaWorker {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: { resolve: (v: any) => void; reject: (e: Error) => void };
  private queue = Promise.resolve();
  private queued = 0;
  constructor(private readonly checkpoint: string) {}
  close() {
    const child = this.child;
    this.child = undefined;
    this.reader?.reject(new Error("one_shot_local_stopped"));
    this.reader = undefined;
    child?.kill();
  }
  private read(signal: AbortSignal, ms: number, start: () => void): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { finish(new Error("one_shot_local_timeout")); this.close(); }, ms);
      const abort = () => { finish(new Error("one_shot_aborted")); this.close(); };
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timeout); signal.removeEventListener("abort", abort); this.reader = undefined;
        if (error) reject(error); else resolve(value);
      };
      this.reader = { resolve: (v) => finish(undefined, v), reject: (e) => finish(e) };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try { start(); } catch { finish(new Error("one_shot_local_failed")); this.close(); }
    });
  }
  private async start(signal: AbortSignal) {
    const python = process.env.DC_WAIFUS_LAYA_PYTHON;
    if (!python) throw new Error("one_shot_local_not_configured");
    const ready = await this.read(signal, 60_000, () => {
      // The executable is host-local administrator configuration, never API input.
      const child = spawn(python, [fileURLToPath(new URL("../../../assets/laya/worker.py", import.meta.url)), "--checkpoint", this.checkpoint],
        { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: process.env.TMPDIR,
          USE_TF: "0", HF_HUB_DISABLE_PROGRESS_BARS: "1", PYTHONDONTWRITEBYTECODE: "1" } });
      this.child = child;
      let buffer = "";
      child.stdout.on("data", (data: Buffer) => {
        if (this.child !== child) return;
        buffer += data.toString("utf8");
        if (buffer.length > 1_000_000) { this.close(); return; }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { this.reader?.resolve(JSON.parse(line)); } catch { this.close(); }
        }
      });
      child.stderr.resume(); // Never forward unrestricted Python output into logs.
      child.stdin.on("error", () => { if (this.child === child) this.close(); });
      child.on("error", () => { if (this.child === child) this.close(); });
      child.on("exit", () => { if (this.child === child) this.close(); });
    });
    if (ready?.ready !== true) { this.close(); throw new Error("one_shot_local_failed"); }
  }
  call(body: object, signal: AbortSignal): Promise<unknown> {
    if (this.queued >= 32) return Promise.reject(new Error("one_shot_local_busy"));
    this.queued++;
    const run = this.queue.then(async () => {
      signal.throwIfAborted();
      if (!this.child) await this.start(signal);
      const response = await this.read(signal, 30_000, () => { this.child!.stdin.write(JSON.stringify(body) + "\n"); });
      if (response?.truncated === true) throw new Error("one_shot_local_context_limit");
      if (!response?.payload || response.error) throw new Error("one_shot_local_failed");
      return response.payload;
    }).finally(() => { this.queued--; });
    this.queue = run.then(() => undefined, () => undefined);
    // A queued caller must abort promptly, not wait behind a model load.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("one_shot_aborted"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      run.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}
export class LocalLayaPool {
  private readonly workers = new Map<string, LayaWorker>();
  call(checkpoint: string, body: object, signal: AbortSignal): Promise<unknown> {
    if (!["english", "multilingual", "typed-decisions"].includes(checkpoint)) return Promise.reject(new Error("one_shot_local_model_invalid"));
    let worker = this.workers.get(checkpoint);
    if (!worker) { worker = new LayaWorker(checkpoint); this.workers.set(checkpoint, worker); }
    return worker.call(body, signal);
  }
  close() { for (const worker of this.workers.values()) worker.close(); this.workers.clear(); }
}
