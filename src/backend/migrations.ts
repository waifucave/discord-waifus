import { readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ensureDataLayout } from "../config/layout.js";
import { RETRIGGER_MAX_SECONDS, RETRIGGER_MIN_SECONDS } from "../orchestration/decisions.js";
import { extractEntities } from "../orchestration/memoryEntities.js";
import { MEMORY_KINDS } from "../shared/schemas/domain.js";
import {
  PromptLayoutNode,
  WaifuPromptLayout,
  defaultWaifuPromptLayout
} from "../shared/schemas/domain.js";
import { atomicWriteJson } from "../storage/atomic.js";

export { extractEntities } from "../orchestration/memoryEntities.js";

export type MigrationResult = {
  applied: string[];
};

export async function runMigrations(dataRoot: string): Promise<MigrationResult> {
  await ensureDataLayout(dataRoot);
  const applied: string[] = [];

  if (await migrateOrchestratorHistory(dataRoot)) {
    applied.push("migrate-orchestrator-history-to-responding-waifus");
  }
  const configsRenamed = await migrateAgentConfigs(dataRoot);
  if (configsRenamed > 0) {
    applied.push(`migrate-retrigger-pacing-${configsRenamed}`);
  }
  const sessionsRenamed = await migrateSessionFiles(dataRoot);
  if (sessionsRenamed > 0) {
    applied.push(`migrate-scheduled-retrigger-at-${sessionsRenamed}`);
  }
  const participantCachesRemoved = await removeGuildWideActiveParticipantCaches(dataRoot);
  if (participantCachesRemoved > 0) {
    applied.push(`remove-guild-wide-active-participants-${participantCachesRemoved}`);
  }
  if (await migrateLegacyMemories(dataRoot)) {
    applied.push("migrate-memories-to-guild-scope");
  }
  if (await archiveMemoriesWithUnknownWaifus(dataRoot)) {
    applied.push("archive-memories-with-unknown-waifus");
  }
  const layoutsMigrated = await migrateWaifuPromptSections(dataRoot);
  if (layoutsMigrated > 0) {
    applied.push(`migrate-waifu-prompt-layout-${layoutsMigrated}`);
  }
  const w2LayoutsMigrated = await migrateWaifuPromptLayoutW2(dataRoot);
  if (w2LayoutsMigrated > 0) {
    applied.push(`migrate-waifu-prompt-layout-w2-${w2LayoutsMigrated}`);
  }
  // W3: collapse the two-store memory model into one unified MemoryRecord store. This MUST run
  // after the legacy memory steps above (they mutate the old shape) and before any read, because
  // the new schema strips importance/permanent and would silently default strength/pinned — losing
  // user-managed permanent memories — if an old-shape file were parsed without migrating first.
  if (await migrateMemoryStoreV2(dataRoot)) {
    applied.push("migrate-memory-store-v2");
  }

  return { applied };
}

