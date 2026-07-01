// Tier-2 eval: orchestrator scenarios.
//
// Gated behind WAIFUS_EVAL_LIVE=1. These tests make real API calls and cost tokens.
// Default model: gemini-3.1-flash-lite (WAIFUS_EVAL_MODEL override).
// Default runs per scenario: 1 (WAIFUS_EVAL_RUNS override).
//
// Prompt building reuses the exact path used in tests/runtime.test.ts:
//   RuntimeOrchestrator with a custom createPipeline wrapper that calls the REAL
//   gateway pipeline (createGatewayModelPipeline) but intercepts the ProviderRequest
//   for assertion.

import { afterEach, describe, expect, it } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { RuntimeOrchestrator } from "../../src/orchestration/runtime.js";
import type { OrchestratorDecision } from "../../src/orchestration/decisions.js";
import type {
  ModelPipeline,
  ProviderRequest,
  WaifuGenerationRequest,
  WaifuGenerationResult
} from "../../src/providers/types.js";
import { resolveModelTarget } from "../../src/orchestration/pipeline/resolveTarget.js";
import { createGatewayModelPipeline } from "../../src/orchestration/pipeline/gatewayPipeline.js";
import { ensureDataLayout } from "../../src/config/layout.js";
import { StorageService } from "../../src/storage/storageService.js";
import {
  AgentConfigSchema,
  ProviderCredentialsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile
} from "../../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../../src/shared/schemas/common.js";
import { makeTempRoot, removeTempRoot } from "../testUtils.js";
import { EVAL_SCENARIOS } from "./scenarios.js";
import type { RosterEntry } from "./scenarios.js";

// ---------------------------------------------------------------------------
// Tier-2 gate
// ---------------------------------------------------------------------------

const LIVE = process.env["WAIFUS_EVAL_LIVE"] === "1";
const describeLive = LIVE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Per-scenario metrics aggregated across runs
// ---------------------------------------------------------------------------

type ScenarioRun = {
  decision: OrchestratorDecision;
  hasDirective: boolean;
  responderCount: number;
};

type ScenarioResult = {
  key: string;
  runs: ScenarioRun[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quietLogger = () => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
});

