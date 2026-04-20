import type {
  ChannelConfig,
  OrchestratorConfig,
  ProviderConfig,
  StageManagerConfig,
  WaifuConfig
} from "../types/index.js";
import type { DefaultsStore } from "./defaults-store.js";
import { hasResolvedNonEmptyValue, isUnsetModelValue, resolveEnvString } from "./env-utils.js";
import type { InvalidLocalDocument, LocalRuntimeStore } from "./local-runtime-store.js";
import type {
  AppSettingsToml,
  LocalChannelConfig,
  LocalProviderDefinition,
  OrchestratorToml,
  ProviderCatalogFile,
  StageManagerToml,
  WaifuDocument
} from "../types/index.js";

export interface ProviderEditorEntry extends LocalProviderDefinition {
  keyValue: string;
  hasKey: boolean;
  isBuiltIn: boolean;
  canDelete: boolean;
  isRuntimeCallable: boolean;
  runtimeErrors: string[];
}

export interface ConfigReadiness<T> {
  value: T;
  isReady: boolean;
  runtimeErrors: string[];
}

export interface WaifuDocumentMeta {
  isDraft: boolean;
  isDiscordReady: boolean;
  isAiReady: boolean;
  isChatReady: boolean;
  isRuntimeReady: boolean;
  runtimeValidationErrors: string[];
}

export interface ComposedWaifuDocument {
  waifu: WaifuDocument;
  meta: WaifuDocumentMeta;
}

export interface ComposedRuntimeConfig {
  appSettings: AppSettingsToml;
  providerCatalog: ProviderCatalogFile;
  providerEditorEntries: ProviderEditorEntry[];
  runtimeProviders: ProviderConfig[];
  channels: LocalChannelConfig[];
  runtimeChannels: ChannelConfig[];
  orchestrator: ConfigReadiness<{
    providerId: string | null;
    model: string | null;
    temperature: number;
    maxTokens: number;
  }>;
  runtimeOrchestrator: OrchestratorConfig | null;
  stageManager: ConfigReadiness<{
    enabled: boolean;
    providerId: string | null;
    model: string | null;
    temperature: number;
    maxTokens: number;
    quietPeriodSeconds: number;
    historyLimit: number;
    maxRelationshipsPerWaifu: number;
    maxMemoriesPerWaifu: number;
  }>;
  runtimeStageManager: StageManagerConfig;
  waifuDocuments: ComposedWaifuDocument[];
  runtimeWaifus: WaifuConfig[];
  invalidWaifus: InvalidLocalDocument[];
}

export class ConfigComposer {
  constructor(
    private readonly defaultsStore: DefaultsStore,
    private readonly runtimeStore: LocalRuntimeStore
  ) {}

