// DM deletion (spec 9.1.4).
//
// `conversation`: the DM conversation directory (ledger, refs, every agent context) and the DM
// run records. `all`: also the DM state file, that waifu's memories whose subjects include the
// user, the user's pending observations for her, and the cached images of the conversation.
// Neither scope touches `user/dms/<userId>/limits/` (users can never reset the limiter); only the
// owner's forget-user removes the whole `user/dms/<userId>/` directory.

import { readdir, rm } from "node:fs/promises";
import { ConversationLedgerSchema } from "../../shared/schemas/context.js";
import type { StorageService } from "../../storage/storageService.js";
import { FileContextStore } from "../context/contextStore.js";
import { conversationKey, conversationLedgerPath, type ConversationKey } from "../context/keys.js";
import { subjectIncludesUser } from "../memorySubjects.js";
import { readMemoryStore, readPendingObservations, updateMemoryStore, updatePendingObservations } from "../stores/memories.js";
import { dmStatePath, dmStateResource, listDmUserIds, readDmState, updateExistingDmState } from "./dmStore.js";

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
  cachedImages: number;
};

export type DmForgetResult = { dryRun: boolean; scope: DmForgetScope; waifuIds: string[]; deleted: DmForgetDeleted };

export type DmForgetHooks = {
  /** Drop cached image bytes and OCR text (ContextRuntime.purgeImageKeys). */
  purgeImages?: (keys: string[]) => Promise<void>;
  /** Abort the live DM slot and drop cached messages before files go (runtime side effects). */
  beforeDelete?: (conversation: { kind: "dm"; waifuId: string; userId: string }) => Promise<void>;
};

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

export async function dmForget(storage: StorageService, input: DmForgetInput, hooks: DmForgetHooks = {}): Promise<DmForgetResult> {
  const dryRun = input.dryRun === true;
  const waifuIds = input.waifuId ? [input.waifuId] : await dmWaifuIdsForUser(storage, input.userId);
  const deleted: DmForgetDeleted = { dmContexts: 0, dmStates: 0, recentRuns: 0, memories: 0, observations: 0, cachedImages: 0 };
  const store = new FileContextStore(storage);
  for (const waifuId of waifuIds) {
    const conversation = { kind: "dm" as const, waifuId, userId: input.userId };
    const key = conversationKey(conversation);
    const hasConversation = await exists(storage, "user", "conversations", key);
    const state = await readDmState(storage, input.userId, waifuId);
    const images = input.scope === "all" && hasConversation ? await imageKeys(storage, key) : [];
    if (!dryRun) await hooks.beforeDelete?.(conversation);
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
    deleted.cachedImages += images.length;
    if (!dryRun && images.length > 0) await hooks.purgeImages?.(images);
    const aboutUser = (record: { waifuId: string; subjects: Parameters<typeof subjectIncludesUser>[0] }) =>
      record.waifuId === waifuId && subjectIncludesUser(record.subjects, input.userId);
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
