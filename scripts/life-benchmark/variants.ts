// Prompt variants (spec §33.2): a variant replaces, removes or adds paragraphs of the life prompt's
// block A, of the tools' descriptions (and their input fields' descriptions) and of the summary
// instructions (her rest notice, the compaction instruction, the dream's instruction and system
// block), for one run only, through the app's benchmark seams (`src/life/benchmarkHook.ts`). The
// baseline is the shipped prompt. Each run carries its variant in an AsyncLocalStorage, so runs
// with different variants can share one process.
//
// A paragraph is what the text is written in: block A's are separated by a blank line, the tool
// descriptions and summary instructions are written one paragraph per line. Every edit must match
// exactly one paragraph; `checkVariants` tries every edit on the shipped texts before any run.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  SUMMARY_PROMPTS,
  setBenchmarkBlockATransform,
  setBenchmarkSummaryPromptTransform,
  setBenchmarkToolTransform,
  type BenchmarkTool,
  type SummaryPrompt
} from "../../src/life/benchmarkHook.js";
import { COMPACTION_INSTRUCTION } from "../../src/life/compaction.js";
import { DREAM_INSTRUCTION, dreamSystem } from "../../src/life/dream.js";
import { buildBlockA } from "../../src/life/lifeHarness.js";
import { CACHE_REST_NOTICE, REST_NOTICE, REST_NOTICE_PREFIX } from "../../src/life/rest.js";
import { ALL_LIFE_TOOLS, modelTools, offerableTool } from "../../src/life/tools/index.js";
import type { Scenario } from "./scenario.js";
import { runConfig, scenarioWaifu, type ModelPick } from "./world.js";

export const VariantEditSchema = z.union([
  /** The one paragraph containing `replace` becomes `with` (block A: its `<tag>` lines are kept). */
  z.object({ replace: z.string().min(3), with: z.string().min(1) }).strict(),
  /** The one paragraph containing `remove` goes. */
  z.object({ remove: z.string().min(3) }).strict(),
  /** A new paragraph after the one containing `after`; without `after`, at the end (block A: of `<life>`). */
  z.object({ add: z.string().min(1), after: z.string().min(3).optional() }).strict()
]);

const EditsSchema = z.array(VariantEditSchema);

export const PromptVariantSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    description: z.string().min(1),
    /** Block A (as before tools and summaries existed). */
    edits: EditsSchema.default([]),
    /** A tool's description, by tool name (`SendMessage`, `Edit`, …). */
    tools: z.record(z.string(), EditsSchema).default({}),
    /** A tool's input fields' descriptions, by tool name and field (`{ Bash: { command: [...] } }`). */
    toolSchemas: z.record(z.string(), z.record(z.string(), EditsSchema)).default({}),
    /** The summary instructions: `rest` (also the quiet-time rest), `compaction`, `dream`, `dreamSystem`. */
    summaries: z
      .object(Object.fromEntries(SUMMARY_PROMPTS.map((prompt) => [prompt, EditsSchema.optional()])) as Record<SummaryPrompt, z.ZodOptional<typeof EditsSchema>>)
      .strict()
      .default({})
  })
  .strict();

/** A variant as written (everything but `id` and `description` optional). */
export type PromptVariant = z.input<typeof PromptVariantSchema>;
export type VariantEdit = z.infer<typeof VariantEditSchema>;

export const BASELINE: PromptVariant = { id: "baseline", description: "The shipped life prompt.", edits: [] };

// ---- the built-in variants -------------------------------------------------------------------------

const CALM_BLOCK_A =
  "When someone hasn't answered you, follow up once, gently, at most; if they still don't answer, let it go and don't set another watch for the same question. In a busy room, speak when you have something to add, not to fill a silence. One or two messages answer most things.";

const CALM: PromptVariant = {
  id: "calm",
  description: "Fewer follow-up pings and unprompted bursts: one gentle follow-up, speak when there's something to add, one or two messages.",
  edits: [{ add: CALM_BLOCK_A }]
};

/**
 * Every one of these descriptions already ends with an example; each gets a second one of a
 * different shape, aimed at the first-try failures seen in real runs (time ranges, a file that may
 * not exist, a filter of her own instead of an object).
 */
const TOOL_EXAMPLES: PromptVariant = {
  id: "tool-examples",
  description: "A second, differently shaped example call in the descriptions of ReadMessages, SendMessage, Read and Wakeup.",
  tools: {
    ReadMessages: [{ add: 'Another example, a stretch of time in one place: return await tools.read_messages({ place: "dm/kevin", after: "yesterday 18:00", before: "yesterday 23:00" })' }],
    SendMessage: [{ add: 'Another example, one reply: return await tools.send_message({ place: "dm/kevin", messages: [{ text: "omg congrats!!", reply_to: "#k7" }] })' }],
    Read: [{ add: 'Another example, a file that may not exist yet: try { text(await tools.read_file({ path: "~/people/rosa.md" })) } catch { text("no note on rosa yet") }' }],
    Wakeup: [{ add: 'Another example, a filter of your own: return await tools.wakeup({ watch: [{ places: "bake-club/#general", filter: (m) => m.files.length > 0, for: "1d", note: "someone posted a photo of their bake" }] })' }]
  }
};

