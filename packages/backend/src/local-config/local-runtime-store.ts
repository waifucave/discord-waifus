import { promises as fs } from "node:fs";
import path from "node:path";
import type { LocalConfigPaths } from "../local-config-paths.js";
import {
  appSettingsTomlSchema,
  channelsTomlSchema,
  createEmptyStageManagerWaifuDocument,
  localProviderOverridesTomlSchema,
  migrationStateSchema,
  migrationWarningsFileSchema,
  providerKeysTomlSchema,
  stageManagerCheckpointsFileSchema,
  stageManagerWaifuDocumentSchema,
  type AppSettingsToml,
  type ChannelsToml,
  type LocalProviderOverridesToml,
  type MigrationState,
  type MigrationWarningsFile,
  type OrchestratorToml,
  type ProviderKeysToml,
  type StageManagerCheckpointsFile,
  type StageManagerToml,
  type StageManagerWaifuDocument,
  type WaifuDocument,
  orchestratorTomlSchema,
  stageManagerTomlSchema,
  waifuDocumentSchema
} from "../types/index.js";
import {
  ensureDir,
  readJsonFile,
  readTomlFile,
  writeJsonFile,
  writeTomlFile
} from "./toml.js";

export interface InvalidLocalDocument {
  filePath: string;
  idHint: string | null;
  error: string;
}

export interface LocalDocumentListResult<T> {
  documents: T[];
  invalid: InvalidLocalDocument[];
}

export class LocalRuntimeStore {
  constructor(private readonly paths: LocalConfigPaths) {}

  async readAppSettings(): Promise<AppSettingsToml> {
    return readTomlFile(this.paths.runtimeConfigFile(), appSettingsTomlSchema, {
      decode: decodeAppSettingsToml,
      missingValue: appSettingsTomlSchema.parse({ app: {} }) as AppSettingsToml
    });
  }

