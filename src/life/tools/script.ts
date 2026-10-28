// One tool family (Living cast spec §32): every tool but Bash takes one JavaScript `script`, run in
// its own sandbox worker (src/life/sandbox/toolScript.ts), where `tools` holds that tool's own
// functions (`tools.read_messages`, `tools.send_message`, `tools.read_file`, `tools.apply_patch`,
// `tools.wakeup`, `tools.web__run`) and `text()` shows her a value. This module is the host side all
// of them share:
//
// - the input (`{script}`, at most 20,000 characters) and the call table: each function's own cap
//   per script, its arguments read as JSON and handed to the tool's adapter, which checks every field
//   and throws a `ScriptError` (her readable error, before anything runs) or answers;
// - D14: a script naming a private chat anywhere in it, or any call's argument naming one, is a DM
//   call (as is every DM place the tools resolve, by `notePlace`), also when it fails half-way or
//   doesn't even parse; the calls run inside the tool call's async context, so every place they
//   resolve is recorded for it;
// - what she sees: what she passed to `text()` (an image result of `read_file` as the picture), else
//   her return value, else `done`; then her error with its line. The cap is the tool's own.

import { AsyncResource } from "node:async_hooks";
import { z } from "zod";
import { isDmPlaceRef } from "../dmPlaces.js";
import { notePlace } from "../placeRecorder.js";
import { runToolScript, TOOL_SCRIPT_WALL_MS, type ToolCallAnswer, type ToolScriptLimits } from "../sandbox/toolScript.js";
import { parseInput, toolError, type LifeResultBlock, type ToolContext, type ToolOutput } from "./types.js";

/** Her script (§32.1). */
export const MAX_TOOL_SCRIPT_CHARS = 20_000;
/** The D14 mark for a script or argument that names a private chat without one being resolved. */
export const DM_NAMED = "dm_named";

/** Every tool function, and the tool it belongs to (another tool's function throws naming it). */
export const TOOL_FUNCTIONS: Record<string, string> = {
  read_messages: "ReadMessages",
  send_message: "SendMessage",
  read_file: "Read",
  apply_patch: "Edit",
  wakeup: "Wakeup",
  web__run: "Web"
};

