// Registry-driven settings forms (Living cast §14.3 Settings, overhaul §11.0): the keys, their
// types, bounds and help come from `GET /api/help/<topic>`; a save sends only the keys that changed
// as one partial `PUT /api/config` patch.

import type { HelpKey } from "../api/types";

export function getPath(record: unknown, path: string): unknown {
  let node: unknown = record;
  for (const segment of path.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** `{ "life.maxSendsPerTurn": 6, "search.maxPerDay": 9 }` → `{ life: { maxSendsPerTurn: 6 }, search: { maxPerDay: 9 } }`. */
export function nestedPatch(changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(changes)) {
    const segments = path.split(".");
    let node = out;
    for (const segment of segments.slice(0, -1)) {
      node[segment] = (node[segment] && typeof node[segment] === "object" ? node[segment] : {}) as Record<string, unknown>;
      node = node[segment] as Record<string, unknown>;
    }
    node[segments[segments.length - 1]!] = value;
  }
  return out;
}

/** The text an input shows for a stored value. */
export function formText(key: HelpKey, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (key.type === "string-list") return Array.isArray(value) ? value.join("\n") : "";
  if (key.type === "json") return JSON.stringify(value, null, 2);
  return String(value);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

/** An input's text as the key's value, checked against its type and bounds. */
export function parseField(key: HelpKey, raw: string): Parsed {
  const text = raw.trim();
  const nullable = key.nullable;
  if (text === "" && key.type !== "string" && key.type !== "string-list") {
    return nullable ? { ok: true, value: null } : { ok: false, error: "A value is needed." };
  }
  switch (key.type) {
    case "boolean":
      return text === "true" || text === "false" ? { ok: true, value: text === "true" } : { ok: false, error: "true or false" };
    case "integer":
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, error: "A number." };
      if (key.type === "integer" && !Number.isInteger(value)) return { ok: false, error: "A whole number." };
      if (key.min !== undefined && value < key.min) return { ok: false, error: `At least ${key.min}.` };
      if (key.max !== undefined && value > key.max) return { ok: false, error: `At most ${key.max}.` };
      return { ok: true, value };
    }
    case "enum":
      return key.enum?.includes(text) ? { ok: true, value: text } : { ok: false, error: `One of ${key.enum?.join(", ")}.` };
    case "string":
      // An optional path or name: empty clears it.
      if (text === "" && nullable) return { ok: true, value: null };
      if (key.maxLength !== undefined && raw.length > key.maxLength) return { ok: false, error: `At most ${key.maxLength} characters.` };
      return { ok: true, value: raw };
    case "string-list":
      return { ok: true, value: raw.split(/[\n,]/u).map((line) => line.trim()).filter(Boolean) };
    case "json":
      try {
        return { ok: true, value: JSON.parse(text) };
      } catch {
        return { ok: false, error: "Valid JSON." };
      }
  }
}

/** The changed keys of a form (by path), or the first error. */
export function formChanges(keys: readonly HelpKey[], config: unknown, drafts: Record<string, string>): { changes: Record<string, unknown>; errors: Record<string, string> } {
  const changes: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const key of keys) {
    const raw = drafts[key.path];
    if (raw === undefined) continue;
    const parsed = parseField(key, raw);
    if (!parsed.ok) {
      errors[key.path] = parsed.error;
      continue;
    }
    if (JSON.stringify(parsed.value ?? null) !== JSON.stringify(getPath(config, key.path) ?? null)) changes[key.path] = parsed.value;
  }
  return { changes, errors };
}
