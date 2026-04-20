import type { LocalConfigPaths } from "./local-config-paths.js";
import { LocalRuntimeStore } from "./local-config/local-runtime-store.js";
import {
  channelStageStateSchema,
  createEmptyStageManagerWaifuDocument,
  stageManagerCheckpointsFileSchema,
  type ChannelConfig,
  type ChannelStageState,
  type MemoryUpdate,
  type RelationshipEntry,
  type RelationshipUpdate,
  type StageManagerConfig,
  type StageManagerDecision,
  type StageManagerState,
  type StageManagerWaifuDocument,
  waifuStageStateSchema,
  type WaifuConfig,
  type WaifuStageState
} from "./types/index.js";

interface ApplyDecisionArgs {
  decision: StageManagerDecision;
  config: StageManagerConfig;
  knownWaifus: WaifuConfig[];
  availableParticipantsByKey: Map<string, StageManagerParticipant>;
  timestamp: string;
  checkpointScopeId: string;
  checkpointPatch: Partial<ChannelStageState>;
}

export interface StageManagerParticipant {
  key: string;
  targetKind: "user" | "waifu";
  targetName: string;
  targetUserId: string | null;
  targetWaifuId: string | null;
}

export interface StageManagerApplyResult {
  relationshipUpdateCount: number;
  memoryUpdateCount: number;
  affectedWaifuIds: string[];
  affectedParticipantKeys: string[];
}

export interface StageManagerStateStore {
  readonly mode: "local";
  load(): Promise<unknown>;
  snapshot(): unknown;
  getCheckpointScopeId(channel: Pick<ChannelConfig, "channelId" | "guildId">): string;
  getWaifuState(waifuId: string, checkpointScopeId: string): WaifuStageState;
  getCheckpoint(checkpointScopeId: string): ChannelStageState;
  replaceWaifuStateDocument(
    waifuId: string,
    guildStates: Record<string, WaifuStageState>
  ): Promise<void>;
  deleteWaifuStateDocument(waifuId: string): Promise<void>;
  saveCheckpoint(
    checkpointScopeId: string,
    patch: Partial<ChannelStageState>
  ): Promise<ChannelStageState>;
  applyDecisionAndSave(args: ApplyDecisionArgs): Promise<StageManagerApplyResult>;
}

export class StageManagerDataStore implements StageManagerStateStore {
  readonly mode = "local" as const;
  private readonly runtimeStore: LocalRuntimeStore;
  private documents = new Map<string, StageManagerWaifuDocument>();
  private checkpoints = stageManagerCheckpointsFileSchema.parse({ guilds: {} });
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(paths: LocalConfigPaths) {
    this.runtimeStore = new LocalRuntimeStore(paths);
  }

  async load(): Promise<unknown> {
    await this.runtimeStore.ensureRuntimeDirectories();
    const [documentsResult, checkpoints] = await Promise.all([
      this.runtimeStore.listStageManagerDocuments(),
      this.runtimeStore.readStageManagerCheckpoints()
    ]);

    this.documents = new Map(
      documentsResult.documents.map((document) => [document.waifuId, document] as const)
    );
    this.checkpoints = checkpoints;
    return this.snapshot();
  }

  snapshot(): unknown {
    return {
      waifus: Object.fromEntries(
        [...this.documents.entries()].map(([waifuId, document]) => [waifuId, structuredClone(document.guilds)])
      ),
      guilds: structuredClone(this.checkpoints.guilds)
    };
  }

  getCheckpointScopeId(channel: Pick<ChannelConfig, "channelId" | "guildId">): string {
    return channel.guildId;
  }

  getWaifuState(waifuId: string, checkpointScopeId: string): WaifuStageState {
    return structuredClone(
      this.documents.get(waifuId)?.guilds[checkpointScopeId] ?? waifuStageStateSchema.parse({})
    );
  }

  getCheckpoint(checkpointScopeId: string): ChannelStageState {
    return structuredClone(this.checkpoints.guilds[checkpointScopeId] ?? channelStageStateSchema.parse({}));
  }

