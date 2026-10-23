import path from "node:path";
import { atomicWriteJson } from "../../storage/atomic.js";
import { entitiesToSubjects, isObject, legacyGuildId, migrationDirectories, nonEmptyString, readJsonOrUndefined } from "./memorySupport.js";

// Step `memories-global-origin-subjects-v1` (spec 8.2, 8.8): memories become global per waifu.
// Each record's `guildId`/`channelId` move into provenance `origin`; display-name `entities` become
// `subjects` ONLY where a name uniquely matches that guild's member names or a waifu name
// (unresolvable entities are dropped — they were capitalized words, not people); every record
// gains a per-record `revision` (0). Idempotent: records already in the new shape are untouched.
export async function migrateMemoriesGlobalOriginSubjects(dataRoot: string): Promise<string | undefined> {
  const filePath = path.join(dataRoot, "user", "memories.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !Array.isArray(data.memories)) return undefined;
  const directoryFor = migrationDirectories(dataRoot);

  let changed = 0;
  for (const memory of data.memories) {
    if (!isObject(memory)) continue;
    const legacy = "guildId" in memory || "channelId" in memory || "entities" in memory;
    const shaped = isObject(memory.origin) && Array.isArray(memory.subjects) && typeof memory.revision === "number";
    if (!legacy && shaped) continue;

    const guildId = legacyGuildId(memory.guildId);
    const channelId = nonEmptyString(memory.channelId);
    if (!isObject(memory.origin)) {
      memory.origin = { ...(guildId ? { guildId } : {}), ...(guildId && channelId ? { channelId } : {}) };
    }
    if (!Array.isArray(memory.subjects)) {
      memory.subjects = entitiesToSubjects(memory.entities, await directoryFor(guildId));
    }
    if (typeof memory.revision !== "number") memory.revision = 0;
    delete memory.guildId;
    delete memory.channelId;
    delete memory.entities;
    changed += 1;
  }

  if (changed === 0) return undefined;
  await atomicWriteJson(filePath, data);
  return `migrate-memories-global-origin-subjects-${changed}`;
}
