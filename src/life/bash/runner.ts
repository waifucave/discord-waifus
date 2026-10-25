// The host side of her simulated Bash (Living cast spec §16.3.5, T10): one worker thread per call,
// with V8 heap limits and a hard wall-clock limit. The host's event loop never runs her commands;
// it only answers the worker's reads (one file of her folders at a time, by checked path, never a
// link) and receives the change set when the command ends. On the time limit or an abort the
// worker is terminated (just-bash's own python and sqlite workers go with it) and nothing is saved.

import { Worker } from "node:worker_threads";
import type { ChangeBase, ChangeSet } from "../home/homeStore.js";
import type { HomeStore } from "../home/homeStore.js";
import { parseVirtual } from "../home/pathRules.js";
import type { BashHostMessage, BashWorkerInput, BashWorkerMessage } from "./bashWorker.js";

/** Commands she may run (just-bash 3.6.0's built-ins without the network ones, `tar` and `js-exec`). */
export const BASH_COMMANDS = [
  "echo", "cat", "printf", "ls", "mkdir", "mktemp", "rmdir", "touch", "rm", "cp", "mv", "ln", "chmod", "pwd", "readlink",
  "head", "tail", "wc", "stat", "grep", "fgrep", "egrep", "rg", "sed", "awk", "sort", "uniq", "comm", "cut", "paste",
  "tr", "rev", "nl", "fold", "expand", "unexpand", "strings", "split", "column", "join", "tee", "find", "basename",
  "dirname", "tree", "du", "env", "printenv", "alias", "unalias", "history", "xargs", "true", "false", "yes", "clear",
  "bash", "sh", "jq", "base64", "diff", "date", "sleep", "timeout", "time", "seq", "expr", "md5sum", "sha1sum",
  "sha256sum", "file", "help", "which", "tac", "hostname", "whoami", "od", "gzip", "gunzip", "zcat", "yq", "xan", "sqlite3"
] as const;

/** The worker's V8 heap (old generation), MiB (§16.3.5). */
export const BASH_HEAP_MB = 256;
/** just-bash's own output cap (stdout + stderr), bytes; she sees `life.bash.maxOutputChars` of it. */
export const BASH_MAX_OUTPUT_BYTES = 1024 * 1024;

export type BashRun = {
  outcome: "done" | "timeout" | "aborted" | "failed";
  stdout: string;
  stderr: string;
  exitCode: number;
  /** done: what the command left different. */
  changes?: ChangeSet;
  /** Her files as they were when the command started (the conflict check). */
  base: ChangeBase;
  /** Files whose bytes the command read (DM-origin check, §14.4). */
  read: string[];
  /** failed: why (memory, a worker error). */
  error?: string;
};

export type BashRunOptions = {
  store: HomeStore;
  command: string;
  timeoutMs: number;
  python: boolean;
  timeZone: string;
  signal?: AbortSignal;
  /** In-memory filesystem cap (her two folders' limits plus room to work). */
  maxFileSystemBytes: number;
};

/** The worker's entry next to this file (`.ts` when the app runs from source). */
function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./bashWorker${ext}`, import.meta.url);
}

export async function runBash(o: BashRunOptions): Promise<BashRun> {
  const store = o.store;
  const entries = [...(await store.files.walk("home")), ...(await store.files.walk("tmp"))];
  const base = new Map(entries.map((entry) => [entry.path.virtual, { kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs }] as const));
  const env: Record<string, string> = { HOME: `/home/${store.slug}`, USER: store.slug, PWD: `/home/${store.slug}`, TZ: o.timeZone };
  const input: BashWorkerInput = {
    slug: store.slug,
    manifest: entries.map((entry) => ({ path: entry.path.virtual, kind: entry.kind, size: entry.size, mtimeMs: entry.mtimeMs })),
    command: o.command,
    timeoutMs: o.timeoutMs,
    python: o.python,
    env,
    commands: [...BASH_COMMANDS],
    maxOutputBytes: BASH_MAX_OUTPUT_BYTES,
    maxFileSystemBytes: o.maxFileSystemBytes
  };
  const read = new Set<string>();
  if (o.signal?.aborted) return { outcome: "aborted", stdout: "", stderr: "", exitCode: 130, base, read: [] };
  const worker = new Worker(workerUrl(), {
    workerData: input,
    // Nothing of the host's environment: the worker's process.env starts empty.
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: BASH_HEAP_MB, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    // Her commands' stray console output never reaches the host's terminal.
    stdout: true,
    stderr: true
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise<BashRun>((resolve) => {
    let settled = false;
    const finish = (run: Omit<BashRun, "base" | "read">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      resolve({ ...run, base, read: [...read] });
    };
    // The wall clock is the one time limit (§16.3.5): just-bash's own deadlines are set past it, so
    // a command that runs too long always ends here, with the worker terminated and nothing saved.
    const timer = setTimeout(() => finish({ outcome: "timeout", stdout: "", stderr: "", exitCode: 124 }), o.timeoutMs);
    timer.unref?.();
    const onAbort = () => finish({ outcome: "aborted", stdout: "", stderr: "", exitCode: 130 });
    o.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: BashWorkerMessage) => {
      if (settled) return;
      if (message.type === "read") {
        void serveRead(store, base, message.path).then(
          (data) => {
            read.add(message.path);
            const copy = new Uint8Array(data);
            worker.postMessage({ type: "read-result", id: message.id, data: copy } satisfies BashHostMessage, [copy.buffer]);
          },
          (error: unknown) => worker.postMessage({ type: "read-result", id: message.id, error: error instanceof Error ? error.message : "EIO" } satisfies BashHostMessage)
        );
        return;
      }
      if (message.type === "fatal") {
        finish({ outcome: "failed", stdout: "", stderr: "", exitCode: 1, error: message.message });
        return;
      }
      finish({
        outcome: "done",
        stdout: message.stdout,
        stderr: message.stderr,
        exitCode: message.exitCode,
        changes: { writes: message.changes.writes.map((write) => ({ path: write.path, data: new Uint8Array(write.data) })), deletes: message.changes.deletes, dirs: message.changes.dirs }
      });
    });
    worker.on("error", (error) => {
      const memory = (error as { code?: string }).code === "ERR_WORKER_OUT_OF_MEMORY";
      finish({ outcome: "failed", stdout: "", stderr: "", exitCode: 1, error: memory ? "the command ran out of memory" : "the command stopped unexpectedly" });
    });
    worker.on("exit", () => finish({ outcome: "failed", stdout: "", stderr: "", exitCode: 1, error: "the command stopped unexpectedly" }));
  });
}

/** One file's bytes for the worker: only files that were in her folders when the command started. */
async function serveRead(store: HomeStore, base: ChangeBase, virtual: string): Promise<Uint8Array> {
  if (base.get(virtual)?.kind !== "file") throw new Error(`ENOENT: no such file or directory, open '${virtual}'`);
  const p = parseVirtual(virtual, store.slug);
  if (!p) throw new Error(`ENOENT: no such file or directory, open '${virtual}'`);
  return store.files.readBytes(p);
}