  async compose(): Promise<ComposedRuntimeConfig> {
    const [
      defaultAppSettings,
      providerCatalog,
      defaultOrchestrator,
      defaultStageManager,
      localAppSettings,
      localProviders,
      providerKeys,
      localChannels,
      localOrchestrator,
      localStageManager,
      waifuDocuments
    ] = await Promise.all([
      this.defaultsStore.readAppSettings(),
      this.defaultsStore.readProviderCatalog(),
      this.defaultsStore.readOrchestrator(),
      this.defaultsStore.readStageManager(),
      this.runtimeStore.readAppSettings(),
      this.runtimeStore.readProviders(),
      this.runtimeStore.readProviderKeys(),
      this.runtimeStore.readChannels(),
      this.runtimeStore.readOrchestrator(),
      this.runtimeStore.readStageManager(),
      this.runtimeStore.listWaifuDocuments()
    ]);

    const appSettings = localAppSettings.app.schemaVersion ? localAppSettings : defaultAppSettings;
    const providerEditorEntries = composeProviderEditorEntries(
      providerCatalog,
      localProviders.providers,
      providerKeys.providerKeys
    );
    const runtimeProviders = composeRuntimeProviders(providerEditorEntries);
    const providerIndex = new Map(providerEditorEntries.map((entry) => [entry.id, entry] as const));
    const waifuResults = waifuDocuments.documents.map((waifu) => composeWaifu(waifu, providerIndex));
    const runtimeWaifus = waifuResults
      .filter((entry): entry is ComposedWaifuDocument & { runtimeWaifu: WaifuConfig } => "runtimeWaifu" in entry)
      .map((entry) => entry.runtimeWaifu);
    const runtimeWaifuIds = new Set(runtimeWaifus.map((entry) => entry.id));

    const channels = localChannels.channels;
    const runtimeChannels = composeRuntimeChannels(channels, runtimeWaifuIds);
    const orchestrator = composeOrchestrator(localOrchestrator, defaultOrchestrator, providerIndex);
    const stageManager = composeStageManager(localStageManager, defaultStageManager, providerIndex, orchestrator);

    return {
      appSettings,
      providerCatalog,
      providerEditorEntries,
      runtimeProviders,
      channels,
      runtimeChannels,
      orchestrator,
      runtimeOrchestrator: orchestrator.isReady ? orchestrator.value : null,
      stageManager,
      runtimeStageManager: stageManager.value,
      waifuDocuments: waifuResults.map(({ waifu, meta }) => ({ waifu, meta })),
      runtimeWaifus,
      invalidWaifus: waifuDocuments.invalid
    };
  }
}

function composeProviderEditorEntries(
  catalog: ProviderCatalogFile,
  localProviders: LocalProviderDefinition[],
  providerKeys: Array<{ id: string; apiKey: string }>
): ProviderEditorEntry[] {
  const catalogIds = new Set(catalog.providers.map((entry) => entry.id));
  const keysById = new Map(providerKeys.map((entry) => [entry.id, entry.apiKey] as const));

  return [...localProviders]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const keyValue = keysById.get(provider.id) ?? "";
      const runtimeErrors: string[] = [];
      const resolvedBaseUrl = resolveEnvString(provider.baseUrl).trim();
      const hasBaseUrl = Boolean(resolvedBaseUrl) && resolvedBaseUrl !== provider.baseUrl ? true : Boolean(resolvedBaseUrl);
      if (!hasBaseUrl || !isUrlLike(resolvedBaseUrl)) {
        runtimeErrors.push("Missing or invalid base URL");
      }
      if (!provider.models.length) {
        runtimeErrors.push("No configured models");
      }
      if (provider.authMode === "required" && !hasResolvedNonEmptyValue(keyValue)) {
        runtimeErrors.push("Missing API key");
      }

      return {
        ...provider,
        keyValue,
        hasKey: hasResolvedNonEmptyValue(keyValue),
        isBuiltIn: provider.origin === "built-in" || catalogIds.has(provider.id),
        canDelete: provider.origin === "custom",
        isRuntimeCallable: provider.enabled && runtimeErrors.length === 0,
        runtimeErrors
      };
    });
}

function composeRuntimeProviders(entries: ProviderEditorEntry[]): ProviderConfig[] {
  return entries
    .filter((entry) => entry.isRuntimeCallable)
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      type: entry.type,
      baseUrl: resolveEnvString(entry.baseUrl),
      apiKey: entry.authMode === "none" ? "not-required" : resolveEnvString(entry.keyValue),
      enabled: entry.enabled,
      models: [...entry.models]
    }));
}

