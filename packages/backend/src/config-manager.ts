import { EventEmitter } from "node:events";
import path from "node:path";
import { ConfigComposer, type ComposedRuntimeConfig } from "./local-config/config-composer.js";
import { DefaultsStore } from "./local-config/defaults-store.js";
import { LocalRuntimeStore } from "./local-config/local-runtime-store.js";
import { fileExists } from "./local-config/toml.js";
import { LocalConfigPaths } from "./local-config-paths.js";
import {
  channelsFileSchema,
  createEmptyStageManagerWaifuDocument,
  orchestratorFileSchema,
  providerCatalogFileSchema,
  providersFileSchema,
  stageManagerFileSchema,
  type LocalProviderDefinition,
  type OrchestratorConfig,
  type ProviderCatalogEntry,
  type ProviderConfig,
  type StageManagerConfig,
  type WaifuConfig,
  waifuDocumentSchema,
  type ChannelConfig
} from "./types/index.js";
import { Logger } from "./utils/logger.js";

export interface LoadedConfig {
  waifus: WaifuConfig[];
  providers: ProviderConfig[];
  channels: ChannelConfig[];
  orchestrator: OrchestratorConfig;
  stageManager: StageManagerConfig;
}

export interface ConfigChangedEvent {
  config: LoadedConfig;
  changedPath: string;
}

type ConfigEventMap = {
  reloaded: [ConfigChangedEvent];
};

export class ConfigManager extends EventEmitter<ConfigEventMap> {
  readonly logger = new Logger("ConfigManager");
  readonly workspaceRoot: string;
  readonly configDir: string;
  readonly paths: LocalConfigPaths;
  readonly defaultsStore: DefaultsStore;
  readonly runtimeStore: LocalRuntimeStore;
  readonly composer: ConfigComposer;

  waifus: WaifuConfig[] = [];
  providers: ProviderConfig[] = [];
  channels: ChannelConfig[] = [];
  orchestrator!: OrchestratorConfig;
  stageManager!: StageManagerConfig;
  private composedLocalConfig: ComposedRuntimeConfig | null = null;

  constructor(workspaceRoot: string) {
    super();
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.paths = new LocalConfigPaths(this.workspaceRoot);
    this.configDir = this.paths.runtimeRoot;
    this.defaultsStore = new DefaultsStore(this.paths);
    this.runtimeStore = new LocalRuntimeStore(this.paths);
    this.composer = new ConfigComposer(this.defaultsStore, this.runtimeStore);
  }

  async load(): Promise<LoadedConfig> {
    await this.ensureCanonicalRuntimeLayout();
    const migrationState = await this.runtimeStore.readMigrationState();
    if (!migrationState) {
      await this.writeMigrationState("bootstrap_empty");
    }

    const composed = await this.composer.compose();
    this.composedLocalConfig = composed;
    this.waifus = composed.runtimeWaifus;
    this.providers = composed.runtimeProviders;
    this.channels = composed.runtimeChannels;
    this.orchestrator = composed.runtimeOrchestrator ?? {
      providerId: "configure-me",
      model: "configure-me",
      temperature: composed.orchestrator.value.temperature,
      maxTokens: composed.orchestrator.value.maxTokens
    };
    this.stageManager = composed.runtimeStageManager;

    this.logger.info("Configuration loaded from local runtime", {
      waifus: this.waifus.length,
      providers: this.providers.length,
      channels: this.channels.length,
      invalidWaifus: composed.invalidWaifus.length
    });
    if (composed.invalidWaifus.length > 0) {
      this.logger.warn("Invalid local waifu documents were skipped", {
        count: composed.invalidWaifus.length,
        files: composed.invalidWaifus.map((entry) => entry.filePath)
      });
    }
    return this.snapshot();
  }

  async saveWaifus(waifus: WaifuConfig[]): Promise<LoadedConfig> {
    await this.saveLocalWaifus(waifus);
    return this.reloadAndEmit("waifus.json");
  }