  async replaceWaifuStateDocument(
    waifuId: string,
    guildStates: Record<string, WaifuStageState>
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const document = createEmptyStageManagerWaifuDocument(waifuId);
      document.guilds = Object.fromEntries(
        Object.entries(guildStates).map(([guildId, state]) => [
          guildId,
          waifuStageStateSchema.parse(structuredClone(state))
        ])
      );
      await this.runtimeStore.writeStageManagerDocument(document);
      this.documents.set(waifuId, document);
    });
  }

  async deleteWaifuStateDocument(waifuId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.runtimeStore.deleteStageManagerDocument(waifuId);
      this.documents.delete(waifuId);
    });
  }

  async saveCheckpoint(
    checkpointScopeId: string,
    patch: Partial<ChannelStageState>
  ): Promise<ChannelStageState> {
    await this.enqueueWrite(async () => {
      const nextCheckpoints = structuredClone(this.checkpoints);
      const existing = nextCheckpoints.guilds[checkpointScopeId] ?? channelStageStateSchema.parse({});
      nextCheckpoints.guilds[checkpointScopeId] = channelStageStateSchema.parse({
        ...existing,
        ...patch
      });
      await this.runtimeStore.writeStageManagerCheckpoints(nextCheckpoints);
      this.checkpoints = nextCheckpoints;
    });

    return this.getCheckpoint(checkpointScopeId);
  }

  async applyDecisionAndSave(args: ApplyDecisionArgs): Promise<StageManagerApplyResult> {
    let result: StageManagerApplyResult = {
      relationshipUpdateCount: 0,
      memoryUpdateCount: 0,
      affectedWaifuIds: [],
      affectedParticipantKeys: []
    };

    await this.enqueueWrite(async () => {
      const affectedWaifuIds = new Set<string>();
      const affectedParticipantKeys = new Set<string>();
      const stagedDocuments = new Map<string, StageManagerWaifuDocument>();
      let relationshipUpdateCount = 0;
      let memoryUpdateCount = 0;

      for (const update of args.decision.relationshipUpdates) {
        const document = getMutableDocument(stagedDocuments, this.documents, update.waifuId);
        const guildState = getMutableGuildState(document, args.checkpointScopeId);
        if (
          applyRelationshipUpdateToState(
            update,
            guildState,
            args.config,
            args.knownWaifus,
            args.availableParticipantsByKey,
            args.timestamp
          )
        ) {
          relationshipUpdateCount += 1;
          affectedWaifuIds.add(update.waifuId);
          affectedParticipantKeys.add(update.targetParticipantKey);
        }
      }

      for (const update of args.decision.memoryUpdates) {
        const document = getMutableDocument(stagedDocuments, this.documents, update.waifuId);
        const guildState = getMutableGuildState(document, args.checkpointScopeId);
        if (applyMemoryUpdateToState(update, guildState, args.config, args.timestamp)) {
          memoryUpdateCount += 1;
          affectedWaifuIds.add(update.waifuId);
        }
      }

      for (const [waifuId, document] of [...stagedDocuments.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
        await this.runtimeStore.writeStageManagerDocument(document);
        this.documents.set(waifuId, document);
      }

      const nextCheckpoints = structuredClone(this.checkpoints);
      const existingCheckpoint = nextCheckpoints.guilds[args.checkpointScopeId] ?? channelStageStateSchema.parse({});
      nextCheckpoints.guilds[args.checkpointScopeId] = channelStageStateSchema.parse({
        ...existingCheckpoint,
        ...args.checkpointPatch
      });
      await this.runtimeStore.writeStageManagerCheckpoints(nextCheckpoints);
      this.checkpoints = nextCheckpoints;

      result = {
        relationshipUpdateCount,
        memoryUpdateCount,
        affectedWaifuIds: [...affectedWaifuIds],
        affectedParticipantKeys: [...affectedParticipantKeys]
      };
    });

    return result;
  }

  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.writeQueue;
    let release: () => void = () => {};
    this.writeQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

function getMutableDocument(
  stagedDocuments: Map<string, StageManagerWaifuDocument>,
  existingDocuments: Map<string, StageManagerWaifuDocument>,
  waifuId: string
): StageManagerWaifuDocument {
  const existing = stagedDocuments.get(waifuId);
  if (existing) {
    return existing;
  }

  const cloned = structuredClone(
    existingDocuments.get(waifuId) ?? createEmptyStageManagerWaifuDocument(waifuId)
  );
  stagedDocuments.set(waifuId, cloned);
  return cloned;
}

function getMutableGuildState(
  document: StageManagerWaifuDocument,
  checkpointScopeId: string
): WaifuStageState {
  if (!document.guilds[checkpointScopeId]) {
    document.guilds[checkpointScopeId] = waifuStageStateSchema.parse({});
  }
  return document.guilds[checkpointScopeId];
}

function applyRelationshipUpdateToState(
  update: RelationshipUpdate,
  state: WaifuStageState,
  config: StageManagerConfig,
  knownWaifus: WaifuConfig[],
  participantsByKey: Map<string, StageManagerParticipant>,
  timestamp: string
): boolean {
  const participant = participantsByKey.get(update.targetParticipantKey);
  if (!participant) {
    return false;
  }

  const existing = state.relationshipsByParticipant[update.targetParticipantKey];
  if (!existing && Object.keys(state.relationshipsByParticipant).length >= config.maxRelationshipsPerWaifu) {
    return false;
  }

  const normalizedName =
    participant.targetKind === "waifu" && participant.targetWaifuId
      ? knownWaifus.find((entry) => entry.id === participant.targetWaifuId)?.name ?? participant.targetName
      : participant.targetName;

  const nextEntry: RelationshipEntry = {
    targetKind: participant.targetKind,
    targetName: normalizedName,
    targetUserId: participant.targetUserId,
    targetWaifuId: participant.targetWaifuId,
    relationship: update.relationship.trim(),
    updatedAt: timestamp
  };
  state.relationshipsByParticipant[update.targetParticipantKey] = nextEntry;
  return true;
}

function applyMemoryUpdateToState(
  update: MemoryUpdate,
  state: WaifuStageState,
  config: StageManagerConfig,
  timestamp: string
): boolean {
  const maxMemories = config.maxMemoriesPerWaifu;
  const note = update.note.trim();
  const existingByNote = state.memories.find((entry) => entry.note === note);

  if (existingByNote) {
    existingByNote.note = note;
    existingByNote.sourceMessageIds = update.sourceMessageIds.slice(0, 5);
    existingByNote.updatedAt = timestamp;
    return true;
  }

  const occupiedSlots = new Set(state.memories.map((entry) => entry.slot));
  const firstFreeSlot = findFirstFreeSlot(occupiedSlots, maxMemories);
  const requestedSlot = update.slot
    ? Math.min(Math.max(update.slot, 1), maxMemories)
    : null;

  let targetSlot: number;
  if (requestedSlot !== null) {
    if (firstFreeSlot !== null && requestedSlot > firstFreeSlot) {
      targetSlot = firstFreeSlot;
    } else {
      targetSlot = requestedSlot;
    }
  } else if (firstFreeSlot !== null) {
    targetSlot = firstFreeSlot;
  } else {
    targetSlot = [...state.memories]
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0]?.slot ?? 1;
  }

  const existingAtSlot = state.memories.find((entry) => entry.slot === targetSlot);
  const nextMemory = {
    slot: targetSlot,
    note,
    sourceMessageIds: update.sourceMessageIds.slice(0, 5),
    updatedAt: timestamp
  };

  if (existingAtSlot) {
    existingAtSlot.note = nextMemory.note;
    existingAtSlot.sourceMessageIds = nextMemory.sourceMessageIds;
    existingAtSlot.updatedAt = nextMemory.updatedAt;
    return true;
  }

  state.memories.push(nextMemory);
  state.memories.sort((left, right) => left.slot - right.slot);
  if (state.memories.length > maxMemories) {
    state.memories.length = maxMemories;
  }
  return true;
}

function findFirstFreeSlot(occupiedSlots: Set<number>, maxMemories: number): number | null {
  for (let slot = 1; slot <= maxMemories; slot += 1) {
    if (!occupiedSlots.has(slot)) {
      return slot;
    }
  }

  return null;
}
