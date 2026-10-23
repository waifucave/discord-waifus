import { chmod, lstat, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDataLayout, readPackageVersion } from "../config/layout.js";
import { RETRIGGER_MAX_SECONDS, RETRIGGER_MIN_SECONDS } from "../orchestration/decisions.js";
import { extractEntities, WAIFU_NOTE_STRENGTH } from "../orchestration/memoryEntities.js";
import { resolveModelTarget } from "../orchestration/pipeline/resolveTarget.js";
import { MEMORY_KINDS } from "../shared/schemas/domain.js";
import {
  PromptLayoutNode,
  WaifuPromptLayout,
  defaultWaifuPromptLayout
} from "../shared/schemas/domain.js";
import { CURRENT_SCHEMA_VERSION } from "../shared/schemas/common.js";
import { legacyToParams, LegacyGeneration, LegacyReasoning } from "../shared/paramsCompat.js";
import { atomicWriteJson, atomicWriteText } from "../storage/atomic.js";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessLocalDenyIndexV1Schema,
  RemoteAccessTrustIndexV1Schema
} from "../shared/schemas/remoteAccess.js";
import { RemoteAccessConfigV1Schema } from "../shared/schemas/remoteLifecycle.js";
import { remoteStatePaths } from "../remote/paths.js";
import { migrateDreamCursorGlobal } from "./migrationSteps/dreamCursorGlobal.js";
import { migrateMemoriesCrossGuildDedupe } from "./migrationSteps/memoriesCrossGuildDedupe.js";
import { migrateMemoriesGlobalOriginSubjects } from "./migrationSteps/memoriesGlobalOriginSubjects.js";
import { migrateOcrCacheUrlKeysCleanup } from "./migrationSteps/ocrCacheUrlKeysCleanup.js";
import { migratePendingObservationsGlobal } from "./migrationSteps/pendingObservationsGlobal.js";
import { migrateServerContextWindowsExplicit } from "./migrationSteps/serverContextWindowsExplicit.js";
import { layoutHasScheduleDisabled, migrateWaifuDropPromptLayout } from "./migrationSteps/waifuDropPromptLayout.js";
import { migrateWaifuParamsGateway040 } from "./migrationSteps/waifuParamsGateway040.js";
import {
  emptyMigrationLedger,
  readTrustedMigrationLedger,
  writeMigrationLedger,
  type MigrationLedger
} from "./migrationLedger.js";

export type MigrationResult = {
  applied: string[];
};

// How often a boot step runs (see the ledger in ./migrationLedger.ts):
// - "every-boot": invariant checks / housekeeping whose semantics depend on current state; never
//   recorded in the ledger.
// - "once": legacy shape conversions; recorded after a successful run and skipped afterwards.
// - "once-per-app-version": recorded with the app version and re-run when that changes, for
//   steps whose outcome depends on code shipped with the app (e.g. the gateway model registry).
type MigrationStepFrequency = "every-boot" | "once" | "once-per-app-version";

export type MigrationStep = {
  id: string;
  frequency: MigrationStepFrequency;
  // Registered ahead of its implementation (spec 8.0): a pending step is skipped and NOT recorded
  // in the ledger, so it runs normally the first boot after the owning work removes the flag.
  pending?: boolean;
  // Returns the label reported in MigrationResult.applied when the step changed anything.
  run: (dataRoot: string) => Promise<string | undefined>;
};

const label = (changed: boolean, value: string) => (changed ? value : undefined);
const countLabel = (count: number, prefix: string) => (count > 0 ? `${prefix}-${count}` : undefined);

