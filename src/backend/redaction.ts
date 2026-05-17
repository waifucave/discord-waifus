const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|bearer|bot[_-]?token|client[_-]?secret|password|secret|token)/i;
const DISCORD_TOKEN_PATTERN = /[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,40}/g;
const API_KEY_PATTERN = /\b(?:sk|xai|zai|claude|deepseek|openai)[-_][A-Za-z0-9._-]{16,}\b/gi;

export function redactSecrets<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(DISCORD_TOKEN_PATTERN, "[REDACTED]").replace(API_KEY_PATTERN, "[REDACTED]");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactValue(entry)
      ])
    );
  }
  return value;
}
