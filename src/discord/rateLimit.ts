export type DiscordRateLimitDecision = {
  shouldRetry: boolean;
  retryAfterMs: number;
  global: boolean;
};

export function parseDiscordRateLimit(
  status: number,
  headers: Headers,
  body?: { retry_after?: number; global?: boolean }
): DiscordRateLimitDecision {
  const headerRetryAfter = headers.get("retry-after");
  const jsonRetryAfter = body?.retry_after;
  const retryAfterSeconds =
    jsonRetryAfter ?? (headerRetryAfter !== null ? Number.parseFloat(headerRetryAfter) : undefined);

  return {
    shouldRetry: status === 429 || retryAfterSeconds !== undefined,
    retryAfterMs: Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds! * 1000) : 0,
    global: body?.global === true || headers.get("x-ratelimit-global") === "true"
  };
}