/**
 * Built-in examples. Only `add` edits, so they survive rewrites of the shipped paragraphs.
 * `own-voice` (summaries and dream notes in her own voice) shipped on 2026-10-29 and is now part of
 * the baseline; `calm-voice` (calm and own-voice) went with it, as it is now `calm`.
 */
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
  },
  CALM,
  TOOL_EXAMPLES
];

// ---- applying edits ------------------------------------------------------------------------------------

const OPEN_TAG = /^<([a-z_]+)>\n/u;
const CLOSE_TAG = /\n<\/([a-z_]+)>$/u;

/** How one kind of text is split and where an `add` without `after` goes. */
type TextKind = { label: string; separator: string; tags: boolean };

function findParagraph(paragraphs: readonly string[], needle: string, what: string, label: string): number {
  const hits = paragraphs.flatMap((paragraph, index) => (paragraph.includes(needle) ? [index] : []));
  if (hits.length === 0) throw new Error(`${what}: no paragraph of ${label} contains ${JSON.stringify(needle.slice(0, 60))}`);
  if (hits.length > 1) throw new Error(`${what}: ${hits.length} paragraphs of ${label} contain ${JSON.stringify(needle.slice(0, 60))}; quote more of it`);
  return hits[0]!;
}

/** `text` with `edits` applied in order; throws when an edit does not match exactly one paragraph. */
function editText(text: string, edits: readonly VariantEdit[], kind: TextKind, what: string): string {
  if (edits.length === 0) return text;
  const paragraphs = text.split(kind.separator);
  for (const [index, edit] of edits.entries()) {
    const where = `${what} edit ${index + 1}`;
    if ("replace" in edit) {
      const at = findParagraph(paragraphs, edit.replace, where, kind.label);
      const old = paragraphs[at]!;
      const open = kind.tags ? (OPEN_TAG.exec(old)?.[0] ?? "") : "";
      const close = kind.tags ? (CLOSE_TAG.exec(old)?.[0] ?? "") : "";
      paragraphs[at] = `${open}${edit.with.trim()}${close}`;
    } else if ("remove" in edit) {
      const at = findParagraph(paragraphs, edit.remove, where, kind.label);
      const old = paragraphs[at]!;
      const open = kind.tags ? OPEN_TAG.exec(old)?.[0] : undefined;
      const close = kind.tags ? CLOSE_TAG.exec(old)?.[0] : undefined;
      // A paragraph that only opens or only closes a section leaves its tag on the neighbour; a
      // whole section (both tags) goes entirely.
      paragraphs.splice(at, 1);
      if (open && !close && paragraphs[at] !== undefined) paragraphs[at] = `${open}${paragraphs[at]}`;
      if (close && !open && at > 0) paragraphs[at - 1] = `${paragraphs[at - 1]}${close}`;
    } else if (edit.after) {
      const at = findParagraph(paragraphs, edit.after, where, kind.label);
      const old = paragraphs[at]!;
      const close = kind.tags ? CLOSE_TAG.exec(old)?.[0] : undefined;
      if (close) {
        paragraphs[at] = old.slice(0, -close.length);
        paragraphs.splice(at + 1, 0, `${edit.add.trim()}${close}`);
      } else paragraphs.splice(at + 1, 0, edit.add.trim());
    } else if (kind.tags) {
      const end = paragraphs.findIndex((paragraph) => paragraph.endsWith("\n</life>"));
      if (end < 0) throw new Error(`${where}: ${kind.label} has no </life> to add before`);
      paragraphs[end] = paragraphs[end]!.slice(0, -"\n</life>".length);
      paragraphs.splice(end + 1, 0, `${edit.add.trim()}\n</life>`);
    } else paragraphs.push(edit.add.trim());
  }
  return paragraphs.join(kind.separator);
}

/** Block A with the variant's edits applied in order; throws when an edit does not match exactly one paragraph. */
export function applyVariant(blockA: string, variant: PromptVariant): string {
  return editText(blockA, variant.edits ?? [], { label: "block A", separator: "\n\n", tags: true }, `variant ${variant.id}`);
}

