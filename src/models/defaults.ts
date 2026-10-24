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

export type CuratedFamily = "muse-contributor" | "haiku" | "sonnet" | "deepseek-flash" | "luna" | "sol";

type Route = { readonly providerId: string; readonly modelId: string };

/**
 * Curated model family → its route on the vendor's own API and through OpenRouter (spec §9.2). The
 * models migration maps stored models onto these; the catalog uses the pairs for the OpenRouter
 * reasoning-replay check (a direct route that needs no replay makes its OpenRouter twin safe).
 */
export const CURATED_FAMILY_ROUTES: Readonly<Record<CuratedFamily, { readonly direct: Route; readonly openrouter: Route }>> = Object.freeze({
  "muse-contributor": {
    direct: { providerId: "meta", modelId: "muse-spark-1.3-contributor" },
    openrouter: { providerId: "openrouter", modelId: "meta/muse-spark-1.3-contributor" }
  },
  haiku: {
    direct: { providerId: "anthropic", modelId: "claude-haiku-5-5" },
    openrouter: { providerId: "openrouter", modelId: "anthropic/claude-haiku-5.5" }
  },
  sonnet: {
    direct: { providerId: "anthropic", modelId: "claude-sonnet-5-5" },
    openrouter: { providerId: "openrouter", modelId: "anthropic/claude-sonnet-5.5" }
  },
  "deepseek-flash": {
    direct: { providerId: "deepseek", modelId: "deepseek-flash" },
    openrouter: { providerId: "openrouter", modelId: "deepseek/deepseek-v4.1-flash" }
  },
  luna: {
    direct: { providerId: "openai", modelId: "gpt-6-luna" },
    openrouter: { providerId: "openrouter", modelId: "openai/gpt-6-luna" }
  },
  sol: {
    direct: { providerId: "openai", modelId: "gpt-6.1-sol" },
    openrouter: { providerId: "openrouter", modelId: "openai/gpt-6.1-sol" }
  }
});
