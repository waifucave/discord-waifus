// DM deletion (spec 9.1.4; Living cast §7.5 step 1).
//
// `conversation`: the DM conversation directory (`user/conversations/dm_<user>_<waifu>/`: refs and
// whatever earlier versions kept there), the DM run records and the conversation's cached images
// and OCR text. `all`: also the DM state file. Neither scope touches the rate-limit counters in
// `user/dms/<userId>/limits/` (users can never reset the limiter); only the owner's forget-user
// removes the whole `user/dms/<userId>/` directory.
//
// The bot cannot delete the user's own messages, so a forget also writes a floor message id into
// the limits file (which survives): nothing at or below it is ever read back into the conversation.
// Memories, notes and life state are not this module's: the life scrub (L2) handles them.

import { readdir, rm } from "node:fs/promises";
import { DiscordImageFetcher } from "../../discord/attachments.js";
import { DEFAULT_APP_CONFIG } from "../../shared/schemas/config.js";
import type { StorageService } from "../../storage/storageService.js";
import { conversationDirPath, conversationKey } from "../context/keys.js";
import { ImageOcrService } from "../ocr.js";
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
  /** Images whose cached bytes existed (and were, or would be, deleted). */
  cachedImages: number;
};

export type DmForgetResult = { dryRun: boolean; scope: DmForgetScope; waifuIds: string[]; deleted: DmForgetDeleted };

export type DmConversation = { kind: "dm"; waifuId: string; userId: string };

export type DmForgetHooks = {
  /** Drop cached image bytes and OCR text. Default: on disk. */
  purgeImages?: (keys: string[]) => Promise<void>;
  /** The image keys the DM shows (the live conversation cache knows them). Default: none known. */
  imageKeys?: (conversation: DmConversation) => Promise<string[]> | string[];
  /** Abort live work in the DM and drop cached messages before files go. */
  beforeDelete?: (conversation: DmConversation) => Promise<void>;
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

/** Waifus with a DM conversation directory or state for this user. */
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

export async function dmForget(storage: StorageService, input: DmForgetInput, hooks: DmForgetHooks = {}): Promise<DmForgetResult> {
  const dryRun = input.dryRun === true;
  const waifuIds = input.waifuId ? [input.waifuId] : await dmWaifuIdsForUser(storage, input.userId);
  const deleted: DmForgetDeleted = { dmContexts: 0, dmStates: 0, recentRuns: 0, cachedImages: 0 };
  const diskImages = new DiscordImageFetcher({ dataRoot: storage.dataRoot, logger: silentLogger });
  const purge =
    hooks.purgeImages ??
    (async (keys: string[]) => {
      await diskImages.purge(keys);
      await new ImageOcrService({ dataRoot: storage.dataRoot, config: DEFAULT_APP_CONFIG.ocr, logger: silentLogger, fetcher: diskImages }).purge(keys);
    });
  for (const waifuId of waifuIds) {
    const conversation: DmConversation = { kind: "dm", waifuId, userId: input.userId };
    const key = conversationKey(conversation);
    const hasConversation = await exists(storage, "user", "conversations", key);
    const state = await readDmState(storage, input.userId, waifuId);
    const images = [...new Set((await hooks.imageKeys?.(conversation)) ?? [])];
    const cached = images.length > 0 ? await diskImages.cachedKeys(images) : [];
    if (!dryRun) {
      await hooks.beforeDelete?.(conversation);
      // The floor first: whatever happens next, old messages are never read back.
      const floor = dmFloorAt((hooks.now ?? (() => new Date()))());
      await updateDmLimit(storage, input.userId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
      if (images.length > 0) await purge(images);
    }
    deleted.cachedImages += cached.length;
    if (hasConversation) {
      deleted.dmContexts += 1;
      if (!dryRun) {
        await storage.withLocks([`refs:${key}`], () => rm(storage.dataPath(conversationDirPath(key)), { recursive: true, force: true }));
      }
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
  }
  return { dryRun, scope: input.scope, waifuIds, deleted };
}
