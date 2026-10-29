// Prompt variants (spec §33.2): a variant replaces, removes or adds paragraphs of the life prompt's
// block A for one run only, through the app's benchmark seam (`src/life/benchmarkHook.ts`). The
// baseline is the shipped prompt. Each run carries its variant in an AsyncLocalStorage, so runs
// with different variants can share one process.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { setBenchmarkBlockATransform } from "../../src/life/benchmarkHook.js";

export const VariantEditSchema = z.union([
  /** The one paragraph containing `replace` becomes `with` (its `<tag>` lines are kept). */
  z.object({ replace: z.string().min(3), with: z.string().min(1) }).strict(),
  /** The one paragraph containing `remove` goes. */
  z.object({ remove: z.string().min(3) }).strict(),
  /** A new paragraph after the one containing `after`; without `after`, at the end of `<life>`. */
  z.object({ add: z.string().min(1), after: z.string().min(3).optional() }).strict()
]);

export const PromptVariantSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
  description: z.string().min(1),
  edits: z.array(VariantEditSchema).default([])
});

export type PromptVariant = z.infer<typeof PromptVariantSchema>;
export type VariantEdit = z.infer<typeof VariantEditSchema>;

export const BASELINE: PromptVariant = { id: "baseline", description: "The shipped life prompt.", edits: [] };

/** Built-in examples. Only `add` edits, so they survive rewrites of the shipped paragraphs. */
export const BUILT_IN_VARIANTS: readonly PromptVariant[] = [
  BASELINE,
  {
    id: "brief",
    description: "One extra paragraph asking for shorter chat lines and fewer messages per reply.",
    edits: [
      {
        add: "Most of your messages are a few words, rarely more than one short sentence. One or two messages answer most things; save longer bursts for when you're really excited or telling a story."
      }
    ]
  }
];

const OPEN_TAG = /^<([a-z_]+)>\n/u;
const CLOSE_TAG = /\n<\/([a-z_]+)>$/u;

function findParagraph(paragraphs: readonly string[], needle: string, what: string): number {
  const hits = paragraphs.flatMap((paragraph, index) => (paragraph.includes(needle) ? [index] : []));
  if (hits.length === 0) throw new Error(`${what}: no paragraph of block A contains ${JSON.stringify(needle.slice(0, 60))}`);
  if (hits.length > 1) throw new Error(`${what}: ${hits.length} paragraphs of block A contain ${JSON.stringify(needle.slice(0, 60))}; quote more of it`);
  return hits[0]!;
}

/** Block A with the variant's edits applied in order; throws when an edit does not match exactly one paragraph. */
export function applyVariant(blockA: string, variant: PromptVariant): string {
  const paragraphs = blockA.split("\n\n");
  for (const [index, edit] of variant.edits.entries()) {
    const what = `variant ${variant.id} edit ${index + 1}`;
    if ("replace" in edit) {
      const at = findParagraph(paragraphs, edit.replace, what);
      const old = paragraphs[at]!;
      const open = OPEN_TAG.exec(old)?.[0] ?? "";
      const close = CLOSE_TAG.exec(old)?.[0] ?? "";
      paragraphs[at] = `${open}${edit.with.trim()}${close}`;
    } else if ("remove" in edit) {
      const at = findParagraph(paragraphs, edit.remove, what);
      const old = paragraphs[at]!;
      const open = OPEN_TAG.exec(old)?.[0];
      const close = CLOSE_TAG.exec(old)?.[0];
      // A paragraph that only opens or only closes a section leaves its tag on the neighbour; a
      // whole section (both tags) goes entirely.
      paragraphs.splice(at, 1);
      if (open && !close && paragraphs[at] !== undefined) paragraphs[at] = `${open}${paragraphs[at]}`;
      if (close && !open && at > 0) paragraphs[at - 1] = `${paragraphs[at - 1]}${close}`;
    } else if (edit.after) {
      const at = findParagraph(paragraphs, edit.after, what);
      const old = paragraphs[at]!;
      const close = CLOSE_TAG.exec(old)?.[0];
      if (close) {
        paragraphs[at] = old.slice(0, -close.length);
        paragraphs.splice(at + 1, 0, `${edit.add.trim()}${close}`);
      } else paragraphs.splice(at + 1, 0, edit.add.trim());
    } else {
      const end = paragraphs.findIndex((paragraph) => paragraph.endsWith("\n</life>"));
      if (end < 0) throw new Error(`${what}: block A has no </life> to add before`);
      paragraphs[end] = paragraphs[end]!.slice(0, -"\n</life>".length);
      paragraphs.splice(end + 1, 0, `${edit.add.trim()}\n</life>`);
    }
  }
  return paragraphs.join("\n\n");
}

const current = new AsyncLocalStorage<PromptVariant>();
let installed = false;

/** Runs `work` with `variant` as block A's edits for everything it starts (timers and promises included). */
export function withVariant<T>(variant: PromptVariant, work: () => Promise<T>): Promise<T> {
  if (!installed) {
    installed = true;
    setBenchmarkBlockATransform((blockA) => {
      const active = current.getStore();
      return active && active.edits.length > 0 ? applyVariant(blockA, active) : blockA;
    });
  }
  return current.run(variant, work);
}

/** `--variants=baseline,brief,./my-variant.json`: built-ins by id, files (.json, or .ts/.js exporting `default`) by path. */
export async function loadVariants(spec: string, cwd = process.cwd()): Promise<PromptVariant[]> {
  const out: PromptVariant[] = [];
  for (const item of spec.split(",").map((part) => part.trim()).filter(Boolean)) {
    const builtIn = BUILT_IN_VARIANTS.find((variant) => variant.id === item);
    if (builtIn) {
      out.push(builtIn);
      continue;
    }
    if (!/[/.]/u.test(item)) throw new Error(`Unknown variant ${item} (built-ins: ${BUILT_IN_VARIANTS.map((variant) => variant.id).join(", ")})`);
    const file = path.resolve(cwd, item);
    const raw = file.endsWith(".json") ? JSON.parse(await readFile(file, "utf8")) : ((await import(pathToFileURL(file).href)) as { default: unknown }).default;
    const list = Array.isArray(raw) ? raw : [raw];
    for (const entry of list) out.push(PromptVariantSchema.parse(entry));
  }
  const ids = out.map((variant) => variant.id);
  if (new Set(ids).size !== ids.length) throw new Error("Two variants share an id.");
  return out.length > 0 ? out : [BASELINE];
}
