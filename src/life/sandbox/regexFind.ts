// Her RegExp in `web__run`'s find (Living cast spec §32.3a): a pattern can backtrack for minutes, so
// it never runs on the host's own thread. Each find gets a small worker thread of its own over the
// page's lines, ended after `REGEX_FIND_MS`; the host builds the matches from the positions it
// reports. Her flags are kept except g, y, d and v (one match per line, as text finds).

import { Worker } from "node:worker_threads";
import { MAX_FIND_MATCHES, MAX_FIND_QUERY_CHARS } from "./webPage.js";

/** How long one RegExp find may run. */
export const REGEX_FIND_MS = 1_000;

// Run as a CommonJS script by the worker (`eval`): only the line loop, nothing of the host.
const FINDER = `
const { parentPort, workerData } = require("node:worker_threads");
const { lines, source, flags, max } = workerData;
const re = new RegExp(source, flags);
const hits = [];
for (let i = 0; i < lines.length && hits.length < max; i += 1) {
  const line = lines[i];
  if (!line.trim()) continue;
  const match = re.exec(line);
  if (match) hits.push([i, match.index]);
}
parentPort.postMessage(hits);
`;

/** The lines (and where on them) her RegExp matches, at most 20; an error she can read otherwise. */
export function regexFind(lines: readonly string[], source: string, flags: string, signal?: AbortSignal): Promise<{ ok: true; hits: Array<[number, number]> } | { ok: false; error: string }> {
  if (source.length > MAX_FIND_QUERY_CHARS) return Promise.resolve({ ok: false, error: `a RegExp of at most ${MAX_FIND_QUERY_CHARS} characters` });
  const kept = [...new Set(flags.split(""))].filter((flag) => "imsu".includes(flag)).join("");
  try {
    // Building it runs nothing: a bad pattern is her error here.
    new RegExp(source, kept);
  } catch (error) {
    return Promise.resolve({ ok: false, error: error instanceof Error ? error.message : "that RegExp can't be used" });
  }
  return new Promise((resolve) => {
    let done = false;
    const worker = new Worker(FINDER, {
      eval: true,
      workerData: { lines: [...lines], source, flags: kept, max: MAX_FIND_MATCHES },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      stdout: true,
      stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    const finish = (result: { ok: true; hits: Array<[number, number]> } | { ok: false; error: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate().catch(() => undefined);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "that RegExp took too long on this page; try plain text" }), REGEX_FIND_MS);
    timer.unref?.();
    const onAbort = () => finish({ ok: false, error: "interrupted" });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (hits: unknown) => {
      const valid = Array.isArray(hits) && hits.every((hit) => Array.isArray(hit) && hit.length === 2 && hit.every((n) => Number.isInteger(n) && n >= 0));
      finish(valid ? { ok: true, hits: (hits as Array<[number, number]>).slice(0, MAX_FIND_MATCHES) } : { ok: false, error: "that RegExp couldn't be run" });
    });
    worker.on("error", () => finish({ ok: false, error: "that RegExp couldn't be run on this page" }));
    worker.on("exit", () => finish({ ok: false, error: "that RegExp couldn't be run on this page" }));
  });
}
