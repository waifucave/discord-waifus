// Her `Web` script, the host side (Living cast spec §31.1): each call gets its own worker thread
// (webScriptWorker.ts), so a script waiting a minute on the network never holds up another waifu's
// code or the shared §30 sandbox. The worker asks for web calls over its port; this side runs them
// (`call`, the per-call and daily caps live there) and answers. It keeps the time:
//
// - her own computing: the worker says when her code runs (`busy`) and when it waits for the web
//   (`idle`); `cpuMs` of busy time in all, plus `RUN_GRACE_MS`, and the worker is stopped (a native
//   call QuickJS can't interrupt, a slow RegExp in `find`, counts here);
// - the whole run: `wallMs` (60 s), whatever it waits for (each web call has its own time limit too);
// - a stop, a pause or a turn's abort ends it at once.
//
// When the run ends, for any reason, its web calls still going are aborted and the worker is
// terminated. What comes back from the worker is checked and cut again here: nothing it sends is
// trusted as it is.

import { Worker } from "node:worker_threads";
import type { WebHostReply, WebScriptDone, WebScriptError, WebScriptLimits, WebWorkerMessage } from "./webScriptWorker.js";

export type { WebScriptLimits };

export const WEB_SCRIPT_LIMITS: WebScriptLimits = {
  cpuMs: 1_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxOutputChars: 8_000,
  // Past the per-call caps (4 + 6 + 2) the host refuses; this bounds a loop that never stops asking.
  maxHostCalls: 24
};
/** The longest one script runs, waiting included. */
export const WEB_SCRIPT_WALL_MS = 60_000;
/** Her busy time past `cpuMs` by this much ends the worker. */
export const RUN_GRACE_MS = 250;
/** Until her code first runs (the worker loads QuickJS first). */
const START_MS = 10_000;
const MAX_ERROR_CHARS = 300;
export const OUTPUT_CUT = "… (cut)";

export type WebCallName = "search" | "open" | "ask";
export type WebCallAnswer = { ok: true; value: unknown } | { ok: false; error: string };
/** One web call of her script: never throws (a throw is a failed call). */
export type WebCall = (fn: WebCallName, args: unknown[], signal: AbortSignal) => Promise<WebCallAnswer>;

export type WebScriptStop = "time" | "wall" | "memory" | "stack" | "aborted" | "crash" | "start";
export type WebScriptOutcome = {
  /** Her prints, then what she returned, cut at `maxOutputChars` (`… (cut)`). */
  output: string;
  /** Nothing was printed or returned. */
  empty: boolean;
  /** Her error (`TypeError: … (line 3)`) or why the run was stopped. */
  error?: string;
  stop?: WebScriptStop;
};

