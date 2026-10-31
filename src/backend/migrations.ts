import { chmod, lstat, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ensureDataLayout, readPackageVersion } from "../config/layout.js";
import { LEGACY_MODEL_MAP, RETRIGGER_MAX_SECONDS, RETRIGGER_MIN_SECONDS, WAIFU_NOTE_STRENGTH } from "./migrationSteps/legacy.js";
import { extractLegacyEntities as extractEntities } from "./migrationSteps/memorySupport.js";
import { MEMORY_KINDS } from "./migrationSteps/legacySchemas.js";
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
import { migrateOcrCacheTtlDefault168 } from "./migrationSteps/ocrCacheTtlDefault168.js";
import { migrateOrchestratorHistoryPerGuild } from "./migrationSteps/orchestratorHistoryPerGuild.js";
import { migrateServerDropEnabledFlags } from "./migrationSteps/serverDropEnabledFlags.js";
import { migrateOcrCacheUrlKeysCleanup } from "./migrationSteps/ocrCacheUrlKeysCleanup.js";
import { migratePendingObservationsGlobal } from "./migrationSteps/pendingObservationsGlobal.js";
import { migrateServerContextWindowsExplicit } from "./migrationSteps/serverContextWindowsExplicit.js";
import { migrateWaifuDropPromptLayout } from "./migrationSteps/waifuDropPromptLayout.js";
import { migrateLivingCastModels } from "./migrationSteps/livingCastModels.js";
import { checkStoredModelEfforts } from "./migrationSteps/modelEffortCheck.js";
import { migrateLivingCastTypingHolds } from "./migrationSteps/livingCastDebounce.js";
import { migrateLivingCastHome } from "./migrationSteps/livingCastHome.js";
import { migrateLivingCastBedTime, migrateLivingCastDropBusy, migrateLivingCastLifeFolder } from "./migrationSteps/livingCastLifeFolder.js";
import { DROP_REST_NOTICE_RATIO_STEP_ID, migrateLivingCastDropRestNoticeRatio } from "./migrationSteps/livingCastRestNoticeRatio.js";
import { migrateLivingCastSendCap, SEND_CAP_STEP_ID } from "./migrationSteps/livingCastSendCap.js";
import { migrateLivingCastWakeups, WAKEUPS_STEP_ID } from "./migrationSteps/livingCastWakeups.js";
import { migrateLivingCastNoSchedule, NO_SCHEDULE_STEP_ID } from "./migrationSteps/livingCastNoSchedule.js";
import { migrateLivingCastWebTurnCap, WEB_TURN_CAP_STEP_ID } from "./migrationSteps/livingCastWebTurnCap.js";
import { migrateLivingCastMemoriesToNotes } from "./migrationSteps/livingCastMemoriesToNotes.js";
import { migrateLivingCastArchiveDirector } from "./migrationSteps/livingCastArchiveDirector.js";
import { migrateLivingCastDmState } from "./migrationSteps/livingCastDmState.js";
import { migrateLivingCastServerFields } from "./migrationSteps/livingCastServerFields.js";
import { migrateLivingCastAppConfig } from "./migrationSteps/livingCastAppConfig.js";
import { installedCatalog, routeKey } from "../models/catalog.js";
import {
  emptyMigrationLedger,
  readTrustedMigrationLedger,
  writeMigrationLedger,
  type MigrationLedger
} from "./migrationLedger.js";

export type MigrationResult = {
  applied: string[];
  /** Steps that skipped input they could not read: not recorded, so the next boot runs them again. */
  incomplete: string[];
};

/**
 * What a step's run reports: the label of what it changed (or undefined), or `incomplete` when it
 * left unreadable input alone. An incomplete step is never recorded as done (a once-step would
 * otherwise skip that input forever); it runs again at the next boot, and it stays idempotent.
 */
