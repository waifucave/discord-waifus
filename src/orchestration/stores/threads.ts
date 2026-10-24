// Threads and forum posts (spec 9.5): `user/servers/<guildId>/threads.json` records the threads the
// bot has seen. A thread is its own conversation (`g_<guild>_<threadId>`) that inherits the parent
// channel's cast; it is never auto-created as a channel entry. The runtime sees threads through
// `ensureServer`'s overlay: a virtual channel entry (`thread: { parentId }`) per live thread whose
// parent has a cast, so every `server.channels[id]` reader works unchanged.

import path from "node:path";
import { CURRENT_SCHEMA_VERSION, bumpRevision, createRevisionedBase } from "../../shared/schemas/common.js";
import type { ServerConfig } from "../../shared/schemas/domain.js";
import {
  THREAD_RESUME_WINDOW_MS,
  THREAD_RETENTION_MS,
  ThreadsFileSchema,
  type ThreadKind,
  type ThreadRecord,
  type ThreadsFile
} from "../../shared/schemas/threads.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { resolveDataPath } from "../../config/paths.js";
import type { StorageService } from "../../storage/storageService.js";

type ChannelEntry = ServerConfig["channels"][string];

export const threadsRelativePath = (guildId: string): string => path.join("user", "servers", guildId, "threads.json");
export const threadsResourceKey = (guildId: string): string => `threads:${guildId}`;

/** Activity stamps closer together than this do not rewrite threads.json. */
const TOUCH_GRANULARITY_MS = 60_000;

function emptyThreads(guildId: string): ThreadsFile {
  return ThreadsFileSchema.parse({ ...createRevisionedBase(), guildId });
}

export async function readThreads(storage: StorageService, guildId: string): Promise<ThreadsFile> {
  return storage.readJson(threadsRelativePath(guildId), ThreadsFileSchema, emptyThreads(guildId));
}

export type ThreadObservation = {
  threadId: string;
  parentId: string;
  name?: string;
  kind?: ThreadKind;
  archived?: boolean;
  locked?: boolean;
  /** A message was seen in the thread: stamp `lastActivityAt`. */
  activity?: boolean;
};

/**
 * Record what the gateway just told us about a thread (created, renamed, archived, locked, or a
 * message seen in it). Writes only when something changed (activity is coalesced to a minute) and
 * drops threads idle for 30 days. Returns the stored record.
 */
export async function observeThread(
  storage: StorageService,
  guildId: string,
  observation: ThreadObservation,
  now: Date = new Date(),
  /** Receives the ids of threads dropped by the 30-day idle prune, so the caller can delete their conversations. */
  pruned?: string[]
): Promise<ThreadRecord> {
  return storage.locks.withLock(threadsResourceKey(guildId), async () => {
    const file = await readThreads(storage, guildId);
    const existing = file.threads[observation.threadId];
    const nowIso = now.toISOString();
    const next: ThreadRecord = {
      threadId: observation.threadId,
      parentId: observation.parentId,
      name: observation.name ?? existing?.name ?? "",
      kind: observation.kind ?? existing?.kind ?? "public_thread",
      archived: observation.archived ?? existing?.archived ?? false,
      locked: observation.locked ?? existing?.locked ?? false,
      lastActivityAt: existing?.lastActivityAt ?? nowIso
    };
    if (observation.activity) {
      const last = existing ? Date.parse(existing.lastActivityAt) : Number.NEGATIVE_INFINITY;
      if (!(now.getTime() - last < TOUCH_GRANULARITY_MS)) next.lastActivityAt = nowIso;
    }
    const stale = Object.values(file.threads).filter(
      (thread) => thread.threadId !== next.threadId && now.getTime() - Date.parse(thread.lastActivityAt) > THREAD_RETENTION_MS
    );
    const same =
      existing !== undefined &&
      existing.parentId === next.parentId &&
      existing.name === next.name &&
      existing.kind === next.kind &&
      existing.archived === next.archived &&
      existing.locked === next.locked &&
      existing.lastActivityAt === next.lastActivityAt;
    if (same && stale.length === 0) return existing;
    const threads = { ...file.threads, [next.threadId]: next };
    for (const thread of stale) {
      delete threads[thread.threadId];
      pruned?.push(thread.threadId);
    }
    const written = ThreadsFileSchema.parse(bumpRevision({ ...file, threads, schemaVersion: CURRENT_SCHEMA_VERSION }, nowIso));
    await atomicWriteJson(resolveDataPath(storage.dataRoot, threadsRelativePath(guildId)), written);
    return next;
  });
}

/** The thread was deleted on Discord: forget it. */
export async function removeThread(storage: StorageService, guildId: string, threadId: string, now: Date = new Date()): Promise<boolean> {
  return storage.locks.withLock(threadsResourceKey(guildId), async () => {
    const file = await readThreads(storage, guildId);
    if (!file.threads[threadId]) return false;
    const { [threadId]: _removed, ...threads } = file.threads;
    const written = ThreadsFileSchema.parse(
      bumpRevision({ ...file, threads, schemaVersion: CURRENT_SCHEMA_VERSION }, now.toISOString())
    );
    await atomicWriteJson(resolveDataPath(storage.dataRoot, threadsRelativePath(guildId)), written);
    return true;
  });
}

