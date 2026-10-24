// Owner privacy affordance (spec 6.5, 8.8, 9.1.4, 12.10): forget one Discord user.
// First every DM with the user goes (`dmForget(scope: "all")` per waifu: DM contexts, ledgers and
// state, her memories of the user, cached images), then the whole `user/dms/<userId>/` directory
// including the rate-limit counters (only the owner can reset those); a fresh limits file keeps only
// the forget floor, so the old chat is never read back from Discord. Then every memory whose
// subjects include the user (multi-subject memories included) or that was learned in their DMs,
// their pending observations, and
// the user's message bodies in every remaining conversation ledger become "(removed)". Context
// summaries keep the user until their next compaction (documented limitation). The usage ledger is
// never rewritten (O5).

import { readdir, rm } from "node:fs/promises";
import { ConversationLedgerSchema } from "../shared/schemas/context.js";
import type { StorageService } from "../storage/storageService.js";
import { type ConversationKey, conversationLedgerPath, parseConversationKey } from "./context/keys.js";
import { readMemoryStore, readPendingObservations, updateMemoryStore, updatePendingObservations } from "./stores/memories.js";
import { dmForget, isAboutDmUser, type DmForgetHooks } from "./dm/dmForget.js";
import { dmFloorAt, dmUserDir, listDmLimitWaifuIds, listDmUserIds, updateDmLimit } from "./dm/dmStore.js";

export const REMOVED_MESSAGE_BODY = "(removed)";

export type ForgetUserResult = {
  discordUserId: string;
  dryRun: boolean;
  memories: number;
  observations: number;
  /** Conversation ledgers that contain (or contained) the user's messages. */
  ledgers: number;
  /** Ledger entries whose body is (or would be) replaced. */
  ledgerEntries: number;
  /** DM conversations (ledger, refs, contexts) deleted. */
  dmContexts: number;
  /** DM state files deleted (rate-limit counter files are counted separately in dmLimits). */
  dmStates: number;
  dmLimits: number;
  cachedImages: number;
};

async function listConversationKeys(storage: StorageService): Promise<ConversationKey[]> {
  try {
    const entries = await readdir(storage.dataPath("user", "conversations"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && parseConversationKey(entry.name) !== undefined)
      .map((entry) => entry.name as ConversationKey)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readLedger(storage: StorageService, key: ConversationKey) {
  try {
    return await storage.readJson(conversationLedgerPath(key), ConversationLedgerSchema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function forgetUser(
  storage: StorageService,
  input: { discordUserId: string; dryRun?: boolean },
  hooks: DmForgetHooks = {}
): Promise<ForgetUserResult> {
  const { discordUserId } = input;
  const dryRun = input.dryRun === true;
  const dm = await dmForget(storage, { userId: discordUserId, scope: "all", dryRun }, hooks);
  const hasDmDir = (await listDmUserIds(storage)).includes(discordUserId);
  const dmLimits = hasDmDir ? (await listDmLimitWaifuIds(storage, discordUserId)).length : 0;
  if (!dryRun && hasDmDir) {
    await rm(storage.dataPath(dmUserDir(discordUserId)), { recursive: true, force: true });
  }
  if (!dryRun) {
    // The counters are gone, but the forget floors stay: the bot cannot delete the user's own
    // messages, so without them the next DM would read the forgotten chat back from Discord.
    const floor = dmFloorAt((hooks.now ?? (() => new Date()))());
    for (const waifuId of dm.waifuIds) {
      await updateDmLimit(storage, discordUserId, waifuId, (current) => ({ ...current, floorMessageId: floor }));
    }
  }
  const isTarget = (entry: { authorId: string; body: string; images: unknown[] }) =>
    entry.authorId === discordUserId && (entry.body !== REMOVED_MESSAGE_BODY || entry.images.length > 0);

  let memories = dm.deleted.memories;
  let observations = dm.deleted.observations;
  if (dryRun) {
    // The DM dry run counted the same records per waifu: count the store once instead.
    memories = (await readMemoryStore(storage)).memories.filter((record) => isAboutDmUser(record, discordUserId)).length;
    observations = (await readPendingObservations(storage)).observations.filter((observation) =>
      isAboutDmUser(observation, discordUserId)
    ).length;
  } else {
    await updateMemoryStore(storage, (current) => {
      const kept = current.memories.filter((record) => !isAboutDmUser(record, discordUserId));
      memories = dm.deleted.memories + current.memories.length - kept.length;
      return { ...current, memories: kept };
    });
    await updatePendingObservations(storage, (current) => {
      const kept = current.observations.filter((observation) => !isAboutDmUser(observation, discordUserId));
      observations = dm.deleted.observations + current.observations.length - kept.length;
      return { ...current, observations: kept };
    });
  }

  let ledgers = 0;
  let ledgerEntries = 0;
  for (const key of await listConversationKeys(storage)) {
    // The user's own DM conversations are deleted whole (dmContexts), never rewritten.
    if (key.startsWith(`dm_${discordUserId}_`)) continue;
    const ledger = await readLedger(storage, key);
    if (!ledger) continue;
    const hits = Object.values(ledger.entries).filter(isTarget).length;
    if (hits === 0) continue;
    if (dryRun) {
      ledgers += 1;
      ledgerEntries += hits;
      continue;
    }
    let changed = 0;
    await storage.updateRevisionedJson({
      resourceKey: `ledger:${key}`,
      relativePath: conversationLedgerPath(key),
      schema: ConversationLedgerSchema,
      fallback: ledger,
      transform: (current) => {
        changed = 0;
        const entries = Object.fromEntries(
          Object.entries(current.entries).map(([id, entry]) => {
            if (!isTarget(entry)) return [id, entry];
            changed += 1;
            // A one-off cache miss for every context of this conversation (spec 8.8).
            return [id, { ...entry, body: REMOVED_MESSAGE_BODY, images: [] }];
          })
        );
        return { ...current, entries };
      }
    });
    if (changed > 0) {
      ledgers += 1;
      ledgerEntries += changed;
    }
  }

  return {
    discordUserId,
    dryRun,
    memories,
    observations,
    ledgers,
    ledgerEntries,
    dmContexts: dm.deleted.dmContexts,
    dmStates: dm.deleted.dmStates,
    dmLimits,
    cachedImages: dm.deleted.cachedImages
  };
}
