import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ensureDataLayout } from "../config/layout.js";
import { atomicWriteJson } from "../storage/atomic.js";

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

  return { applied };
}

async function readJsonOrUndefined(filePath: string): Promise<unknown | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const REPLY_STYLES = new Set(["normal", "short", "long", "sleepy"]);

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
        delaySeconds: 0,
        replyStyle: "normal"
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
        delaySeconds: 0,
        replyStyle: "normal"
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
      if (typeof next.replyStyle !== "string" || !REPLY_STYLES.has(next.replyStyle)) {
        next.replyStyle = "normal";
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
    if (retrigger === undefined || retrigger < 100) {
      retrigger = 100;
      changed = true;
    } else if (retrigger > 7200) {
      retrigger = 7200;
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
    if ("idleTriggerPacing" in sections) {
      if (!("retriggerPacing" in sections)) {
        sections.retriggerPacing = sections.idleTriggerPacing;
      }
      delete sections.idleTriggerPacing;
      mutated = true;
    }
    if ("retriggerPacing_old" in sections) {
      delete sections.retriggerPacing_old;
      mutated = true;
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