function composeWaifu(
  waifu: WaifuDocument,
  providerIndex: Map<string, ProviderEditorEntry>
): ComposedWaifuDocument | (ComposedWaifuDocument & { runtimeWaifu: WaifuConfig }) {
  const runtimeValidationErrors: string[] = [];
  const providerId = normalizeOptionalValue(waifu.ai.providerId);
  const model = normalizeOptionalValue(waifu.ai.model);
  const provider = providerId ? providerIndex.get(providerId) : undefined;

  if (!hasResolvedNonEmptyValue(waifu.botToken)) {
    runtimeValidationErrors.push("Missing Discord bot token");
  }

  if (!hasResolvedNonEmptyValue(waifu.applicationId)) {
    runtimeValidationErrors.push("Application ID missing");
  }

  if (!waifu.personality.description.trim()) {
    runtimeValidationErrors.push("Personality description missing");
  }

  if (!waifu.personality.backstory.trim()) {
    runtimeValidationErrors.push("Backstory missing");
  }

  if (!providerId) {
    runtimeValidationErrors.push("AI provider missing");
  } else if (!provider) {
    runtimeValidationErrors.push("AI provider not found");
  } else {
    if (!provider.enabled) {
      runtimeValidationErrors.push("AI provider disabled");
    }
    if (!provider.isRuntimeCallable) {
      runtimeValidationErrors.push(...provider.runtimeErrors.map((error) => `Provider ${provider.id}: ${error}`));
    }
  }

  if (!model) {
    runtimeValidationErrors.push("AI model missing");
  } else if (provider && !provider.models.includes(model)) {
    runtimeValidationErrors.push("AI model is not configured for the selected provider");
  }

  const isDiscordReady = hasResolvedNonEmptyValue(waifu.botToken);
  const isAiReady =
    Boolean(providerId) &&
    Boolean(model) &&
    Boolean(provider?.enabled) &&
    Boolean(provider?.isRuntimeCallable) &&
    Boolean(provider?.models.includes(model ?? ""));
  const isDraft =
    !isDiscordReady ||
    !isAiReady ||
    !waifu.personality.description.trim() ||
    !waifu.personality.backstory.trim() ||
    !waifu.enabled;
  const isChatReady = waifu.enabled && isDiscordReady && isAiReady;
  const meta: WaifuDocumentMeta = {
    isDraft,
    isDiscordReady,
    isAiReady,
    isChatReady,
    isRuntimeReady: isChatReady,
    runtimeValidationErrors
  };

  if (!isChatReady || !providerId || !model) {
    return { waifu, meta };
  }

  return {
    waifu,
    meta,
    runtimeWaifu: {
      id: waifu.id,
      name: waifu.name,
      displayName: waifu.displayName,
      botToken: resolveEnvString(waifu.botToken),
      applicationId: resolveEnvString(waifu.applicationId),
      enabled: waifu.enabled,
      avatarPath: waifu.avatarPath,
      bannerPath: waifu.bannerPath,
      statusText: waifu.statusText,
      statusType: waifu.statusType,
      personality: {
        ...waifu.personality
      },
      schedule: {
        ...waifu.schedule
      },
      ai: {
        ...waifu.ai,
        providerId,
        model
      }
    }
  };
}

function composeRuntimeChannels(
  channels: LocalChannelConfig[],
  validWaifuIds: Set<string>
): ChannelConfig[] {
  return channels.map((channel) => ({
    guildId: channel.guildId,
    channelId: channel.channelId,
    channelName: channel.channelName,
    enabled: channel.enabled,
    activeWaifuIds: channel.activeWaifuIds.filter((waifuId) => validWaifuIds.has(waifuId)),
    contextAnchorMessageId: channel.contextAnchorMessageId || null,
    contextMessageCount: channel.contextMessageCount,
    idleChatterEnabled: channel.idleChatterEnabled,
    idleTimerMinSeconds: channel.idleTimerMinSeconds,
    idleTimerMaxSeconds: channel.idleTimerMaxSeconds
  }));
}

