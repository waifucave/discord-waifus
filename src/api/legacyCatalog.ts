/**
 * legacyCatalog.ts — synthesises the legacy ModelCapabilityMetadata / ProviderMetadata shapes
 * from the @waifucave/gateway registry so that /api/models and /api/providers can drop the
 * last hard-coded catalog.ts dependency (Task 4, Gateway P3b cutover).
 *
 * Coverage: the six native provider ids only (xai, deepseek, anthropic, openai, zai,
 * google-ai-studio).  openrouter routes and deprecated models are excluded.
 * Synthesis is cached at module level — the registry is static at runtime.
 */

import { PROVIDERS } from "@waifucave/gateway";
import type { ModelCapabilityMetadata, ProviderMetadata } from "../providers/types.js";
import { sharedRegistry } from "../orchestration/pipeline/resolveTarget.js";

const LEGACY_PROVIDER_IDS = ["xai", "deepseek", "anthropic", "openai", "zai", "google-ai-studio"] as const;

/** Static docsUrls preserved from the old catalog. */
const DOCS_URLS: Record<string, string> = {
  xai: "https://docs.x.ai/developers/models",
  deepseek: "https://api-docs.deepseek.com/api/create-chat-completion",
  anthropic: "https://platform.claude.com/docs/en/about-claude/models/overview",
  openai: "https://developers.openai.com/api/docs/models",
  zai: "https://docs.z.ai/guides/overview/migrate-to-glm-new",
  "google-ai-studio": "https://ai.google.dev/gemini-api/docs"
};

function wireToClient(
  wire: string
): "openai-compatible-chat" | "openai-responses" | "anthropic-messages" | "google-generative-language" {
  switch (wire) {
    case "openai-chat":
      return "openai-compatible-chat";
    case "openai-responses":
      return "openai-responses";
    case "anthropic-messages":
      return "anthropic-messages";
    case "google-generative-language":
      return "google-generative-language";
    default:
      return "openai-compatible-chat";
  }
}

function wireToSupportedRoles(wire: string): ModelCapabilityMetadata["supportedRoles"] {
  if (wire === "anthropic-messages") {
    return ["user", "assistant"];
  }
  if (wire === "google-generative-language") {
    return ["user", "model"];
  }
  // openai-chat and openai-responses
  return ["system", "user", "assistant", "tool"];
}

/**
 * Converts "reasoning.budgetTokens" (registry canonical name) to the legacy
 * snake_case key the frontend / API consumers expect.
 */
function mapReasoningKey(key: string): string {
  return key === "reasoning.budgetTokens" ? "reasoning.budget_tokens" : key;
}

// ── module-level cache ──────────────────────────────────────────────────────

let _models: ModelCapabilityMetadata[] | undefined;
let _providers: ProviderMetadata[] | undefined;

export function legacyModels(): ModelCapabilityMetadata[] {
  if (_models) return _models;

  const reg = sharedRegistry();
  const result: ModelCapabilityMetadata[] = [];

  for (const ref of reg.listModels()) {
    if (!LEGACY_PROVIDER_IDS.includes(ref.providerId as (typeof LEGACY_PROVIDER_IDS)[number])) continue;

    const r = reg.resolve(ref.providerId, ref.modelId);
    if (!r || r.meta.deprecated === true) continue;

    const reasoningControls = Object.keys(r.params)
      .filter((k) => k.startsWith("reasoning."))
      .map(mapReasoningKey);

    const maxContextTokens = r.limits.contextTokens > 0 ? r.limits.contextTokens : undefined;
    const maxOutputTokens = r.limits.maxOutputTokens > 0 ? r.limits.maxOutputTokens : undefined;

    const tempParam = r.params["temperature"];
    const topPParam = r.params["topP"];
    const defaultTemperature = tempParam?.default !== undefined ? (tempParam.default as number) : undefined;
    const defaultTopP = topPParam?.default !== undefined ? (topPParam.default as number) : undefined;

    const model: ModelCapabilityMetadata = {
      providerId: r.providerId as ModelCapabilityMetadata["providerId"],
      modelId: r.modelId,
      displayName: r.displayName,
      endpoint: r.endpoint,
      client: wireToClient(r.wire),
      supportedRoles: wireToSupportedRoles(r.wire),
      supportsTools: r.features.tools.supported ?? false,
      supportsStructuredOutput:
        (r.features.structuredOutput.jsonMode || r.features.structuredOutput.jsonSchema) ?? false,
      supportsStreaming: r.features.streaming ?? false,
      supportsImageInput: r.modalities.input.includes("image"),
      reasoningControls,
      safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
    };

    if (maxContextTokens !== undefined) model.maxContextTokens = maxContextTokens;
    if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
    if (defaultTemperature !== undefined) model.defaultTemperature = defaultTemperature;
    if (defaultTopP !== undefined) model.defaultTopP = defaultTopP;

    result.push(model);
  }

  _models = result;
  return _models;
}

export function legacyProviders(): ProviderMetadata[] {
  if (_providers) return _providers;

  const allModels = legacyModels();

  const result: ProviderMetadata[] = LEGACY_PROVIDER_IDS.map((id) => {
    const gwProvider = PROVIDERS.find((p) => p.id === id);
    const models = allModels.filter((m) => m.providerId === id);

    return {
      id: id as ProviderMetadata["id"],
      displayName: gwProvider?.displayName ?? id,
      credentialName: gwProvider?.credentialEnv ?? "",
      baseUrl: gwProvider?.baseUrl ?? "",
      docsUrl: DOCS_URLS[id] ?? "",
      models
    };
  });

  _providers = result;
  return _providers;
}