function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./webScriptWorker${ext}`, import.meta.url);
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The worker's end message, checked strictly: anything else is a crash. */
function doneOf(value: unknown, maxChars: number): WebScriptDone | undefined {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return undefined;
  if (value["ok"]) {
    const result = value["value"];
    if (result !== null && typeof result !== "string") return undefined;
    return { ok: true, value: result === null ? null : result.slice(0, maxChars + 1), cut: value["cut"] === true || (typeof result === "string" && result.length > maxChars) };
  }
  const error = value["error"];
  if (!isRecord(error)) return undefined;
  const kind = error["kind"];
  if (kind !== "time" && kind !== "memory" && kind !== "stack" && kind !== "error") return undefined;
  const line = error["line"];
  return {
    ok: false,
    error: {
      kind,
      name: typeof error["name"] === "string" ? cut(error["name"], 60) : "Error",
      message: typeof error["message"] === "string" ? cut(error["message"], MAX_ERROR_CHARS) : "",
      ...(typeof line === "number" && Number.isInteger(line) && line > 0 && line < 1_000_000 ? { line } : {})
    }
  };
}

const STOP_TEXT: Record<WebScriptStop, string> = {
  time: "your script computed for too long (it has 1 s of its own; waiting for the web doesn't count)",
  wall: "your script ran for 60 seconds and was stopped",
  memory: "your script used too much memory",
  stack: "your script recursed too deeply",
  aborted: "the script was interrupted",
  crash: "the script stopped unexpectedly",
  start: "the script couldn't start"
};

function errorText(error: WebScriptError): { text: string; stop?: WebScriptStop } {
  if (error.kind === "time") return { text: STOP_TEXT.time, stop: "time" };
  if (error.kind === "memory") return { text: STOP_TEXT.memory, stop: "memory" };
  if (error.kind === "stack") return { text: STOP_TEXT.stack, stop: "stack" };
  return { text: `${error.name}: ${error.message}${error.line !== undefined ? ` (line ${error.line})` : ""}` };
}

export function runWebScript(
  script: string,
  call: WebCall,
  o: { timeZone: string; now: Date; signal?: AbortSignal; limits?: Partial<WebScriptLimits>; wallMs?: number }
): Promise<WebScriptOutcome> {
  const limits: WebScriptLimits = { ...WEB_SCRIPT_LIMITS, ...o.limits };
  const wallMs = o.wallMs ?? WEB_SCRIPT_WALL_MS;
  return new Promise((resolve) => {
    const prints: string[] = [];
    let printedChars = 0;
    let printsCut = false;
    let ended = false;
    let busySince: number | undefined;
    let used = 0;
    let cpuTimer: ReturnType<typeof setTimeout> | undefined;
    const calls = new AbortController();
    const worker = new Worker(workerUrl(), {
      workerData: { script, limits, clock: { nowMs: o.now.getTime(), timeZone: o.timeZone } },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();

    const end = (how: { done: WebScriptDone } | { stop: WebScriptStop }) => {
      if (ended) return;
      ended = true;
      clearTimeout(wallTimer);
      clearTimeout(startTimer);
      if (cpuTimer) clearTimeout(cpuTimer);
      o.signal?.removeEventListener("abort", onAbort);
      calls.abort();
      void worker.terminate().catch(() => undefined);
      const parts = [...prints];
      let error: string | undefined;
      let stop: WebScriptStop | undefined;
      let resultCut = false;
      if ("done" in how) {
        if (how.done.ok) {
          if (how.done.value !== null && how.done.value !== "") parts.push(how.done.value);
          resultCut = how.done.cut;
        } else {
          const text = errorText(how.done.error);
          error = text.text;
          stop = text.stop;
        }
      } else {
        stop = how.stop;
        error = STOP_TEXT[how.stop];
      }
      let output = parts.join("\n");
      if (output.length > limits.maxOutputChars || printsCut || resultCut) output = `${output.slice(0, limits.maxOutputChars)}${OUTPUT_CUT}`;
      resolve({ output, empty: parts.length === 0, ...(error !== undefined ? { error } : {}), ...(stop ? { stop } : {}) });
    };

    const armCpu = () => {
      if (cpuTimer) clearTimeout(cpuTimer);
      const left = Math.max(0, limits.cpuMs - used) + RUN_GRACE_MS;
      // Messages already waiting (an `idle`, her end) are read first: a busy host never blames her.
      cpuTimer = setTimeout(() => setImmediate(() => (busySince !== undefined ? end({ stop: "time" }) : undefined)), left);
      cpuTimer.unref?.();
    };
    const wallTimer = setTimeout(() => end({ stop: "wall" }), wallMs);
    wallTimer.unref?.();
    let first = true;
    const startTimer = setTimeout(() => end({ stop: "start" }), START_MS);
    startTimer.unref?.();
    const onAbort = () => end({ stop: "aborted" });
    if (o.signal?.aborted) {
      queueMicrotask(onAbort);
    } else o.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: WebWorkerMessage) => {
      if (ended || !isRecord(message)) return;
      if (message.t === "busy") {
        if (first) {
          first = false;
          clearTimeout(startTimer);
        }
        if (busySince === undefined) busySince = performance.now();
        armCpu();
        return;
      }
      if (message.t === "idle") {
        if (busySince !== undefined) used += performance.now() - busySince;
        busySince = undefined;
        if (cpuTimer) clearTimeout(cpuTimer);
        if (used > limits.cpuMs + RUN_GRACE_MS) end({ stop: "time" });
        return;
      }
      if (message.t === "print") {
        if (typeof message.text !== "string" || printsCut) return;
        const text = message.text.slice(0, limits.maxOutputChars + 1);
        printedChars += text.length + 1;
        prints.push(text);
        if (printedChars > limits.maxOutputChars + 1) printsCut = true;
        return;
      }
      if (message.t === "call") {
        const id = message.call;
        const fn = message.fn;
        if (typeof id !== "number" || !Number.isInteger(id) || (fn !== "search" && fn !== "open" && fn !== "ask") || typeof message.args !== "string" || message.args.length > 16_384) {
          end({ stop: "crash" });
          return;
        }
        let args: unknown;
        try {
          args = JSON.parse(message.args);
        } catch {
          args = undefined;
        }
        const answer: Promise<WebCallAnswer> = Array.isArray(args)
          ? call(fn, args, calls.signal).catch(() => ({ ok: false as const, error: `${fn}: that didn't work` }))
          : Promise.resolve({ ok: false as const, error: `${fn}: those arguments can't be read` });
        void answer.then((result) => {
          if (ended) return;
          let reply: WebHostReply;
          if (result.ok) {
            let value: string | undefined;
            try {
              value = JSON.stringify(result.value ?? null);
            } catch {
              value = undefined;
            }
            reply = value === undefined ? { t: "reply", call: id, ok: false, error: `${fn}: that didn't work` } : { t: "reply", call: id, ok: true, value };
          } else reply = { t: "reply", call: id, ok: false, error: cut(String(result.error), MAX_ERROR_CHARS) };
          worker.postMessage(reply);
        });
        return;
      }
      if (message.t === "done") {
        const done = doneOf(message.result, limits.maxOutputChars);
        end(done ? { done } : { stop: "crash" });
      }
    });
    // Out of heap, or ended for any other reason before it said it was done.
    worker.on("error", (error: unknown) => end({ stop: /memory|heap/iu.test(error instanceof Error ? error.message : String(error)) ? "memory" : "crash" }));
    worker.on("exit", () => end({ stop: "crash" }));
  });
}
