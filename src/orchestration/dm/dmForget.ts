// DM deletion (spec 9.1.4; Living cast §7.5 step 1).
//
// `conversation`: the DM conversation directory (`user/conversations/dm_<user>_<waifu>/`: refs and
// whatever earlier versions kept there) and the conversation's cached images and OCR text. `all`: also the DM state file. Neither scope touches the rate-limit counters in
// `user/dms/<userId>/limits/` (users can never reset the limiter); only the owner's forget-user
// removes the whole `user/dms/<userId>/` directory.
//
// The bot cannot delete the user's own messages, so a forget also writes a floor message id into
// the limits file (which survives): nothing at or below it is ever read back into the conversation.
//
// The images to purge come from the conversation's durable image index (and a legacy ledger's image
// refs), read before the directory goes, plus whatever the live conversation cache shows: the API
// path without a runtime, or a forget after a restart, purges them too.
// Memories, notes and life state are not this module's: the life scrub (L2) handles them.

import { readdir, rm } from "node:fs/promises";
import type { Logger } from "../../backend/logger.js";
import { DiscordImageFetcher } from "../../discord/attachments.js";
import { DEFAULT_APP_CONFIG } from "../../shared/schemas/config.js";
import type { StorageService } from "../../storage/storageService.js";
import { forgetConversationImageIndex, readConversationImageKeys } from "../../discord/imageIndex.js";
import { conversationDirPath, conversationKey } from "../context/keys.js";
import { ImageOcrService } from "../ocr.js";
import { dmFloorAt, dmStatePath, dmStateResource, listDmUserIds, readDmState, updateDmLimit } from "./dmStore.js";

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
  /** Images whose cached bytes or OCR text existed (and were, or would be, deleted). */
  cachedImages: number;
};

export type DmForgetResult = { dryRun: boolean; scope: DmForgetScope; waifuIds: string[]; deleted: DmForgetDeleted };

export type DmConversation = { kind: "dm"; waifuId: string; userId: string };

export type DmForgetHooks = {
  /** Drop cached image bytes and OCR text. Default: on disk. */
  purgeImages?: (keys: string[]) => Promise<void>;
  /** Extra image keys the DM shows right now (the live conversation cache). The durable index is always read. */
  imageKeys?: (conversation: DmConversation) => Promise<string[]> | string[];
  /** Abort live work in the DM and drop cached messages before files go. */
  beforeDelete?: (conversation: DmConversation) => Promise<void>;
  now?: () => Date;
  /** Where a moved-aside, unreadable forget record is reported. */
  logger?: Pick<Logger, "warn">;
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
  const deleted: DmForgetDeleted = { dmContexts: 0, dmStates: 0, cachedImages: 0 };
  const diskImages = new DiscordImageFetcher({ dataRoot: storage.dataRoot, logger: silentLogger });
  const diskOcr = new ImageOcrService({ dataRoot: storage.dataRoot, config: DEFAULT_APP_CONFIG.ocr, logger: silentLogger, fetcher: diskImages });
  const purge =
    hooks.purgeImages ??
    (async (keys: string[]) => {
      await diskImages.purge(keys);
      await diskOcr.purge(keys);
    });
  for (const waifuId of waifuIds) {
    const conversation: DmConversation = { kind: "dm", waifuId, userId: input.userId };
    const key = conversationKey(conversation);
    const hasConversation = await exists(storage, "user", "conversations", key);
    const state = await readDmState(storage, input.userId, waifuId);
    const images = [...new Set([...(await readConversationImageKeys(storage.dataRoot, key)), ...((await hooks.imageKeys?.(conversation)) ?? [])])];
    const cached = images.length > 0 ? new Set([...(await diskImages.cachedKeys(images)), ...(await diskOcr.cachedKeys(images))]) : new Set<string>();
    if (!dryRun) {
      await hooks.beforeDelete?.(conversation);
      // The floor first: whatever happens next, old messages are never read back.
      const floor = dmFloorAt((hooks.now ?? (() => new Date()))());
      await updateDmLimit(storage, input.userId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
      if (images.length > 0) await purge(images);
    }
    deleted.cachedImages += cached.size;
    if (hasConversation) {
      deleted.dmContexts += 1;
      if (!dryRun) {
        // On the image index's queue: index writes queued before drain first, later ones are skipped.
        await storage.withLocks([`refs:${key}`], () =>
          forgetConversationImageIndex(storage.dataRoot, key, () => rm(storage.dataPath(conversationDirPath(key)), { recursive: true, force: true }))
        );
      }
    }
    if (input.scope === "conversation") continue;
    // scope "all"
    if (state) {
      deleted.dmStates += 1;
      if (!dryRun) {
        await storage.withLocks([dmStateResource(input.userId, waifuId)], () =>
          rm(storage.dataPath(dmStatePath(input.userId, waifuId)), { force: true })
        );
      }
    }
  }
  return { dryRun, scope: input.scope, waifuIds, deleted };
}
