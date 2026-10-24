// winter provider failure → app error kind (Living cast spec §9.1).
//
// - `context_overflow`: the adapter's own `contextOverflow` verdict (never parsed from text).
// - `quota`: a subscription-quota `rate_limit` stream event, or `insufficient_quota` / a usage-window
//   code on a 429.
// - `billing`: what winter itself classifies as `billing_error` (402, billing codes).
// - `rate_limit`, `auth`: winter's own codes.
// - `aborted`: the caller's signal (never retried, never a provider alert).
// - `other`: everything else (server, network, stall, timeout, bad request, capability refusals).

import { normalizeThrown, toSdkAssistantMessageError, type ProviderError } from "@yanlinglabs/winter-provider-runtime";

export type ModelErrorKind = "context_overflow" | "quota" | "billing" | "rate_limit" | "auth" | "aborted" | "other";

/** Provider codes that mean "the account's quota is used up", not "slow down". */
const QUOTA_PROVIDER_CODES = new Set(["insufficient_quota", "usage_limit_reached", "usage_limit_exceeded"]);

const MAX_MESSAGE_CHARS = 400;

export class ModelCallError extends Error {
  override name = "ModelCallError";
  readonly kind: ModelErrorKind;
  /** winter's own code (`server`, `timeout`, …) or an app code (`missing_credentials`, `unknown_model`, …). */
  readonly code: string;
  readonly status?: number;
  readonly providerCode?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    kind: ModelErrorKind,
    message: string,
    details: { code?: string; status?: number; providerCode?: string; retryable?: boolean; retryAfterMs?: number } = {}
  ) {
    super(message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}...` : message);
    this.kind = kind;
    this.code = details.code ?? kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
    this.retryable = details.retryable ?? false;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

/** The app kind for a normalized winter error. `subscriptionQuota`: the stream carried a subscription-quota event. */
export function modelErrorKind(error: ProviderError, o: { subscriptionQuota?: boolean } = {}): ModelErrorKind {
  if (error.contextOverflow === true) return "context_overflow";
  if (error.code === "aborted") return "aborted";
  if (error.providerCode !== undefined && QUOTA_PROVIDER_CODES.has(error.providerCode)) return "quota";
  if (error.code === "rate_limit" && o.subscriptionQuota === true) return "quota";
  if (toSdkAssistantMessageError(error) === "billing_error" || error.providerCode === "billing_error") return "billing";
  if (error.code === "rate_limit") return "rate_limit";
  if (error.code === "auth") return "auth";
  return "other";
}

export function fromProviderError(error: ProviderError, o: { subscriptionQuota?: boolean } = {}): ModelCallError {
  return new ModelCallError(modelErrorKind(error, o), error.message, {
    code: error.code,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    retryable: error.retryable,
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {})
  });
}

/** Anything thrown on the call path → a ModelCallError (bounded message, no raw bodies). */
export function toModelCallError(error: unknown, o: { subscriptionQuota?: boolean } = {}): ModelCallError {
  if (error instanceof ModelCallError) return error;
  return fromProviderError(normalizeThrown(error), o);
}

/** True for a context-overflow failure (also when wrapped as a cause). */
export function isContextOverflowError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  if ((error as { kind?: unknown }).kind === "context_overflow") return true;
  return isContextOverflowError((error as { cause?: unknown }).cause, depth + 1);
}
