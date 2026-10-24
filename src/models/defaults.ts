// Curated-catalog defaults (Living cast spec §9.2), free of any winter import so the config schema
// can use them.

/** `models.allowed` default. Routes the installed winter catalog lacks are hidden, not an error. */
export const DEFAULT_ALLOWED_ROUTES: readonly string[] = Object.freeze([
  "meta/muse-spark-1.3-contributor",
  "openrouter/meta/muse-spark-1.3-contributor",
  "anthropic/claude-haiku-5-5",
  "openrouter/anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5-5",
  "openrouter/anthropic/claude-sonnet-5.5",
  "deepseek/deepseek-flash",
  "openrouter/deepseek/deepseek-v4.1-flash",
  "openai/gpt-6-luna",
  "openrouter/openai/gpt-6-luna",
  "openai/gpt-6.1-sol",
  "openrouter/openai/gpt-6.1-sol"
]);

/** `models.maxOutputUsdPerMTok` default (D6: nothing above $10 per million output tokens). */
export const DEFAULT_MAX_OUTPUT_USD_PER_MTOK = 10;