/** Old free functions she may still write from habit (§30, §31), with the call that replaced them. */
const LEGACY: Record<string, Record<string, string>> = {
  Wakeup: Object.fromEntries(["at", "every", "watch", "page", "cancel"].map((name) => [name, `${name}() is gone: call tools.wakeup({ ${name}: [...] })`])),
  Web: {
    search: 'search() is gone: call tools.web__run({ search_query: [{ q: "…" }] })',
    open: 'open() is gone: call tools.web__run({ open: [{ ref_id: "https://…" }] })',
    print: "print() is gone: use text()"
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A call refused or failed: her script gets an Error of this name and message (no `error:` prefix). */
export class ScriptError extends Error {
  constructor(message: string, readonly kind: "Error" | "TypeError" | "RangeError" = "Error") {
    super(message.replace(/^error:\s*/u, ""));
  }
}

/** What a script's calls produce besides their answers (the tool output's extras). */
export type ScriptRun = {
  messageIds: string[];
  /** SendMessage: every sent id (the intent's done line). */
  resultRefs: string[];
  /** SendMessage: the places it sent to. */
  sentPlaces: Set<string>;
  /** Pictures `read_file` gave her, by image id: shown only when she shows them. */
  images: Map<string, () => Promise<LifeResultBlock[]>>;
  /** Per function, how many calls this script made. */
  counts: Map<string, number>;
};

export type ScriptFunction = {
  name: string;
  /** Calls per script (§32.2). */
  max: number;
  /** Its argument as JSON, at most this long (default 16,384). */
  maxArgChars?: number;
  run(arg: unknown, run: ScriptRun, signal: AbortSignal): Promise<unknown>;
};

export type ScriptToolSpec = {
  tool: string;
  functions: ScriptFunction[];
  /** What she sees, at most (§32.1: Read 100,000, the rest 8,000). */
  outputChars?: number;
  wallMs?: number;
  maxHostCalls?: number;
  /** A first line for the result (Web: that it is untrusted content), decided once the script ran. */
  header?: () => string | undefined;
};

const Input = z.object({ script: z.string().min(1, "script is a short JavaScript program").max(MAX_TOOL_SCRIPT_CHARS) }).strict();

/** Any string inside a value that names a private chat (D14). */
export function namesDm(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === "string") return isDmPlaceRef(value);
  if (Array.isArray(value)) return value.some((entry) => namesDm(entry, depth + 1));
  if (isRecord(value)) return Object.entries(value).some(([key, entry]) => isDmPlaceRef(key) || namesDm(entry, depth + 1));
  return false;
}

/** The surface her script sees: this tool's functions, the other tools' as readable errors, old habits. */
function surfaceOf(spec: ScriptToolSpec) {
  const own = new Set(spec.functions.map((fn) => fn.name));
  const others = Object.fromEntries(
    Object.entries(TOOL_FUNCTIONS)
      .filter(([name]) => !own.has(name))
      .map(([name, tool]) => [name, `tools.${name} is the ${tool} tool's; call ${tool}${own.size > 0 ? ` (this one has ${[...own].map((fn) => `tools.${fn}`).join(", ")})` : ""}`])
  );
  return { functions: [...own], others, legacy: LEGACY[spec.tool] ?? {} };
}

/** Runs her script for one tool and turns what she showed into the tool's output. */
export async function runScriptTool(input: unknown, ctx: ToolContext, spec: ScriptToolSpec): Promise<ToolOutput> {
  // D14 first: whatever happens next (a bad input, a syntax error), a script naming a DM is a DM call.
  if (isRecord(input) && namesDm(input)) notePlace(DM_NAMED);
  const parsed = parseInput(Input, input);
  if (!parsed.ok) return parsed.output;
  const run: ScriptRun = { messageIds: [], resultRefs: [], sentPlaces: new Set(), images: new Map(), counts: new Map() };
  const byName = new Map(spec.functions.map((fn) => [fn.name, fn] as const));
  const maxArgChars = Math.max(...spec.functions.map((fn) => fn.maxArgChars ?? 16_384));
  // Each call runs in this tool call's async context: the places it resolves are this call's (D14).
  const call = AsyncResource.bind(async (name: string, arg: unknown, signal: AbortSignal): Promise<ToolCallAnswer> => {
    const fn = byName.get(name);
    if (!fn) return { ok: false, name: "TypeError", error: `there is no tools.${name} here` };
    if (namesDm(arg)) notePlace(DM_NAMED);
    const used = run.counts.get(name) ?? 0;
    if (used >= fn.max) return { ok: false, name: "RangeError", error: `tools.${name}: at most ${fn.max} call${fn.max === 1 ? "" : "s"} in one script` };
    run.counts.set(name, used + 1);
    if (fn.maxArgChars !== undefined && JSON.stringify(arg ?? null).length > fn.maxArgChars) return { ok: false, name: "RangeError", error: `tools.${name}: what you gave it is too long` };
    try {
      return { ok: true, value: await fn.run(arg, run, signal) };
    } catch (error) {
      if (error instanceof ScriptError) return { ok: false, name: error.kind, error: error.message };
      if (signal.aborted) return { ok: false, error: `tools.${name}: interrupted` };
      ctx.deps.logger?.warn?.("Life tool function failed", { waifuId: ctx.waifu.id, tool: spec.tool, fn: name, message: error instanceof Error ? error.message : String(error) });
      return { ok: false, error: `tools.${name}: that didn't work` };
    }
  });
  const limits: Partial<ToolScriptLimits> = {
    maxOutputChars: spec.outputChars ?? 8_000,
    // One past the functions' own caps, so the call over a cap gets its function's readable error.
    maxHostCalls: spec.maxHostCalls ?? spec.functions.reduce((sum, fn) => sum + fn.max, 0) + 1,
    maxArgChars
  };
  const outcome = await runToolScript(parsed.value.script, call, {
    surface: surfaceOf(spec),
    timeZone: ctx.deps.timeZone,
    now: ctx.deps.now(),
    signal: ctx.signal,
    limits,
    wallMs: spec.wallMs ?? TOOL_SCRIPT_WALL_MS
  });
  const blocks: LifeResultBlock[] = [];
  const header = spec.header?.();
  if (header) blocks.push({ type: "text", text: header });
  for (const item of outcome.shown) {
    if (item.kind === "text") {
      blocks.push({ type: "text", text: item.text });
      continue;
    }
    const image = run.images.get(item.id);
    if (!image) {
      blocks.push({ type: "text", text: `[no picture ${item.id}: show what tools.read_file gave you]` });
      continue;
    }
    blocks.push(...(await image()));
  }
  if (outcome.error !== undefined) blocks.push({ type: "text", text: `error: ${outcome.error}` });
  else if (outcome.empty) blocks.push({ type: "text", text: "done" });
  const extras: Partial<ToolOutput> = {
    ...(run.messageIds.length > 0 ? { messageIds: [...new Set(run.messageIds)] } : {}),
    ...(run.resultRefs.length > 0 ? { resultRef: run.resultRefs.join(",") } : {}),
    ...(run.sentPlaces.size > 0 ? { sentPlaces: [...run.sentPlaces] } : {})
  };
  const textOnly = blocks.every((block) => block.type === "text");
  const content: ToolOutput["content"] = textOnly ? blocks.map((block) => (block as { text: string }).text).join("\n") : mergeTexts(blocks);
  return { content, ...(outcome.error !== undefined ? { isError: true } : {}), ...extras };
}

/** Neighbouring text blocks joined (an image keeps its place between them). */
function mergeTexts(blocks: LifeResultBlock[]): LifeResultBlock[] {
  const out: LifeResultBlock[] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (block.type === "text" && last?.type === "text") out[out.length - 1] = { type: "text", text: `${last.text}\n${block.text}` };
    else out.push(block);
  }
  return out;
}

