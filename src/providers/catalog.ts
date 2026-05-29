import { ModelCapabilityMetadata, ProviderMetadata } from "./types.js";

const openAiCompatibleRoles = ["system", "developer", "user", "assistant", "tool"] as const;
const anthropicRoles = ["user", "assistant", "tool"] as const;

export const PROVIDER_CATALOG: ProviderMetadata[] = [
  {
    id: "xai",
    displayName: "x.ai",
    credentialName: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/developers/models",
    models: [
      xaiModel("grok-4.3", "Grok 4.3", ["reasoning.effort"], true),
      xaiModel("grok-4.20-0309-reasoning", "Grok 4.20 Reasoning", [], true),
      xaiModel("grok-4.20-0309-non-reasoning", "Grok 4.20 Non-Reasoning", [], true),
      xaiModel("grok-4.20-multi-agent-0309", "Grok 4.20 Multi-Agent", ["agent_count"], true),
      xaiModel("grok-4-1-fast-reasoning", "Grok 4.1 Fast Reasoning", [], true),
      xaiModel("grok-4-1-fast-non-reasoning", "Grok 4.1 Fast Non-Reasoning", [], true)
    ]
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    credentialName: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/api/create-chat-completion",
    models: [
      deepSeekModel("deepseek-v4-flash", "DeepSeek V4 Flash", false),
      deepSeekModel("deepseek-v4-pro", "DeepSeek V4 Pro", false)
    ]
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    credentialName: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    models: [
      anthropicModel("claude-opus-4-7", "Claude Opus 4.7", ["reasoning.effort"], true),
      anthropicModel("claude-sonnet-4-6", "Claude Sonnet 4.6", ["reasoning.enabled", "reasoning.effort"], true),
      anthropicModel("claude-haiku-4-5-20251001", "Claude Haiku 4.5", ["reasoning.enabled", "reasoning.budget_tokens"], true)
    ]
  },
  {
    id: "openai",
    displayName: "OpenAI",
    credentialName: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://developers.openai.com/api/docs/models",
    models: [
      openAiModel("gpt-5.5", "GPT-5.5", ["reasoning.effort"], true),
      openAiModel("gpt-5.4", "GPT-5.4", ["reasoning.effort"], true),
      openAiModel("gpt-5.4-mini", "GPT-5.4 Mini", ["reasoning.effort"], true),
      openAiModel("gpt-5.4-nano", "GPT-5.4 Nano", ["reasoning.effort"], true),
      openAiModel("gpt-4o", "GPT-4o", [], true),
      openAiModel("gpt-4o-mini", "GPT-4o mini", [], true)
    ]
  },
  {
    id: "zai",
    displayName: "Z.AI",
    credentialName: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    docsUrl: "https://docs.z.ai/guides/overview/migrate-to-glm-new",
    models: [
      zaiModel("glm-4.7", "GLM 4.7", true),
      zaiModel("glm-5", "GLM 5", true),
      zaiModel("glm-5-turbo", "GLM 5 Turbo", true),
      zaiModel("glm-5.1", "GLM 5.1", true)
    ]
  }
];

export function listProviders(): ProviderMetadata[] {
  return structuredClone(PROVIDER_CATALOG);
}

export function listModels(): ModelCapabilityMetadata[] {
  return PROVIDER_CATALOG.flatMap((provider) => provider.models.map((model) => ({ ...model })));
}

export function getModel(modelId: string): ModelCapabilityMetadata | undefined {
  return listModels().find((model) => model.modelId === modelId);
}

export function getProviderForModel(modelId: string): ProviderMetadata | undefined {
  return listProviders().find((provider) => provider.models.some((model) => model.modelId === modelId));
}

function xaiModel(
  modelId: string,
  displayName: string,
  reasoningControls: string[],
  supportsImageInput: boolean
): ModelCapabilityMetadata {
  return {
    providerId: "xai",
    modelId,
    displayName,
    endpoint: "/chat/completions",
    client: "openai-compatible-chat",
    supportedRoles: [...openAiCompatibleRoles],
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    supportsImageInput,
    reasoningControls,
    defaultTemperature: 0.7,
    defaultTopP: 1,
    safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
  };
}

function deepSeekModel(
  modelId: string,
  displayName: string,
  supportsImageInput: boolean
): ModelCapabilityMetadata {
  return {
    providerId: "deepseek",
    modelId,
    displayName,
    endpoint: "/chat/completions",
    client: "openai-compatible-chat",
    supportedRoles: [...openAiCompatibleRoles],
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    supportsImageInput,
    reasoningControls: ["reasoning.enabled", "reasoning.effort"],
    defaultTemperature: 0.7,
    defaultTopP: 1,
    safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
  };
}

function anthropicModel(
  modelId: string,
  displayName: string,
  reasoningControls: string[],
  supportsImageInput: boolean
): ModelCapabilityMetadata {
  return {
    providerId: "anthropic",
    modelId,
    displayName,
    endpoint: "/v1/messages",
    client: "anthropic-messages",
    supportedRoles: [...anthropicRoles],
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    supportsImageInput,
    reasoningControls,
    defaultTemperature: 0.7,
    defaultTopP: 1,
    safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
  };
}

function openAiModel(
  modelId: string,
  displayName: string,
  reasoningControls: string[],
  supportsImageInput: boolean
): ModelCapabilityMetadata {
  return {
    providerId: "openai",
    modelId,
    displayName,
    endpoint: "/responses",
    client: "openai-responses",
    supportedRoles: [...openAiCompatibleRoles],
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    supportsImageInput,
    reasoningControls,
    defaultTemperature: 0.7,
    defaultTopP: 1,
    safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
  };
}

function zaiModel(
  modelId: string,
  displayName: string,
  supportsImageInput: boolean
): ModelCapabilityMetadata {
  return {
    providerId: "zai",
    modelId,
    displayName,
    endpoint: "/chat/completions",
    client: "openai-compatible-chat",
    supportedRoles: [...openAiCompatibleRoles],
    supportsTools: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    supportsImageInput,
    reasoningControls: ["reasoning.enabled"],
    defaultTemperature: 0.7,
    defaultTopP: 1,
    safeDefaultRoles: ["orchestrator", "waifu", "stage_manager"]
  };
}