  async saveProviders(providers: ProviderConfig[]): Promise<LoadedConfig> {
    await this.saveLocalProviders(providers);
    return this.reloadAndEmit("providers.json");
  }

  async saveChannels(channels: ChannelConfig[]): Promise<LoadedConfig> {
    await this.runtimeStore.writeChannels({
      channels: channels.map((channel) => ({
        ...channel,
        contextAnchorMessageId: channel.contextAnchorMessageId ?? ""
      }))
    });
    return this.reloadAndEmit("channels.json");
  }

  async saveOrchestrator(orchestrator: OrchestratorConfig): Promise<LoadedConfig> {
    await this.runtimeStore.writeOrchestrator({
      orchestrator: {
        ...orchestrator,
        providerId: orchestrator.providerId || "configure-me",
        model: orchestrator.model || "configure-me"
      }
    });
    return this.reloadAndEmit("orchestrator.json");
  }

  async saveStageManager(stageManager: StageManagerConfig): Promise<LoadedConfig> {
    await this.runtimeStore.writeStageManager({
      stageManager: {
        ...stageManager,
        providerId: stageManager.providerId ?? "",
        model: stageManager.model ?? ""
      }
    });
    return this.reloadAndEmit("stage-manager.json");
  }

  watch(): void {
    this.logger.info("Config file watching is disabled; changes apply only through explicit saves or restart.");
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  snapshot(): LoadedConfig {
    return {
      waifus: [...this.waifus],
      providers: [...this.providers],
      channels: [...this.channels],
      orchestrator: { ...this.orchestrator },
      stageManager: { ...this.stageManager }
    };
  }

  async refreshFromDisk(changedPath: string): Promise<LoadedConfig> {
    return this.reloadAndEmit(changedPath);
  }

  private async ensureCanonicalRuntimeLayout(): Promise<void> {
    await this.runtimeStore.ensureRuntimeDirectories();

    const [
      defaultAppSettings,
      providerCatalog,
      defaultOrchestrator,
      defaultStageManager
    ] = await Promise.all([
      this.defaultsStore.readAppSettings(),
      this.defaultsStore.readProviderCatalog(),
      this.defaultsStore.readOrchestrator(),
      this.defaultsStore.readStageManager()
    ]);

    if (!(await fileExists(this.paths.runtimeConfigFile()))) {
      await this.runtimeStore.writeAppSettings(defaultAppSettings);
    }

    if (!(await fileExists(this.paths.runtimeProvidersFile()))) {
      await this.runtimeStore.writeProviders({
        providers: providerCatalog.providers.map(providerCatalogEntryToLocalDefinition)
      });
    }

    if (!(await fileExists(this.paths.runtimeKeysFile()))) {
      await this.runtimeStore.writeProviderKeys({ providerKeys: [] });
    }

    if (!(await fileExists(this.paths.runtimeChannelsFile()))) {
      await this.runtimeStore.writeChannels({ channels: [] });
    }

    if (!(await fileExists(this.paths.runtimeOrchestratorFile()))) {
      await this.runtimeStore.writeOrchestrator(defaultOrchestrator);
    }

    if (!(await fileExists(this.paths.runtimeStageManagerFile()))) {
      await this.runtimeStore.writeStageManager(defaultStageManager);
    }

    if (!(await fileExists(this.paths.stageManagerCheckpointsFile()))) {
      await this.runtimeStore.writeStageManagerCheckpoints({ guilds: {} });
    }

    if (!(await fileExists(this.paths.migrationWarningsFile()))) {
      await this.runtimeStore.writeMigrationWarnings({
        schemaVersion: 1,
        globalWarnings: [],
        waifuWarnings: {}
      });
    }
  }

  private async writeMigrationState(status: "bootstrap_empty" | "import_completed"): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.runtimeStore.writeMigrationState({
      schemaVersion: 1,
      status,
      createdAt: timestamp,
      completedAt: timestamp
    });
  }