export type MigrationStepOutcome = string | undefined | { applied?: string; incomplete: string };

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
  // Returns the label reported in MigrationResult.applied when the step changed anything.
  run: (dataRoot: string) => Promise<MigrationStepOutcome>;
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
  // The legacy prompt-layout steps (waifu-prompt-sections-to-layout, waifu-prompt-layout-w2,
  // waifu-memories-to-mid) were removed with the layout editor (spec 8.6). Their ids may remain in
  // existing ledgers as history; waifu-drop-prompt-layout-v1 below handles every legacy shape.
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
    // config.json / waifu.json) and before the version stamp below. The remap table is frozen in
    // migrationSteps/legacy.ts since the gateway left (Living cast L1); living-cast-models-v1 then
    // turns the result into winter model choices.
    id: "configs-to-gateway-params",
    frequency: "once-per-app-version",
    run: async (dataRoot) => label(await migrateConfigsToGatewayParams(dataRoot), "migrate-configs-to-gateway-params")
  },
  // Removed with the gateway (Living cast L1): waifu-params-gateway-040-v1 (Phase 4, dropped params
  // the gateway 0.4.0 catalog rejected). Its id may remain in existing ledgers as history;
  // living-cast-models-v1 drops `params` altogether.
  {
    // Has its own one-time marker; the cheap missing-`enabled` fill keeps running every boot.
    id: "enable-discord-bots-v1",
    frequency: "every-boot",
    run: async (dataRoot) => label(await enableDiscordBotsForUpgrade(dataRoot), "enable-discord-bots-v1")
  },
  // Phase 4 steps (spec 8.2). They must stay before the schema-version stamp and keep this
  // relative order.
  { id: "waifu-drop-prompt-layout-v1", frequency: "once", run: migrateWaifuDropPromptLayout }, // T4
  { id: "server-context-windows-explicit-v1", frequency: "once", run: migrateServerContextWindowsExplicit }, // T5
  { id: "memories-global-origin-subjects-v1", frequency: "once", run: migrateMemoriesGlobalOriginSubjects }, // T6
  // Guarded by its own marker file (user/.memories-dedupe-v1.json) so ledger loss never re-runs it.
  { id: "memories-cross-guild-dedupe-v1", frequency: "once", run: migrateMemoriesCrossGuildDedupe }, // T6
  { id: "pending-observations-global-v1", frequency: "once", run: migratePendingObservationsGlobal }, // T6
  { id: "dream-cursor-global-v1", frequency: "once", run: migrateDreamCursorGlobal }, // T6
  { id: "ocr-cache-url-keys-cleanup-v1", frequency: "once", run: migrateOcrCacheUrlKeysCleanup }, // T2
  { id: "ocr-cache-ttl-168-v1", frequency: "once", run: migrateOcrCacheTtlDefault168 }, // acceptance M5
  // Phase 5 steps (spec 9.3, 9.7). The history split must stay after orchestrator-history-responding-waifus
  // above, which still normalizes legacy decision shapes in the global file it splits.
  { id: "orchestrator-history-per-guild-v1", frequency: "every-boot", run: migrateOrchestratorHistoryPerGuild },
  { id: "server-drop-enabled-flags-v1", frequency: "once", run: migrateServerDropEnabledFlags },
  // Living cast steps (spec §11.2). The gateway-era model fields become nested winter model choices;
  // the effort check re-validates stored efforts against the installed winter catalog every boot.
  { id: "living-cast-models-v1", frequency: "once", run: migrateLivingCastModels },
  { id: "living-cast-model-effort-check", frequency: "every-boot", run: (dataRoot) => checkStoredModelEfforts(dataRoot) },
  // Living cast L2 (spec §7.4, §11.2): the memory store becomes notes, the director's data is
  // archived, an in-flight DM becomes a wake, and server files and config.toml lose the retired
  // settings. Each is idempotent; everything retired lands in user/.archive/living-cast/.
  { id: "living-cast-memories-to-notes-v1", frequency: "once", run: (dataRoot) => migrateLivingCastMemoriesToNotes(dataRoot) },
  { id: "living-cast-archive-director-v1", frequency: "once", run: migrateLivingCastArchiveDirector },
  { id: "living-cast-dm-state-v1", frequency: "once", run: (dataRoot) => migrateLivingCastDmState(dataRoot) },
  { id: "living-cast-server-fields-v1", frequency: "once", run: migrateLivingCastServerFields },
  { id: "living-cast-app-config-v1", frequency: "once", run: migrateLivingCastAppConfig },
  // Living cast L4 (spec §16.13): a development host's L2-era notes, reminders and watches become
  // her home folder and files, and a life still on the L2 tools starts a new epoch.
  { id: "living-cast-home-v1", frequency: "once", run: (dataRoot) => migrateLivingCastHome(dataRoot) },
  // Typing-aware holds (spec §4.2): debounce values still at an earlier default move to the new ones.
  { id: "living-cast-typing-holds-v1", frequency: "once", run: migrateLivingCastTypingHolds },
  // Her day (spec §21.6): her app-managed files move into ~/life/ (and lives start a new epoch), and
  // the owner-set busy blocks are archived and dropped (her own ~/life/schedule.json replaced them
  // until §38).
  { id: "living-cast-life-folder-v1", frequency: "once", run: (dataRoot) => migrateLivingCastLifeFolder(dataRoot) },
  { id: "living-cast-drop-busy-v1", frequency: "once", run: (dataRoot) => migrateLivingCastDropBusy(dataRoot) },
  // Bed time (spec §21.6c): the owner's availability.sleep is renamed availability.bedTime (archived first).
  { id: "living-cast-bed-time-v1", frequency: "once", run: (dataRoot) => migrateLivingCastBedTime(dataRoot) },
  // The rest notice at the trigger (spec §26): life.restNoticeRatio is dropped from config.toml (archived first).
  { id: DROP_REST_NOTICE_RATIO_STEP_ID, frequency: "once", run: (dataRoot) => migrateLivingCastDropRestNoticeRatio(dataRoot) },
  // SendMessage scripts (spec §27.1): life.maxSendsPerTurn still at the old default 8 becomes 15.
  { id: SEND_CAP_STEP_ID, frequency: "once", run: migrateLivingCastSendCap },
  // Web scripts (spec §31.4): life.webFetch.maxPerTurn still at the old default 3 becomes 6.
  { id: WEB_TURN_CAP_STEP_ID, frequency: "once", run: migrateLivingCastWebTurnCap },
  // Wakeup(script) (spec §30.3): her reminders.json and watches.json become ~/life/wakeups.json (old
  // files archived, side files follow), and lives on the old tools start a new epoch.
  { id: WAKEUPS_STEP_ID, frequency: "once", run: (dataRoot) => migrateLivingCastWakeups(dataRoot) },
  // No schedule, no bed time (spec §38): her bed time, scheduleInPrompt and the sleep notice leave
  // every waifu.json and the day's settings leave config.toml (archived first); her ~/life/schedule.json
  // is archived and begun lives start a new epoch.
  { id: NO_SCHEDULE_STEP_ID, frequency: "once", run: (dataRoot) => migrateLivingCastNoSchedule(dataRoot) },
  {
    // Runs LAST: every step above may still leave a file's schemaVersion at 1 even once its shape
    // is current. Stamping here — after all shape conversions — is what lets the next boot's
    // schema parses (z.literal(CURRENT_SCHEMA_VERSION)) succeed instead of throwing.
    id: `stamp-schema-version-${CURRENT_SCHEMA_VERSION}`,
    frequency: "once",
    run: async (dataRoot) => label(await stampSchemaVersion2(dataRoot), "stamp-schema-version-2")
  }
];

