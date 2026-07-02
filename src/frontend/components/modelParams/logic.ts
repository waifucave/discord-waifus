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

export function buildParamControls(doc: Pick<ResolvedModel, "params">): ParamControl[] {
  const sampling: ParamControl[] = [];
  const reasoning: ParamControl[] = [];
  const other: ParamControl[] = [];
  for (const [key, descriptor] of Object.entries(doc.params)) {
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