async function removeGuildWideActiveParticipantCaches(dataRoot: string): Promise<number> {
  const serversRoot = path.join(dataRoot, "user", "servers");
  let guilds: string[];
  try {
    guilds = await readdir(serversRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }

  let count = 0;
  for (const guildId of guilds) {
    const filePath = path.join(serversRoot, guildId, "active-chat-participants.json");
    try {
      await rm(filePath);
      count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return count;
}

async function readJsonOrUndefined(filePath: string): Promise<unknown | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrateLegacyDecision(entry: Record<string, unknown>): boolean {
  let changed = false;

  // Pull the retrigger seconds from any known legacy name first.
  let retrigger: number | undefined;
  if (typeof entry.retriggerAfterSeconds === "number") {
    retrigger = entry.retriggerAfterSeconds;
  } else if (typeof entry.idleTrigger === "number") {
    retrigger = entry.idleTrigger;
    changed = true;
  }
  if ("idleTrigger" in entry) {
    delete entry.idleTrigger;
    changed = true;
  }

  // Convert legacy chain-style `steps[]` into respondingWaifus / action.
  if (Array.isArray(entry.steps) && !Array.isArray(entry.respondingWaifus)) {
    const respondingWaifus: Array<Record<string, unknown>> = [];
    let hasNoReply = false;
    for (const step of entry.steps as unknown[]) {
      if (!isObject(step)) continue;
      const kind = typeof step.kind === "string" ? step.kind : "";
      if (!kind) continue;
      if (kind === "no_reply") {
        hasNoReply = true;
        continue;
      }
      const responder: Record<string, unknown> = {
        waifuId: kind,
        delaySeconds: 0
      };
      if (typeof step.sceneDirection === "string" && step.sceneDirection.length > 0) {
        responder.sceneDirection = step.sceneDirection;
      }
      if (typeof step.replyToMessageId === "string" && step.replyToMessageId.length > 0) {
        responder.replyToMessageId = step.replyToMessageId;
      }
      respondingWaifus.push(responder);
    }
    entry.respondingWaifus = respondingWaifus;
    if (respondingWaifus.length > 0) {
      entry.action = "reply";
    } else if (hasNoReply) {
      entry.action = "no_reply";
    } else {
      entry.action = "reply";
    }
    delete entry.steps;
    changed = true;
  }

  // Convert original legacy action="waifus"|"no_reply" + selectedWaifuIds + sceneDirections form.
  if (
    !Array.isArray(entry.respondingWaifus) &&
    typeof entry.action === "string" &&
    (Array.isArray((entry as { selectedWaifuIds?: unknown }).selectedWaifuIds) ||
      Array.isArray((entry as { sceneDirections?: unknown }).sceneDirections))
  ) {
    const selected = Array.isArray(entry.selectedWaifuIds) ? entry.selectedWaifuIds : [];
    const sceneDirections = Array.isArray(entry.sceneDirections) ? entry.sceneDirections : [];
    const respondingWaifus: Array<Record<string, unknown>> = [];
    for (let i = 0; i < selected.length; i += 1) {
      const waifuId = selected[i];
      if (typeof waifuId !== "string" || !waifuId) continue;
      const responder: Record<string, unknown> = {
        waifuId,
        delaySeconds: 0
      };
      const sceneDirection = sceneDirections[i];
      if (typeof sceneDirection === "string" && sceneDirection.length > 0) {
        responder.sceneDirection = sceneDirection;
      }
      respondingWaifus.push(responder);
    }
    entry.respondingWaifus = respondingWaifus;
    entry.action = entry.action === "no_reply" ? "no_reply" : "reply";
    delete entry.selectedWaifuIds;
    delete entry.sceneDirections;
    changed = true;
  }

  // Normalize each respondingWaifu entry so it satisfies the current schema.
  if (Array.isArray(entry.respondingWaifus)) {
    const fixed: Array<Record<string, unknown>> = [];
    for (const candidate of entry.respondingWaifus) {
      if (!isObject(candidate)) {
        changed = true;
        continue;
      }
      const next: Record<string, unknown> = { ...candidate };
      if (typeof next.delaySeconds !== "number" || !Number.isFinite(next.delaySeconds) || next.delaySeconds < 0) {
        next.delaySeconds = 0;
        changed = true;
      }
      fixed.push(next);
    }
    entry.respondingWaifus = fixed;
  }

  // Ensure action is present and consistent with respondingWaifus.
  const responders = Array.isArray(entry.respondingWaifus) ? entry.respondingWaifus : [];
  if (entry.action !== "reply" && entry.action !== "no_reply") {
    entry.action = responders.length > 0 ? "reply" : "no_reply";
    changed = true;
  }
  if (entry.action === "reply" && responders.length === 0) {
    entry.action = "no_reply";
    changed = true;
  }

  // Place retriggerAfterSeconds appropriately for the action.
  if (entry.action === "no_reply") {
    if (retrigger === undefined || retrigger < RETRIGGER_MIN_SECONDS) {
      retrigger = RETRIGGER_MIN_SECONDS;
      changed = true;
    } else if (retrigger > RETRIGGER_MAX_SECONDS) {
      retrigger = RETRIGGER_MAX_SECONDS;
      changed = true;
    }
    if (entry.retriggerAfterSeconds !== retrigger) {
      entry.retriggerAfterSeconds = retrigger;
      changed = true;
    }
  } else if ("retriggerAfterSeconds" in entry) {
    delete entry.retriggerAfterSeconds;
    changed = true;
  }

  if (
    entry.status !== "pending" &&
    entry.status !== "completed" &&
    entry.status !== "interrupted" &&
    entry.status !== "failed"
  ) {
    entry.status = "completed";
    changed = true;
  }
  if (!Array.isArray(entry.waifuMessageIds)) {
    entry.waifuMessageIds = [];
    changed = true;
  }
  if (!Array.isArray(entry.responderOutcomes)) {
    entry.responderOutcomes = [];
    changed = true;
  }

  return changed;
}

async function migrateOrchestratorHistory(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "orchestrator", "history.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data)) return false;
  const decisions = data.decisions;
  if (!Array.isArray(decisions)) return false;
  let changed = false;
  for (const entry of decisions) {
    if (!isObject(entry)) continue;
    if (migrateLegacyDecision(entry)) {
      changed = true;
    }
  }
  if (!changed) return false;
  await atomicWriteJson(filePath, data);
  return true;
}

async function migrateAgentConfigs(dataRoot: string): Promise<number> {
  const agentDirs = ["orchestrator", "stage-manager", "reviewer"];
  let count = 0;
  for (const agent of agentDirs) {
    const filePath = path.join(dataRoot, "user", agent, "config.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const sections = data.promptSections;
    if (!isObject(sections)) continue;
    let mutated = false;
    // W1 renamed the prompt sections: the pacing toggle became pausePlanning; the
    // loopBreaking/toolUse sections were removed. Carry a deliberate "false" forward
    // instead of letting the new schema default it back to true on read.
    for (const legacyPacingKey of ["idleTriggerPacing", "retriggerPacing"]) {
      if (legacyPacingKey in sections) {
        if (!("pausePlanning" in sections)) {
          sections.pausePlanning = sections[legacyPacingKey];
        }
        delete sections[legacyPacingKey];
        mutated = true;
      }
    }
    for (const removedKey of ["loopBreaking", "toolUse", "retriggerPacing_old"]) {
      if (removedKey in sections) {
        delete sections[removedKey];
        mutated = true;
      }
    }
    if (mutated) {
      await atomicWriteJson(filePath, data);
      count += 1;
    }
  }
  return count;
}

async function migrateSessionFiles(dataRoot: string): Promise<number> {
  const serversRoot = path.join(dataRoot, "user", "servers");
  let guilds: string[];
  try {
    guilds = await readdir(serversRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const guildId of guilds) {
    const sessionsDir = path.join(serversRoot, guildId, "sessions");
    let sessionFiles: string[];
    try {
      sessionFiles = await readdir(sessionsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const fileName of sessionFiles) {
      if (!fileName.endsWith(".json")) continue;
      const filePath = path.join(sessionsDir, fileName);
      const data = await readJsonOrUndefined(filePath);
      if (!isObject(data)) continue;
      let mutated = false;
      if ("scheduledIdleTriggerAt" in data) {
        if (!("scheduledRetriggerAt" in data)) {
          data.scheduledRetriggerAt = data.scheduledIdleTriggerAt;
        }
        delete data.scheduledIdleTriggerAt;
        mutated = true;
      }
      if ("cachedWaifuContinuation" in data) {
        delete data.cachedWaifuContinuation;
        mutated = true;
      }
      if (mutated) {
        await atomicWriteJson(filePath, data);
        count += 1;
      }
    }
  }
  return count;
}

// Legacy waifus stored a flat boolean `promptSections` toggle set. Convert each into the new
// ordered `promptLayout` tree, preserving the user's on/off choices by disabling the matching
// blocks on top of the default arrangement. Always-on and conditional blocks stay enabled.
const LEGACY_PROMPT_SECTION_TO_BLOCK: Record<string, string> = {
  directorNotes: "directorNotes",
  hardRules: "hardRules",
  mentionPolicy: "mentionPolicy",
  replyTargeting: "replyTargeting",
  environmentInstructions: "environment",
  inputFormat: "contextStructure",
  styleConstraints: "styleConstraints",
  personality: "personalityReminder"
};

function setBlockEnabled(layout: WaifuPromptLayout, blockId: string, enabled: boolean): void {
  const visit = (nodes: PromptLayoutNode[]) => {
    for (const node of nodes) {
      if (node.kind === "block") {
        if (node.blockId === blockId) node.enabled = enabled;
      } else {
        for (const child of node.children) {
          if (child.blockId === blockId) child.enabled = enabled;
        }
      }
    }
  };
  visit(layout.top);
  visit(layout.mid);
  visit(layout.trailing);
}

async function migrateWaifuPromptSections(dataRoot: string): Promise<number> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const legacy = data.promptSections;
    if (!isObject(legacy)) continue; // already migrated or never had the legacy field

    const layout = defaultWaifuPromptLayout();
    for (const [legacyKey, blockId] of Object.entries(LEGACY_PROMPT_SECTION_TO_BLOCK)) {
      if (legacy[legacyKey] === false) {
        setBlockEnabled(layout, blockId, false);
      }
    }
    data.promptLayout = layout;
    delete data.promptSections;
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

async function migrateLegacyMemories(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "memories.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !Array.isArray(data.memories)) return false;

  const [historyGuilds, configuredGuildIds] = await Promise.all([
    memoryGuildsFromStageManagerHistory(dataRoot),
    listConfiguredGuildIds(dataRoot)
  ]);
  const onlyConfiguredGuildId = configuredGuildIds.length === 1 ? configuredGuildIds[0] : undefined;

  let changed = false;
  for (const memory of data.memories) {
    if (!isObject(memory)) continue;
    // Leave already-unified (W3) records alone — adding `scope` back would make the V2 shape
    // detector treat a clean store as legacy and re-run on every boot.
    if (isNewShapeMemory(memory)) continue;
    if (memory.scope !== "guild") {
      memory.scope = "guild";
      changed = true;
    }

    const memoryId = typeof memory.id === "string" ? memory.id : undefined;
    const existingGuildId = typeof memory.guildId === "string" && memory.guildId.length > 0
      ? memory.guildId
      : undefined;
    const historyGuildId = memoryId ? singleValue(historyGuilds.get(memoryId)) : undefined;
    const guildId = existingGuildId ?? historyGuildId ?? onlyConfiguredGuildId;

    if (guildId) {
      if (memory.guildId !== guildId) {
        memory.guildId = guildId;
        changed = true;
      }
    } else if (memory.status !== "archived") {
      memory.status = "archived";
      changed = true;
    }
  }

  if (!changed) return false;
  await atomicWriteJson(filePath, data);
  return true;
}

async function archiveMemoriesWithUnknownWaifus(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "memories.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !Array.isArray(data.memories)) return false;
  const configuredWaifuIds = new Set(await listConfiguredWaifuIds(dataRoot));
  const now = new Date().toISOString();

  let changed = false;
  for (const memory of data.memories) {
    if (!isObject(memory)) continue;
    const waifuId = typeof memory.waifuId === "string" ? memory.waifuId : undefined;
    if (memory.status === "active" && (!waifuId || !configuredWaifuIds.has(waifuId))) {
      memory.status = "archived";
      memory.updatedAt = now;
      changed = true;
    }
  }

  if (!changed) return false;
  await atomicWriteJson(filePath, data);
  return true;
}

const NOTE_STRENGTH = 2;
const VALID_MEMORY_KINDS = new Set<string>(MEMORY_KINDS);

function clampStrength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.max(0, Math.min(5, value));
}

function memoryRecordHasOldShape(memory: Record<string, unknown>): boolean {
  return "importance" in memory || "permanent" in memory || "scope" in memory || "sourceMessageIds" in memory;
}

// A unified (W3) record carries `source`/`strength` and none of the legacy keys.
function isNewShapeMemory(memory: Record<string, unknown>): boolean {
  return ("source" in memory || "strength" in memory) && !memoryRecordHasOldShape(memory);
}

// W3 shape migration. Transforms the legacy long-term records and folds the separate short-term
// store into the unified MemoryRecord store, then removes the short-term file. Idempotent: once a
// record carries none of the old keys (importance/permanent/scope/sourceMessageIds) and the
// short-term file is gone, there is nothing to do.
async function migrateMemoryStoreV2(dataRoot: string): Promise<boolean> {
  const memoriesPath = path.join(dataRoot, "user", "memories.json");
  const shortTermPath = path.join(dataRoot, "user", "short-term-memories.json");

  const memoriesData = await readJsonOrUndefined(memoriesPath);
  const shortTermData = await readJsonOrUndefined(shortTermPath);

  const memoriesIsObject = isObject(memoriesData) && Array.isArray(memoriesData.memories);
  const existingRecords: unknown[] = memoriesIsObject ? (memoriesData.memories as unknown[]) : [];
  const hasOldLongTerm = existingRecords.some(
    (memory) => isObject(memory) && memoryRecordHasOldShape(memory)
  );
  const shortTermExists = shortTermData !== undefined;

  if (!hasOldLongTerm && !shortTermExists) return false;

  // Establish the base store. If memories.json is absent or malformed but a short-term file exists,
  // start from an empty store so the short-term entries still survive the merge.
  const baseStore: Record<string, unknown> = memoriesIsObject
    ? { ...memoriesData }
    : { schemaVersion: 1, revision: 0, updatedAt: new Date().toISOString(), memories: [] };

  const migrated: Array<Record<string, unknown>> = [];
  for (const raw of existingRecords) {
    if (!isObject(raw)) continue;
    if (!memoryRecordHasOldShape(raw)) {
      // Already new-shape (e.g. mixed store on a partial prior run) — carry through untouched.
      migrated.push(raw);
      continue;
    }
    const permanent = raw.permanent === true;
    const importance = clampStrength(raw.importance);
    const content = typeof raw.content === "string" ? raw.content : "";
    const guildId = typeof raw.guildId === "string" ? raw.guildId : "";
    const waifuId = typeof raw.waifuId === "string" ? raw.waifuId : "";
    const kind = typeof raw.kind === "string" && VALID_MEMORY_KINDS.has(raw.kind) ? raw.kind : "fact";
    // The new schema requires non-empty guildId/waifuId/content for every record (the old schema
    // tolerated guildId-less archived memories). Drop orphans rather than emit a record that would
    // fail MemoryStoreSchema parse on the next read.
    if (!guildId || !waifuId || !content) continue;
    const next: Record<string, unknown> = {
      id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomUUID(),
      guildId,
      waifuId,
      content,
      kind,
      source: permanent ? "user" : "stage_manager",
      pinned: permanent,
      strength: importance,
      entities: extractEntities(content),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      status: raw.status === "archived" ? "archived" : "active"
    };
    if (typeof raw.channelId === "string" && raw.channelId.length > 0) {
      next.channelId = raw.channelId;
    }
    if (typeof raw.expiresAt === "string" && raw.expiresAt.length > 0) {
      next.expiresAt = raw.expiresAt;
    }
    migrated.push(next);
  }

  // Fold short-term entries into the unified store as waifu_tool/context notes, keeping expiresAt.
  if (isObject(shortTermData) && Array.isArray(shortTermData.entries)) {
    for (const raw of shortTermData.entries) {
      if (!isObject(raw)) continue;
      const content = typeof raw.content === "string" ? raw.content : "";
      const guildId = typeof raw.guildId === "string" ? raw.guildId : "";
      const waifuId = typeof raw.waifuId === "string" ? raw.waifuId : "";
      if (!content || !guildId || !waifuId) continue;
      const note: Record<string, unknown> = {
        id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomUUID(),
        guildId,
        waifuId,
        content,
        kind: "context",
        source: "waifu_tool",
        pinned: false,
        strength: NOTE_STRENGTH,
        entities: extractEntities(content),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        updatedAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        status: "active"
      };
      if (typeof raw.channelId === "string" && raw.channelId.length > 0) {
        note.channelId = raw.channelId;
      }
      if (typeof raw.expiresAt === "string" && raw.expiresAt.length > 0) {
        note.expiresAt = raw.expiresAt;
      }
      migrated.push(note);
    }
  }

  baseStore.memories = migrated;
  await atomicWriteJson(memoriesPath, baseStore);

  // Remove the now-merged short-term store; tolerate a missing file.
  try {
    await rm(shortTermPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return true;
}

async function memoryGuildsFromStageManagerHistory(dataRoot: string): Promise<Map<string, Set<string>>> {
  const data = await readJsonOrUndefined(path.join(dataRoot, "user", "stage-manager", "history.json"));
  const guildsByMemoryId = new Map<string, Set<string>>();
  if (!isObject(data) || !Array.isArray(data.edits)) return guildsByMemoryId;
  for (const entry of data.edits) {
    if (!isObject(entry) || typeof entry.guildId !== "string" || !Array.isArray(entry.affectedMemoryIds)) {
      continue;
    }
    for (const memoryId of entry.affectedMemoryIds) {
      if (typeof memoryId !== "string" || !memoryId) continue;
      const guilds = guildsByMemoryId.get(memoryId) ?? new Set<string>();
      guilds.add(entry.guildId);
      guildsByMemoryId.set(memoryId, guilds);
    }
  }
  return guildsByMemoryId;
}

async function listConfiguredGuildIds(dataRoot: string): Promise<string[]> {
  const serversRoot = path.join(dataRoot, "user", "servers");
  let entries: string[];
  try {
    entries = await readdir(serversRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const guildIds: string[] = [];
  for (const entry of entries) {
    const data = await readJsonOrUndefined(path.join(serversRoot, entry, "server.json"));
    if (isObject(data) && typeof data.guildId === "string" && data.guildId.length > 0) {
      guildIds.push(data.guildId);
    }
  }
  return guildIds;
}

async function listConfiguredWaifuIds(dataRoot: string): Promise<string[]> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const waifuIds: string[] = [];
  for (const entry of entries) {
    const data = await readJsonOrUndefined(path.join(waifusRoot, entry, "waifu.json"));
    if (isObject(data) && typeof data.id === "string" && data.id.length > 0) {
      waifuIds.push(data.id);
    }
  }
  return waifuIds;
}

function singleValue(values: Set<string> | undefined): string | undefined {
  if (!values || values.size !== 1) return undefined;
  return [...values][0];
}

// Block IDs that existed in the W1 (pre-W2) registry. Any waifu whose promptLayout contains one
// of these IDs is using the old registry and must be reset wholesale to the new default so the
// new blocks are enabled by default (reconcileWaifuPromptLayout would only append them disabled).
const LEGACY_WAIFU_BLOCK_IDS = new Set([
  "personality",
  "contextStructure",
  "environment",
  "replyTargeting",
  "mentionPolicy",
  "styleConstraints",
  "hardRules",
  "directorNotes",
  "activeParticipants",
  "serverEmojis",
  "personalityReminder",
  "sceneDirection",
  "toolUse"
]);

function layoutContainsLegacyIds(layout: unknown): boolean {
  if (!isObject(layout)) return false;
  const sections = ["top", "mid", "trailing"] as const;
  for (const section of sections) {
    const nodes = layout[section];
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!isObject(node)) continue;
      if (node.kind === "block" && typeof node.blockId === "string" && LEGACY_WAIFU_BLOCK_IDS.has(node.blockId)) {
        return true;
      }
      if (node.kind === "group" && Array.isArray(node.children)) {
        for (const child of node.children) {
          if (isObject(child) && typeof child.blockId === "string" && LEGACY_WAIFU_BLOCK_IDS.has(child.blockId)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

async function migrateWaifuPromptLayoutW2(dataRoot: string): Promise<number> {
  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let entries: string[];
  try {
    entries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    // Only migrate waifus that have a promptLayout with legacy block IDs.
    if (!layoutContainsLegacyIds(data.promptLayout)) continue;
    data.promptLayout = defaultWaifuPromptLayout();
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}
