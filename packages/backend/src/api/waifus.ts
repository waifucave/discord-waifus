import { promises as fs } from "node:fs";
import path from "node:path";
import type { Express } from "express";
import multer from "multer";
import { z } from "zod";
import type { ComposedWaifuDocument } from "../local-config/config-composer.js";
import type { InvalidLocalDocument } from "../local-config/local-runtime-store.js";
import type { BotManager } from "../bot-manager.js";
import type { ConfigManager } from "../config-manager.js";
import type { StageManagerStateStore } from "../stage-manager-store.js";
import {
  createEmptyStageManagerWaifuDocument,
  localAssetUrlPrefix,
  migrationWarningSchema,
  stageManagerMemoryEntrySchema,
  stageManagerRelationshipEntrySchema,
  waifuDocumentSchema,
  type MigrationWarning,
  type StageManagerMemoryEntry,
  type StageManagerRelationshipEntry,
  type StageManagerWaifuDocument,
  type WaifuConfig,
  type WaifuDocument
} from "../types/index.js";
import { asyncRoute } from "./helpers.js";

const upload = multer({ storage: multer.memoryStorage() });

const editorRelationshipSchema = stageManagerRelationshipEntrySchema.extend({
  participantKey: z.string().min(1)
});

const editorGuildStateSchema = z.object({
  guildId: z.string().min(1),
  relationships: z.array(editorRelationshipSchema).default([]),
  memories: z.array(stageManagerMemoryEntrySchema).default([])
});

const editorStageManagerSchema = z.object({
  guilds: z.array(editorGuildStateSchema).default([])
});

const waifuEditorWriteSchema = z.object({
  waifu: waifuDocumentSchema,
  stageManager: editorStageManagerSchema
});

interface WaifuEditorMeta {
  isDraft: boolean;
  isDiscordReady: boolean;
  isAiReady: boolean;
  isChatReady: boolean;
  isRuntimeReady: boolean;
  runtimeValidationErrors: string[];
  migrationWarnings: MigrationWarning[];
}

interface WaifuEditorGuildState {
  guildId: string;
  relationships: Array<StageManagerRelationshipEntry & { participantKey: string }>;
  memories: StageManagerMemoryEntry[];
}

interface WaifuEditorPayload {
  waifu: WaifuDocument;
  stageManager: {
    guilds: WaifuEditorGuildState[];
  };
  meta: WaifuEditorMeta;
}

interface InvalidWaifuRow extends InvalidLocalDocument {
  migrationWarnings: MigrationWarning[];
}

interface LocalEditorState {
  waifus: WaifuEditorPayload[];
  invalidWaifus: InvalidWaifuRow[];
}