// Order matters and is the historical boot order. Every step is idempotent, so re-running all of
// them (missing/corrupt ledger, 1.x → 2.x manual upgrades) is always safe.
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    id: "harden-remote-access-state-v1",
    frequency: "every-boot",
    run: async (dataRoot) =>
      label(await validateAndHardenRemoteAccessState(dataRoot), "harden-remote-access-state-v1")
  },
  {
    id: "orchestrator-history-responding-waifus",
    frequency: "once",
    run: async (dataRoot) =>
      label(await migrateOrchestratorHistory(dataRoot), "migrate-orchestrator-history-to-responding-waifus")
  },
  {
    id: "agent-config-retrigger-pacing",
    frequency: "once",
    run: async (dataRoot) => countLabel(await migrateAgentConfigs(dataRoot), "migrate-retrigger-pacing")
  },
  {
    id: "session-scheduled-retrigger-at",
    frequency: "once",
    run: async (dataRoot) => countLabel(await migrateSessionFiles(dataRoot), "migrate-scheduled-retrigger-at")
  },
  {
    id: "remove-guild-wide-active-participants",
    frequency: "once",
    run: async (dataRoot) =>
      countLabel(await removeGuildWideActiveParticipantCaches(dataRoot), "remove-guild-wide-active-participants")
  },
  {
    id: "memories-to-guild-scope",
    frequency: "once",
    run: async (dataRoot) => label(await migrateLegacyMemories(dataRoot), "migrate-memories-to-guild-scope")
  },
  {
    // Housekeeping, not a shape change: deleting a waifu does not touch its memories, so this is
    // what archives them on the next boot.
    id: "archive-memories-with-unknown-waifus",
    frequency: "every-boot",
    run: async (dataRoot) =>
      label(await archiveMemoriesWithUnknownWaifus(dataRoot), "archive-memories-with-unknown-waifus")
  },
  {
    id: "waifu-prompt-sections-to-layout",
    frequency: "once",
    run: async (dataRoot) => countLabel(await migrateWaifuPromptSections(dataRoot), "migrate-waifu-prompt-layout")
  },
  {
    id: "waifu-prompt-layout-w2",
    frequency: "once",
    run: async (dataRoot) => countLabel(await migrateWaifuPromptLayoutW2(dataRoot), "migrate-waifu-prompt-layout-w2")
  },
  {
    id: "waifu-memories-to-mid",
    frequency: "once",
    run: async (dataRoot) => countLabel(await migrateWaifuPromptMemoriesToMid(dataRoot), "migrate-waifu-memories-to-mid")
  },
  {
    // W3: collapse the two-store memory model into one unified MemoryRecord store. This MUST run
    // after the legacy memory steps above (they mutate the old shape) and before any read, because
    // the new schema strips importance/permanent and would silently default strength/pinned —
    // losing user-managed permanent memories — if an old-shape file were parsed without migrating.
    id: "memory-store-v2",
    frequency: "once",
    run: async (dataRoot) => label(await migrateMemoryStoreV2(dataRoot), "migrate-memory-store-v2")
  },
  {
    // §7.3: convert stored reasoning/generation into unified gateway params and remap retired
    // model ids. Must run after the shape migrations above (which may still be touching agent
    // config.json / waifu.json) and before the version stamp below. The remap table ships with the
    // app/gateway, so it re-runs whenever the app version changes.
    id: "configs-to-gateway-params",
    frequency: "once-per-app-version",
    run: async (dataRoot) => label(await migrateConfigsToGatewayParams(dataRoot), "migrate-configs-to-gateway-params")
  },
  {
    // Phase 4 (spec 8.2/8.10): drops stored params the gateway 0.4.0 catalog rejects. Owned by T7a.
    id: "waifu-params-gateway-040-v1",
    frequency: "once-per-app-version",
    run: migrateWaifuParamsGateway040
  },
  {
    // Has its own one-time marker; the cheap missing-`enabled` fill keeps running every boot.
    id: "enable-discord-bots-v1",
    frequency: "every-boot",
    run: async (dataRoot) => label(await enableDiscordBotsForUpgrade(dataRoot), "enable-discord-bots-v1")
  },
  // Phase 4 steps (spec 8.2), registered pending until their owning tasks land. They must stay
  // before the schema-version stamp and keep this relative order.
  // Implemented (T4) but kept pending until T3 stops reading layouts at runtime; T4 part 2 removes the flag.
  { id: "waifu-drop-prompt-layout-v1", frequency: "once", pending: true, run: migrateWaifuDropPromptLayout },
  { id: "server-context-windows-explicit-v1", frequency: "once", pending: true, run: migrateServerContextWindowsExplicit }, // T5
  { id: "memories-global-origin-subjects-v1", frequency: "once", pending: true, run: migrateMemoriesGlobalOriginSubjects }, // T6
  // Guarded by its own marker file (user/.memories-dedupe-v1.json) so ledger loss never re-runs it.
  { id: "memories-cross-guild-dedupe-v1", frequency: "once", pending: true, run: migrateMemoriesCrossGuildDedupe }, // T6
  { id: "pending-observations-global-v1", frequency: "once", pending: true, run: migratePendingObservationsGlobal }, // T6
  { id: "dream-cursor-global-v1", frequency: "once", pending: true, run: migrateDreamCursorGlobal }, // T6
  { id: "ocr-cache-url-keys-cleanup-v1", frequency: "once", pending: true, run: migrateOcrCacheUrlKeysCleanup }, // T2
  {
    // Runs LAST: every step above may still leave a file's schemaVersion at 1 even once its shape
    // is current. Stamping here — after all shape conversions — is what lets the next boot's
    // schema parses (z.literal(CURRENT_SCHEMA_VERSION)) succeed instead of throwing.
    id: `stamp-schema-version-${CURRENT_SCHEMA_VERSION}`,
    frequency: "once",
    run: async (dataRoot) => label(await stampSchemaVersion2(dataRoot), "stamp-schema-version-2")
  }
];