/** The Living cast L2 data steps (spec §11.2), registered above just before the schema stamp. */
export const LIVING_CAST_L2_STEP_IDS: ReadonlySet<string> = new Set([
  "living-cast-memories-to-notes-v1",
  "living-cast-archive-director-v1",
  "living-cast-dm-state-v1",
  "living-cast-server-fields-v1",
  "living-cast-app-config-v1"
]);

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
  const incomplete: string[] = [];

  const persistLedger = async () => {
    if (!ledgerDirty) return;
    ledger.appVersion = appVersion;
    ledger.updatedAt = new Date().toISOString();
    await writeMigrationLedger(dataRoot, ledger);
  };

  try {
    for (const step of options.steps ?? MIGRATION_STEPS) {
      if (stepIsRecorded(step, ledger, appVersion)) continue;
      const outcome = await step.run(dataRoot);
      const result = typeof outcome === "object" ? outcome.applied : outcome;
      if (result) applied.push(result);
      if (typeof outcome === "object") {
        incomplete.push(`${step.id}: ${outcome.incomplete}`);
        continue;
      }
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
  await recordIncompleteMigrations(dataRoot, incomplete).catch(() => undefined);

  return { applied, incomplete };
}

/**
 * Steps that left unreadable data alone at the last start (`app/migrations-incomplete.json`), for
 * `waifus doctor`, `waifus status` and the dashboard's owner notices. Written only while there are
 * any (a clean run removes it), so it never shows up in an ordinary data root.
 */
export const INCOMPLETE_MIGRATIONS_RELATIVE_PATH = path.join("app", "migrations-incomplete.json");

export type IncompleteMigration = { step: string; detail: string; at: string };

async function recordIncompleteMigrations(dataRoot: string, incomplete: readonly string[]): Promise<void> {
  const file = path.join(dataRoot, INCOMPLETE_MIGRATIONS_RELATIVE_PATH);
  if (incomplete.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const at = new Date().toISOString();
  const steps: IncompleteMigration[] = incomplete.map((entry) => {
    const index = entry.indexOf(": ");
    return index > 0 ? { step: entry.slice(0, index), detail: entry.slice(index + 2), at } : { step: entry, detail: "", at };
  });
  await atomicWriteJson(file, { updatedAt: at, steps }, { mode: 0o600 });
}

/** The incomplete steps recorded by the last start (none when the file is missing or unreadable). */
export async function readIncompleteMigrations(dataRoot: string): Promise<IncompleteMigration[]> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dataRoot, INCOMPLETE_MIGRATIONS_RELATIVE_PATH), "utf8")) as { steps?: unknown };
    if (!Array.isArray(parsed.steps)) return [];
    return parsed.steps.flatMap((entry): IncompleteMigration[] => {
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      return typeof record.step === "string"
        ? [{ step: record.step, detail: typeof record.detail === "string" ? record.detail : "", at: typeof record.at === "string" ? record.at : "" }]
        : [];
    });
  } catch {
    return [];
  }
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

    // Phase 4: memories are global, so a record whose guild cannot be recovered stays active
    // without one (memories-global-origin-subjects-v1 gives it `origin: {}`).
    if (guildId && memory.guildId !== guildId) {
      memory.guildId = guildId;
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
      memory.archivedReason = "unknown_waifu";
      // Before memories-global-origin-subjects-v1 has run a record has no revision yet.
      if (typeof memory.revision === "number") memory.revision += 1;
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
    // waifuId/content are required; a guild-less record is kept (Phase 4: memories are global and
    // memories-global-origin-subjects-v1 gives it `origin: {}`).
    if (!waifuId || !content) continue;
    const next: Record<string, unknown> = {
      id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomUUID(),
      ...(guildId ? { guildId } : {}),
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
      if (!content || !waifuId) continue;
      const note: Record<string, unknown> = {
        id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : randomUUID(),
        ...(guildId ? { guildId } : {}),
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
    // Only retired ids remap; any other id is left in place rather than silently substituted.
    const mapped = LEGACY_MODEL_MAP[data.modelId];
    if (mapped) {
      data.providerId = mapped.providerId;
      data.modelId = mapped.modelId;
      mutated = true;
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
  houseConfigured: boolean;
  waifuBotCount: number;
};

// Lenient companion to the strict `user/discord-bots.json` read, for `waifus doctor` (T5 fix).
// Mirrors exactly the two fields the strict path reports (House bot token presence, waifu bot
// count) by reading the raw structure instead of requiring the full DiscordBotsFileSchema parse.
export async function readDiscordBotsLeniently(dataRoot: string): Promise<LenientDiscordBotsSummary> {
  const data = await readJsonOrUndefined(path.join(dataRoot, "user", "discord-bots.json"));
  if (!isObject(data)) return { houseConfigured: false, waifuBotCount: 0 };
  const orchestrator = data.orchestrator;
  return {
    houseConfigured: isObject(orchestrator) && orchestrator.token !== undefined,
    waifuBotCount: Array.isArray(data.waifus) ? data.waifus.length : 0
  };
}

export type UnresolvedModelRef = { scope: string; providerId: string | null; modelId: string };

// For `waifus doctor`: every stored model choice (each waifu.json and the assistant config) whose
// route the installed winter catalog does not carry, plus any gateway-era flat model id that has
// not been migrated yet. Uses lenient raw JSON reads rather than the domain Zod schemas so an
// unmigrated file still surfaces its model instead of being dropped by a strict parse failure.
export async function findUnresolvedModels(dataRoot: string): Promise<UnresolvedModelRef[]> {
  const unresolved: UnresolvedModelRef[] = [];

  const assistant = await readJsonOrUndefined(path.join(dataRoot, "user", "assistant", "config.json"));
  if (isObject(assistant)) {
    const ref = unresolvedModelRef(assistant, "assistant");
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
  const model = data.model;
  if (isObject(model) && typeof model.providerId === "string" && typeof model.modelId === "string") {
    const key = routeKey({ providerId: model.providerId, modelId: model.modelId });
    return installedCatalog().models.some((entry) => entry.key === key)
      ? undefined
      : { scope, providerId: model.providerId, modelId: model.modelId };
  }
  // A gateway-era flat id that living-cast-models-v1 has not converted yet.
  if (typeof data.modelId !== "string" || data.modelId.length === 0) return undefined;
  return { scope, providerId: typeof data.providerId === "string" ? data.providerId : null, modelId: data.modelId };
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
      // `user/.archive/` holds verbatim copies of pre-migration documents: never re-stamped.
      if (entry.name === ".archive") continue;
      // A waifu's own folders (`user/waifus/<id>/home`, `/tmp`, Living cast §16.2) hold her files,
      // not app records: a JSON file of hers is never stamped, and one that does not parse never
      // stops a boot.
      if ((entry.name === "home" || entry.name === "tmp") && path.basename(path.dirname(dir)) === "waifus") continue;
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
