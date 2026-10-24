// winter provider failure → app error kind (Living cast spec §9.1).
//
// - `context_overflow`: the adapter's own `contextOverflow` verdict (never parsed from text).
// - `quota`: a subscription-quota `rate_limit` stream event, `insufficient_quota` / a usage-window
//   code, or (the gateway's rule) a 429 whose code names a quota, an insufficiency or a usage limit.
// - `billing`: winter's own `billing` code (0.0.57: any 402, Anthropic's 400 "credit balance is too
//   low" direct or through OpenRouter, OpenRouter `payment_required`, OpenAI's spend/billing-limit
//   codes, also as mid-stream frames), plus a small fallback for what winter still leaves as
//   `bad_request`/`rate_limit`/`server` (see BILLING_FALLBACK_*). OpenAI `insufficient_quota` is
//   `billing` in winter but stays app `quota` here: the quota check runs first.
// - `rate_limit`, `auth`: winter's own codes.
// - `aborted`: the caller's signal (never retried, never a provider alert).
// - `other`: everything else (server, network, stall, timeout, bad request, capability refusals).

import { normalizeThrown, toSdkAssistantMessageError, type ProviderError } from "@yanlinglabs/winter-provider-runtime";

export type ModelErrorKind = "context_overflow" | "quota" | "billing" | "rate_limit" | "auth" | "aborted" | "other";

/** Provider codes that mean "the account's quota is used up", not "slow down". */
const QUOTA_PROVIDER_CODES = new Set(["insufficient_quota", "usage_limit_reached", "usage_limit_exceeded"]);

// The fallback left from the retired gateway's classifier, for what winter 0.0.57 still does not
// call `billing` (measured against its `normalizeHttpError`, tests/modelCredentialsAndErrors.test.ts):
// the `insufficient_credits` code (a 400 or a retryable 429 in winter), and the "insufficient
// credits/balance/funds" and "requires more credits" phrases on a status other than 402. winter now
// covers `billing_error`, `billing_hard_limit_reached`, `billing_not_active`, `credit_balance_too_low`
// and "credit balance is too low", which left this list. Phrases are matched on winter's message,
// which carries the provider's own error message (`HTTP 400 — <message>` or the stream frame's).
const BILLING_FALLBACK_CODES = new Set(["insufficient_credits"]);
const BILLING_FALLBACK_PHRASES = [/insufficient (credits|balance|funds)/i, /requires more credits/i];

/** True when a failure means the provider account cannot pay. */
export function isBillingFailure(error: ProviderError): boolean {
  if (error.code === "auth" || error.code === "aborted") return false;
  if (error.code === "billing") return true;
  if (toSdkAssistantMessageError(error) === "billing_error") return true;
  // OpenRouter's in-flight-budget 402 (sent with Retry-After) is winter's retryable `rate_limit`.
  if (error.status === 402 && error.code !== "rate_limit") return true;
  if (error.providerCode !== undefined && BILLING_FALLBACK_CODES.has(error.providerCode)) return true;
  return BILLING_FALLBACK_PHRASES.some((phrase) => phrase.test(error.message));
}

/** The gateway's quota code rule: on a 429, a code naming a quota, an insufficiency or a usage limit. */
function isQuotaCodeOn429(error: ProviderError): boolean {
  const code = error.providerCode;
  if (code === undefined || (error.code !== "rate_limit" && error.status !== 429)) return false;
  return code.includes("quota") || code.includes("insufficient") || code.startsWith("usage_limit");
}

const MAX_MESSAGE_CHARS = 400;

export class ModelCallError extends Error {
  override name = "ModelCallError";
  readonly kind: ModelErrorKind;
  /** winter's own code (`server`, `timeout`, …) or an app code (`missing_credentials`, `unknown_model`, …). */
  readonly code: string;
  readonly status?: number;
  readonly providerCode?: string;
  /** winter's verdict AND nothing was committed: a call that produced part of its answer is never retried. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /**
   * Part of the answer (text, a tool call or reasoning) had arrived before the failure. A bare
   * `message_start` or a role-only chunk does not commit a call.
   */
  readonly committed: boolean;
  /** The request was refused for its images (too many, or one past a limit): compaction does not fix it. */
  readonly imageOverflow: boolean;

  constructor(
    kind: ModelErrorKind,
    message: string,
    details: {
      code?: string;
      status?: number;
      providerCode?: string;
      retryable?: boolean;
      retryAfterMs?: number;
      committed?: boolean;
      imageOverflow?: boolean;
    } = {}
  ) {
    super(message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS)}...` : message);
    this.kind = kind;
    this.code = details.code ?? kind;
    if (details.status !== undefined) this.status = details.status;
    if (details.providerCode !== undefined) this.providerCode = details.providerCode;
    this.committed = details.committed === true;
    this.retryable = (details.retryable ?? false) && !this.committed;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    this.imageOverflow = details.imageOverflow === true;
  }
}

/** The app kind for a normalized winter error. `subscriptionQuota`: the stream carried a subscription-quota event. */
export function modelErrorKind(error: ProviderError, o: { subscriptionQuota?: boolean } = {}): ModelErrorKind {
  if (error.contextOverflow === true) return "context_overflow";
  if (error.code === "aborted") return "aborted";
  // Quota before billing: winter files `insufficient_quota` / `usage_limit_*` under billing_error,
  // but they reset with the quota window, so they get the shorter quota cooldown.
  if (error.providerCode !== undefined && QUOTA_PROVIDER_CODES.has(error.providerCode)) return "quota";
  if (error.code === "rate_limit" && o.subscriptionQuota === true) return "quota";
  if (isBillingFailure(error)) return "billing";
  if (isQuotaCodeOn429(error)) return "quota";
  if (error.code === "rate_limit") return "rate_limit";
  if (error.code === "auth") return "auth";
  return "other";
}

export function fromProviderError(error: ProviderError, o: { subscriptionQuota?: boolean; committed?: boolean } = {}): ModelCallError {
  const kind = modelErrorKind(error, o);
  return new ModelCallError(kind, error.message, {
    code: error.code,
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.providerCode !== undefined ? { providerCode: error.providerCode } : {}),
    // A quota or billing failure never clears by retrying (winter may call such a 429 retryable).
    retryable: error.retryable && kind !== "billing" && kind !== "quota",
    ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    committed: o.committed === true,
    imageOverflow: error.imageOverflow === true
  });
}

/** Anything thrown on the call path → a ModelCallError (bounded message, no raw bodies). */
export function toModelCallError(error: unknown, o: { subscriptionQuota?: boolean; committed?: boolean } = {}): ModelCallError {
  if (error instanceof ModelCallError) return error;
  return fromProviderError(normalizeThrown(error), o);
}

/** True for a context-overflow failure (also when wrapped as a cause). */
export function isContextOverflowError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  if ((error as { kind?: unknown }).kind === "context_overflow") return true;
  return isContextOverflowError((error as { cause?: unknown }).cause, depth + 1);
}
