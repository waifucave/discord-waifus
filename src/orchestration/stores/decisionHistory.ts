// Persistence for orchestrator decision history (and its responder outcomes) plus the
// stage-manager and reviewer history logs.
//
// Orchestrator decisions are stored PER GUILD (spec 9.3): `user/servers/<guildId>/orchestrator-history.json`
// under the resource key `orchestrator:history:<guildId>`, newest first, capped at 300 per guild.
// Every write takes only its own guild's lock, so two guilds recording decisions at the same time
// never contend. Decisions with no guild (untargeted manual triggers) live in the read-only
// `user/orchestrator/history-legacy.json` that the per-guild migration produces.

import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  OrchestratorDecisionHistoryEntry,
  OrchestratorDecisionStatus,
  OrchestratorHistoryFile,
  OrchestratorHistoryFileSchema,
  OrchestratorResponderOutcome,
  OrchestratorRespondingWaifu,
  ReviewerHistoryFileSchema,
  StageManagerHistoryFileSchema,
  createEmptyRevisionedFile
} from "../../shared/schemas/domain.js";
import { StorageService } from "../../storage/storageService.js";

/** Decisions kept per guild. */
export const DECISION_HISTORY_CAP_PER_GUILD = 300;
/** Decisions that carry no guild (read-only; produced by the per-guild migration). */
export const LEGACY_DECISION_HISTORY_PATH = path.join("user", "orchestrator", "history-legacy.json");

const emptyHistory = (): OrchestratorHistoryFile =>
  OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }));

function isSafeGuildDirName(guildId: string): boolean {
  // Same alphabet as the API's assertSafeId: the id becomes a directory name.
  return /^[A-Za-z0-9._:-]+$/.test(guildId) && !/^\.+$/.test(guildId);
}

export function decisionHistoryPath(guildId: string): string {
  if (!isSafeGuildDirName(guildId)) throw new Error(`Invalid guild id for decision history: ${guildId}`);
  return path.join("user", "servers", guildId, "orchestrator-history.json");
}

export function decisionHistoryResourceKey(guildId: string): string {
  return `orchestrator:history:${guildId}`;
}

async function updateGuildHistory(
  storage: StorageService,
  guildId: string,
  transform: (decisions: OrchestratorDecisionHistoryEntry[]) => OrchestratorDecisionHistoryEntry[]
): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: decisionHistoryResourceKey(guildId),
    relativePath: decisionHistoryPath(guildId),
    schema: OrchestratorHistoryFileSchema,
    fallback: emptyHistory(),
    transform: (current) => ({ ...current, decisions: transform(current.decisions) })
  });
}