export function setupWaifuRoutes(
  app: Express,
  deps: {
    config: ConfigManager;
    botManager: BotManager;
    stageManagerStore: StageManagerStateStore;
  }
): void {
  app.get(
    "/api/waifus/template",
    asyncRoute(async (_request, response) => {
      const template = await deps.config.defaultsStore.readDefaultWaifuTemplate();
      response.json(buildLocalWaifuPayloadFromTemplate(template));
    })
  );

  app.get(
    "/api/waifus",
    asyncRoute(async (_request, response) => {
      const state = await buildLocalEditorState(deps.config);
      response.json(state);
    })
  );

  app.get(
    "/api/waifus/:id",
    asyncRoute(async (request, response) => {
      const state = await buildLocalEditorState(deps.config);
      const waifu = state.waifus.find((entry) => entry.waifu.id === request.params.id);
      if (waifu) {
        response.json(waifu);
        return;
      }

      const invalid = state.invalidWaifus.find((entry) => entry.idHint === request.params.id);
      if (invalid) {
        response.status(400).json({
          error: invalid.error,
          filePath: invalid.filePath,
          migrationWarnings: invalid.migrationWarnings
        });
        return;
      }

      response.status(404).json({ error: "Waifu not found" });
    })
  );

  app.post(
    "/api/waifus",
    asyncRoute(async (request, response) => {
      const payload = waifuEditorWriteSchema.parse(request.body);
      const state = await buildLocalEditorState(deps.config);
      if (state.waifus.some((entry) => entry.waifu.id === payload.waifu.id)) {
        response.status(409).json({ error: "Waifu with this id already exists" });
        return;
      }
      if (state.invalidWaifus.some((entry) => entry.idHint === payload.waifu.id)) {
        response.status(409).json({
          error: "A malformed waifu document already exists for this id"
        });
        return;
      }

      try {
        const created = await saveLocalWaifuEditorPayload({
          config: deps.config,
          stageManagerStore: deps.stageManagerStore,
          nextPayload: payload,
          mode: "create"
        });
        response.status(201).json(created);
      } catch (error) {
        respondWithWaifuMutationError(response, error);
      }
    })
  );

  app.put(
    "/api/waifus/:id",
    asyncRoute(async (request, response) => {
      const payload = waifuEditorWriteSchema.parse(request.body);
      const waifuId = String(request.params.id);

      if (payload.waifu.id !== waifuId) {
        response.status(400).json({
          error: "Waifu id is immutable and must match the route parameter"
        });
        return;
      }

      const state = await buildLocalEditorState(deps.config);
      const existing = state.waifus.find((entry) => entry.waifu.id === waifuId);
      if (!existing) {
        response.status(404).json({ error: "Waifu not found" });
        return;
      }

      try {
        const updated = await saveLocalWaifuEditorPayload({
          config: deps.config,
          stageManagerStore: deps.stageManagerStore,
          existingPayload: existing,
          nextPayload: payload,
          mode: "update"
        });
        response.json(updated);
      } catch (error) {
        respondWithWaifuMutationError(response, error);
      }
    })
  );

  app.delete(
    "/api/waifus/:id",
    asyncRoute(async (request, response) => {
      const waifuId = String(request.params.id);
      const state = await buildLocalEditorState(deps.config);
      const existing = state.waifus.find((entry) => entry.waifu.id === waifuId);
      if (!existing) {
        response.status(404).json({ error: "Waifu not found" });
        return;
      }

      try {
        await deleteLocalWaifuEditorPayload(deps.config, deps.stageManagerStore, waifuId);
        response.status(204).end();
      } catch (error) {
        respondWithWaifuMutationError(response, error);
      }
    })
  );

  app.post(
    "/api/waifus/:id/avatar",
    upload.single("file"),
    asyncRoute(async (request, response) => {
      const updated = await updateWaifuAsset(
        deps.config,
        String(request.params.id),
        "avatarPath",
        "avatar",
        request.file
      );
      response.json({ ok: true, waifu: updated });
    })
  );

  app.post(
    "/api/waifus/:id/banner",
    upload.single("file"),
    asyncRoute(async (request, response) => {
      const updated = await updateWaifuAsset(
        deps.config,
        String(request.params.id),
        "bannerPath",
        "banner",
        request.file
      );
      response.json({ ok: true, waifu: updated });
    })
  );

  app.post(
    "/api/waifus/:id/start",
    asyncRoute(async (request, response) => {
      const waifuId = String(request.params.id);
      const state = await buildLocalEditorState(deps.config);
      const entry = state.waifus.find((candidate) => candidate.waifu.id === waifuId);
      if (!entry) {
        response.status(404).json({ error: "Waifu not found" });
        return;
      }

      if (!entry.meta.isDiscordReady) {
        response.status(400).json({
          error: "Waifu is not Discord-ready",
          meta: entry.meta
        });
        return;
      }

      await deps.botManager.startBot(entry.waifu as WaifuConfig);
      await deps.botManager.applyGuildNicknames(
        entry.waifu.id,
        getGuildIdsForWaifuDocuments(entry.waifu.id, deps.config.channels)
      );
      response.json({ ok: true, meta: entry.meta });
    })
  );

  app.post(
    "/api/waifus/:id/stop",
    asyncRoute(async (request, response) => {
      await deps.botManager.stopBot(String(request.params.id));
      response.json({ ok: true });
    })
  );
}

