// Per-channel session state (user/servers/<guild>/sessions/<channel>.json): active pipeline and
// the persisted retrigger wake.

import { rm } from "node:fs/promises";
import path from "node:path";
import { resolveDataPath } from "../../config/paths.js";
import { nowIso } from "../../shared/schemas/common.js";
import { StorageService } from "../../storage/storageService.js";
import { type ChannelSessionState, ChannelSessionStateSchema, createEmptyChannelSessionState } from "../session.js";

export function sessionRelativePath(guildId: string, channelId: string): string {
  return path.join("user", "servers", guildId, "sessions", `${channelId}.json`);
}

/** Forget a channel's session file (a deleted or expired thread). A missing file is fine. */
export async function removeChannelSession(storage: StorageService, guildId: string, channelId: string): Promise<void> {
  await storage.withLocks([`session:${guildId}:${channelId}`], () =>
    rm(resolveDataPath(storage.dataRoot, sessionRelativePath(guildId, channelId)), { force: true })
  );
}

export async function ensureChannelSession(storage: StorageService, guildId: string, channelId: string): Promise<ChannelSessionState> {
  return storage.updateRevisionedJson({
    resourceKey: `session:${guildId}:${channelId}`,
    relativePath: sessionRelativePath(guildId, channelId),
    schema: ChannelSessionStateSchema,
    fallback: createEmptyChannelSessionState(guildId, channelId),
    transform: (current) => current
  });
}

async function readChannelSession(storage: StorageService, guildId: string, channelId: string): Promise<ChannelSessionState> {
  return storage.withLocks(
    [`session:${guildId}:${channelId}`],
    () => storage.readJson(
      sessionRelativePath(guildId, channelId),
      ChannelSessionStateSchema,
      createEmptyChannelSessionState(guildId, channelId)
    )
  );
}

export async function updateSession(
  storage: StorageService,
  guildId: string,
  channelId: string,
  transform: (current: ChannelSessionState) => ChannelSessionState
): Promise<ChannelSessionState> {
  return storage.updateRevisionedJson({
    resourceKey: `session:${guildId}:${channelId}`,
    relativePath: sessionRelativePath(guildId, channelId),
    schema: ChannelSessionStateSchema,
    fallback: createEmptyChannelSessionState(guildId, channelId),
    transform
  });
}

export async function setActivePipeline(storage: StorageService, guildId: string, channelId: string, kind: "orchestrator" | "waifu") {
  await updateSession(storage, guildId, channelId, (current) => ({
    ...current,
    activePipeline: { kind, startedAt: nowIso() }
  }));
}

export async function markSessionIdle(storage: StorageService, guildId: string, channelId: string) {
  await updateSession(storage, guildId, channelId, (current) => ({
    ...current,
    activePipeline: null
  }));
}

export async function clearScheduledRetrigger(storage: StorageService, guildId: string, channelId: string): Promise<void> {
  await updateSession(storage, guildId, channelId, (current) => {
    const { scheduledRetriggerAt: _scheduledRetriggerAt, scheduledRetrigger: _scheduledRetrigger, ...rest } = current;
    return {
      ...rest,
      activePipeline: null
    };
  });
}

// Drop the persisted wake (if any) without touching activePipeline; skips the write when unset.
export async function consumeScheduledRetrigger(storage: StorageService, guildId: string, channelId: string): Promise<void> {
  const session = await readChannelSession(storage, guildId, channelId);
  if (!session.scheduledRetriggerAt && !session.scheduledRetrigger) return;
  await updateSession(storage, guildId, channelId, (current) => {
    const { scheduledRetriggerAt: _scheduledRetriggerAt, scheduledRetrigger: _scheduledRetrigger, ...rest } = current;
    return rest;
  });
}

export async function persistShutdownWake(storage: StorageService, guildId: string, channelId: string): Promise<void> {
  await updateSession(storage, guildId, channelId, (current) =>
    current.scheduledRetriggerAt
      ? current
      : { ...current, scheduledRetriggerAt: nowIso(), scheduledRetrigger: { source: "shutdown", seconds: 0 } }
  );
}