  async writeAppSettings(value: AppSettingsToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeConfigFile(), appSettingsTomlSchema.parse(value), {
      encode: encodeAppSettingsToml
    });
  }

  async readProviders(): Promise<LocalProviderOverridesToml> {
    return readTomlFile(this.paths.runtimeProvidersFile(), localProviderOverridesTomlSchema, {
      decode: decodeProvidersToml,
      missingValue: localProviderOverridesTomlSchema.parse({ providers: [] }) as LocalProviderOverridesToml
    });
  }

  async writeProviders(value: LocalProviderOverridesToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeProvidersFile(), localProviderOverridesTomlSchema.parse(value), {
      encode: encodeProvidersToml
    });
  }

  async readProviderKeys(): Promise<ProviderKeysToml> {
    return readTomlFile(this.paths.runtimeKeysFile(), providerKeysTomlSchema, {
      decode: decodeProviderKeysToml,
      missingValue: providerKeysTomlSchema.parse({ providerKeys: [] }) as ProviderKeysToml
    });
  }

  async writeProviderKeys(value: ProviderKeysToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeKeysFile(), providerKeysTomlSchema.parse(value), {
      encode: encodeProviderKeysToml
    });
  }

  async readChannels(): Promise<ChannelsToml> {
    return readTomlFile(this.paths.runtimeChannelsFile(), channelsTomlSchema, {
      decode: decodeChannelsToml,
      missingValue: channelsTomlSchema.parse({ channels: [] }) as ChannelsToml
    });
  }

  async writeChannels(value: ChannelsToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeChannelsFile(), channelsTomlSchema.parse(value), {
      encode: encodeChannelsToml
    });
  }

  async readOrchestrator(): Promise<OrchestratorToml> {
    return readTomlFile(this.paths.runtimeOrchestratorFile(), orchestratorTomlSchema, {
      decode: decodeOrchestratorToml,
      missingValue: orchestratorTomlSchema.parse({ orchestrator: {} }) as OrchestratorToml
    });
  }

  async writeOrchestrator(value: OrchestratorToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeOrchestratorFile(), orchestratorTomlSchema.parse(value), {
      encode: encodeOrchestratorToml
    });
  }

  async readStageManager(): Promise<StageManagerToml> {
    return readTomlFile(this.paths.runtimeStageManagerFile(), stageManagerTomlSchema, {
      decode: decodeStageManagerToml,
      missingValue: stageManagerTomlSchema.parse({ stageManager: {} }) as StageManagerToml
    });
  }

  async writeStageManager(value: StageManagerToml): Promise<void> {
    await writeTomlFile(this.paths.runtimeStageManagerFile(), stageManagerTomlSchema.parse(value), {
      encode: encodeStageManagerToml
    });
  }

  async listWaifuDocuments(): Promise<LocalDocumentListResult<WaifuDocument>> {
    return this.listJsonDocuments(this.paths.waifusRoot, waifuDocumentSchema, (filePath, value) => {
      assertMatchingId(path.basename(filePath, ".json"), value.id, "waifu");
    });
  }

  async readWaifuDocument(waifuId: string): Promise<WaifuDocument> {
    const document = await readJsonFile(this.paths.waifuFile(waifuId), waifuDocumentSchema);
    assertMatchingId(waifuId, document.id, "waifu");
    return document;
  }

  async writeWaifuDocument(value: WaifuDocument): Promise<void> {
    await writeJsonFile(this.paths.waifuFile(value.id), waifuDocumentSchema.parse(value));
  }

  async deleteWaifuDocument(waifuId: string): Promise<void> {
    await fs.rm(this.paths.waifuFile(waifuId), { force: true });
  }

  async listStageManagerDocuments(): Promise<LocalDocumentListResult<StageManagerWaifuDocument>> {
    return this.listJsonDocuments(
      this.paths.stageManagerDataRoot,
      stageManagerWaifuDocumentSchema,
      (filePath, value) => {
        assertMatchingId(path.basename(filePath, ".json"), value.waifuId, "stage-manager companion");
      }
    );
  }

  async readStageManagerDocument(waifuId: string): Promise<StageManagerWaifuDocument> {
    const document = await readJsonFile(
      this.paths.stageManagerDataFile(waifuId),
      stageManagerWaifuDocumentSchema,
      {
        missingValue: createEmptyStageManagerWaifuDocument(waifuId) as StageManagerWaifuDocument
      }
    );
    assertMatchingId(waifuId, document.waifuId, "stage-manager companion");
    return document;
  }

  async writeStageManagerDocument(value: StageManagerWaifuDocument): Promise<void> {
    await writeJsonFile(this.paths.stageManagerDataFile(value.waifuId), stageManagerWaifuDocumentSchema.parse(value));
  }

  async deleteStageManagerDocument(waifuId: string): Promise<void> {
    await fs.rm(this.paths.stageManagerDataFile(waifuId), { force: true });
  }

  async readStageManagerCheckpoints(): Promise<StageManagerCheckpointsFile> {
    return readJsonFile(this.paths.stageManagerCheckpointsFile(), stageManagerCheckpointsFileSchema, {
      missingValue: stageManagerCheckpointsFileSchema.parse({ guilds: {} }) as StageManagerCheckpointsFile
    });
  }

  async writeStageManagerCheckpoints(value: StageManagerCheckpointsFile): Promise<void> {
    await writeJsonFile(this.paths.stageManagerCheckpointsFile(), stageManagerCheckpointsFileSchema.parse(value));
  }

  async readMigrationState(): Promise<MigrationState | null> {
    try {
      return await readJsonFile(this.paths.migrationStateFile(), migrationStateSchema);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeMigrationState(value: MigrationState): Promise<void> {
    await writeJsonFile(this.paths.migrationStateFile(), migrationStateSchema.parse(value));
  }

  async readMigrationWarnings(): Promise<MigrationWarningsFile> {
    return readJsonFile(this.paths.migrationWarningsFile(), migrationWarningsFileSchema, {
      missingValue: migrationWarningsFileSchema.parse({
        schemaVersion: 1,
        globalWarnings: [],
        waifuWarnings: {}
      }) as MigrationWarningsFile
    });
  }

  async writeMigrationWarnings(value: MigrationWarningsFile): Promise<void> {
    await writeJsonFile(this.paths.migrationWarningsFile(), migrationWarningsFileSchema.parse(value));
  }

  async ensureRuntimeDirectories(): Promise<void> {
    await Promise.all([
      ensureDir(this.paths.runtimeRoot),
      ensureDir(this.paths.waifusRoot),
      ensureDir(this.paths.stageManagerDataRoot),
      ensureDir(this.paths.stateRoot),
      ensureDir(path.join(this.paths.assetsRoot, "waifus"))
    ]);
  }

  private async listJsonDocuments<T>(
    dirPath: string,
    schema: { parse: (value: unknown) => T },
    validateIdentity: (filePath: string, value: T) => void
  ): Promise<LocalDocumentListResult<T>> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const documents: T[] = [];
      const invalid: InvalidLocalDocument[] = [];

      for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json")).sort((a, b) =>
        a.name.localeCompare(b.name)
      )) {
        const filePath = path.join(dirPath, entry.name);
        try {
          const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
          const parsed = schema.parse(raw);
          validateIdentity(filePath, parsed);
          documents.push(parsed);
        } catch (error) {
          invalid.push({
            filePath,
            idHint: path.basename(entry.name, ".json") || null,
            error: error instanceof Error ? error.message : "Unknown validation error"
          });
        }
      }

      return { documents, invalid };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return { documents: [], invalid: [] };
      }
      throw error;
    }
  }
}

function assertMatchingId(fileStem: string, valueId: string, label: string): void {
  if (fileStem !== valueId) {
    throw new Error(`Invalid ${label} document: filename stem "${fileStem}" does not match embedded id "${valueId}"`);
  }
}

