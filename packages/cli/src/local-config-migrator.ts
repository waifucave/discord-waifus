import { promises as fs } from "node:fs";
import path from "node:path";
import { stringify } from "smol-toml";
import { getRuntimeLayoutPaths, inspectRuntimeState, seedLocalRuntimeFromDefaults } from "./runtime-layout.js";

interface LegacyProvider {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: string[];
}

interface LegacyWaifu {
  id: string;
  name: string;
  displayName: string;
  botToken: string;
  applicationId: string;
  enabled: boolean;
  avatarPath: string | null;
  bannerPath: string | null;
  statusText: string | null;
  statusType: "online" | "idle" | "dnd" | "invisible";
  personality: {
    description: string;
    traits: string[];
    speechPatterns: string[];
    likes: string[];
    dislikes: string[];
    backstory: string;
    quirks: string[];
    relationshipsWithOtherWaifus: Record<string, string>;
  };
  schedule: {
    sleepTime: { start: string; end: string };
    busyTime: { start: string; end: string; reason: string };
  };
  ai: {
    providerId: string;
    model: string;
    temperature: number;
    repetitionPenalty: number;
    maxTokens: number;
    systemPromptOverride: string | null;
  };
}

interface LegacyChannel {
  guildId: string;
  channelId: string;
  channelName: string;
  enabled: boolean;
  activeWaifuIds: string[];
  contextAnchorMessageId: string | null;
  contextMessageCount: number;
  idleChatterEnabled: boolean;
  idleTimerMinSeconds: number;
  idleTimerMaxSeconds: number;
}

interface LegacyRelationshipEntry {
  targetKind: "user" | "waifu";
  targetName: string;
  targetUserId: string | null;
  targetWaifuId: string | null;
  relationship: string;
  updatedAt: string;
}

interface LegacyMemoryNote {
  slot: number;
  note: string;
  sourceMessageIds: string[];
  updatedAt: string;
}

interface LegacyStageManagerState {
  waifus: Record<
    string,
    {
      relationshipsByParticipant: Record<string, LegacyRelationshipEntry>;
      memories: LegacyMemoryNote[];
    }
  >;
  channels: Record<
    string,
    {
      lastProcessedMessageId: string | null;
      lastRunAt: string | null;
    }
  >;
}

interface CatalogProvider {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic";
  authMode: "required" | "none";
  enabledByDefault: boolean;
  baseUrl: string;
  models: string[];
}

interface MigrationWarning {
  code: string;
  field: string;
  message: string;
  legacyValue?: string;
  createdAt: string;
}

interface MigrationWarningsFile {
  schemaVersion: number;
  globalWarnings: MigrationWarning[];
  waifuWarnings: Record<string, MigrationWarning[]>;
}

export interface MigrationResult {
  written: string[];
  idMap: Record<string, string>;
  warningCount: number;
}

