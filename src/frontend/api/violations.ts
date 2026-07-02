import { ApiError } from "./client";

export type SaveErrorViolation = { param: string; code: string; rule?: string };

/**
 * Pulls write-validation violations (`{param, code, rule?}`) out of a caught save error, when
 * present. `ApiError.body.details` is `unknown` on the wire — populated for `unsupported_parameter`
 * (`{error, violations}`), absent for `unknown_model` (just `{error, providerId, modelId}`) and for
 * `ConflictError` (`{error, message, latest}`, no `details` at all) — so this returns `undefined`
 * for anything that isn't a violations-bearing `ApiError`.
 */
export function violationsFromApiError(err: unknown): SaveErrorViolation[] | undefined {
  if (!(err instanceof ApiError)) return undefined;
  const details = err.body.details as { violations?: SaveErrorViolation[] } | undefined;
  return details?.violations;
}
