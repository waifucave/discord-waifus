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

  if (await renameOrchestratorHistory(dataRoot)) {
    applied.push("rename-retrigger-after-seconds-history");
  }
  const configsRenamed = await renameAgentConfigs(dataRoot);
  if (configsRenamed > 0) {
    applied.push(`rename-retrigger-pacing-${configsRenamed}`);
  }
  const sessionsRenamed = await renameSessionFiles(dataRoot);
  if (sessionsRenamed > 0) {
    applied.push(`rename-scheduled-retrigger-at-${sessionsRenamed}`);
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

const IDLE_TRIGGER_ALLOWED = new Set([180, 300, 900, 1800, 3600, 7200, 14400]);

function clampIdleTrigger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (IDLE_TRIGGER_ALLOWED.has(value)) return value;
  let best = 14400;
  for (const allowed of IDLE_TRIGGER_ALLOWED) {
    if (allowed >= value) {
      if (allowed < best) best = allowed;
    }
  }
  return best;
}

async function renameOrchestratorHistory(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "orchestrator", "history.json");
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data)) return false;
  const decisions = data.decisions;
  if (!Array.isArray(decisions)) return false;
  let changed = false;
  for (const entry of decisions) {
    if (!isObject(entry)) continue;
    if ("retriggerAfterSeconds" in entry && !("idleTrigger" in entry)) {
      entry.idleTrigger = entry.retriggerAfterSeconds;
      delete entry.retriggerAfterSeconds;
      changed = true;
    } else if ("retriggerAfterSeconds" in entry) {
      delete entry.retriggerAfterSeconds;
      changed = true;
    }
    if (!("steps" in entry) && "action" in entry) {
      const action = entry.action;
      const oldSelected = Array.isArray(entry.selectedWaifuIds) ? entry.selectedWaifuIds : [];
      const oldSceneDirections = Array.isArray(entry.sceneDirections) ? entry.sceneDirections : [];
      const newSteps: Array<Record<string, unknown>> = [];
      if (action === "waifus") {
        for (let i = 0; i < oldSelected.length; i += 1) {
          const waifuId = oldSelected[i];
          if (typeof waifuId !== "string" || !waifuId) continue;
          const step: Record<string, unknown> = { kind: waifuId };
          const sceneDirection = oldSceneDirections[i];
          if (typeof sceneDirection === "string" && sceneDirection.length > 0) {
            step.sceneDirection = sceneDirection;
          }
          newSteps.push(step);
        }
      } else if (action === "no_reply") {
        newSteps.push({ kind: "no_reply" });
      }
      entry.steps = newSteps;
      if ("idleTrigger" in entry) {
        const clamped = clampIdleTrigger(entry.idleTrigger);
        if (clamped === undefined) {
          delete entry.idleTrigger;
        } else {
          entry.idleTrigger = clamped;
        }
      }
      const hasNoReplyStep = newSteps.some((step) => step.kind === "no_reply");
      if (!hasNoReplyStep && "idleTrigger" in entry) {
        delete entry.idleTrigger;
      }
      delete entry.action;
      delete entry.selectedWaifuIds;
      delete entry.sceneDirections;
      changed = true;
    } else if ("idleTrigger" in entry) {
      const clamped = clampIdleTrigger(entry.idleTrigger);
      if (clamped === undefined) {
        delete entry.idleTrigger;
        changed = true;
      } else if (clamped !== entry.idleTrigger) {
        entry.idleTrigger = clamped;
        changed = true;
      }
    }
  }
  if (!changed) return false;
  await atomicWriteJson(filePath, data);
  return true;
}

async function renameAgentConfigs(dataRoot: string): Promise<number> {
  const agentDirs = ["orchestrator", "stage-manager", "reviewer"];
  let count = 0;
  for (const agent of agentDirs) {
    const filePath = path.join(dataRoot, "user", agent, "config.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const sections = data.promptSections;
    if (!isObject(sections)) continue;
    if ("retriggerPacing" in sections && !("idleTriggerPacing" in sections)) {
      sections.idleTriggerPacing = sections.retriggerPacing;
      delete sections.retriggerPacing;
      await atomicWriteJson(filePath, data);
      count += 1;
    } else if ("retriggerPacing" in sections) {
      delete sections.retriggerPacing;
      await atomicWriteJson(filePath, data);
      count += 1;
    }
  }
  return count;
}

async function renameSessionFiles(dataRoot: string): Promise<number> {
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
      if ("scheduledRetriggerAt" in data && !("scheduledIdleTriggerAt" in data)) {
        data.scheduledIdleTriggerAt = data.scheduledRetriggerAt;
        delete data.scheduledRetriggerAt;
        await atomicWriteJson(filePath, data);
        count += 1;
      } else if ("scheduledRetriggerAt" in data) {
        delete data.scheduledRetriggerAt;
        await atomicWriteJson(filePath, data);
        count += 1;
      }
    }
  }
  return count;
}
