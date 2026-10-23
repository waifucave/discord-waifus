// Owner privacy affordance (spec 6.5, 8.8, 9.1.4/12.10 as of Phase 4): forget one Discord user.
// Deletes every memory whose subjects include the user (multi-subject memories included), their
// pending observations, and replaces that user's message bodies with "(removed)" in every
// conversation ledger. Context summaries keep the user until their next compaction (documented
// limitation); DM state/contexts join in Phase 5. The usage ledger is never rewritten (O5).

import { readdir } from "node:fs/promises";
import { ConversationLedgerSchema } from "../shared/schemas/context.js";
import type { StorageService } from "../storage/storageService.js";
import { type ConversationKey, conversationLedgerPath, parseConversationKey } from "./context/keys.js";
import { subjectIncludesUser } from "./memorySubjects.js";
import { readMemoryStore, readPendingObservations, updateMemoryStore, updatePendingObservations } from "./stores/memories.js";

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
  input: { discordUserId: string; dryRun?: boolean }
): Promise<ForgetUserResult> {
  const { discordUserId } = input;
  const dryRun = input.dryRun === true;
  const isTarget = (entry: { authorId: string; body: string; images: unknown[] }) =>
    entry.authorId === discordUserId && (entry.body !== REMOVED_MESSAGE_BODY || entry.images.length > 0);

  let memories = 0;
  let observations = 0;
  if (dryRun) {
    memories = (await readMemoryStore(storage)).memories.filter((record) => subjectIncludesUser(record.subjects, discordUserId)).length;
    observations = (await readPendingObservations(storage)).observations.filter((observation) =>
      subjectIncludesUser(observation.subjects, discordUserId)
    ).length;
  } else {
    await updateMemoryStore(storage, (current) => {
      const kept = current.memories.filter((record) => !subjectIncludesUser(record.subjects, discordUserId));
      memories = current.memories.length - kept.length;
      return { ...current, memories: kept };
    });
    await updatePendingObservations(storage, (current) => {
      const kept = current.observations.filter((observation) => !subjectIncludesUser(observation.subjects, discordUserId));
      observations = current.observations.length - kept.length;
      return { ...current, observations: kept };
    });
  }

  let ledgers = 0;
  let ledgerEntries = 0;
  for (const key of await listConversationKeys(storage)) {
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

  return { discordUserId, dryRun, memories, observations, ledgers, ledgerEntries };
}