async function listHistoryGuildIds(storage: StorageService): Promise<string[]> {
  try {
    const entries = await readdir(path.join(storage.dataRoot, "user", "servers"), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isSafeGuildDirName(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** One guild's decision-history file (empty when it has none yet). */
export async function readOrchestratorHistoryForGuild(
  storage: StorageService,
  guildId: string
): Promise<OrchestratorHistoryFile> {
  return storage.readJson(decisionHistoryPath(guildId), OrchestratorHistoryFileSchema, emptyHistory());
}

export async function readCompletedOrchestratorDecisionsForChannel(
  storage: StorageService,
  guildId: string,
  channelId: string
): Promise<OrchestratorDecisionHistoryEntry[]> {
  const history = await readOrchestratorHistoryForGuild(storage, guildId);
  return history.decisions.filter(
    (decision) => decision.channelId === channelId && decision.status === "completed"
  );
}

/** One decision by id (any status), or undefined once it rotated out of its guild's history. */
export async function readOrchestratorDecision(
  storage: StorageService,
  guildId: string,
  id: string
): Promise<OrchestratorDecisionHistoryEntry | undefined> {
  const history = await readOrchestratorHistoryForGuild(storage, guildId);
  return history.decisions.find((decision) => decision.id === id);
}

/**
 * Every guild's history plus `history-legacy.json`, merged newest first (ties keep file order).
 * The envelope takes the highest revision and latest update of the files read. An unreadable file
 * is skipped: one broken guild file must not take the whole history view down.
 */
export async function readMergedOrchestratorHistory(storage: StorageService): Promise<OrchestratorHistoryFile> {
  const files: OrchestratorHistoryFile[] = [];
  const tryRead = async (relativePath: string): Promise<void> => {
    try {
      files.push(await storage.readJson(relativePath, OrchestratorHistoryFileSchema, emptyHistory()));
    } catch {
      // skipped, see above
    }
  };
  for (const guildId of await listHistoryGuildIds(storage)) {
    await tryRead(decisionHistoryPath(guildId));
  }
  await tryRead(LEGACY_DECISION_HISTORY_PATH);
  const base = emptyHistory();
  for (const file of files) {
    if (file.revision > base.revision) base.revision = file.revision;
    if (file.updatedAt > base.updatedAt) base.updatedAt = file.updatedAt;
  }
  const decisions = files.flatMap((file) => file.decisions);
  // Array.prototype.sort is stable: equal timestamps keep their file-then-position order.
  decisions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { ...base, decisions };
}

export async function appendOrchestratorHistory(storage: StorageService, entry: {
  id: string;
  guildId: string;
  channelId: string;
  action: "reply" | "no_reply";
  respondingWaifus: OrchestratorRespondingWaifu[];
  retriggerAfterSeconds?: number;
  wakePlan?: string;
  reasoning: string;
  status: OrchestratorDecisionStatus;
  waifuMessageIds: string[];
  responderOutcomes: OrchestratorResponderOutcome[];
  createdAt: string;
}) {
  await updateGuildHistory(storage, entry.guildId, (decisions) =>
    [entry, ...decisions].slice(0, DECISION_HISTORY_CAP_PER_GUILD)
  );
}

export async function updateOrchestratorDecisionStatus(
  storage: StorageService,
  guildId: string,
  id: string,
  status: OrchestratorDecisionStatus
): Promise<void> {
  await updateGuildHistory(storage, guildId, (decisions) =>
    decisions.map((decision) => (decision.id === id ? { ...decision, status } : decision))
  );
}

export async function insertOrchestratorResponderOutcomeAfter(
  storage: StorageService,
  guildId: string,
  decisionId: string,
  afterOutcomeId: string,
  outcome: OrchestratorResponderOutcome
): Promise<void> {
  await updateGuildHistory(storage, guildId, (decisions) =>
    decisions.map((decision) => {
      if (decision.id !== decisionId) return decision;
      const responderOutcomes = [...decision.responderOutcomes];
      const afterIndex = responderOutcomes.findIndex((entry) => entry.id === afterOutcomeId);
      responderOutcomes.splice(afterIndex >= 0 ? afterIndex + 1 : responderOutcomes.length, 0, outcome);
      return { ...decision, responderOutcomes };
    })
  );
}

export async function moveOrchestratorResponderOutcomeAfter(
  storage: StorageService,
  guildId: string,
  decisionId: string,
  afterOutcomeId: string,
  outcomeId: string,
  handoffFromWaifuId: string
): Promise<void> {
  await updateGuildHistory(storage, guildId, (decisions) =>
    decisions.map((decision) => {
      if (decision.id !== decisionId) return decision;
      const responderOutcomes = [...decision.responderOutcomes];
      const existingIndex = responderOutcomes.findIndex((entry) => entry.id === outcomeId);
      if (existingIndex < 0) return decision;
      const [existing] = responderOutcomes.splice(existingIndex, 1);
      const afterIndex = responderOutcomes.findIndex((entry) => entry.id === afterOutcomeId);
      responderOutcomes.splice(afterIndex >= 0 ? afterIndex + 1 : responderOutcomes.length, 0, {
        ...existing,
        handoffFromWaifuId
      });
      return { ...decision, responderOutcomes };
    })
  );
}

export async function updateOrchestratorResponderOutcome(
  storage: StorageService,
  guildId: string,
  decisionId: string,
  outcomeId: string,
  patch: Partial<Pick<
    OrchestratorResponderOutcome,
    "handoffFromWaifuId" | "status" | "reason" | "directiveStripped"
  >>
): Promise<void> {
  await updateGuildHistory(storage, guildId, (decisions) =>
    decisions.map((decision) =>
      decision.id === decisionId
        ? {
            ...decision,
            responderOutcomes: decision.responderOutcomes.map((outcome) =>
              outcome.id === outcomeId
                ? {
                    ...outcome,
                    ...patch,
                    reason: patch.reason === undefined && "reason" in patch
                      ? undefined
                      : patch.reason ?? outcome.reason
                  }
                : outcome
            )
          }
        : decision
    )
  );
}

export async function finalizeOrchestratorDecisionAfterError(storage: StorageService, input: {
  guildId: string;
  decisionId: string;
  status: Extract<OrchestratorDecisionStatus, "interrupted" | "failed">;
  currentOutcomeId?: string;
  reason: string;
}): Promise<void> {
  await updateGuildHistory(storage, input.guildId, (decisions) =>
    decisions.map((decision) => {
      if (decision.id !== input.decisionId) return decision;
      return {
        ...decision,
        status: input.status,
        responderOutcomes: decision.responderOutcomes.map((outcome) => {
          if (outcome.status !== "pending") return outcome;
          if (input.status === "interrupted") {
            return { ...outcome, status: "interrupted" as const, reason: input.reason };
          }
          if (outcome.id === input.currentOutcomeId) {
            return { ...outcome, status: "failed" as const, reason: input.reason };
          }
          return { ...outcome, status: "not_run" as const, reason: "previous_responder_failed" };
        })
      };
    })
  );
}

export async function recordOrchestratorDecisionWaifuMessage(
  storage: StorageService,
  guildId: string,
  id: string,
  outcomeId: string | undefined,
  messageId: string
): Promise<void> {
  await updateGuildHistory(storage, guildId, (decisions) =>
    decisions.map((decision) =>
      decision.id === id
        ? {
            ...decision,
            waifuMessageIds: [...decision.waifuMessageIds, messageId],
            responderOutcomes: decision.responderOutcomes.map((outcome) =>
              outcome.id === outcomeId
                ? { ...outcome, messageIds: [...outcome.messageIds, messageId] }
                : outcome
            )
          }
        : decision
    )
  );
}

function healPending(decisions: OrchestratorDecisionHistoryEntry[]): OrchestratorDecisionHistoryEntry[] {
  return decisions.map((decision) =>
    decision.status === "pending"
      ? {
          ...decision,
          status: "interrupted" as const,
          responderOutcomes: decision.responderOutcomes.map((outcome) =>
            outcome.status === "pending"
              ? { ...outcome, status: "interrupted" as const, reason: "runtime_restarted" }
              : outcome
          )
        }
      : decision
  );
}

/**
 * Restart heal: a decision still `pending` belongs to a run the restart killed. Walks every known
 * guild (and the legacy file) and only writes a file that actually has something to heal.
 */
export async function healPendingOrchestratorDecisions(storage: StorageService): Promise<void> {
  for (const guildId of await listHistoryGuildIds(storage)) {
    const history = await readOrchestratorHistoryForGuild(storage, guildId);
    if (!history.decisions.some((decision) => decision.status === "pending")) continue;
    await updateGuildHistory(storage, guildId, healPending);
  }
  const legacy = await storage
    .readJson(LEGACY_DECISION_HISTORY_PATH, OrchestratorHistoryFileSchema, emptyHistory())
    .catch(() => undefined);
  if (legacy?.decisions.some((decision) => decision.status === "pending")) {
    await storage.updateRevisionedJson({
      resourceKey: "orchestrator:history-legacy",
      relativePath: LEGACY_DECISION_HISTORY_PATH,
      schema: OrchestratorHistoryFileSchema,
      fallback: emptyHistory(),
      transform: (current) => ({ ...current, decisions: healPending(current.decisions) })
    });
  }
}

export async function appendStageManagerHistory(storage: StorageService, entry: {
  id: string;
  guildId?: string;
  channelId?: string;
  tool: "add_memory" | "update_memory" | "archive_memory" | "merge_memories" | "no_change";
  affectedMemoryIds: string[];
  summary: string;
  observationCount?: number;
  createdAt: string;
}) {
  await storage.updateRevisionedJson({
    resourceKey: "stage-manager:history",
    relativePath: "user/stage-manager/history.json",
    schema: StageManagerHistoryFileSchema,
    fallback: StageManagerHistoryFileSchema.parse(createEmptyRevisionedFile({ edits: [] })),
    transform: (current) => ({ ...current, edits: [entry, ...current.edits].slice(0, 200) })
  });
}

export async function appendReviewerHistory(storage: StorageService, entry: {
  id: string;
  guildId?: string;
  channelId?: string;
  reviewerUserId?: string;
  targetMessageIds: string[];
  hallucination: boolean;
  deleted: boolean;
  createdAt: string;
}) {
  await storage.updateRevisionedJson({
    resourceKey: "reviewer:history",
    relativePath: "user/reviewer/history.json",
    schema: ReviewerHistoryFileSchema,
    fallback: ReviewerHistoryFileSchema.parse(createEmptyRevisionedFile({ reviews: [] })),
    transform: (current) => ({ ...current, reviews: [entry, ...current.reviews].slice(0, 200) })
  });
}