function decodeAppSettingsToml(value: unknown): unknown {
  const source = asRecord(value);
  const app = asRecord(source.app);
  return {
    app: {
      schemaVersion: app.schema_version
    }
  };
}

function encodeAppSettingsToml(value: AppSettingsToml): unknown {
  return {
    app: {
      schema_version: value.app.schemaVersion
    }
  };
}

function decodeProvidersToml(value: unknown): unknown {
  const source = asRecord(value);
  return {
    providers: asArray(source.providers).map((entry) => {
      const row = asRecord(entry);
      return {
        id: row.id,
        origin: row.origin,
        name: row.name,
        type: row.type,
        authMode: row.auth_mode,
        enabled: row.enabled,
        baseUrl: row.base_url,
        models: row.models
      };
    })
  };
}

function encodeProvidersToml(value: LocalProviderOverridesToml): unknown {
  return {
    providers: value.providers.map((entry) => ({
      id: entry.id,
      origin: entry.origin,
      name: entry.name,
      type: entry.type,
      auth_mode: entry.authMode,
      enabled: entry.enabled,
      base_url: entry.baseUrl,
      models: entry.models
    }))
  };
}

function decodeProviderKeysToml(value: unknown): unknown {
  const source = asRecord(value);
  return {
    providerKeys: asArray(source.provider_keys).map((entry) => {
      const row = asRecord(entry);
      return {
        id: row.id,
        apiKey: row.api_key
      };
    })
  };
}

function encodeProviderKeysToml(value: ProviderKeysToml): unknown {
  return {
    provider_keys: value.providerKeys.map((entry) => ({
      id: entry.id,
      api_key: entry.apiKey
    }))
  };
}

function decodeChannelsToml(value: unknown): unknown {
  const source = asRecord(value);
  return {
    channels: asArray(source.channels).map((entry) => {
      const row = asRecord(entry);
      return {
        guildId: row.guild_id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        enabled: row.enabled,
        activeWaifuIds: row.active_waifu_ids,
        contextAnchorMessageId: row.context_anchor_message_id,
        contextMessageCount: row.context_message_count,
        idleChatterEnabled: row.idle_chatter_enabled,
        idleTimerMinSeconds: row.idle_timer_min_seconds,
        idleTimerMaxSeconds: row.idle_timer_max_seconds
      };
    })
  };
}

function encodeChannelsToml(value: ChannelsToml): unknown {
  return {
    channels: value.channels.map((entry) => ({
      guild_id: entry.guildId,
      channel_id: entry.channelId,
      channel_name: entry.channelName,
      enabled: entry.enabled,
      active_waifu_ids: entry.activeWaifuIds,
      context_anchor_message_id: entry.contextAnchorMessageId,
      context_message_count: entry.contextMessageCount,
      idle_chatter_enabled: entry.idleChatterEnabled,
      idle_timer_min_seconds: entry.idleTimerMinSeconds,
      idle_timer_max_seconds: entry.idleTimerMaxSeconds
    }))
  };
}

function decodeOrchestratorToml(value: unknown): unknown {
  const source = asRecord(value);
  const orchestrator = asRecord(source.orchestrator);
  return {
    orchestrator: {
      providerId: orchestrator.provider_id,
      model: orchestrator.model,
      temperature: orchestrator.temperature,
      maxTokens: orchestrator.max_tokens
    }
  };
}

function encodeOrchestratorToml(value: OrchestratorToml): unknown {
  return {
    orchestrator: {
      provider_id: value.orchestrator.providerId,
      model: value.orchestrator.model,
      temperature: value.orchestrator.temperature,
      max_tokens: value.orchestrator.maxTokens
    }
  };
}

function decodeStageManagerToml(value: unknown): unknown {
  const source = asRecord(value);
  const stageManager = asRecord(source.stage_manager);
  return {
    stageManager: {
      enabled: stageManager.enabled,
      providerId: stageManager.provider_id,
      model: stageManager.model,
      temperature: stageManager.temperature,
      maxTokens: stageManager.max_tokens,
      quietPeriodSeconds: stageManager.quiet_period_seconds,
      historyLimit: stageManager.history_limit,
      maxRelationshipsPerWaifu: stageManager.max_relationships_per_waifu,
      maxMemoriesPerWaifu: stageManager.max_memories_per_waifu
    }
  };
}

function encodeStageManagerToml(value: StageManagerToml): unknown {
  return {
    stage_manager: {
      enabled: value.stageManager.enabled,
      provider_id: value.stageManager.providerId,
      model: value.stageManager.model,
      temperature: value.stageManager.temperature,
      max_tokens: value.stageManager.maxTokens,
      quiet_period_seconds: value.stageManager.quietPeriodSeconds,
      history_limit: value.stageManager.historyLimit,
      max_relationships_per_waifu: value.stageManager.maxRelationshipsPerWaifu,
      max_memories_per_waifu: value.stageManager.maxMemoriesPerWaifu
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
