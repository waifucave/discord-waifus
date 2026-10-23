import path from "node:path";
import { conversationKey } from "../../orchestration/context/keys.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { entitiesToSubjects, isObject, legacyGuildId, migrationDirectories, nonEmptyString, readJsonFile } from "./memorySupport.js";

// Step `pending-observations-global-v1` (spec 8.2): queued observations lose their guild scope.
// `guildId`/`channelId` → `origin`; resolvable `entities` → `subjects` (same unique-match rule as
// the memory step); `conversationKey` from guild + channel. Idempotent.
export async function migratePendingObservationsGlobal(dataRoot: string): Promise<string | undefined> {
  const filePath = path.join(dataRoot, "user", "memory", "pending-observations.json");
  const read = await readJsonFile(filePath);
  if (read.kind === "missing") return undefined;
  if (read.kind === "invalid" || !isObject(read.value) || !Array.isArray(read.value.observations)) {
    throw new Error("user/memory/pending-observations.json is unreadable; repair it to finish migrating observations.");
  }
  const data = read.value as Record<string, unknown> & { observations: unknown[] };
  const directoryFor = migrationDirectories(dataRoot);

  let changed = 0;
  for (const observation of data.observations) {
    if (!isObject(observation)) continue;
    if (!("guildId" in observation) && !("channelId" in observation) && !("entities" in observation) && isObject(observation.origin)) {
      continue;
    }
    const guildId = legacyGuildId(observation.guildId);
    const channelId = nonEmptyString(observation.channelId);
    if (!isObject(observation.origin)) {
      observation.origin = { ...(guildId ? { guildId } : {}), ...(guildId && channelId ? { channelId } : {}) };
    }
    if (!Array.isArray(observation.subjects)) {
      observation.subjects = entitiesToSubjects(observation.entities, await directoryFor(guildId));
    }
    if (observation.conversationKey === undefined && guildId && channelId) {
      try {
        observation.conversationKey = conversationKey({ kind: "guild", guildId, channelId });
      } catch {
        // Ids that cannot form a key (never real snowflakes) simply carry no conversation.
      }
    }
    delete observation.guildId;
    delete observation.channelId;
    delete observation.entities;
    changed += 1;
  }

  if (changed === 0) return undefined;
  await atomicWriteJson(filePath, data);
  return `migrate-pending-observations-global-${changed}`;
}