  private async saveLocalWaifus(waifus: WaifuConfig[]): Promise<void> {
    await this.runtimeStore.ensureRuntimeDirectories();
    const existingDocuments = await this.runtimeStore.listWaifuDocuments();
    const currentRuntimeIds = new Set(this.waifus.map((entry) => entry.id));
    const nextRuntimeIds = new Set(waifus.map((entry) => entry.id));

    for (const waifuId of currentRuntimeIds) {
      if (!nextRuntimeIds.has(waifuId)) {
        await this.runtimeStore.deleteWaifuDocument(waifuId);
        await this.runtimeStore.deleteStageManagerDocument(waifuId);
      }
    }

    const existingDocumentIds = new Set(existingDocuments.documents.map((entry) => entry.id));
    for (const waifu of waifus) {
      await this.runtimeStore.writeWaifuDocument(runtimeWaifuToDocument(waifu));
      if (!existingDocumentIds.has(waifu.id)) {
        await this.runtimeStore.writeStageManagerDocument(createEmptyStageManagerWaifuDocument(waifu.id));
      }
    }
  }

  private async saveLocalProviders(providers: ProviderConfig[]): Promise<void> {
    await this.runtimeStore.ensureRuntimeDirectories();
    const [existingProviders, existingKeys, providerCatalog] = await Promise.all([
      this.runtimeStore.readProviders(),
      this.runtimeStore.readProviderKeys(),
      this.defaultsStore.readProviderCatalog()
    ]);

    const currentRuntimeIds = new Set(this.providers.map((entry) => entry.id));
    const nextRuntimeIds = new Set(providers.map((entry) => entry.id));
    const catalogById = new Map(providerCatalog.providers.map((entry) => [entry.id, entry] as const));
    const existingDefinitionsById = new Map(
      existingProviders.providers.map((entry) => [entry.id, entry] as const)
    );
    const nextDefinitions = existingProviders.providers.filter(
      (entry) => !currentRuntimeIds.has(entry.id) || nextRuntimeIds.has(entry.id)
    );
    const nextKeys = existingKeys.providerKeys.filter(
      (entry) => !currentRuntimeIds.has(entry.id) || nextRuntimeIds.has(entry.id)
    );
    const nextDefinitionMap = new Map(nextDefinitions.map((entry) => [entry.id, entry] as const));
    const nextKeyMap = new Map(nextKeys.map((entry) => [entry.id, entry] as const));

    for (const provider of providers) {
      const existingDefinition = existingDefinitionsById.get(provider.id);
      const catalogEntry = catalogById.get(provider.id);
      const authMode = existingDefinition?.authMode ?? catalogEntry?.authMode ?? "required";
      nextDefinitionMap.set(provider.id, {
        id: provider.id,
        origin: existingDefinition?.origin ?? (catalogEntry ? "built-in" : "custom"),
        name: provider.name,
        type: provider.type,
        authMode,
        enabled: provider.enabled,
        baseUrl: provider.baseUrl,
        models: [...provider.models]
      });
      nextKeyMap.set(provider.id, {
        id: provider.id,
        apiKey: provider.apiKey
      });
    }

    await this.runtimeStore.writeProviders({
      providers: [...nextDefinitionMap.values()].sort((left, right) => left.id.localeCompare(right.id))
    });
    await this.runtimeStore.writeProviderKeys({
      providerKeys: [...nextKeyMap.values()].sort((left, right) => left.id.localeCompare(right.id))
    });
  }

  private async reloadAndEmit(changedPath: string): Promise<LoadedConfig> {
    const config = await this.load();
    this.emit("reloaded", {
      config,
      changedPath: path.join(this.configDir, changedPath)
    });
    return config;
  }
}

function runtimeWaifuToDocument(waifu: WaifuConfig) {
  return waifuDocumentSchema.parse({
    schemaVersion: 1,
    ...waifu
  });
}

function providerCatalogEntryToLocalDefinition(entry: ProviderCatalogEntry): LocalProviderDefinition {
  return {
    id: entry.id,
    origin: "built-in",
    name: entry.name,
    type: entry.type,
    authMode: entry.authMode,
    enabled: entry.enabledByDefault,
    baseUrl: entry.baseUrl,
    models: [...entry.models]
  };
}
