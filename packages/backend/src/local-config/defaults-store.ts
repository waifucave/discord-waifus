import {
  appSettingsTomlSchema,
  channelsTomlSchema,
  type AppSettingsToml,
  type ChannelsToml,
  type OrchestratorToml,
  type ProviderCatalogFile,
  type StageManagerToml,
  type WaifuDocument,
  orchestratorTomlSchema,
  providerCatalogFileSchema,
  stageManagerTomlSchema,
  waifuDocumentSchema
} from "../types/index.js";
import type { LocalConfigPaths } from "../local-config-paths.js";
import { readJsonFile, readTomlFile } from "./toml.js";

export class DefaultsStore {
  constructor(private readonly paths: LocalConfigPaths) {}

  async readAppSettings(): Promise<AppSettingsToml> {
    return readTomlFile(this.paths.defaultsConfigFile(), appSettingsTomlSchema, {
      decode: decodeAppSettingsToml,
      missingValue: appSettingsTomlSchema.parse({ app: {} }) as AppSettingsToml
    });
  }

  async readChannels(): Promise<ChannelsToml> {
    return readTomlFile(this.paths.defaultsChannelsFile(), channelsTomlSchema, {
      decode: decodeChannelsToml,
      missingValue: channelsTomlSchema.parse({ channels: [] }) as ChannelsToml
    });
  }

  async readOrchestrator(): Promise<OrchestratorToml> {
    return readTomlFile(this.paths.defaultsOrchestratorFile(), orchestratorTomlSchema, {
      decode: decodeOrchestratorToml,
      missingValue: orchestratorTomlSchema.parse({ orchestrator: {} }) as OrchestratorToml
    });
  }

  async readProviderCatalog(): Promise<ProviderCatalogFile> {
    return readJsonFile(this.paths.defaultsProviderCatalogFile(), providerCatalogFileSchema, {
      missingValue: providerCatalogFileSchema.parse({ providers: [] }) as ProviderCatalogFile
    });
  }

  async readStageManager(): Promise<StageManagerToml> {
    return readTomlFile(this.paths.defaultsStageManagerFile(), stageManagerTomlSchema, {
      decode: decodeStageManagerToml,
      missingValue: stageManagerTomlSchema.parse({ stageManager: {} }) as StageManagerToml
    });
  }

  async readDefaultWaifuTemplate(): Promise<WaifuDocument> {
    return readJsonFile(this.paths.defaultWaifuTemplateFile(), waifuDocumentSchema, {
      missingValue: waifuDocumentSchema.parse({
        id: "NewWaifu-001",
        name: "New Waifu",
        displayName: "New Waifu",
        botToken: "",
        applicationId: "",
        enabled: false,
        avatarPath: null,
        bannerPath: null,
        statusText: null,
        statusType: "online",
        personality: {
          description: "",
          traits: [],
          speechPatterns: [],
          likes: [],
          dislikes: [],
          backstory: "",
          quirks: [],
          relationshipsWithOtherWaifus: {}
        },
        schedule: {
          sleepTime: { start: "01:00", end: "09:00" },
          busyTime: { start: "09:00", end: "17:00", reason: "Busy" }
        },
        ai: {
          providerId: "",
          model: "",
          temperature: 0.8,
          repetitionPenalty: 1,
          maxTokens: 300,
          systemPromptOverride: null
        }
      }) as WaifuDocument
    });
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