async function buildLocalEditorState(config: ConfigManager): Promise<LocalEditorState> {
  const [composed, stageManagerDocuments, migrationWarnings] = await Promise.all([
    config.composer.compose(),
    config.runtimeStore.listStageManagerDocuments(),
    config.runtimeStore.readMigrationWarnings()
  ]);

  const invalidStageDocuments = new Map<string, InvalidWaifuRow>();
  for (const invalid of stageManagerDocuments.invalid) {
    if (invalid.idHint) {
      invalidStageDocuments.set(invalid.idHint, {
        ...invalid,
        migrationWarnings: migrationWarnings.waifuWarnings[invalid.idHint] ?? []
      });
    }
  }

  const composedWaifuIds = new Set(composed.waifuDocuments.map((entry) => entry.waifu.id));
  const waifus = composed.waifuDocuments
    .filter((entry) => !invalidStageDocuments.has(entry.waifu.id))
    .map((entry) => {
      const stageManagerDocument =
        stageManagerDocuments.documents.find((document) => document.waifuId === entry.waifu.id) ??
        createEmptyStageManagerWaifuDocument(entry.waifu.id);
      return buildLocalWaifuPayload(
        entry,
        stageManagerDocument,
        migrationWarnings.waifuWarnings[entry.waifu.id] ?? []
      );
    });

  const invalidWaifus: InvalidWaifuRow[] = [
    ...composed.invalidWaifus.map((entry) => ({
      ...entry,
      migrationWarnings: entry.idHint ? migrationWarnings.waifuWarnings[entry.idHint] ?? [] : []
    })),
    ...stageManagerDocuments.invalid.map((entry) => ({
      ...entry,
      migrationWarnings: entry.idHint ? migrationWarnings.waifuWarnings[entry.idHint] ?? [] : []
    })),
    ...stageManagerDocuments.documents
      .filter((document) => !composedWaifuIds.has(document.waifuId))
      .map((document) => ({
        filePath: config.paths.stageManagerDataFile(document.waifuId),
        idHint: document.waifuId,
        error: "Orphaned stage-manager data file without a waifu document",
        migrationWarnings: migrationWarnings.waifuWarnings[document.waifuId] ?? []
      }))
  ];

  return {
    waifus,
    invalidWaifus
  };
}

function buildLocalWaifuPayload(
  waifu: ComposedWaifuDocument,
  stageManagerDocument: StageManagerWaifuDocument,
  migrationWarnings: MigrationWarning[]
): WaifuEditorPayload {
  return {
    waifu: waifu.waifu,
    stageManager: stageManagerDocumentToEditor(stageManagerDocument),
    meta: {
      ...waifu.meta,
      migrationWarnings
    }
  };
}

function buildLocalWaifuPayloadFromTemplate(template: WaifuDocument): WaifuEditorPayload {
  return {
    waifu: template,
    stageManager: {
      guilds: []
    },
    meta: {
      isDraft: true,
      isDiscordReady: false,
      isAiReady: false,
      isChatReady: false,
      isRuntimeReady: false,
      runtimeValidationErrors: [
        "Missing Discord bot token",
        "Application ID missing",
        "Personality description missing",
        "Backstory missing",
        "AI provider missing",
        "AI model missing"
      ],
      migrationWarnings: []
    }
  };
}

