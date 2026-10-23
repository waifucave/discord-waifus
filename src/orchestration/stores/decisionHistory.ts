// Persistence for orchestrator decision history (and its responder outcomes) plus the
// stage-manager and reviewer history logs.

import {
  OrchestratorDecisionHistoryEntry,
  OrchestratorDecisionStatus,
  OrchestratorHistoryFileSchema,
  OrchestratorResponderOutcome,
  OrchestratorRespondingWaifu,
  ReviewerHistoryFileSchema,
  StageManagerHistoryFileSchema,
  createEmptyRevisionedFile
} from "../../shared/schemas/domain.js";
import { StorageService } from "../../storage/storageService.js";

export async function readCompletedOrchestratorDecisionsForChannel(
  storage: StorageService,
  guildId: string,
  channelId: string
): Promise<OrchestratorDecisionHistoryEntry[]> {
  const history = await storage.readJson(
    "user/orchestrator/history.json",
    OrchestratorHistoryFileSchema,
    OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
  );
  return history.decisions.filter(
    (decision) =>
      decision.guildId === guildId &&
      decision.channelId === channelId &&
      decision.status === "completed"
  );
}

/** One decision by id (any status), or undefined once it rotated out of the 200-entry history. */
export async function readOrchestratorDecision(
  storage: StorageService,
  id: string
): Promise<OrchestratorDecisionHistoryEntry | undefined> {
  const history = await storage.readJson(
    "user/orchestrator/history.json",
    OrchestratorHistoryFileSchema,
    OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] }))
  );
  return history.decisions.find((decision) => decision.id === id);
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
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({ ...current, decisions: [entry, ...current.decisions].slice(0, 200) })
  });
}

export async function updateOrchestratorDecisionStatus(storage: StorageService, id: string, status: OrchestratorDecisionStatus): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) =>
        decision.id === id ? { ...decision, status } : decision
      )
    })
  });
}

export async function insertOrchestratorResponderOutcomeAfter(
  storage: StorageService,
  decisionId: string,
  afterOutcomeId: string,
  outcome: OrchestratorResponderOutcome
): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) => {
        if (decision.id !== decisionId) return decision;
        const responderOutcomes = [...decision.responderOutcomes];
        const afterIndex = responderOutcomes.findIndex((entry) => entry.id === afterOutcomeId);
        responderOutcomes.splice(afterIndex >= 0 ? afterIndex + 1 : responderOutcomes.length, 0, outcome);
        return { ...decision, responderOutcomes };
      })
    })
  });
}

export async function moveOrchestratorResponderOutcomeAfter(
  storage: StorageService,
  decisionId: string,
  afterOutcomeId: string,
  outcomeId: string,
  handoffFromWaifuId: string
): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) => {
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
    })
  });
}

export async function updateOrchestratorResponderOutcome(
  storage: StorageService,
  decisionId: string,
  outcomeId: string,
  patch: Partial<Pick<
    OrchestratorResponderOutcome,
    "handoffFromWaifuId" | "status" | "reason" | "directiveStripped"
  >>
): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) =>
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
    })
  });
}

export async function finalizeOrchestratorDecisionAfterError(storage: StorageService, input: {
  decisionId: string;
  status: Extract<OrchestratorDecisionStatus, "interrupted" | "failed">;
  currentOutcomeId?: string;
  reason: string;
}): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) => {
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
    })
  });
}

export async function recordOrchestratorDecisionWaifuMessage(
  storage: StorageService,
  id: string,
  outcomeId: string | undefined,
  messageId: string
): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) =>
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
    })
  });
}

export async function healPendingOrchestratorDecisions(storage: StorageService): Promise<void> {
  await storage.updateRevisionedJson({
    resourceKey: "orchestrator:history",
    relativePath: "user/orchestrator/history.json",
    schema: OrchestratorHistoryFileSchema,
    fallback: OrchestratorHistoryFileSchema.parse(createEmptyRevisionedFile({ decisions: [] })),
    transform: (current) => ({
      ...current,
      decisions: current.decisions.map((decision) =>
        decision.status === "pending"
          ? {
              ...decision,
              status: "interrupted" as const,
              responderOutcomes: decision.responderOutcomes.map((outcome) =>
                outcome.status === "pending"
                  ? {
                      ...outcome,
                      status: "interrupted" as const,
                      reason: "runtime_restarted"
                    }
                  : outcome
              )
            }
          : decision
      )
    })
  });
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