export async function migrateLocalConfig(projectRoot: string): Promise<MigrationResult> {
  const runtimeState = await inspectRuntimeState(projectRoot);
  if (!runtimeState.legacyLiveExists) {
    throw new Error("No legacy runtime files found to import.");
  }
  if (runtimeState.migrationState?.status === "import_completed") {
    throw new Error("Legacy import already completed for this project.");
  }

  const paths = runtimeState.paths;
  const timestamp = new Date().toISOString();
  const warnings: MigrationWarningsFile = {
    schemaVersion: 1,
    globalWarnings: [],
    waifuWarnings: {}
  };

  const [legacyWaifusFile, legacyProvidersFile, legacyChannelsFile, legacyOrchestratorFile, legacyStageManagerFile, legacyStageManagerStateFile, catalogFile] =
    await Promise.all([
      readJson<{
        waifus: LegacyWaifu[];
      }>(paths.legacyWaifusFile, { waifus: [] }),
      readJson<{
        providers: LegacyProvider[];
      }>(paths.legacyProvidersFile, { providers: [] }),
      readJson<{
        channels: LegacyChannel[];
      }>(paths.legacyChannelsFile, { channels: [] }),
      readJson(paths.legacyOrchestratorFile, {
        orchestrator: {
          providerId: "configure-me",
          model: "configure-me",
          temperature: 0.7,
          maxTokens: 500
        }
      }),
      readJson(paths.legacyStageManagerFile, {
        stageManager: {
          enabled: true,
          providerId: null,
          model: null,
          temperature: 0.4,
          maxTokens: 500,
          quietPeriodSeconds: 300,
          historyLimit: 60,
          maxRelationshipsPerWaifu: 20,
          maxMemoriesPerWaifu: 8
        }
      }),
      readJson<LegacyStageManagerState>(paths.legacyStageManagerStateFile, {
        waifus: {},
        channels: {}
      }),
      readJson<{
        providers: CatalogProvider[];
      }>(paths.defaultsProviderCatalogFile, { providers: [] })
    ]);

  const idMap = buildWaifuIdMap(legacyWaifusFile.waifus);
  const catalogById = new Map(catalogFile.providers.map((entry) => [entry.id, entry] as const));
  const written = await seedLocalRuntimeFromDefaults(projectRoot, {
    writeBootstrapMigrationState: false
  });

  const migratedWaifus = await Promise.all(
    legacyWaifusFile.waifus.map(async (waifu) => {
      const nextId = idMap[waifu.id];
      const migratedAssets = await migrateWaifuAssets(
        paths,
        waifu,
        nextId,
        warnings,
        timestamp
      );

      if (waifu.id !== nextId) {
        addWaifuWarning(warnings, nextId, {
          code: "legacy_id_sanitized",
          field: "id",
          message: `Legacy waifu id "${waifu.id}" was sanitized to "${nextId}".`,
          legacyValue: waifu.id,
          createdAt: timestamp
        });
      }

      return {
        schemaVersion: 1,
        id: nextId,
        name: waifu.name,
        displayName: waifu.displayName,
        botToken: waifu.botToken,
        applicationId: waifu.applicationId,
        enabled: waifu.enabled,
        avatarPath: migratedAssets.avatarPath,
        bannerPath: migratedAssets.bannerPath,
        statusText: waifu.statusText,
        statusType: waifu.statusType,
        personality: {
          ...waifu.personality,
          relationshipsWithOtherWaifus: Object.fromEntries(
            Object.entries(waifu.personality.relationshipsWithOtherWaifus).map(([relationshipId, value]) => [
              idMap[relationshipId] ?? relationshipId,
              value
            ])
          )
        },
        schedule: waifu.schedule,
        ai: {
          ...waifu.ai,
          providerId: waifu.ai.providerId
        }
      };
    })
  );

  const migratedChannels = legacyChannelsFile.channels.map((channel) => ({
    guildId: channel.guildId,
    channelId: channel.channelId,
    channelName: channel.channelName,
    enabled: channel.enabled,
    activeWaifuIds: channel.activeWaifuIds.map((waifuId) => idMap[waifuId] ?? waifuId),
    contextAnchorMessageId: channel.contextAnchorMessageId ?? "",
    contextMessageCount: channel.contextMessageCount,
    idleChatterEnabled: channel.idleChatterEnabled,
    idleTimerMinSeconds: channel.idleTimerMinSeconds,
    idleTimerMaxSeconds: channel.idleTimerMaxSeconds
  }));

  const migratedProviders = legacyProvidersFile.providers.map((provider) => {
    const catalog = catalogById.get(provider.id);
    return {
      id: provider.id,
      origin: catalog ? ("built-in" as const) : ("custom" as const),
      name: provider.name,
      type: provider.type,
      authMode: catalog?.authMode ?? deriveAuthMode(provider.id),
      enabled: provider.enabled,
      baseUrl: provider.baseUrl,
      models: provider.models
    };
  });

  const migratedProviderKeys = legacyProvidersFile.providers
    .map((provider) => {
      const authMode = catalogById.get(provider.id)?.authMode ?? deriveAuthMode(provider.id);
      if (authMode === "none" || !provider.apiKey) {
        return null;
      }
      return {
        id: provider.id,
        apiKey: provider.apiKey
      };
    })
    .filter((entry): entry is { id: string; apiKey: string } => Boolean(entry));

  const waifuGuilds = buildWaifuGuilds(migratedChannels);
  const migratedStageManagerDocuments = Object.fromEntries(
    migratedWaifus.map((waifu) => {
      const legacyState = legacyStageManagerStateFile.waifus[findLegacyIdForNewId(idMap, waifu.id) ?? waifu.id];
      const guildIds = [...(waifuGuilds.get(waifu.id) ?? new Set<string>())];
      const guilds: Record<string, { relationshipsByParticipant: Record<string, LegacyRelationshipEntry>; memories: LegacyMemoryNote[] }> = {};

      if (legacyState) {
        if (guildIds.length === 0) {
          addWaifuWarning(warnings, waifu.id, {
            code: "stage_manager_guild_missing",
            field: "stageManager.guilds",
            message: "Legacy stage-manager data could not be assigned because this waifu is not active in any migrated guild.",
            createdAt: timestamp
          });
        }
        if (guildIds.length > 1) {
          addWaifuWarning(warnings, waifu.id, {
            code: "stage_manager_state_duplicated",
            field: "stageManager.guilds",
            message: `Legacy stage-manager state was duplicated into ${guildIds.length} guild sections during import.`,
            createdAt: timestamp
          });
        }
      }

      for (const guildId of guildIds) {
        guilds[guildId] = {
          relationshipsByParticipant: Object.fromEntries(
            Object.entries(legacyState?.relationshipsByParticipant ?? {}).map(([participantKey, relationship]) => {
              const targetWaifuId = relationship.targetWaifuId
                ? (idMap[relationship.targetWaifuId] ?? relationship.targetWaifuId)
                : null;
              return [
                remapParticipantKey(participantKey, idMap),
                {
                  ...relationship,
                  targetWaifuId,
                  targetName:
                    relationship.targetKind === "waifu" && targetWaifuId
                      ? migratedWaifus.find((candidate) => candidate.id === targetWaifuId)?.name ?? relationship.targetName
                      : relationship.targetName
                }
              ];
            })
          ),
          memories: [...(legacyState?.memories ?? [])]
        };
      }

      return [
        waifu.id,
        {
          schemaVersion: 1,
          waifuId: waifu.id,
          guilds
        }
      ] as const;
    })
  );

  const migratedCheckpoints = collapseLegacyCheckpoints(
    legacyStageManagerStateFile.channels,
    migratedChannels,
    warnings,
    timestamp
  );

  await Promise.all([
    atomicWriteFile(
      paths.runtimeProvidersFile,
      `${stringify({
        providers: migratedProviders.map((provider) => ({
          id: provider.id,
          origin: provider.origin,
          name: provider.name,
          type: provider.type,
          auth_mode: provider.authMode,
          enabled: provider.enabled,
          base_url: provider.baseUrl,
          models: provider.models
        }))
      })}\n`
    ),
    atomicWriteFile(
      paths.runtimeKeysFile,
      `${stringify({
        provider_keys: migratedProviderKeys.map((entry) => ({
          id: entry.id,
          api_key: entry.apiKey
        }))
      })}\n`
    ),
    atomicWriteFile(
      paths.runtimeChannelsFile,
      `${stringify({
        channels: migratedChannels.map((channel) => ({
          guild_id: channel.guildId,
          channel_id: channel.channelId,
          channel_name: channel.channelName,
          enabled: channel.enabled,
          active_waifu_ids: channel.activeWaifuIds,
          context_anchor_message_id: channel.contextAnchorMessageId,
          context_message_count: channel.contextMessageCount,
          idle_chatter_enabled: channel.idleChatterEnabled,
          idle_timer_min_seconds: channel.idleTimerMinSeconds,
          idle_timer_max_seconds: channel.idleTimerMaxSeconds
        }))
      })}\n`
    ),
    atomicWriteFile(
      paths.runtimeOrchestratorFile,
      `${stringify({
        orchestrator: {
          provider_id: asRecord(legacyOrchestratorFile).orchestrator?.providerId ?? "configure-me",
          model: asRecord(legacyOrchestratorFile).orchestrator?.model ?? "configure-me",
          temperature: asRecord(legacyOrchestratorFile).orchestrator?.temperature ?? 0.7,
          max_tokens: asRecord(legacyOrchestratorFile).orchestrator?.maxTokens ?? 500
        }
      })}\n`
    ),
    atomicWriteFile(
      paths.runtimeStageManagerFile,
      `${stringify({
        stage_manager: {
          enabled: asRecord(legacyStageManagerFile).stageManager?.enabled ?? true,
          provider_id: asRecord(legacyStageManagerFile).stageManager?.providerId ?? "",
          model: asRecord(legacyStageManagerFile).stageManager?.model ?? "",
          temperature: asRecord(legacyStageManagerFile).stageManager?.temperature ?? 0.4,
          max_tokens: asRecord(legacyStageManagerFile).stageManager?.maxTokens ?? 500,
          quiet_period_seconds: asRecord(legacyStageManagerFile).stageManager?.quietPeriodSeconds ?? 300,
          history_limit: asRecord(legacyStageManagerFile).stageManager?.historyLimit ?? 60,
          max_relationships_per_waifu: asRecord(legacyStageManagerFile).stageManager?.maxRelationshipsPerWaifu ?? 20,
          max_memories_per_waifu: asRecord(legacyStageManagerFile).stageManager?.maxMemoriesPerWaifu ?? 8
        }
      })}\n`
    ),
    atomicWriteFile(
      paths.stageManagerCheckpointsFile,
      `${JSON.stringify({ guilds: migratedCheckpoints }, null, 2)}\n`
    ),
    atomicWriteFile(
      paths.migrationWarningsFile,
      `${JSON.stringify(warnings, null, 2)}\n`
    ),
    atomicWriteFile(
      paths.migrationStateFile,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          status: "import_completed",
          createdAt: timestamp,
          completedAt: timestamp
        },
        null,
        2
      )}\n`
    )
  ]);

  written.push(
    paths.runtimeProvidersFile,
    paths.runtimeKeysFile,
    paths.runtimeChannelsFile,
    paths.runtimeOrchestratorFile,
    paths.runtimeStageManagerFile,
    paths.stageManagerCheckpointsFile,
    paths.migrationWarningsFile,
    paths.migrationStateFile
  );

  for (const waifu of migratedWaifus) {
    const waifuPath = path.join(paths.runtimeWaifusRoot, `${waifu.id}.json`);
    const stageManagerPath = path.join(paths.runtimeStageManagerDataRoot, `${waifu.id}.json`);
    await atomicWriteFile(waifuPath, `${JSON.stringify(waifu, null, 2)}\n`);
    await atomicWriteFile(
      stageManagerPath,
      `${JSON.stringify(migratedStageManagerDocuments[waifu.id], null, 2)}\n`
    );
    written.push(waifuPath, stageManagerPath);
  }

  return {
    written: [...new Set(written)],
    idMap,
    warningCount:
      warnings.globalWarnings.length +
      Object.values(warnings.waifuWarnings).reduce((count, entries) => count + entries.length, 0)
  };
}

function buildWaifuIdMap(waifus: LegacyWaifu[]): Record<string, string> {
  const used = new Set<string>();
  const idMap: Record<string, string> = {};

  for (const waifu of waifus) {
    const baseId = sanitizeWaifuId(waifu.id);
    let nextId = baseId;
    let suffix = 2;
    while (used.has(nextId)) {
      nextId = `${baseId}_${suffix}`;
      suffix += 1;
    }
    used.add(nextId);
    idMap[waifu.id] = nextId;
  }

  return idMap;
}

function sanitizeWaifuId(value: string): string {
  const sanitized = value
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "Waifu_1";
}

function buildWaifuGuilds(
  channels: Array<{ guildId: string; activeWaifuIds: string[] }>
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const channel of channels) {
    for (const waifuId of channel.activeWaifuIds) {
      const guilds = result.get(waifuId) ?? new Set<string>();
      guilds.add(channel.guildId);
      result.set(waifuId, guilds);
    }
  }
  return result;
}

function collapseLegacyCheckpoints(
  checkpoints: LegacyStageManagerState["channels"],
  channels: Array<{ guildId: string; channelId: string }>,
  warnings: MigrationWarningsFile,
  timestamp: string
) {
  const guildByChannelId = new Map(channels.map((channel) => [channel.channelId, channel.guildId] as const));
  const grouped = new Map<
    string,
    Array<{ channelId: string; lastProcessedMessageId: string | null; lastRunAt: string | null }>
  >();

  for (const [channelId, checkpoint] of Object.entries(checkpoints)) {
    const guildId = guildByChannelId.get(channelId);
    if (!guildId) {
      warnings.globalWarnings.push({
        code: "legacy_checkpoint_orphaned",
        field: "stageManager.checkpoints",
        message: `Legacy checkpoint for channel "${channelId}" could not be mapped to a migrated guild.`,
        legacyValue: channelId,
        createdAt: timestamp
      });
      continue;
    }
    const entries = grouped.get(guildId) ?? [];
    entries.push({ channelId, ...checkpoint });
    grouped.set(guildId, entries);
  }

  return Object.fromEntries(
    [...grouped.entries()].map(([guildId, entries]) => {
      const withMessageId = entries.filter((entry) => entry.lastProcessedMessageId);
      const highestMessage = withMessageId.sort((left, right) =>
        compareMessageIds(left.lastProcessedMessageId, right.lastProcessedMessageId)
      )[withMessageId.length - 1];
      const latestRun = entries
        .filter((entry) => entry.lastRunAt)
        .sort((left, right) => String(left.lastRunAt).localeCompare(String(right.lastRunAt)))
        .at(-1);

      if (entries.length > 1) {
        warnings.globalWarnings.push({
          code: "legacy_checkpoints_collapsed",
          field: `stageManager.checkpoints.${guildId}`,
          message: `Collapsed ${entries.length} channel checkpoints into one guild checkpoint for "${guildId}".`,
          createdAt: timestamp
        });
      }

      return [
        guildId,
        {
          lastProcessedMessageId: highestMessage?.lastProcessedMessageId ?? null,
          lastRunAt: latestRun?.lastRunAt ?? null
        }
      ];
    })
  );
}

function compareMessageIds(left: string | null, right: string | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  try {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

async function migrateWaifuAssets(
  paths: ReturnType<typeof getRuntimeLayoutPaths>,
  waifu: LegacyWaifu,
  waifuId: string,
  warnings: MigrationWarningsFile,
  timestamp: string
): Promise<{ avatarPath: string | null; bannerPath: string | null }> {
  return {
    avatarPath: await migrateAssetField(paths, waifu, waifuId, "avatarPath", "avatar", warnings, timestamp),
    bannerPath: await migrateAssetField(paths, waifu, waifuId, "bannerPath", "banner", warnings, timestamp)
  };
}

async function migrateAssetField(
  paths: ReturnType<typeof getRuntimeLayoutPaths>,
  waifu: LegacyWaifu,
  waifuId: string,
  key: "avatarPath" | "bannerPath",
  stem: "avatar" | "banner",
  warnings: MigrationWarningsFile,
  timestamp: string
): Promise<string | null> {
  const value = waifu[key];
  if (!value || !value.trim()) {
    return null;
  }

  const sourcePath = await resolveLegacyAssetPath(paths, value);
  if (!sourcePath) {
    addWaifuWarning(warnings, waifuId, {
      code: "legacy_asset_unresolved",
      field: key,
      message: `Legacy ${stem} asset could not be resolved during import.`,
      legacyValue: value,
      createdAt: timestamp
    });
    return null;
  }

  const extension = path.extname(sourcePath) || ".png";
  const destinationDir = path.join(paths.runtimeAssetsWaifusRoot, waifuId);
  const destinationPath = path.join(destinationDir, `${stem}${extension}`);
  await fs.mkdir(destinationDir, { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  return path.posix.join("waifus", waifuId, `${stem}${extension}`);
}

async function resolveLegacyAssetPath(
  paths: ReturnType<typeof getRuntimeLayoutPaths>,
  value: string
): Promise<string | null> {
  const trimmed = value.trim();
  const candidates = [
    trimmed,
    path.join(path.dirname(paths.legacyConfigRoot), trimmed.replace(/^\.\//, "")),
    path.join(paths.legacyConfigRoot, trimmed.replace(/^\.\/?config\/assets\//, "").replace(/^config\/assets\//, "").replace(/^\.\/assets\//, "").replace(/^assets\//, ""))
  ];

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
    if (await fileExists(resolved)) {
      return resolved;
    }
  }

  return null;
}

function remapParticipantKey(value: string, idMap: Record<string, string>): string {
  const match = value.match(/^waifu:(.+)$/);
  if (!match) {
    return value;
  }
  return `waifu:${idMap[match[1]] ?? match[1]}`;
}

function findLegacyIdForNewId(idMap: Record<string, string>, nextId: string): string | null {
  return Object.entries(idMap).find(([, mapped]) => mapped === nextId)?.[0] ?? null;
}

function deriveAuthMode(providerId: string): "required" | "none" {
  return providerId === "ollama" || providerId === "lmstudio" ? "none" : "required";
}

function addWaifuWarning(
  warnings: MigrationWarningsFile,
  waifuId: string,
  warning: MigrationWarning
): void {
  warnings.waifuWarnings[waifuId] = warnings.waifuWarnings[waifuId] ?? [];
  warnings.waifuWarnings[waifuId].push(warning);
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