async function saveLocalWaifuEditorPayload(args: {
  config: ConfigManager;
  stageManagerStore: StageManagerStateStore;
  existingPayload?: WaifuEditorPayload;
  nextPayload: z.infer<typeof waifuEditorWriteSchema>;
  mode: "create" | "update";
}): Promise<WaifuEditorPayload> {
  const nextWaifu = waifuDocumentSchema.parse(args.nextPayload.waifu);
  const nextStageManager = editorStageManagerSchema.parse(args.nextPayload.stageManager);

  const currentWaifu = args.existingPayload?.waifu;
  const currentStageManager = args.existingPayload?.stageManager ?? { guilds: [] };

  const waifuChanged =
    args.mode === "create" ||
    serializeForCompare(normalizeWaifuDocument(currentWaifu)) !==
      serializeForCompare(normalizeWaifuDocument(nextWaifu));
  const stageManagerChanged =
    args.mode === "create" ||
    serializeForCompare(normalizeEditorStageManager(currentStageManager)) !==
      serializeForCompare(normalizeEditorStageManager(nextStageManager));

  let waifuCommitted = false;
  let stageManagerCommitted = false;

  try {
    if (waifuChanged) {
      await args.config.runtimeStore.writeWaifuDocument(nextWaifu);
      waifuCommitted = true;
    }

    if (stageManagerChanged) {
      await args.stageManagerStore.replaceWaifuStateDocument(
        nextWaifu.id,
        editorStageManagerToGuildMap(nextStageManager)
      );
      stageManagerCommitted = true;
    }
  } catch (error) {
    if (waifuCommitted) {
      await args.config.refreshFromDisk("waifus.json");
    }
    throw new WaifuMutationError(
      "Primary waifu save committed partially",
      500,
      error,
      { waifuCommitted, stageManagerCommitted }
    );
  }

  let didRewriteChannels = false;
  try {
    if (waifuChanged) {
      didRewriteChannels = await pruneInvalidChannelReferences(args.config);
    }
  } catch (error) {
    if (waifuCommitted || didRewriteChannels) {
      await args.config.refreshFromDisk("waifus.json");
    }
    throw new WaifuMutationError(
      "Waifu saved, but secondary cleanup failed",
      500,
      error,
      { waifuCommitted, stageManagerCommitted, channelsPruned: didRewriteChannels }
    );
  }

  if (waifuCommitted || didRewriteChannels) {
    await args.config.refreshFromDisk("waifus.json");
  }

  const state = await buildLocalEditorState(args.config);
  const saved = state.waifus.find((entry) => entry.waifu.id === nextWaifu.id);
  if (!saved) {
    throw new Error("Saved waifu could not be reloaded");
  }
  return saved;
}

async function deleteLocalWaifuEditorPayload(
  config: ConfigManager,
  stageManagerStore: StageManagerStateStore,
  waifuId: string
): Promise<void> {
  let waifuCommitted = false;
  let stageManagerCommitted = false;

  try {
    await config.runtimeStore.deleteWaifuDocument(waifuId);
    waifuCommitted = true;
    await stageManagerStore.deleteWaifuStateDocument(waifuId);
    stageManagerCommitted = true;
  } catch (error) {
    if (waifuCommitted) {
      await config.refreshFromDisk("waifus.json");
    }
    throw new WaifuMutationError(
      "Primary waifu delete committed partially",
      500,
      error,
      { waifuCommitted, stageManagerCommitted }
    );
  }

  let didRewriteChannels = false;
  try {
    didRewriteChannels = await pruneInvalidChannelReferences(config);
    await cleanupManualRelationshipReferences(config, waifuId);
    await cleanupStageManagerParticipantReferences(config, stageManagerStore, waifuId);
    await fs.rm(config.paths.waifuAssetsDir(waifuId), { recursive: true, force: true });
  } catch (error) {
    await config.refreshFromDisk("waifus.json");
    throw new WaifuMutationError(
      "Waifu deleted, but secondary cleanup failed",
      500,
      error,
      { waifuCommitted, stageManagerCommitted, channelsPruned: didRewriteChannels }
    );
  }

  await config.refreshFromDisk("waifus.json");
}

