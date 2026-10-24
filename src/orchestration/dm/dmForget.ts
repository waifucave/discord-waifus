// DM deletion (spec 9.1.4).
//
// `conversation`: the DM conversation directory (ledger, refs, every agent context, observer
// cursor), the DM run records and the conversation's cached images and OCR text. `all`: also the
// DM state file, that waifu's memories and pending observations about the user (by subject, or
// DM-origin from this user's chat). Neither scope touches the rate-limit counters in
// `user/dms/<userId>/limits/` (users can never reset the limiter); only the owner's forget-user
// removes the whole `user/dms/<userId>/` directory.
//
// The bot cannot delete the user's own messages, so a forget also writes a floor message id into
// the limits file (which survives): nothing at or below it is ever read back into the
// conversation (reconcile, conversation cache, observer, resume tail check).

import { readdir, rm } from "node:fs/promises";
import { DiscordImageFetcher } from "../../discord/attachments.js";
import { ConversationLedgerSchema } from "../../shared/schemas/context.js";
import { DEFAULT_APP_CONFIG } from "../../shared/schemas/config.js";
import type { MemoryOrigin, MemorySubject } from "../../shared/schemas/domain.js";
import type { StorageService } from "../../storage/storageService.js";
import { FileContextStore } from "../context/contextStore.js";
import { conversationKey, conversationLedgerPath, type ConversationKey } from "../context/keys.js";
import { subjectIncludesUser } from "../memorySubjects.js";
import { ImageOcrService } from "../ocr.js";
import { readMemoryStore, readPendingObservations, updateMemoryStore, updatePendingObservations } from "../stores/memories.js";
import { dmFloorAt, dmStatePath, dmStateResource, listDmUserIds, readDmState, updateDmLimit, updateExistingDmState } from "./dmStore.js";

export type DmForgetScope = "conversation" | "all";

export type DmForgetInput = {
  userId: string;
  /** One waifu; omitted = every waifu with DM data for the user. */
  waifuId?: string;
  scope: DmForgetScope;
  dryRun?: boolean;
};

export type DmForgetDeleted = {
  dmContexts: number;
  dmStates: number;
  recentRuns: number;
  memories: number;
  observations: number;
  /** Images whose cached bytes existed (and were, or would be, deleted). */
  cachedImages: number;
};

export type DmForgetResult = { dryRun: boolean; scope: DmForgetScope; waifuIds: string[]; deleted: DmForgetDeleted };

export type DmForgetHooks = {
  /** Drop cached image bytes and OCR text (ContextRuntime.purgeImageKeys). Default: on disk. */
  purgeImages?: (keys: string[]) => Promise<void>;
  /** Abort the live DM slot, quiesce its observer and drop cached messages before files go. */
  beforeDelete?: (conversation: { kind: "dm"; waifuId: string; userId: string }) => Promise<void>;
  now?: () => Date;
};

const silentLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function exists(storage: StorageService, ...segments: string[]): Promise<boolean> {
  try {
    await readdir(storage.dataPath(...segments));
    return true;
  } catch {
    return false;
  }
}

/** Waifus with a DM conversation or state for this user. */
async function dmWaifuIdsForUser(storage: StorageService, userId: string): Promise<string[]> {
  const ids = new Set<string>();
  try {
    for (const entry of await readdir(storage.dataPath("user", "conversations"), { withFileTypes: true })) {
      const prefix = `dm_${userId}_`;
      if (entry.isDirectory() && entry.name.startsWith(prefix)) ids.add(entry.name.slice(prefix.length));
    }
  } catch {
    // no conversations yet
  }
  if ((await listDmUserIds(storage)).includes(userId)) {
    for (const entry of await readdir(storage.dataPath("user", "dms", userId), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) ids.add(entry.name.slice(0, -5));
    }
  }
  return [...ids].sort();
}

async function imageKeys(storage: StorageService, key: ConversationKey): Promise<string[]> {
  try {
    const ledger = await storage.readJson(conversationLedgerPath(key), ConversationLedgerSchema);
    return [...new Set(Object.values(ledger.entries).flatMap((entry) => entry.images.map((image) => image.key)))];
  } catch {
    return [];
  }
}

