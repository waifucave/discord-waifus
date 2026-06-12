import type { Gateway, ToolChoice } from "@waifucave/gateway";
import type { ReasoningConfig } from "../../shared/schemas/domain.js";

export class GatewayPipelineError extends Error {}

export type SamplingInputs = {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  reasoning?: ReasoningConfig;
  stopSequences?: string[];
};

/** Old config shapes → unified dotted gateway params. Unset stays absent. */
export function buildUnifiedParams(inputs: SamplingInputs): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (inputs.temperature !== undefined) params.temperature = inputs.temperature;
  if (inputs.topP !== undefined) params.topP = inputs.topP;
  if (inputs.maxOutputTokens !== undefined) params.maxOutputTokens = inputs.maxOutputTokens;
  if (inputs.stopSequences !== undefined && inputs.stopSequences.length > 0) params.stopSequences = inputs.stopSequences;
  const reasoning = inputs.reasoning ?? {};
  if (reasoning.effort === "none") {
    params["reasoning.enabled"] = false;
  } else {
    if (reasoning.enabled !== undefined) params["reasoning.enabled"] = reasoning.enabled;
    if (reasoning.effort !== undefined) params["reasoning.effort"] = reasoning.effort;
    if (reasoning.budgetTokens !== undefined) params["reasoning.budgetTokens"] = reasoning.budgetTokens;
  }
  return params;
}

export type PreconformResult = {
  params: Record<string, unknown>;
  toolChoice?: ToolChoice;
  dropped: Array<{ param: string; reason: string }>;
};

// validate() accepts the full ToolChoice value (object included) and derives
// the "named" mode internally — pass it through untouched.

/**
 * Pre-conform an old-shape request against the registry (the sanctioned
 * pattern from MIGRATION_PLAN §11.9: the app conforms via the capability
 * surface; the gateway stays strict). Policy:
 *  - optional value params that violate → dropped (recorded in `dropped`);
 *  - over-long stopSequences → truncated to the descriptor's maxItems;
 *  - a forbidden toolChoice caused by reasoning → reasoning disabled for the
 *    call (decisions NEED their forced tool; reasoning is expendable there);
 *  - anything else still violating → throw (semantics we must not bend).
 */
export function preconformRequest(
  gateway: Gateway,
  providerId: string,
  modelId: string,
  input: { params: Record<string, unknown>; toolChoice?: ToolChoice }
): PreconformResult {
  const model = gateway.getCapabilities(providerId, modelId);
  if (!model) throw new GatewayPipelineError(`Unknown model ${providerId}:${modelId}`);

  const params = { ...input.params };
  const dropped: PreconformResult["dropped"] = [];

  const stop = params.stopSequences;
  const stopDescriptor = model.params["stopSequences"];
  if (Array.isArray(stop) && stopDescriptor?.maxItems !== undefined && stop.length > stopDescriptor.maxItems) {
    params.stopSequences = stop.slice(0, stopDescriptor.maxItems);
    dropped.push({ param: "stopSequences", reason: `truncated to ${stopDescriptor.maxItems}` });
  }

  for (let pass = 0; pass < 4; pass++) {
    const result = gateway.validate(providerId, modelId, {
      params,
      toolChoice: input.toolChoice
    });
    if (result.ok) return { params, toolChoice: input.toolChoice, dropped };

    let changed = false;
    for (const violation of result.violations) {
      if (violation.param === "toolChoice") {
        // Forced tool collides with a reasoning-state rule; the forced tool is
        // the semantic payload of decision calls — disable reasoning instead.
        // Only viable when the model actually HAS a reasoning.enabled param;
        // otherwise (e.g. forced tools unsupported outright) fall through to a
        // clean no-change throw instead of churning the loop.
        if (model.params["reasoning.enabled"] && params["reasoning.enabled"] !== false) {
          params["reasoning.enabled"] = false;
          delete params["reasoning.effort"];
          delete params["reasoning.budgetTokens"];
          dropped.push({ param: "reasoning.enabled", reason: violation.ruleId ?? violation.code });
          changed = true;
        }
        continue;
      }
      if (violation.param in params || violation.param.startsWith("reasoning.")) {
        delete params[violation.param];
        dropped.push({ param: violation.param, reason: violation.code });
        changed = true;
      }
    }
    if (!changed) {
      const detail = result.violations.map((v) => `${v.param}: ${v.code}`).join("; ");
      throw new GatewayPipelineError(`invalid request for ${providerId}:${modelId} — ${detail}`);
    }
  }
  throw new GatewayPipelineError(`pre-conform did not converge for ${providerId}:${modelId}`);
}
