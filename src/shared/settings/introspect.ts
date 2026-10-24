// Reading the registry's schemas (overhaul spec §10.2): leaf walking, key types and bounds, defaults,
// and turning a command-line string into a value. Works on zod 4's schema definitions; a leaf's
// type comes from its input side (a transform's or a preprocess's output enum where that is all
// there is).

import type { z } from "zod";
import { SETTING_GROUPS, settingGroup } from "./registry.js";
import type { KeyInfo, SettingGroup } from "./types.js";

type Def = { type: string; [key: string]: unknown };
type Node = { _zod: { def: Def; bag?: Record<string, unknown> } };

const WRAPPERS = new Set(["default", "optional", "nullable", "prefault", "readonly", "catch", "nonoptional"]);

function def(schema: unknown): Def {
  return (schema as Node)._zod.def;
}

/** The schema under its wrappers (default, optional, nullable, pipes). */
function unwrap(schema: unknown): { node: unknown; nullable: boolean; defaultValue?: unknown } {
  let node = schema;
  let nullable = false;
  let defaultValue: unknown;
  for (let guard = 0; guard < 20; guard += 1) {
    const d = def(node);
    if (d.type === "nullable") nullable = true;
    if (d.type === "default" && defaultValue === undefined) {
      const raw = d["defaultValue"];
      defaultValue = typeof raw === "function" ? (raw as () => unknown)() : raw;
    }
    if (WRAPPERS.has(d.type)) {
      node = d["innerType"];
      continue;
    }
    if (d.type === "pipe") {
      // A preprocess (transform → schema) is described by its output; a transform after a schema by its input.
      const input = d["in"];
      node = def(input).type === "transform" ? d["out"] : input;
      continue;
    }
    break;
  }
  return { node, nullable, ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

/** A union of `null` and one schema reads as that schema, nullable. */
function settle(schema: unknown): { node: unknown; nullable: boolean } {
  let { node, nullable } = unwrap(schema);
  const d = def(node);
  if (d.type === "union") {
    const options = (d["options"] as unknown[]).filter((option) => def(unwrap(option).node).type !== "null");
    if (options.length < (d["options"] as unknown[]).length) nullable = true;
    if (options.length === 1) {
      const inner = settle(options[0]);
      return { node: inner.node, nullable: nullable || inner.nullable };
    }
  }
  return { node, nullable };
}

/** The schema at a dotted path, or undefined. */
export function schemaAt(root: z.ZodType, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split(".")) {
    const { node: inner } = settle(node);
    const d = def(inner);
    if (d.type !== "object") return undefined;
    const shape = d["shape"] as Record<string, unknown>;
    if (!(segment in shape)) return undefined;
    node = shape[segment];
  }
  return node;
}

/**
 * Every leaf of a group's schema: non-object nodes, and objects the registry marks as leaves. Paths
 * the group excludes are skipped (with everything under them).
 */
export function schemaLeaves(group: SettingGroup): string[] {
  const out: string[] = [];
  const walk = (schema: unknown, prefix: string) => {
    if (prefix && prefix in group.excluded) return;
    if (prefix && group.keys[prefix]?.leaf) {
      out.push(prefix);
      return;
    }
    const { node } = settle(schema);
    const d = def(node);
    if (d.type === "object") {
      for (const [key, child] of Object.entries(d["shape"] as Record<string, unknown>)) walk(child, prefix ? `${prefix}.${key}` : key);
      return;
    }
    if (prefix) out.push(prefix);
  };
  walk(group.schema, "");
  return out;
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export { getPath };

/** `{a: {b: value}}` for `a.b`. */
export function nestedPatch(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  let out: unknown = value;
  for (const segment of segments.reverse()) out = { [segment]: out };
  return out as Record<string, unknown>;
}

/** Deep-merges plain objects (arrays and leaves replace). */
export function mergePatches(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = out[key];
    out[key] =
      current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)
        ? mergePatches(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

function describeLeaf(schema: unknown): Pick<KeyInfo, "type" | "enum" | "min" | "max" | "maxLength" | "nullable"> {
  const { node, nullable } = settle(schema);
  const d = def(node);
  const bag = (node as Node)._zod.bag ?? {};
  switch (d.type) {
    case "boolean":
      return { type: "boolean", nullable };
    case "number": {
      const min = typeof bag["minimum"] === "number" ? (bag["minimum"] as number) : typeof bag["exclusiveMinimum"] === "number" ? (bag["exclusiveMinimum"] as number) : undefined;
      const max = typeof bag["maximum"] === "number" ? (bag["maximum"] as number) : undefined;
      const integer = bag["format"] === "safeint" || bag["format"] === "int32";
      return { type: integer ? "integer" : "number", nullable, ...(min !== undefined && Number.isFinite(min) && Math.abs(min) < 1e15 ? { min } : {}), ...(max !== undefined && Number.isFinite(max) && Math.abs(max) < 1e15 ? { max } : {}) };
    }
    case "string":
      return { type: "string", nullable, ...(typeof bag["maxLength"] === "number" ? { maxLength: bag["maxLength"] as number } : {}) };
    case "enum":
      return { type: "enum", nullable, enum: Object.values(d["entries"] as Record<string, string>).map(String) };
    case "literal":
      return { type: "string", nullable };
    case "union": {
      // A union of strings and literals (the detector target, the web-fetch model) is a string.
      const kinds = (d["options"] as unknown[]).map((option) => def(settle(option).node).type);
      if (kinds.every((kind) => kind === "string" || kind === "literal")) return { type: "string", nullable };
      return { type: "json", nullable };
    }
    case "array": {
      const element = def(settle(d["element"]).node).type;
      return { type: element === "string" ? "string-list" : "json", nullable };
    }
    default:
      return { type: "json", nullable };
  }
}

/** A leaf with no default, not optional and not nullable (an id or a name every record must carry). */
function requiredLeaf(schema: unknown): boolean {
  let node = schema;
  for (let guard = 0; guard < 20; guard += 1) {
    const d = def(node);
    if (d.type === "default" || d.type === "optional" || d.type === "nullable") return false;
    if (!WRAPPERS.has(d.type)) return true;
    node = d["innerType"];
  }
  return true;
}

export function keyInfo(group: SettingGroup, path: string): KeyInfo | undefined {
  const help = group.keys[path];
  const schema = schemaAt(group.schema, path);
  if (!help || !schema) return undefined;
  const { help: text, example, unit, ...flags } = help;
  // A record's defaults are parsed from a seed (an example id and name): its required fields have none.
  const seeded = group.target.kind === "id" && (flags.readOnly === true || requiredLeaf(schema));
  const defaults = seeded ? undefined : group.defaults?.();
  const fallback = defaults !== undefined ? getPath(defaults, path) : undefined;
  return {
    group: group.id,
    path,
    id: `${group.id}.${path}`,
    ...describeLeaf(schema),
    ...(fallback !== undefined ? { default: fallback } : {}),
    help: text,
    flags,
    ...(example !== undefined ? { example } : {}),
    ...(unit !== undefined ? { unit } : {})
  };
}

const infoCache = new Map<string, KeyInfo[]>();

/** Every key of a group, in registry order. */
export function groupKeyInfos(group: SettingGroup): KeyInfo[] {
  const cached = infoCache.get(group.id);
  if (cached) return cached;
  const infos = Object.keys(group.keys).flatMap((path) => {
    const info = keyInfo(group, path);
    return info ? [info] : [];
  });
  infoCache.set(group.id, infos);
  return infos;
}

export function allKeyInfos(): KeyInfo[] {
  return SETTING_GROUPS.flatMap(groupKeyInfos);
}

/** A key by its full id (`app.life.maxSendsPerTurn`), or the app shorthand (`life.maxSendsPerTurn`). */
export function findKey(id: string): KeyInfo | undefined {
  for (const group of SETTING_GROUPS) {
    if (id.startsWith(`${group.id}.`)) {
      const info = groupKeyInfos(group).find((candidate) => candidate.path === id.slice(group.id.length + 1));
      if (info) return info;
    }
  }
  return groupKeyInfos(settingGroup("app")!).find((candidate) => candidate.path === id);
}

const TRUE = new Set(["true", "yes", "on", "1"]);
const FALSE = new Set(["false", "no", "off", "0"]);

/** `provider/model[@effort]`, or JSON: a model choice. */
function parseModelChoice(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const [route, effort] = trimmed.split("@");
  const slash = route!.indexOf("/");
  if (slash <= 0 || slash === route!.length - 1) throw new Error("use provider/model, like anthropic/claude-haiku-5-5 (add @effort for an effort)");
  return { providerId: route!.slice(0, slash), modelId: route!.slice(slash + 1), ...(effort ? { effort } : {}) };
}

export type Coerced = { ok: true; value: unknown } | { ok: false; error: string };

/** A command-line string as a value for this key (then validated by the schema). */
export function coerceValue(info: KeyInfo, raw: string): Coerced {
  const text = raw.trim();
  if (text === "null") {
    if (info.nullable || info.flags.nullUnset || info.flags.nullIsValue) return { ok: true, value: null };
    return { ok: false, error: `${info.id} cannot be null` };
  }
  try {
    switch (info.type) {
      case "boolean":
        if (TRUE.has(text.toLowerCase())) return { ok: true, value: true };
        if (FALSE.has(text.toLowerCase())) return { ok: true, value: false };
        return { ok: false, error: `${info.id} is true or false` };
      case "integer":
      case "number": {
        const value = Number(text);
        if (!text || !Number.isFinite(value)) return { ok: false, error: `${info.id} is a number` };
        if (info.type === "integer" && !Number.isInteger(value)) return { ok: false, error: `${info.id} is a whole number` };
        if (info.min !== undefined && value < info.min) return { ok: false, error: `${info.id} is at least ${info.min}` };
        if (info.max !== undefined && value > info.max) return { ok: false, error: `${info.id} is at most ${info.max}` };
        return { ok: true, value };
      }
      case "enum": {
        if (info.enum?.includes(text)) return { ok: true, value: text };
        const near = info.enum?.filter((option) => option.startsWith(text.slice(0, 2))) ?? [];
        return { ok: false, error: `${info.id} is one of ${info.enum?.join(", ")}${near.length ? ` (did you mean ${near.join(" or ")}?)` : ""}` };
      }
      case "string-list":
        return { ok: true, value: text.startsWith("[") ? JSON.parse(text) : text ? text.split(",").map((part) => part.trim()).filter(Boolean) : [] };
      case "string":
        if (info.maxLength !== undefined && raw.length > info.maxLength) return { ok: false, error: `${info.id} is at most ${info.maxLength} characters` };
        return { ok: true, value: raw };
      case "json":
        if (info.path === "model") return { ok: true, value: parseModelChoice(text) };
        if (info.id === "channel.enabledWaifuIds") return { ok: true, value: text.startsWith("[") ? JSON.parse(text) : text.split(",").map((part) => part.trim()).filter(Boolean) };
        return { ok: true, value: JSON.parse(text) };
    }
  } catch (error) {
    return { ok: false, error: `${info.id}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A short type label for help (`integer 1–30`, `enum terse|chatty|expressive`). */
export function typeLabel(info: KeyInfo): string {
  const range = info.min !== undefined || info.max !== undefined ? ` ${info.min ?? ""}–${info.max ?? ""}` : "";
  const base =
    info.type === "enum"
      ? `one of ${info.enum?.join(" | ")}`
      : info.type === "string-list"
        ? "list of strings"
        : info.type === "json"
          ? "JSON"
          : `${info.type}${range}`;
  const length = info.maxLength !== undefined ? ` (≤ ${info.maxLength} chars)` : "";
  return `${base}${length}${info.nullable || info.flags.nullIsValue ? " or null" : ""}${info.unit ? ` [${info.unit}]` : ""}`;
}