async function updateWaifuAsset(
  config: ConfigManager,
  waifuId: string,
  key: "avatarPath" | "bannerPath",
  stem: "avatar" | "banner",
  file?: Express.Multer.File
): Promise<WaifuEditorPayload> {
  if (!file) {
    throw new Error("No file uploaded");
  }

  const document = await config.runtimeStore.readWaifuDocument(waifuId);
  const assetDirectory = config.paths.waifuAssetsDir(waifuId);
  await fs.mkdir(assetDirectory, { recursive: true });

  for (const entry of await fs.readdir(assetDirectory)) {
    if (entry.startsWith(`${stem}.`)) {
      await fs.rm(path.join(assetDirectory, entry), { force: true });
    }
  }

  const extension = getAssetExtension(file);
  const relativeAssetPath = path.posix.join("waifus", waifuId, `${stem}${extension}`);
  await fs.writeFile(path.join(assetDirectory, `${stem}${extension}`), file.buffer);
  await config.runtimeStore.writeWaifuDocument({
    ...document,
    [key]: relativeAssetPath
  });
  await config.refreshFromDisk("waifus.json");

  const state = await buildLocalEditorState(config);
  const updated = state.waifus.find((entry) => entry.waifu.id === waifuId);
  if (!updated) {
    throw new Error("Waifu not found after asset update");
  }
  return updated;
}

async function pruneInvalidChannelReferences(config: ConfigManager): Promise<boolean> {
  const [channels, composed] = await Promise.all([
    config.runtimeStore.readChannels(),
    config.composer.compose()
  ]);
  const validWaifuIds = new Set(composed.runtimeWaifus.map((entry) => entry.id));
  const nextChannels = channels.channels.map((channel) => ({
    ...channel,
    activeWaifuIds: channel.activeWaifuIds.filter((waifuId) => validWaifuIds.has(waifuId))
  }));

  if (serializeForCompare(channels.channels) === serializeForCompare(nextChannels)) {
    return false;
  }

  await config.runtimeStore.writeChannels({ channels: nextChannels });
  return true;
}

async function cleanupManualRelationshipReferences(
  config: ConfigManager,
  deletedWaifuId: string
): Promise<void> {
  const documents = await config.runtimeStore.listWaifuDocuments();
  for (const waifu of documents.documents) {
    if (waifu.id === deletedWaifuId || !(deletedWaifuId in waifu.personality.relationshipsWithOtherWaifus)) {
      continue;
    }

    const nextRelationships = { ...waifu.personality.relationshipsWithOtherWaifus };
    delete nextRelationships[deletedWaifuId];
    await config.runtimeStore.writeWaifuDocument({
      ...waifu,
      personality: {
        ...waifu.personality,
        relationshipsWithOtherWaifus: nextRelationships
      }
    });
  }
}

async function cleanupStageManagerParticipantReferences(
  config: ConfigManager,
  stageManagerStore: StageManagerStateStore,
  deletedWaifuId: string
): Promise<void> {
  const documents = await config.runtimeStore.listStageManagerDocuments();
  for (const document of documents.documents) {
    if (document.waifuId === deletedWaifuId) {
      continue;
    }

    let changed = false;
    const nextGuilds = Object.fromEntries(
      Object.entries(document.guilds).map(([guildId, guildState]) => {
        const nextRelationships = Object.fromEntries(
          Object.entries(guildState.relationshipsByParticipant).filter(([participantKey, relationship]) => {
            const shouldKeep =
              participantKey !== `waifu:${deletedWaifuId}` && relationship.targetWaifuId !== deletedWaifuId;
            if (!shouldKeep) {
              changed = true;
            }
            return shouldKeep;
          })
        );

        return [
          guildId,
          {
            ...guildState,
            relationshipsByParticipant: nextRelationships
          }
        ];
      })
    );

    if (!changed) {
      continue;
    }

    await stageManagerStore.replaceWaifuStateDocument(document.waifuId, nextGuilds);
  }
}

