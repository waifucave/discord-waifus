// Gateway P4 Task 4: provider ids widen from the legacy 6-value enum (src/api/legacyCatalog.ts
// stays scoped to those six BY DESIGN — see the comment at its top) to any id the gateway
// registry knows. Storage writes that name a provider/model now get validated against the live
// registry instead of failing later at chat time:
//   - unknown provider id (credentials PUT)                      -> 400 unknown_provider
//   - unknown (providerId, modelId) pair (waifu/agent config)    -> 400 unknown_model
//   - params the model's registry descriptor forbids             -> 400 unsupported_parameter
import { createGateway, PROVIDERS } from "@waifucave/gateway";
import { badRequest } from "./errors.js";
import { resolveModelTarget, type ModelTarget } from "../orchestration/pipeline/resolveTarget.js";

const KNOWN_PROVIDER_IDS = new Set(PROVIDERS.map((provider) => provider.id));

/** Validation needs no provider credentials — it never makes a network call. */
const validationGateway = createGateway({ credentials: () => undefined });

export function assertKnownProvider(providerId: string): void {
  if (!KNOWN_PROVIDER_IDS.has(providerId)) {
    throw badRequest(`Unknown provider: ${providerId}`, { error: "unknown_provider", providerId });
  }
}

/** Resolves + asserts (providerId, modelId) is a real gateway route; 400s otherwise. */
export function assertKnownModel(providerId: string | undefined, modelId: string): ModelTarget {
  try {
    return resolveModelTarget({ providerId, modelId });
  } catch {
    throw badRequest(`Unknown model: ${modelId}`, { error: "unknown_model", providerId, modelId });
  }
}

export function assertParamsValid(
  providerId: string,
  modelId: string,
  params: Record<string, unknown>
): void {
  const result = validationGateway.validate(providerId, modelId, { params });
  if (!result.ok) {
    throw badRequest(`Unsupported parameters for ${providerId}:${modelId}`, {
      error: "unsupported_parameter",
      violations: result.violations.map((violation) => ({
        param: violation.param,
        code: violation.code,
        rule: violation.ruleId
      }))
    });
  }
}

/** Runs the full write-time check when a (possibly updated) config carries a modelId. */
export function assertModelWriteValid(
  providerId: string | undefined,
  modelId: string | undefined,
  params: Record<string, unknown>
): void {
  if (!modelId) return;
  const target = assertKnownModel(providerId, modelId);
  assertParamsValid(target.providerId, target.modelId, params);
}
