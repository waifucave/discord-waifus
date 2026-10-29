// Her tool script, the host side (Living cast spec §32.1, from §31.4's web script): each call gets its
// own worker thread (toolScriptWorker.ts), so a script waiting a minute on the network or in a chat
// never holds up another waifu's code or the shared §30 sandbox. The worker asks for her tool's
// functions over its port; this side runs them (`call`: the tool's checks and caps live there) and
// answers. It keeps the time:
//
// - her own computing: the worker says when her code runs (`busy`) and when it waits for the host
//   (`idle`), each message stamped with the worker's own clock, and her busy time is summed from
//   those stamps (never from when this side got to the message: a host busy with something else
//   adds nothing); over `cpuMs` + `RUN_GRACE_MS` the run is a time hit. A backstop timer stops a
//   worker still busy `BACKSTOP_SLACK_MS` past her budget (a native call QuickJS can't interrupt),
//   after reading any messages already waiting;
// - the whole run: `wallMs` (60 s; SendMessage 150 s), whatever it waits for;
// - a stop, a pause or a turn's abort ends it at once.
//
// When the run ends, for any reason, the worker is terminated; its calls still going are waited for
// (§32.3a: what they do gets its receipt) up to the wall clock, then told to stop and given
// `SETTLE_GRACE_MS` to finish what they began (a stop, an abort or the wall clock tells them at once).
// What comes back from the worker is checked and cut again here: nothing it sends is trusted as it is.

import { Worker } from "node:worker_threads";
import type { ToolHostReply, ToolScriptDone, ToolScriptError, ToolScriptLimits, ToolScriptSurface, ToolWorkerMessage } from "./toolScriptWorker.js";

export type { ToolScriptLimits, ToolScriptSurface };

export const TOOL_SCRIPT_LIMITS: ToolScriptLimits = {
  cpuMs: 1_000,
  memoryBytes: 16 * 1024 * 1024,
  stackBytes: 256 * 1024,
  maxOutputChars: 8_000,
  // The tool's own per-function caps refuse first; this bounds a loop that never stops asking.
  maxHostCalls: 24,
  maxArgChars: 16_384
};
/** The longest one script runs, waiting included (SendMessage passes its own). */
export const TOOL_SCRIPT_WALL_MS = 60_000;
/** Her busy time (from the worker's stamps) past `cpuMs` by this much is a time hit. */
export const RUN_GRACE_MS = 250;
/** The backstop for a worker stuck busy: this long past her remaining budget, by this side's clock. */
export const BACKSTOP_SLACK_MS = 2_000;
/** Until her code first runs (the worker loads QuickJS first). */
const START_MS = 10_000;
const MAX_ERROR_CHARS = 1_000;
/** A call still going once it was told to stop gets this long to finish what it began. */
export const SETTLE_GRACE_MS = 10_000;
/** The end of an output cut at its cap (§32.3a: it says so). */
export const outputCut = (max: number) => `… (cut: at most ${max.toLocaleString("en-US")} characters are shown)`;
/** At most this many pictures are shown by one script. */
export const MAX_SHOWN_IMAGES = 10;

export type ToolCallAnswer = { ok: true; value: unknown } | { ok: false; error: string; name?: "Error" | "TypeError" | "RangeError" };
/** One call of her script (its function's name and its one argument): never throws (a throw is a failed call). */
export type ToolCall = (fn: string, arg: unknown, signal: AbortSignal) => Promise<ToolCallAnswer>;

/** What she showed, in order: text, or a picture (an image id a `read_file` gave her). */
export type ToolScriptShown = { kind: "text"; text: string } | { kind: "image"; id: string };
export type ToolScriptStop = "time" | "wall" | "memory" | "stack" | "aborted" | "crash" | "start";
export type ToolScriptOutcome = {
  /** What she showed with text(), else her return value; texts cut at `maxOutputChars`, the last saying so. */
  shown: ToolScriptShown[];
  /** Nothing was shown or returned. */
  empty: boolean;
  /** Her error (`TypeError: … (line 3)`) or why the run was stopped. */
  error?: string;
  stop?: ToolScriptStop;
};