/**
 * A runtime-only channel entry for a thread. It deliberately carries no `enabled` flag: the runtime
 * only reads `enabledWaifuIds` (a channel is active exactly when that list is non-empty), and the
 * legacy flag is being removed from the schema. The cast covers the field the current schema still
 * defaults to false.
 */
function virtualThreadEntry(entry: Omit<ChannelEntry, "enabled">): ChannelEntry {
  return entry as ChannelEntry;
}

/** A parent channel with a cast whose threads are not switched off. */
export function parentSharesCast(parent: ChannelEntry | undefined): parent is ChannelEntry {
  return Boolean(parent && (parent.enabledWaifuIds?.length ?? 0) > 0 && parent.threads !== "off");
}

/**
 * The channel entry that governs `channelId` (spec 9.5): an explicit entry with waifus wins, else a
 * thread inherits its parent's cast unless the parent's `threads` is "off". Undefined for a plain
 * channel without an entry, or a thread with nothing to inherit.
 */
export function resolveChannelConfig(
  server: Pick<ServerConfig, "channels">,
  channelId: string,
  parentId?: string
): ChannelEntry | undefined {
  const explicit = server.channels[channelId];
  if (explicit && (explicit.enabledWaifuIds?.length ?? 0) > 0) return explicit;
  const inheritFrom = parentId ?? explicit?.thread?.parentId;
  const parent = inheritFrom ? server.channels[inheritFrom] : undefined;
  if (inheritFrom && parentSharesCast(parent)) {
    return virtualThreadEntry({
      channelId,
      ...(explicit?.name ? { name: explicit.name } : {}),
      enabledWaifuIds: [...parent.enabledWaifuIds],
      thread: { parentId: inheritFrom }
    });
  }
  return explicit;
}

/** Live = neither archived nor locked: only live threads take part (replies, timers, resume). */
export function isLiveThread(thread: Pick<ThreadRecord, "archived" | "locked">): boolean {
  return !thread.archived && !thread.locked;
}

/**
 * `server` plus a virtual channel entry for every live thread that inherits a parent's cast.
 * Threads with their own explicit cast, archived or locked threads, and threads whose parent has
 * no cast (or has `threads: "off"`) get no inherited entry, so they stay silent.
 */
export function overlayThreadChannels(server: ServerConfig, threads: ThreadsFile): ServerConfig {
  let channels: ServerConfig["channels"] | undefined;
  for (const thread of Object.values(threads.threads)) {
    const explicit = server.channels[thread.threadId];
    if (explicit && (explicit.enabledWaifuIds?.length ?? 0) > 0) {
      // Explicit cast wins, but the thread's own archive / lock state and activity still apply.
      channels ??= { ...server.channels };
      channels[thread.threadId] = {
        ...explicit,
        thread: {
          parentId: thread.parentId,
          lastActivityAt: thread.lastActivityAt,
          explicit: true,
          ...(isLiveThread(thread) ? {} : { silenced: true })
        }
      };
      continue;
    }
    if (!isLiveThread(thread)) {
      continue;
    }
    const parent = server.channels[thread.parentId];
    if (!parentSharesCast(parent)) continue;
    channels ??= { ...server.channels };
    channels[thread.threadId] = virtualThreadEntry({
      channelId: thread.threadId,
      name: thread.name || explicit?.name,
      enabledWaifuIds: [...parent.enabledWaifuIds],
      thread: { parentId: thread.parentId, lastActivityAt: thread.lastActivityAt }
    });
  }
  return channels ? { ...server, channels } : server;
}

/** `ensureServer`'s overlay step: reads threads.json (a missing file is no threads). */
export async function withThreadChannels(storage: StorageService, server: ServerConfig): Promise<ServerConfig> {
  const threads = await readThreads(storage, server.guildId).catch(() => undefined);
  return threads && Object.keys(threads.threads).length > 0 ? overlayThreadChannels(server, threads) : server;
}

/** True for a virtual thread entry that restart resume should leave alone (idle > 24 h). */
export function isStaleThreadForResume(channel: ChannelEntry, now: Date = new Date()): boolean {
  const at = channel.thread?.lastActivityAt;
  if (!channel.thread) return false;
  if (!at) return false;
  return now.getTime() - Date.parse(at) > THREAD_RESUME_WINDOW_MS;
}

/**
 * Display name for `<place>` (spec 9.5): a plain channel is its name; a thread renders under its
 * parent as `recipes › "Best brownies"`, which the place line shows as
 * `Bake Club › #recipes › "Best brownies"`.
 */
export function channelPlaceName(server: Pick<ServerConfig, "channels">, channelId: string): string | undefined {
  const channel = server.channels[channelId];
  if (!channel) return undefined;
  if (!channel.thread) return channel.name;
  const parent = server.channels[channel.thread.parentId]?.name ?? channel.thread.parentId;
  return `${parent} › "${channel.name ?? channelId}"`;
}
