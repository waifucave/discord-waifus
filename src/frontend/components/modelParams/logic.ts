// PURE — no React, no fetch. Descriptor→control ordering, route grouping, and
// violation-message mapping for the gateway-backed model params UX (T2/T3/T5 consume).
import type { ParamDescriptor, ResolvedModel } from "@waifucave/gateway";
import type { LlmModelSummary, LlmValidationViolation } from "../../api/llm";

export type ParamControl = {
  key: string;
  descriptor: ParamDescriptor;
  group: "sampling" | "reasoning" | "other";
  unverified: boolean;
};

// These four sampling params surface first (in this order) when present; every other
// sampling-group param follows, alphabetically.
const SAMPLING_PRIORITY: readonly string[] = ["temperature", "topP", "maxOutputTokens", "stopSequences"];
// reasoning.enabled surfaces first within the reasoning group; the rest are alphabetical.
const REASONING_PRIORITY: readonly string[] = ["reasoning.enabled"];

function classifyGroup(key: string): ParamControl["group"] {
  if (key === "reasoning" || key.startsWith("reasoning.")) return "reasoning";
  // Vendor-namespaced extension params (e.g. "google.safetySettings", "minimax.reasoningSplit")
  // aren't generic sampling knobs — bucket them as "other" (rendered under "Advanced").
  if (key.includes(".")) return "other";
  return "sampling";
}

/** Priority keys (in listed order) first, then everything else alphabetically. */
function compareWithPriority(a: string, b: string, priority: readonly string[]): number {
  const pa = priority.indexOf(a);
  const pb = priority.indexOf(b);
  if (pa !== -1 && pb !== -1) return pa - pb;
  if (pa !== -1) return -1;
  if (pb !== -1) return 1;
  return a.localeCompare(b);
}

// Global Constraint (P5 plan): no responseFormat/structured-output control anywhere — an
// anthropic codec gap, out of scope for this migration. Keyed on the param name rather than
// descriptor.type because moonshot's responseFormat descriptor is type:"enum" — indistinguishable
// by shape from a legitimately-renderable enum param.
const EXCLUDED_PARAM_KEYS: ReadonlySet<string> = new Set(["responseFormat"]);

export function buildParamControls(doc: Pick<ResolvedModel, "params">): ParamControl[] {
  const sampling: ParamControl[] = [];
  const reasoning: ParamControl[] = [];
  const other: ParamControl[] = [];
  for (const [key, descriptor] of Object.entries(doc.params)) {
    if (EXCLUDED_PARAM_KEYS.has(key)) continue;
    const group = classifyGroup(key);
    const control: ParamControl = { key, descriptor, group, unverified: descriptor.confidence === "unverified" };
    if (group === "sampling") sampling.push(control);
    else if (group === "reasoning") reasoning.push(control);
    else other.push(control);
  }
  sampling.sort((a, b) => compareWithPriority(a.key, b.key, SAMPLING_PRIORITY));
  reasoning.sort((a, b) => compareWithPriority(a.key, b.key, REASONING_PRIORITY));
  other.sort((a, b) => a.key.localeCompare(b.key));
  return [...sampling, ...reasoning, ...other];
}

/**
 * Clamps a raw form value (string from an <input>, or a number) to the descriptor's [min,max]
 * bounds, rounding to the nearest integer first for `type:"int"` descriptors. Only the bounds
 * actually present on the descriptor are applied — a missing min/max is not enforced. Returns
 * `undefined` for an empty/whitespace-only/unparseable raw value; callers treat `undefined` as
 * "clear the key" (an untouched/cleared control stores no key, never `NaN` or `""`).
 */
export function clampToDescriptor(
  descriptor: Pick<ParamDescriptor, "type" | "min" | "max">,
  raw: string | number
): number | undefined {
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return undefined;
  let value = descriptor.type === "int" ? Math.round(num) : num;
  if (descriptor.min !== undefined) value = Math.max(descriptor.min, value);
  if (descriptor.max !== undefined) value = Math.min(descriptor.max, value);
  return value;
}

/**
 * Appends a trimmed tag to `list`, refusing blank input, duplicates, and anything past
 * `maxItems` (when given). Returns the SAME `list` reference (not a copy) on every no-op path,
 * so callers can skip an `onChange`/re-render by comparing references.
 */
export function addTag(list: string[], raw: string, maxItems?: number): string[] {
  const tag = raw.trim();
  if (!tag) return list;
  if (list.includes(tag)) return list;
  if (maxItems !== undefined && list.length >= maxItems) return list;
  return [...list, tag];
}

/**
 * Human label for a param key: drops any dotted namespace prefix (the group's section header —
 * "Reasoning", "Advanced" — already names it, e.g. "reasoning.enabled" -> "Enabled"), then
 * spaces camelCase into Title Case ("maxOutputTokens" -> "Max Output Tokens").
 */
export function paramLabel(key: string): string {
  const leaf = key.includes(".") ? key.slice(key.lastIndexOf(".") + 1) : key;
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** param -> human message: prefer violation.message; else `${code}${ruleId ? ` (rule ${ruleId})` : ""}`. */
export function violationsByParam(violations: LlmValidationViolation[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const violation of violations) {
    result[violation.param] =
      violation.message ?? `${violation.code}${violation.ruleId ? ` (rule ${violation.ruleId})` : ""}`;
  }
  return result;
}

export type RouteGroup = {
  key: string;
  displayName: string;
  company: string;
  routes: LlmModelSummary[];
};

/**
 * group key = `${company}|${displayName}`; excludes deprecated models; groups sorted by
 * company then displayName; within a group, non-openrouter routes sort before openrouter.
 */
export function groupModelRoutes(models: LlmModelSummary[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>();
  for (const model of models) {
    if (model.deprecated) continue;
    const key = `${model.company}|${model.displayName}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, displayName: model.displayName, company: model.company, routes: [] };
      groups.set(key, group);
    }
    group.routes.push(model);
  }
  const result = Array.from(groups.values());
  for (const group of result) {
    group.routes = [
      ...group.routes.filter((route) => route.providerId !== "openrouter"),
      ...group.routes.filter((route) => route.providerId === "openrouter")
    ];
  }
  result.sort((a, b) => a.company.localeCompare(b.company) || a.displayName.localeCompare(b.displayName));
  return result;
}

/** first non-openrouter route whose providerId is configured; else openrouter route if configured; else first route. */
export function defaultRoute(group: RouteGroup, configuredProviderIds: Set<string>): LlmModelSummary | undefined {
  const nonOpenrouter = group.routes.find(
    (route) => route.providerId !== "openrouter" && configuredProviderIds.has(route.providerId)
  );
  if (nonOpenrouter) return nonOpenrouter;
  const openrouter = group.routes.find(
    (route) => route.providerId === "openrouter" && configuredProviderIds.has(route.providerId)
  );
  if (openrouter) return openrouter;
  return group.routes[0];
}

/** resolves a STORED pair back to its group (for editing an existing config); undefined for unknown ids. */
export function findRoute(
  models: LlmModelSummary[],
  providerId: string,
  modelId: string
): { group: RouteGroup; route: LlmModelSummary } | undefined {
  for (const group of groupModelRoutes(models)) {
    const route = group.routes.find((r) => r.providerId === providerId && r.modelId === modelId);
    if (route) return { group, route };
  }
  return undefined;
}