function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./toolScriptWorker${ext}`, import.meta.url);
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The worker's end message, checked strictly: anything else is a crash. */
function doneOf(value: unknown, maxChars: number): ToolScriptDone | undefined {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") return undefined;
  if (value["ok"]) {
    const result = value["value"];
    if (result !== null && typeof result !== "string") return undefined;
    const image = value["image"];
    return {
      ok: true,
      value: result === null ? null : result.slice(0, maxChars + 1),
      ...(typeof image === "string" && image.length <= 40 ? { image } : {}),
      cut: value["cut"] === true || (typeof result === "string" && result.length > maxChars),
      shown: value["shown"] === true
    };
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

function stopText(stop: ToolScriptStop, wallMs: number): string {
  switch (stop) {
    case "time":
      return "your script computed for too long (it has 1 s of its own; waiting for the tools doesn't count)";
    case "wall":
      return `your script ran for ${Math.round(wallMs / 1000)} seconds and was stopped`;
    case "memory":
      return "your script used too much memory";
    case "stack":
      return "your script recursed too deeply";
    case "aborted":
      return "the script was interrupted";
    case "crash":
      return "the script stopped unexpectedly";
    case "start":
      return "the script couldn't start";
  }
}

function errorText(error: ToolScriptError, wallMs: number): { text: string; stop?: ToolScriptStop } {
  if (error.kind === "time") return { text: stopText("time", wallMs), stop: "time" };
  if (error.kind === "memory") return { text: stopText("memory", wallMs), stop: "memory" };
  if (error.kind === "stack") return { text: stopText("stack", wallMs), stop: "stack" };
  return { text: `${error.name}: ${error.message}${error.line !== undefined ? ` (line ${error.line})` : ""}` };
}

export function runToolScript(
  script: string,
  call: ToolCall,
  o: { surface: ToolScriptSurface; timeZone: string; now: Date; signal?: AbortSignal; limits?: Partial<ToolScriptLimits>; wallMs?: number }
): Promise<ToolScriptOutcome> {
  const limits: ToolScriptLimits = { ...TOOL_SCRIPT_LIMITS, ...o.limits };
  const wallMs = o.wallMs ?? TOOL_SCRIPT_WALL_MS;
  const allowed = new Set(o.surface.functions);
  return new Promise((resolve) => {
    const shown: ToolScriptShown[] = [];
    let shownChars = 0;
    let textCut = false;
    let images = 0;
    let ended = false;
    let busySince: number | undefined;
    let used = 0;
    let cpuTimer: ReturnType<typeof setTimeout> | undefined;
    const calls = new AbortController();
    const inflight = new Set<Promise<unknown>>();
    const startedAt = Date.now();
    const worker = new Worker(workerUrl(), {
      workerData: { script, limits, surface: o.surface, clock: { nowMs: o.now.getTime(), timeZone: o.timeZone } },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();

    const addText = (raw: string) => {
      if (textCut) return;
      const text = raw.slice(0, limits.maxOutputChars + 1);
      shownChars += text.length + 1;
      shown.push({ kind: "text", text });
      if (shownChars > limits.maxOutputChars + 1) textCut = true;
    };

    const end = (how: { done: ToolScriptDone } | { stop: ToolScriptStop }) => {
      if (ended) return;
      ended = true;
      clearTimeout(wallTimer);
      clearTimeout(startTimer);
      if (cpuTimer) clearTimeout(cpuTimer);
      o.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      let error: string | undefined;
      let stop: ToolScriptStop | undefined;
      if ("done" in how) {
        if (how.done.ok) {
          if (!how.done.shown) {
            if (how.done.image !== undefined) shown.push({ kind: "image", id: how.done.image });
            else if (how.done.value !== null && how.done.value !== "") {
              addText(how.done.value);
              if (how.done.cut) textCut = true;
            }
          }
        } else {
          const text = errorText(how.done.error, wallMs);
          error = text.text;
          stop = text.stop;
        }
      } else {
        stop = how.stop;
        error = stopText(how.stop, wallMs);
      }
      // Texts in all are cut at the cap, on the text that crosses it.
      let left = limits.maxOutputChars;
      const kept: ToolScriptShown[] = [];
      let cutAny = textCut;
      for (const item of shown) {
        if (item.kind === "image") {
          kept.push(item);
          continue;
        }
        if (left <= 0) {
          cutAny = true;
          continue;
        }
        if (item.text.length > left) {
          kept.push({ kind: "text", text: item.text.slice(0, left) });
          cutAny = true;
          left = 0;
          continue;
        }
        kept.push(item);
        left -= item.text.length + 1;
      }
      if (cutAny) {
        const last = [...kept].reverse().find((item): item is { kind: "text"; text: string } => item.kind === "text");
        if (last) last.text = `${last.text}${outputCut(limits.maxOutputChars)}`;
        else kept.push({ kind: "text", text: outputCut(limits.maxOutputChars) });
      }
      const outcome: ToolScriptOutcome = { shown: kept, empty: kept.length === 0, ...(error !== undefined ? { error } : {}), ...(stop ? { stop } : {}) };
      // Her calls still going (§32.3a): waited for up to the wall clock (at once stopped by a stop,
      // an abort or the wall clock itself), then given a short grace to finish what they began.
      if (inflight.size === 0) {
        calls.abort();
        resolve(outcome);
        return;
      }
      const stopNow = () => calls.abort();
      if (stop === "aborted" || stop === "wall" || o.signal?.aborted) stopNow();
      o.signal?.addEventListener("abort", stopNow, { once: true });
      const deadline = setTimeout(stopNow, Math.max(0, startedAt + wallMs - Date.now()));
      deadline.unref?.();
      let grace: ReturnType<typeof setTimeout> | undefined;
      const graceOver = new Promise<void>((done) => {
        calls.signal.addEventListener("abort", () => {
          grace = setTimeout(done, SETTLE_GRACE_MS);
          grace.unref?.();
        }, { once: true });
        if (calls.signal.aborted) {
          grace = setTimeout(done, SETTLE_GRACE_MS);
          grace.unref?.();
        }
      });
      void Promise.race([Promise.allSettled([...inflight]), graceOver]).then(() => {
        clearTimeout(deadline);
        if (grace) clearTimeout(grace);
        o.signal?.removeEventListener("abort", stopNow);
        calls.abort();
        resolve(outcome);
      });
    };

    // The backstop only: her busy time itself comes from the worker's stamps. Messages already
    // waiting (an `idle`, her end) are read first, and the slack is far over a host's own hiccups.
    const armCpu = () => {
      if (cpuTimer) clearTimeout(cpuTimer);
      const left = Math.max(0, limits.cpuMs - used) + BACKSTOP_SLACK_MS;
      cpuTimer = setTimeout(() => setImmediate(() => (busySince !== undefined ? end({ stop: "time" }) : undefined)), left);
      cpuTimer.unref?.();
    };
    /** The worker's stamp, else (a malformed one) this side's clock on the same base. */
    const stampOf = (at: unknown) => (typeof at === "number" && Number.isFinite(at) ? at : performance.timeOrigin + performance.now());
    const wallTimer = setTimeout(() => end({ stop: "wall" }), wallMs);
    wallTimer.unref?.();
    let first = true;
    const startTimer = setTimeout(() => end({ stop: "start" }), START_MS);
    startTimer.unref?.();
    const onAbort = () => end({ stop: "aborted" });
    if (o.signal?.aborted) {
      queueMicrotask(onAbort);
    } else o.signal?.addEventListener("abort", onAbort, { once: true });

    worker.on("message", (message: ToolWorkerMessage) => {
      if (ended || !isRecord(message)) return;
      if (message.t === "busy") {
        if (first) {
          first = false;
          clearTimeout(startTimer);
        }
        if (busySince === undefined) busySince = stampOf(message.at);
        armCpu();
        return;
      }
      if (message.t === "idle") {
        if (busySince !== undefined) used += Math.max(0, stampOf(message.at) - busySince);
        busySince = undefined;
        if (cpuTimer) clearTimeout(cpuTimer);
        if (used > limits.cpuMs + RUN_GRACE_MS) end({ stop: "time" });
        return;
      }
      if (message.t === "text") {
        if (typeof message.text !== "string") return;
        addText(message.text);
        return;
      }
      if (message.t === "image") {
        if (typeof message.id !== "string" || message.id.length > 40 || images >= MAX_SHOWN_IMAGES) return;
        images += 1;
        shown.push({ kind: "image", id: message.id });
        return;
      }
      if (message.t === "call") {
        const id = message.call;
        const fn = message.fn;
        if (typeof id !== "number" || !Number.isInteger(id) || typeof fn !== "string" || !allowed.has(fn) || typeof message.arg !== "string" || message.arg.length > limits.maxArgChars) {
          end({ stop: "crash" });
          return;
        }
        let arg: unknown;
        let readable = true;
        try {
          arg = JSON.parse(message.arg);
        } catch {
          readable = false;
        }
        const answer: Promise<ToolCallAnswer> = readable
          ? call(fn, arg, calls.signal).catch(() => ({ ok: false as const, error: `tools.${fn}: that didn't work` }))
          : Promise.resolve({ ok: false as const, name: "TypeError" as const, error: `tools.${fn}: what you gave it can't be read` });
        inflight.add(answer);
        void answer.finally(() => inflight.delete(answer));
        void answer.then((result) => {
          if (ended) return;
          let reply: ToolHostReply;
          if (result.ok) {
            let value: string | undefined;
            try {
              value = JSON.stringify(result.value ?? null);
            } catch {
              value = undefined;
            }
            reply = value === undefined ? { t: "reply", call: id, ok: false, error: `tools.${fn}: that didn't work` } : { t: "reply", call: id, ok: true, value };
          } else reply = { t: "reply", call: id, ok: false, ...(result.name ? { name: result.name } : {}), error: cut(String(result.error), MAX_ERROR_CHARS) };
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