/** A tool definition with the variant's edits of its description and its fields' descriptions (the same object when it has none). */
export function applyToolEdits(tool: BenchmarkTool, variant: PromptVariant): BenchmarkTool {
  const descriptionEdits = variant.tools?.[tool.name] ?? [];
  const fieldEdits = Object.entries(variant.toolSchemas?.[tool.name] ?? {}).filter(([, edits]) => edits.length > 0);
  if (descriptionEdits.length === 0 && fieldEdits.length === 0) return tool;
  const description = editText(tool.description, descriptionEdits, { label: `the ${tool.name} description`, separator: "\n", tags: false }, `variant ${variant.id} tools.${tool.name}`);
  if (fieldEdits.length === 0) return { ...tool, description };
  // The shipped schemas are shared constants: edit a copy.
  const inputSchema = structuredClone(tool.inputSchema);
  const properties = inputSchema["properties"] as Record<string, { description?: unknown }> | undefined;
  for (const [field, edits] of fieldEdits) {
    const what = `variant ${variant.id} toolSchemas.${tool.name}.${field}`;
    const property = properties?.[field];
    if (!property || typeof property.description !== "string") throw new Error(`${what}: ${tool.name} has no input field ${field} with a description (fields: ${Object.keys(properties ?? {}).join(", ")})`);
    property.description = editText(property.description, edits, { label: `the ${tool.name} ${field} description`, separator: "\n", tags: false }, what);
  }
  return { ...tool, description, inputSchema };
}

/** A summary instruction with the variant's edits; the rest notice must still open like one (`isRestNotice`). */
export function applySummaryEdits(prompt: SummaryPrompt, text: string, variant: PromptVariant): string {
  const edits = variant.summaries?.[prompt] ?? [];
  if (edits.length === 0) return text;
  const what = `variant ${variant.id} summaries.${prompt}`;
  const edited = editText(text, edits, { label: `the ${prompt} instruction`, separator: "\n", tags: false }, what);
  if (prompt === "rest" && !edited.startsWith(REST_NOTICE_PREFIX)) {
    throw new Error(`${what}: the rest notice must still start with ${JSON.stringify(REST_NOTICE_PREFIX)} (the app and the benchmark recognise rest turns by it)`);
  }
  return edited;
}

// ---- checking variants before any run ------------------------------------------------------------------

/** The shipped texts a variant's edits are tried on. Build them outside any `withVariant`. */
export type ShippedTexts = { blockA: string[]; tools: BenchmarkTool[]; summaries: Record<SummaryPrompt, string[]> };

/** The texts each scenario's run starts from: her block A, every offerable tool under the run's config, the summary instructions. */
export function shippedTexts(scenarios: readonly Scenario[], o: { model: ModelPick; web: boolean }): ShippedTexts {
  const out: ShippedTexts = { blockA: [], tools: [], summaries: { rest: [REST_NOTICE, CACHE_REST_NOTICE], compaction: [COMPACTION_INSTRUCTION], dream: [DREAM_INSTRUCTION], dreamSystem: [] } };
  const names = ALL_LIFE_TOOLS.map((tool) => tool.name).filter(offerableTool);
  for (const scenario of scenarios) {
    const config = runConfig(scenario, o.model, { web: o.web });
    const waifu = scenarioWaifu(scenario, o.model);
    out.blockA.push(buildBlockA(waifu, { serverNicknames: [], others: [] }, scenario.start.timeZone, { tmpRetentionDays: config.life.tmp.retentionDays }));
    out.tools.push(...modelTools(names, config));
    out.summaries.dreamSystem.push(dreamSystem(waifu));
  }
  return out;
}

/** Throws (naming the variant and edit) unless every edit of `variant` matches exactly one paragraph of each shipped text it targets. */
export function checkVariant(variant: PromptVariant, shipped: ShippedTexts): void {
  for (const blockA of shipped.blockA) applyVariant(blockA, variant);
  const offered = [...new Set(shipped.tools.map((tool) => tool.name))];
  for (const name of new Set([...Object.keys(variant.tools ?? {}), ...Object.keys(variant.toolSchemas ?? {})])) {
    if (!offered.includes(name)) throw new Error(`variant ${variant.id}: no tool called ${name} (tools: ${offered.join(", ")})`);
  }
  for (const tool of shipped.tools) applyToolEdits(tool, variant);
  for (const prompt of SUMMARY_PROMPTS) for (const text of shipped.summaries[prompt]) applySummaryEdits(prompt, text, variant);
}

/** Every variant against every scenario's shipped texts: a broken edit stops the benchmark before any run. */
export function checkVariants(variants: readonly PromptVariant[], scenarios: readonly Scenario[], o: { model: ModelPick; web: boolean }): void {
  const shipped = shippedTexts(scenarios, o);
  for (const variant of variants) checkVariant(variant, shipped);
}

// ---- one run's variant ---------------------------------------------------------------------------------

const current = new AsyncLocalStorage<PromptVariant>();
let installed = false;

/** Runs `work` with `variant`'s edits for everything it starts (timers and promises included). */
export function withVariant<T>(variant: PromptVariant, work: () => Promise<T>): Promise<T> {
  if (!installed) {
    installed = true;
    setBenchmarkBlockATransform((blockA) => {
      const active = current.getStore();
      return active ? applyVariant(blockA, active) : blockA;
    });
    setBenchmarkToolTransform((tool) => {
      const active = current.getStore();
      return active ? applyToolEdits(tool, active) : tool;
    });
    setBenchmarkSummaryPromptTransform((prompt, text) => {
      const active = current.getStore();
      return active ? applySummaryEdits(prompt, text, active) : text;
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