function stepIsRecorded(step: MigrationStep, ledger: MigrationLedger, appVersion: string): boolean {
  if (step.frequency === "every-boot") return false;
  const entry = ledger.steps[step.id];
  if (!entry) return false;
  return step.frequency === "once" || entry.appVersion === appVersion;
}

export async function runMigrations(
  dataRoot: string,
  options: { appVersion?: string; steps?: readonly MigrationStep[] } = {}
): Promise<MigrationResult> {
  await ensureDataLayout(dataRoot);
  const appVersion = options.appVersion ?? (await readPackageVersion());
  const trusted = await readTrustedMigrationLedger(dataRoot);
  const ledger = trusted ?? emptyMigrationLedger(appVersion);
  let ledgerDirty = trusted === undefined || trusted.appVersion !== appVersion;
  const applied: string[] = [];

  const persistLedger = async () => {
    if (!ledgerDirty) return;
    ledger.appVersion = appVersion;
    ledger.updatedAt = new Date().toISOString();
    await writeMigrationLedger(dataRoot, ledger);
  };

  try {
    for (const step of options.steps ?? MIGRATION_STEPS) {
      if (step.pending) continue;
      if (stepIsRecorded(step, ledger, appVersion)) continue;
      const result = await step.run(dataRoot);
      if (result) applied.push(result);
      if (step.frequency !== "every-boot") {
        ledger.steps[step.id] = { appliedAt: new Date().toISOString(), appVersion };
        ledgerDirty = true;
      }
    }
  } catch (error) {
    // Record the steps that completed before the failure so the next boot resumes at the failed
    // step; a ledger write failure must not mask the original error.
    await persistLedger().catch(() => undefined);
    throw error;
  }
  await persistLedger();

  return { applied };
}

// The runtime used to log in every bot with a token and ignore `enabled`, which earlier writes
// persisted as `false` (schema default / pre-P6 PUTs). Now that `enabled: false` keeps a bot
// offline, carry those bots over as enabled exactly once (marker file), so a later explicit disable
// sticks. A missing key always means enabled.
async function enableDiscordBotsForUpgrade(dataRoot: string): Promise<boolean> {
  const filePath = path.join(dataRoot, "user", "discord-bots.json");
  const markerPath = path.join(dataRoot, "user", ".discord-bots-enabled-v1.json");
  const firstPass = (await readJsonOrUndefined(markerPath)) === undefined;
  const data = await readJsonOrUndefined(filePath);
  let changed = false;
  if (isObject(data)) {
    const entries = [data.orchestrator, ...(Array.isArray(data.waifus) ? data.waifus : [])];
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const hasToken = typeof entry.token === "string" && entry.token.length > 0;
      if (!("enabled" in entry) || (firstPass && hasToken && entry.enabled === false)) {
        entry.enabled = true;
        changed = true;
      }
    }
    if (changed) await atomicWriteJson(filePath, data);
  }
  if (firstPass) {
    await atomicWriteJson(markerPath, { schemaVersion: CURRENT_SCHEMA_VERSION, appliedAt: new Date().toISOString() });
  }
  return changed;
}

