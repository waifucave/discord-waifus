// PDF text for `Read` (Living cast spec §16.3.3): the parser runs in a worker thread with a heap
// limit and a time limit (pdfWorker.ts); the host only gets the pages' text back.

import { Worker } from "node:worker_threads";
import type { PdfWorkerInput, PdfWorkerResult } from "./pdfWorker.js";

export const PDF_TIMEOUT_MS = 20_000;
export const PDF_HEAP_MB = 256;

function workerUrl(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./pdfWorker${ext}`, import.meta.url);
}

/** The text of pages `first`–`last` (1-based) and the page count, or why it could not be read. */
export function extractPdfText(data: Uint8Array, o: { first: number; last: number; timeoutMs?: number; signal?: AbortSignal }): Promise<PdfWorkerResult> {
  const copy = new Uint8Array(data);
  const worker = new Worker(workerUrl(), {
    workerData: { data: copy, first: o.first, last: o.last } satisfies PdfWorkerInput,
    transferList: [copy.buffer],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: PDF_HEAP_MB, maxYoungGenerationSizeMb: 32 },
    stdout: true,
    stderr: true
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: PdfWorkerResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "it took too long to read" }), o.timeoutMs ?? PDF_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => finish({ ok: false, error: "interrupted" });
    o.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (message: PdfWorkerResult) => finish(message));
    worker.on("error", () => finish({ ok: false, error: "it could not be read" }));
    worker.on("exit", () => finish({ ok: false, error: "it could not be read" }));
  });
}