async function seedScenarioStorage(
  storage: StorageService,
  roster: RosterEntry[],
  modelId: string,
  providerId: string
): Promise<void> {
  await storage.writeJson(
    "providers",
    "user/providers.json",
    ProviderCredentialsFileSchema,
    ProviderCredentialsFileSchema.parse(
      createEmptyRevisionedFile({
        providers: {
          [providerId]: {
            providerId,
            apiKey: process.env["WAIFUS_EVAL_API_KEY"] ?? "placeholder",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      })
    )
  );

  await storage.writeJson(
    "orchestrator",
    "user/orchestrator/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: true,
      providerId,
      modelId,
      contextWindow: 30,
      prompt: "decide"
    })
  );

  await storage.writeJson(
    "stage-manager",
    "user/stage-manager/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: false,
      providerId,
      modelId,
      contextWindow: 30,
      prompt: "memories"
    })
  );

  await storage.writeJson(
    "reviewer",
    "user/reviewer/config.json",
    AgentConfigSchema,
    AgentConfigSchema.parse({
      ...createRevisionedBase(),
      enabled: false,
      providerId,
      modelId,
      contextWindow: 10,
      prompt: "review"
    })
  );

  const waifuIds = roster.map((r) => r.id);
  await storage.writeJson(
    "server:g-eval",
    "user/servers/g-eval/server.json",
    ServerConfigSchema,
    ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: "g-eval",
      enabled: true,
      channels: {
        "ch-eval": {
          channelId: "ch-eval",
          enabled: true,
          enabledWaifuIds: waifuIds
        }
      }
    })
  );

  for (const entry of roster) {
    await storage.writeJson(
      `waifu:${entry.id}`,
      `user/waifus/${entry.id}/waifu.json`,
      WaifuConfigSchema,
      WaifuConfigSchema.parse({
        ...createRevisionedBase(),
        id: entry.id,
        name: entry.displayName,
        displayName: entry.displayName,
        enabled: true,
        providerId,
        modelId,
        botId: entry.botId,
        persona: entry.persona,
        contextWindow: 30
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Main live describe block
// ---------------------------------------------------------------------------

describeLive("orchestrator eval — tier 2 (WAIFUS_EVAL_LIVE=1)", () => {
  const modelId = process.env["WAIFUS_EVAL_MODEL"] ?? "gemini-3.1-flash-lite";
  const apiKey = process.env["WAIFUS_EVAL_API_KEY"];
  const runs = Number(process.env["WAIFUS_EVAL_RUNS"] ?? "1");

  // Fail fast inside live describe if API key is missing
  // describe.skip still executes this factory at collection — only throw when genuinely live.
  if (LIVE && !apiKey) {
    throw new Error(
      "WAIFUS_EVAL_API_KEY is required when WAIFUS_EVAL_LIVE=1. " +
        "Set it to your API key for the model provider."
    );
  }

  const roots: string[] = [];
  const allResults: ScenarioResult[] = [];

  afterEach(async () => {
    await Promise.all(roots.map(removeTempRoot));
    roots.length = 0;
  });

  // Derive providerId from modelId
  function inferProviderId(id: string): string {
    if (id.startsWith("gemini")) return "google-ai-studio";
    if (id.startsWith("claude")) return "anthropic";
    if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) return "openai";
    if (id.startsWith("deepseek")) return "deepseek";
    return "google-ai-studio"; // safe default for eval
  }

  const providerId = inferProviderId(modelId);
  const target = resolveModelTarget({ providerId, modelId });
  const gateway = createGateway({ credentials: () => apiKey });

  for (const scenario of EVAL_SCENARIOS) {
    it(
      `[${scenario.key}] ${scenario.description}`,
      { timeout: 60_000 },
      async () => {
        const scenarioResults: ScenarioRun[] = [];

        for (let run = 0; run < runs; run++) {
          const root = await makeTempRoot("eval-orch-");
          roots.push(root);
          await ensureDataLayout(root);
          const storage = new StorageService(root);
          await seedScenarioStorage(storage, scenario.roster, modelId, providerId);

          // Captured orchestrator request (for potential debugging)
          let capturedDecision: OrchestratorDecision | undefined;

          // Fake Discord facade that serves the scenario messages once
          const discord = {
            sent: [] as Array<{ content: string; senderBotId?: string }>,
            async connect() {
              return { connected: true, orchestratorConnected: true, waifuBotCount: scenario.roster.length, warnings: [] };
            },
            async disconnect() {},
            async listGuilds() { return []; },
            onReviewCommand: () => () => undefined,
            onClearCommand: () => () => undefined,
            onRunCommand: () => () => undefined,
            onRunWaifuAutocomplete: () => () => undefined,
            onStopCommand: () => () => undefined,
            onMemoriesCommand: () => () => undefined,
            onPrintCommand: () => () => undefined,
            onPrintWaifuAutocomplete: () => () => undefined,
            onDebugCommand: () => () => undefined,
            async fetchFreshContext() { return scenario.messages; },
            async sendWaifuMessage(input: { content: string; senderBotId?: string }) {
              this.sent.push(input);
              return { messageId: `sent-${this.sent.length}` };
            },
            async sendTyping() {},
            async validateDebugChannel(input: { channelId: string }) { return { channelId: input.channelId }; },
            async fetchChannelMetadata(input: { guildId: string; channelId: string }) { return input; },
            async sendDebugMessage() { return { messageId: "debug-1" }; },
            async deleteMessages(input: { messageIds: string[] }) {
              return { deletedMessageIds: input.messageIds, failedMessageIds: [] };
            },
            async deleteAllMessages() {
              return { scannedMessageCount: 0, deletedCount: 0, failedCount: 0, failedMessageIds: [] };
            }
          };

          // Pipeline wrapper: calls the real gateway pipeline but captures the decision
          const realPipeline = createGatewayModelPipeline({ ...target, queryRole: "orchestrator", gateway });
          const wrappedPipeline: ModelPipeline = {
            async decideOrchestrator(request: ProviderRequest) {
              const decision = await realPipeline.decideOrchestrator!(request);
              capturedDecision = decision;
              return decision;
            },
            async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
              if (!realPipeline.generateWaifu) {
                return { content: "(no waifu pipeline)" };
              }
              return realPipeline.generateWaifu(request);
            }
          };

          const runtime = new RuntimeOrchestrator({
            sleep: async () => undefined,
            storage,
            discord,
            maxAutomaticTurns: 1,
            createPipeline: () => wrappedPipeline,
            logger: quietLogger()
          });

          await runtime.triggerChannel("g-eval", "ch-eval");
          await runtime.stop();

          if (!capturedDecision) {
            throw new Error(`No orchestrator decision captured for scenario ${scenario.key} run ${run}`);
          }

          const hasDirective = capturedDecision.action === "reply" &&
            capturedDecision.respondingWaifus.some((w) => w.directive != null);
          const responderCount = capturedDecision.respondingWaifus.length;

          scenarioResults.push({ decision: capturedDecision, hasDirective, responderCount });
        }

        allResults.push({ key: scenario.key, runs: scenarioResults });

        // Per-scenario assertions (checked on the FIRST run; more runs give sampling coverage)
        const firstRun = scenarioResults[0]!;
        const { expect: exp } = scenario;

        if (exp.action) {
          expect(firstRun.decision.action).toBe(exp.action);
        }
        if (exp.maxResponders !== undefined) {
          expect(firstRun.responderCount).toBeLessThanOrEqual(exp.maxResponders);
        }
        if (exp.minResponders !== undefined) {
          expect(firstRun.responderCount).toBeGreaterThanOrEqual(exp.minResponders);
        }
        if (exp.directiveAllowed === false) {
          expect(firstRun.hasDirective).toBe(false);
        }
        if (exp.expectedIntentOptions && firstRun.hasDirective) {
          const intents = firstRun.decision.respondingWaifus
            .map((w) => w.directive?.intent)
            .filter(Boolean);
          for (const intent of intents) {
            expect(exp.expectedIntentOptions).toContain(intent);
          }
        }
        if (exp.minRetrigger !== undefined && firstRun.decision.action === "no_reply") {
          expect(firstRun.decision.retriggerAfterSeconds ?? 0).toBeGreaterThanOrEqual(exp.minRetrigger);
        }
        if (exp.maxRetrigger !== undefined && firstRun.decision.action === "no_reply") {
          expect(firstRun.decision.retriggerAfterSeconds ?? Infinity).toBeLessThanOrEqual(exp.maxRetrigger);
        }
        if (exp.requiresWakePlan && firstRun.decision.action === "no_reply") {
          expect(firstRun.decision.wakePlan).toBeTruthy();
        }
      }
    );
  }

  // Aggregate summary printed after all scenarios (use afterAll pattern via a final test)
  it("aggregate metrics summary", { timeout: 5_000 }, () => {
    if (allResults.length === 0) return;

    let totalRuns = 0;
    let directiveRuns = 0;
    let noReplyRuns = 0;
    const responderDist: Record<number, number> = {};
    const retriggerValues: number[] = [];

    for (const scenarioResult of allResults) {
      for (const run of scenarioResult.runs) {
        totalRuns++;
        if (run.hasDirective) directiveRuns++;
        if (run.decision.action === "no_reply") {
          noReplyRuns++;
          if (run.decision.retriggerAfterSeconds) {
            retriggerValues.push(run.decision.retriggerAfterSeconds);
          }
        }
        responderDist[run.responderCount] = (responderDist[run.responderCount] ?? 0) + 1;
      }
    }

    const directiveRate = totalRuns > 0 ? (directiveRuns / totalRuns) * 100 : 0;
    const noReplyRate = totalRuns > 0 ? (noReplyRuns / totalRuns) * 100 : 0;
    const retriggerBands = {
      "100-300": retriggerValues.filter((s) => s >= 100 && s <= 300).length,
      "600-1800": retriggerValues.filter((s) => s >= 600 && s <= 1800).length,
      "3600+": retriggerValues.filter((s) => s >= 3600).length
    };

    const summary = [
      `\n=== Orchestrator Eval Summary (model=${modelId}) ===`,
      `Total runs: ${totalRuns} (${runs} per scenario × ${EVAL_SCENARIOS.length} scenarios)`,
      `Directive rate: ${directiveRate.toFixed(1)}%`,
      `No-reply rate: ${noReplyRate.toFixed(1)}%`,
      `Responder dist: ${JSON.stringify(responderDist)}`,
      `Retrigger bands: 100-300s=${retriggerBands["100-300"]} | 600-1800s=${retriggerBands["600-1800"]} | 3600+s=${retriggerBands["3600+"]}`,
      `======================================================`
    ].join("\n");

    console.log(summary);
  });
});