function stageManagerDocumentToEditor(document: StageManagerWaifuDocument): { guilds: WaifuEditorGuildState[] } {
  return {
    guilds: Object.entries(document.guilds)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([guildId, guildState]) => ({
        guildId,
        relationships: Object.entries(guildState.relationshipsByParticipant)
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([participantKey, relationship]) => ({
            participantKey,
            ...relationship
          })),
        memories: [...guildState.memories].sort((left, right) => left.slot - right.slot)
      }))
  };
}

function editorStageManagerToGuildMap(
  stageManager: z.infer<typeof editorStageManagerSchema>
): Record<string, StageManagerWaifuDocument["guilds"][string]> {
  return Object.fromEntries(
    stageManager.guilds.map((guild) => [
      guild.guildId,
      {
        relationshipsByParticipant: Object.fromEntries(
          guild.relationships.map((relationship) => [
            relationship.participantKey,
            stageManagerRelationshipEntrySchema.parse({
              targetKind: relationship.targetKind,
              targetName: relationship.targetName,
              targetUserId: relationship.targetUserId,
              targetWaifuId: relationship.targetWaifuId,
              relationship: relationship.relationship,
              updatedAt: relationship.updatedAt
            })
          ])
        ),
        memories: guild.memories.map((memory) => stageManagerMemoryEntrySchema.parse(memory))
      }
    ])
  );
}

function normalizeWaifuDocument(waifu: WaifuDocument | undefined) {
  if (!waifu) {
    return null;
  }

  return {
    ...waifu,
    personality: {
      ...waifu.personality,
      relationshipsWithOtherWaifus: Object.fromEntries(
        Object.entries(waifu.personality.relationshipsWithOtherWaifus).sort((left, right) =>
          left[0].localeCompare(right[0])
        )
      )
    }
  };
}

function normalizeEditorStageManager(stageManager: { guilds: WaifuEditorGuildState[] }) {
  return {
    guilds: [...stageManager.guilds]
      .map((guild) => ({
        guildId: guild.guildId,
        relationships: [...guild.relationships].sort((left, right) =>
          left.participantKey.localeCompare(right.participantKey)
        ),
        memories: [...guild.memories].sort((left, right) => left.slot - right.slot)
      }))
      .sort((left, right) => left.guildId.localeCompare(right.guildId))
  };
}

function serializeForCompare(value: unknown): string {
  return JSON.stringify(value);
}

function getAssetExtension(file: Express.Multer.File): string {
  const originalExtension = path.extname(file.originalname).toLowerCase();
  if (/^\.[a-z0-9]{1,10}$/.test(originalExtension)) {
    return originalExtension;
  }

  switch (file.mimetype) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".jpg";
  }
}

function getGuildIdsForWaifuDocuments(
  waifuId: string,
  channels: Array<{ guildId: string; activeWaifuIds: string[] }>
): string[] {
  return [
    ...new Set(
      channels
        .filter((channel) => channel.activeWaifuIds.includes(waifuId))
        .map((channel) => channel.guildId)
    )
  ];
}

class WaifuMutationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly cause: unknown,
    readonly details: Record<string, unknown>
  ) {
    super(message);
  }
}

function respondWithWaifuMutationError(
  response: Parameters<Express["response"]["json"]>[0] extends never ? never : {
    status: (code: number) => { json: (body: unknown) => void };
  },
  error: unknown
): void {
  if (error instanceof WaifuMutationError) {
    response.status(error.statusCode).json({
      error: error.message,
      details: error.details,
      cause: error.cause instanceof Error ? error.cause.message : String(error.cause)
    });
    return;
  }

  throw error;
}

export function toAssetPreviewUrl(assetPath: string | null): string | null {
  if (!assetPath) {
    return null;
  }

  if (assetPath.startsWith("http://") || assetPath.startsWith("https://") || assetPath.startsWith("/")) {
    return assetPath;
  }

  return `${localAssetUrlPrefix}/${assetPath}`;
}
