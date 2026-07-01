// src/shared/paramsCompat.ts
//
// Pure-function conversion between legacy config shapes (reasoning/generation
// objects, as stored on disk pre-gateway) and unified gateway dotted params
// (Record<string, unknown>). Used by storage/domain migration code, which
// reads raw JSON — no zod validation here, only loose shape guards.
//
// legacyToParams MUST mirror buildUnifiedParams in
// src/orchestration/pipeline/params.ts exactly, including the
// effort === "none" special case (drops effort/budgetTokens, keeping only
// "reasoning.enabled": false).

export type LegacyReasoning = { enabled?: boolean; effort?: string; budgetTokens?: number };
export type LegacyGeneration = { temperature?: number; topP?: number; maxOutputTokens?: number };

/** Dotted param keys that a legacy `reasoning`/`generation` body can express. When both a
 * native `params` body and a legacy body are present, these keys are legacy-authoritative —
 * see resolveParamsPatch in src/api/server.ts. */
export const LEGACY_REPRESENTABLE_PARAM_KEYS = [
  "temperature",
  "topP",
  "maxOutputTokens",
  "reasoning.enabled",
  "reasoning.effort",
  "reasoning.budgetTokens"
] as const;

/** Legacy config shapes → unified dotted gateway params. Unset stays absent. */
export function legacyToParams(input: { reasoning?: LegacyReasoning; generation?: LegacyGeneration }): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  const generation = input.generation ?? {};
  if (generation.temperature !== undefined) params.temperature = generation.temperature;
  if (generation.topP !== undefined) params.topP = generation.topP;
  if (generation.maxOutputTokens !== undefined) params.maxOutputTokens = generation.maxOutputTokens;

  const reasoning = input.reasoning ?? {};
  if (reasoning.effort === "none") {
    params["reasoning.enabled"] = false;
  } else {
    if (reasoning.enabled !== undefined) params["reasoning.enabled"] = reasoning.enabled;
    if (reasoning.effort !== undefined) params["reasoning.effort"] = reasoning.effort;
    if (reasoning.budgetTokens !== undefined) params["reasoning.budgetTokens"] = reasoning.budgetTokens;
  }

  return params;
}

/** Unified dotted gateway params → legacy config shapes. Unknown/mistyped keys are ignored. */
export function paramsToLegacy(params: Record<string, unknown>): { reasoning: LegacyReasoning; generation: LegacyGeneration } {
  const reasoning: LegacyReasoning = {};
  const generation: LegacyGeneration = {};

  if (typeof params.temperature === "number") generation.temperature = params.temperature;
  if (typeof params.topP === "number") generation.topP = params.topP;
  if (typeof params.maxOutputTokens === "number") generation.maxOutputTokens = params.maxOutputTokens;

  if (typeof params["reasoning.enabled"] === "boolean") reasoning.enabled = params["reasoning.enabled"];
  if (typeof params["reasoning.effort"] === "string") reasoning.effort = params["reasoning.effort"];
  if (typeof params["reasoning.budgetTokens"] === "number") reasoning.budgetTokens = params["reasoning.budgetTokens"];

  return { reasoning, generation };
}
