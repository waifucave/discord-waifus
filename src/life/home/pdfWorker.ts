// PDF text for `Read` (Living cast spec §16.3.3), in its own worker thread: a hostile or huge PDF
// never runs its parser on the host's event loop, and the host terminates it at a time limit. This
// file is the worker's entry, loaded by Node directly (type stripping from source, the compiled .js
// when installed), so it imports only npm packages and `node:` builtins.

import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

export type PdfWorkerInput = { data: Uint8Array; first: number; last: number };
export type PdfWorkerResult = { ok: true; totalPages: number; pages: Array<{ page: number; text: string }> } | { ok: false; error: string };

async function main(): Promise<PdfWorkerResult> {
  const input = workerData as PdfWorkerInput;
  const pdf = await getDocumentProxy(new Uint8Array(input.data));
  const totalPages = pdf.numPages;
  const pages: Array<{ page: number; text: string }> = [];
  for (let page = Math.max(1, input.first); page <= Math.min(input.last, totalPages); page += 1) {
    const content = await (await pdf.getPage(page)).getTextContent();
    let text = "";
    for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
      if (typeof item.str !== "string") continue;
      text += item.str;
      text += item.hasEOL ? "\n" : "";
    }
    pages.push({ page, text: text.replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim() });
  }
  return { ok: true, totalPages, pages };
}

main().then(
  (result) => parentPort!.postMessage(result),
  (error: unknown) => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies PdfWorkerResult)
);