// ---- argument checks the adapters share --------------------------------------------------------------

/** Her one argument as an object with only `fields` (unknown fields throw), for `tools.<fn>`. */
export function objectArg(fn: string, arg: unknown, fields: readonly string[], example: string): Record<string, unknown> {
  if (!isRecord(arg)) throw new ScriptError(`tools.${fn} takes one object, like ${example}`, "TypeError");
  const unknown = Object.keys(arg).find((key) => !fields.includes(key));
  if (unknown !== undefined) throw new ScriptError(`tools.${fn}: unknown field ${JSON.stringify(unknown.slice(0, 40))} (it takes ${fields.join(", ")})`, "TypeError");
  // A field set to undefined (dropped by JSON) or null reads as left out.
  return Object.fromEntries(Object.entries(arg).filter(([, value]) => value !== null && value !== undefined));
}

/** A list field: a list of at most `max` (one item alone is taken as a list of one when `single`). */
export function listArg(fn: string, field: string, value: unknown, max: number, o: { single?: boolean } = {}): unknown[] {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : o.single ? [value] : undefined;
  if (!list) throw new ScriptError(`tools.${fn}: ${field} is a list, like ${field}: [ … ]`, "TypeError");
  if (list.length > max) throw new ScriptError(`tools.${fn}: ${field} has at most ${max} item${max === 1 ? "" : "s"}`, "RangeError");
  return list;
}

/** `text.text`-style string fields: text of 1 to `max` characters. */
export function textArg(where: string, value: unknown, max: number, o: { optional?: boolean } = {}): string | undefined {
  if (value === undefined && o.optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new ScriptError(`${where} is text`, "TypeError");
  if (value.length > max) throw new ScriptError(`${where} is at most ${max.toLocaleString("en-US")} characters`, "RangeError");
  return value;
}

/** A whole number in [min, max]. */
export function intArg(where: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ScriptError(`${where} is a whole number from ${min} to ${max}`, "RangeError");
  return value;
}

/** A number in [min, max] (decimals allowed). */
export function numberArg(where: string, value: unknown, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new ScriptError(`${where} is a number from ${min} to ${max}`, "RangeError");
  return value;
}

/** A tool error's text as her script's error (no `error:` prefix). */
export function failed(output: ToolOutput): never {
  const text = typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  throw new ScriptError(text);
}

/** The text of a tool output (its text blocks). */
export function outputText(output: ToolOutput): string {
  return typeof output.content === "string" ? output.content : output.content.map((block) => ("text" in block ? block.text : "")).join("\n");
}

/** The family's schema: one `script`. */
export function scriptSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { script: { type: "string", maxLength: MAX_TOOL_SCRIPT_CHARS, description } },
    required: ["script"],
    additionalProperties: false
  };
}

/** The family's shared lines for each description (§32.1). */
export function familyLines(fn: string): string {
  return `The input is a short JavaScript program (await works): call await tools.${fn}(…) and show what you want to see with text(value) (text as is, anything else as JSON); if you never call text(), what you return is shown. An error shows its line.`;
}