async function validateAndHardenRemoteAccessState(dataRoot: string): Promise<boolean> {
  const paths = remoteStatePaths(dataRoot);
  const files = [
    { filePath: paths.hostConfig, schema: RemoteAccessConfigV1Schema },
    { filePath: paths.installation, schema: RemoteAccessInstallationStateV1Schema },
    { filePath: paths.trustIndex, schema: RemoteAccessTrustIndexV1Schema },
    { filePath: paths.localDenyIndex, schema: RemoteAccessLocalDenyIndexV1Schema }
  ] as const;
  let changed = false;
  for (const { filePath, schema } of files) {
    const value = await readJsonOrUndefined(filePath);
    if (value === undefined) {
      throw new Error(`Required remote state file is missing: ${path.relative(dataRoot, filePath)}`);
    }
    schema.parse(value);
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Remote state path is not an owned regular file: ${path.relative(dataRoot, filePath)}`);
    }
    const mode = info.mode & 0o777;
    if (mode !== 0o600) {
      await chmod(filePath, 0o600);
      changed = true;
    }
  }
  return changed;
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
  personality: "personalityReminder",
  // Not a W1 toggle, but `waifu-drop-prompt-layout-v1` (which runs later) reads it from the layout.
  schedule: "schedule"
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

const VALID_MEMORY_KINDS = new Set<string>(MEMORY_KINDS);

// Defaults to 3 — the domain midpoint — when the old importance field is absent or corrupt.
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
        strength: WAIFU_NOTE_STRENGTH,
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
    const scheduleDisabled = layoutHasScheduleDisabled(data.promptLayout);
    const layout = defaultWaifuPromptLayout();
    // Keep the one choice `waifu-drop-prompt-layout-v1` still honours.
    if (scheduleDisabled) setBlockEnabled(layout, "schedule", false);
    data.promptLayout = layout;
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

// Fix-2 (recency layout): relevantMemories moved from the trailing slot to the mid slot so the
// newest messages keep the final prompt positions. Moves the top-level trailing node (keeping
// its enabled flag) to the end of mid. A node the user placed inside a custom group stays put —
// that arrangement was deliberate.
async function migrateWaifuPromptMemoriesToMid(dataRoot: string): Promise<number> {
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
    if (!isObject(data) || !isObject(data.promptLayout)) continue;
    const layout = data.promptLayout as { mid?: unknown; trailing?: unknown };
    if (!Array.isArray(layout.mid) || !Array.isArray(layout.trailing)) continue;
    const index = layout.trailing.findIndex(
      (node) => isObject(node) && node.kind === "block" && node.blockId === "relevantMemories"
    );
    if (index < 0) continue;
    const [node] = layout.trailing.splice(index, 1);
    layout.mid.push(node);
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

// §7.3: fold legacy reasoning/generation config shapes into the unified gateway `params` record,
// and remap any retired (providerId, modelId) pair per LEGACY_MODEL_MAP / the live registry. Runs
// over the three agent config.json files and every waifu.json.
async function migrateConfigsToGatewayParams(dataRoot: string): Promise<boolean> {
  let changed = false;

  const agentDirs = ["orchestrator", "stage-manager", "reviewer"];
  for (const agent of agentDirs) {
    const filePath = path.join(dataRoot, "user", agent, "config.json");
    if (await migrateConfigDocToGatewayParams(filePath)) changed = true;
  }

  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let waifuEntries: string[];
  try {
    waifuEntries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") waifuEntries = [];
    else throw error;
  }
  for (const entry of waifuEntries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    if (await migrateConfigDocToGatewayParams(filePath)) changed = true;
  }

  return changed;
}

// Mutates a single agent config.json / waifu.json in place. Returns whether it was written.
async function migrateConfigDocToGatewayParams(filePath: string): Promise<boolean> {
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data)) return false;
  let mutated = false;

  if ("reasoning" in data || "generation" in data) {
    const converted = legacyToParams({
      reasoning: data.reasoning as LegacyReasoning | undefined,
      generation: data.generation as LegacyGeneration | undefined
    });
    const existingParams = isObject(data.params) ? data.params : {};
    data.params = { ...converted, ...existingParams };
    delete data.reasoning;
    delete data.generation;
    mutated = true;
  }

  if (typeof data.modelId === "string" && data.modelId.length > 0) {
    try {
      const target = resolveModelTarget({
        providerId: typeof data.providerId === "string" ? data.providerId : undefined,
        modelId: data.modelId
      });
      if (target.remapped) {
        data.providerId = target.providerId;
        data.modelId = target.modelId;
        mutated = true;
      }
    } catch {
      // Unknown model id — leave it in place rather than silently substituting one.
      // waifus doctor (T5) surfaces this as a warning.
    }
  }

  if (!mutated) return false;
  await atomicWriteJson(filePath, data);
  return true;
}

// Final boot-migration step: sets `schemaVersion: CURRENT_SCHEMA_VERSION` on every persisted
// config file still carrying an older value, so the strict `z.literal(CURRENT_SCHEMA_VERSION)`
// parses used throughout the app don't throw on the very next read. Covers the root TOML app
// config, the ephemeral runtime/pid files under app/, and every JSON file under user/ (recursive —
// providers, discord bots, the three agent dirs, every waifu, every server, and memory). The OCR
// results cache under app/cache/ocr lives on its own CACHE_SCHEMA_VERSION (see
// src/orchestration/ocr.ts) and is intentionally never walked here.
async function stampSchemaVersion2(dataRoot: string): Promise<boolean> {
  let changed = false;

  if (await stampTomlConfigSchemaVersion(path.join(dataRoot, "config.toml"))) {
    changed = true;
  }

  for (const name of ["runtime.json", "pid.json"]) {
    if (await stampJsonSchemaVersion(path.join(dataRoot, "app", name))) {
      changed = true;
    }
  }

  const userJsonFiles = await collectJsonFilesRecursive(path.join(dataRoot, "user"));
  for (const filePath of userJsonFiles) {
    if (await stampJsonSchemaVersion(filePath)) changed = true;
  }

  return changed;
}

// Read-only counterpart to stampSchemaVersion2, for `waifus doctor` (T5). Same enumeration (root
// TOML config, the two app/ runtime files, everything under user/), but reports files whose
// schemaVersion is stale instead of mutating them — doctor never runs migrations. Paths are
// returned relative to dataRoot with forward slashes, for stable, portable JSON output.
export async function findUnstampedFiles(dataRoot: string): Promise<string[]> {
  const unstamped: string[] = [];

  if (await isTomlConfigUnstamped(path.join(dataRoot, "config.toml"))) {
    unstamped.push("config.toml");
  }

  for (const name of ["runtime.json", "pid.json"]) {
    const filePath = path.join(dataRoot, "app", name);
    if (await isJsonSchemaVersionUnstamped(filePath)) {
      unstamped.push(toPosixRelative(dataRoot, filePath));
    }
  }

  const userJsonFiles = await collectJsonFilesRecursive(path.join(dataRoot, "user"));
  for (const filePath of userJsonFiles) {
    if (await isJsonSchemaVersionUnstamped(filePath)) {
      unstamped.push(toPosixRelative(dataRoot, filePath));
    }
  }

  return unstamped;
}

function toPosixRelative(dataRoot: string, filePath: string): string {
  return path.relative(dataRoot, filePath).split(path.sep).join("/");
}

type SchemaVersionState = { data: Record<string, unknown>; stale: boolean };

// Shared read step for the JSON schemaVersion check/stamp pair below: parses the file leniently
// and reports whether it's a versioned record (has a `schemaVersion` field) and whether that
// version is stale. `isJsonSchemaVersionUnstamped` only needs `stale`; `stampJsonSchemaVersion`
// reuses `data` so it can mutate and rewrite the same parsed object instead of re-reading.
async function readJsonSchemaVersionState(filePath: string): Promise<SchemaVersionState | undefined> {
  const data = await readJsonOrUndefined(filePath);
  if (!isObject(data) || !("schemaVersion" in data)) return undefined;
  return { data, stale: data.schemaVersion !== CURRENT_SCHEMA_VERSION };
}

async function isJsonSchemaVersionUnstamped(filePath: string): Promise<boolean> {
  const state = await readJsonSchemaVersionState(filePath);
  return state?.stale ?? false;
}

// Shared read step for the TOML schemaVersion check/stamp pair below — same contract as
// `readJsonSchemaVersionState`, but for the root TOML app config.
async function readTomlSchemaVersionState(filePath: string): Promise<SchemaVersionState | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    // Malformed TOML — not this walk's concern; loadAppConfig reports it as a real error.
    return undefined;
  }
  if (!isObject(parsed) || !("schemaVersion" in parsed)) return undefined;
  return { data: parsed, stale: parsed.schemaVersion !== CURRENT_SCHEMA_VERSION };
}

async function isTomlConfigUnstamped(filePath: string): Promise<boolean> {
  const state = await readTomlSchemaVersionState(filePath);
  return state?.stale ?? false;
}

// Lenient companion to the strict `user/providers.json` read, for `waifus doctor` (T5 fix). When
// the strict ProviderCredentialsFileSchema parse fails only because of a stale schemaVersion,
// doctor should still report the real configured provider ids instead of an empty list — same
// lenient readJsonOrUndefined + isObject pattern as findUnresolvedModels below, rather than the
// strict domain schema.
export async function readProviderIdsLeniently(dataRoot: string): Promise<string[]> {
  const data = await readJsonOrUndefined(path.join(dataRoot, "user", "providers.json"));
  if (!isObject(data) || !isObject(data.providers)) return [];
  return Object.keys(data.providers);
}

export type LenientDiscordBotsSummary = {
  orchestratorConfigured: boolean;
  waifuBotCount: number;
};

// Lenient companion to the strict `user/discord-bots.json` read, for `waifus doctor` (T5 fix).
// Mirrors exactly the two fields the strict path reports (orchestrator token presence, waifu bot
// count) by reading the raw structure instead of requiring the full DiscordBotsFileSchema parse.
export async function readDiscordBotsLeniently(dataRoot: string): Promise<LenientDiscordBotsSummary> {
  const data = await readJsonOrUndefined(path.join(dataRoot, "user", "discord-bots.json"));
  if (!isObject(data)) return { orchestratorConfigured: false, waifuBotCount: 0 };
  const orchestrator = data.orchestrator;
  return {
    orchestratorConfigured: isObject(orchestrator) && orchestrator.token !== undefined,
    waifuBotCount: Array.isArray(data.waifus) ? data.waifus.length : 0
  };
}

export type UnresolvedModelRef = { scope: string; providerId: string | null; modelId: string };

// Read-only companion to migrateConfigsToGatewayParams' model-remap step, for `waifus doctor`
// (T5). Same file set (three agent config.json docs + every waifu.json), but reports ids
// resolveModelTarget can't route instead of silently leaving them in place. Uses lenient raw JSON
// reads rather than the domain Zod schemas so an unmigrated (schemaVersion 1) file still surfaces
// its unresolved model instead of being dropped by a strict schema parse failure.
export async function findUnresolvedModels(dataRoot: string): Promise<UnresolvedModelRef[]> {
  const unresolved: UnresolvedModelRef[] = [];

  const agentDirs = ["orchestrator", "stage-manager", "reviewer"];
  for (const agent of agentDirs) {
    const filePath = path.join(dataRoot, "user", agent, "config.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const ref = unresolvedModelRef(data, agent);
    if (ref) unresolved.push(ref);
  }

  const waifusRoot = path.join(dataRoot, "user", "waifus");
  let waifuEntries: string[];
  try {
    waifuEntries = await readdir(waifusRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") waifuEntries = [];
    else throw error;
  }
  for (const entry of waifuEntries) {
    const filePath = path.join(waifusRoot, entry, "waifu.json");
    const data = await readJsonOrUndefined(filePath);
    if (!isObject(data)) continue;
    const scope = typeof data.id === "string" && data.id.length > 0 ? `waifu:${data.id}` : `waifu:${entry}`;
    const ref = unresolvedModelRef(data, scope);
    if (ref) unresolved.push(ref);
  }

  return unresolved;
}

function unresolvedModelRef(data: Record<string, unknown>, scope: string): UnresolvedModelRef | undefined {
  if (typeof data.modelId !== "string" || data.modelId.length === 0) return undefined;
  const providerId = typeof data.providerId === "string" ? data.providerId : undefined;
  try {
    resolveModelTarget({ providerId, modelId: data.modelId });
    return undefined;
  } catch {
    return { scope, providerId: providerId ?? null, modelId: data.modelId };
  }
}

async function collectJsonFilesRecursive(dir: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFilesRecursive(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    }
  }
  return files;
}

// Only stamps files that already declare a schemaVersion field (i.e. are actually versioned
// records) — leaves unrelated JSON untouched.
async function stampJsonSchemaVersion(filePath: string): Promise<boolean> {
  const state = await readJsonSchemaVersionState(filePath);
  if (!state || !state.stale) return false;
  state.data.schemaVersion = CURRENT_SCHEMA_VERSION;
  await atomicWriteJson(filePath, state.data);
  return true;
}

async function stampTomlConfigSchemaVersion(filePath: string): Promise<boolean> {
  const state = await readTomlSchemaVersionState(filePath);
  if (!state || !state.stale) return false;
  state.data.schemaVersion = CURRENT_SCHEMA_VERSION;
  await atomicWriteText(filePath, stringifyToml(state.data) + "\n", { mode: 0o600 });
  return true;
}