function composeOrchestrator(
  localValue: OrchestratorToml,
  defaultValue: OrchestratorToml,
  providerIndex: Map<string, ProviderEditorEntry>
): ConfigReadiness<OrchestratorConfig> {
  const providerId = normalizeOptionalValue(localValue.orchestrator.providerId) ??
    normalizeOptionalValue(defaultValue.orchestrator.providerId);
  const model = normalizeOptionalValue(localValue.orchestrator.model) ??
    normalizeOptionalValue(defaultValue.orchestrator.model);
  const provider = providerId ? providerIndex.get(providerId) : undefined;
  const runtimeErrors: string[] = [];

  if (!providerId) {
    runtimeErrors.push("Provider not configured");
  } else if (!provider) {
    runtimeErrors.push("Provider not found");
  } else if (!provider.enabled) {
    runtimeErrors.push("Provider disabled");
  } else if (!provider.isRuntimeCallable) {
    runtimeErrors.push(...provider.runtimeErrors.map((error) => `Provider ${provider.id}: ${error}`));
  }

  if (!model) {
    runtimeErrors.push("Model not configured");
  } else if (provider && !provider.models.includes(model)) {
    runtimeErrors.push("Model is not configured for the selected provider");
  }

  const value: OrchestratorConfig = {
    providerId: providerId ?? "",
    model: model ?? "",
    temperature: localValue.orchestrator.temperature,
    maxTokens: localValue.orchestrator.maxTokens
  };

  return {
    value,
    isReady: runtimeErrors.length === 0,
    runtimeErrors
  };
}

function composeStageManager(
  localValue: StageManagerToml,
  defaultValue: StageManagerToml,
  providerIndex: Map<string, ProviderEditorEntry>,
  orchestrator: ConfigReadiness<OrchestratorConfig>
): ConfigReadiness<StageManagerConfig> {
  const providerId =
    normalizeOptionalValue(localValue.stageManager.providerId) ??
    normalizeOptionalValue(defaultValue.stageManager.providerId);
  const model =
    normalizeOptionalValue(localValue.stageManager.model) ??
    normalizeOptionalValue(defaultValue.stageManager.model);
  const effectiveProviderId = providerId ?? (orchestrator.isReady ? normalizeOptionalValue(orchestrator.value.providerId) : null);
  const effectiveModel = model ?? (orchestrator.isReady ? normalizeOptionalValue(orchestrator.value.model) : null);
  const provider = effectiveProviderId ? providerIndex.get(effectiveProviderId) : undefined;
  const runtimeErrors: string[] = [];

  if (effectiveProviderId || effectiveModel) {
    if (!effectiveProviderId) {
      runtimeErrors.push("Provider not configured");
    } else if (!provider) {
      runtimeErrors.push("Provider not found");
    } else if (!provider.enabled) {
      runtimeErrors.push("Provider disabled");
    } else if (!provider.isRuntimeCallable) {
      runtimeErrors.push(...provider.runtimeErrors.map((error) => `Provider ${provider.id}: ${error}`));
    }

    if (!effectiveModel) {
      runtimeErrors.push("Model not configured");
    } else if (provider && !provider.models.includes(effectiveModel)) {
      runtimeErrors.push("Model is not configured for the selected provider");
    }
  }

  return {
    value: {
      enabled: localValue.stageManager.enabled,
      providerId: effectiveProviderId,
      model: effectiveModel,
      temperature: localValue.stageManager.temperature,
      maxTokens: localValue.stageManager.maxTokens,
      quietPeriodSeconds: localValue.stageManager.quietPeriodSeconds,
      historyLimit: localValue.stageManager.historyLimit,
      maxRelationshipsPerWaifu: localValue.stageManager.maxRelationshipsPerWaifu,
      maxMemoriesPerWaifu: localValue.stageManager.maxMemoriesPerWaifu
    },
    isReady: runtimeErrors.length === 0,
    runtimeErrors
  };
}

function normalizeOptionalValue(value: string | null | undefined): string | null {
  if (isUnsetModelValue(value)) {
    return null;
  }
  const resolved = resolveEnvString(value ?? "").trim();
  return resolved || null;
}

function isUrlLike(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