/** A record about this user for this waifu: by subject, or learned in this user's DM. */
export function isAboutDmUser(
  record: { waifuId: string; subjects: MemorySubject[]; origin?: MemoryOrigin },
  userId: string,
  waifuId?: string
): boolean {
  if (waifuId !== undefined && record.waifuId !== waifuId) return false;
  return subjectIncludesUser(record.subjects, userId) || (record.origin?.dm === true && record.origin.userId === userId);
}

export async function dmForget(storage: StorageService, input: DmForgetInput, hooks: DmForgetHooks = {}): Promise<DmForgetResult> {
  const dryRun = input.dryRun === true;
  const waifuIds = input.waifuId ? [input.waifuId] : await dmWaifuIdsForUser(storage, input.userId);
  const deleted: DmForgetDeleted = { dmContexts: 0, dmStates: 0, recentRuns: 0, memories: 0, observations: 0, cachedImages: 0 };
  const store = new FileContextStore(storage);
  const diskImages = new DiscordImageFetcher({ dataRoot: storage.dataRoot, logger: silentLogger });
  const purge =
    hooks.purgeImages ??
    (async (keys: string[]) => {
      await diskImages.purge(keys);
      await new ImageOcrService({ dataRoot: storage.dataRoot, config: DEFAULT_APP_CONFIG.ocr, logger: silentLogger, fetcher: diskImages }).purge(keys);
    });
  for (const waifuId of waifuIds) {
    const conversation = { kind: "dm" as const, waifuId, userId: input.userId };
    const key = conversationKey(conversation);
    const hasConversation = await exists(storage, "user", "conversations", key);
    const state = await readDmState(storage, input.userId, waifuId);
    const images = hasConversation ? await imageKeys(storage, key) : [];
    const cached = images.length > 0 ? await diskImages.cachedKeys(images) : [];
    if (!dryRun) {
      await hooks.beforeDelete?.(conversation);
      // The floor first: whatever happens next, old messages are never read back.
      const floor = dmFloorAt((hooks.now ?? (() => new Date()))());
      await updateDmLimit(storage, input.userId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
      // Images and OCR text before the ledger that names them goes.
      if (images.length > 0) await purge(images);
    }
    deleted.cachedImages += cached.length;
    if (hasConversation) {
      deleted.dmContexts += 1;
      if (!dryRun) await store.deleteConversation(key);
    }
    if (input.scope === "conversation") {
      if (state && state.recentRuns.length > 0) {
        deleted.recentRuns += state.recentRuns.length;
        if (!dryRun) await updateExistingDmState(storage, input.userId, waifuId, (current) => ({ ...current, recentRuns: [] }));
      }
      continue;
    }
    // scope "all"
    if (state) {
      deleted.dmStates += 1;
      deleted.recentRuns += state.recentRuns.length;
      if (!dryRun) {
        await storage.withLocks([dmStateResource(input.userId, waifuId)], () =>
          rm(storage.dataPath(dmStatePath(input.userId, waifuId)), { force: true })
        );
      }
    }
    const aboutUser = (record: { waifuId: string; subjects: MemorySubject[]; origin?: MemoryOrigin }) =>
      isAboutDmUser(record, input.userId, waifuId);
    if (dryRun) {
      deleted.memories += (await readMemoryStore(storage)).memories.filter(aboutUser).length;
      deleted.observations += (await readPendingObservations(storage)).observations.filter(aboutUser).length;
    } else {
      let memories = 0;
      let observations = 0;
      await updateMemoryStore(storage, (current) => {
        const kept = current.memories.filter((record) => !aboutUser(record));
        memories = current.memories.length - kept.length;
        return { ...current, memories: kept };
      });
      await updatePendingObservations(storage, (current) => {
        const kept = current.observations.filter((observation) => !aboutUser(observation));
        observations = current.observations.length - kept.length;
        return { ...current, observations: kept };
      });
      deleted.memories += memories;
      deleted.observations += observations;
    }
  }
  return { dryRun, scope: input.scope, waifuIds, deleted };
}
