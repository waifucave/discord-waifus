// Tier-2 eval: waifu generation scenarios.
//
// Gated behind WAIFUS_EVAL_LIVE=1. Makes real API calls.
// Covers:
//   1. naive-long-persona scenario: reply must be ≤ 400 chars, validator passes.
//   2. clean-reply scenario: a simple casual message gets a validator-passing reply.
//
// Prompt building reuses the RuntimeOrchestrator path (same as runtime.test.ts):
//   the real createModelPipeline is passed as createPipeline, so buildWaifuPromptParts
//   assembles the W2 harness blocks through the normal code path.

import { afterEach, describe, expect, it } from "vitest";
import { RuntimeOrchestrator } from "../../src/orchestration/runtime.js";
import type {
  ModelPipeline,
  PipelineCredentials,
  ProviderRequest,
  WaifuGenerationRequest,
  WaifuGenerationResult
} from "../../src/providers/types.js";
import type { OrchestratorDecision } from "../../src/orchestration/decisions.js";
import { createModelPipeline } from "../../src/providers/pipelines.js";
import { validateWaifuOutput } from "../../src/orchestration/outputValidator.js";
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
import type { ContextMessage } from "../../src/orchestration/context.js";
import { EVAL_SCENARIOS } from "./scenarios.js";

// ---------------------------------------------------------------------------
// Tier-2 gate
// ---------------------------------------------------------------------------

const LIVE = process.env["WAIFUS_EVAL_LIVE"] === "1";
const describeLive = LIVE ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quietLogger = () => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
});

function inferProviderId(modelId: string): string {
  if (modelId.startsWith("gemini")) return "google";
  if (modelId.startsWith("claude")) return "anthropic";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "openai";
  if (modelId.startsWith("deepseek")) return "deepseek";
  return "google";
}

async function setupStorage(
  storage: StorageService,
  options: {
    modelId: string;
    providerId: string;
    apiKey: string;
    waifuId: string;
    displayName: string;
    persona: string;
    botId: string;
    extraWaifuIds?: string[];
  }
): Promise<void> {
  await storage.writeJson(
    "providers",
    "user/providers.json",
    ProviderCredentialsFileSchema,
    ProviderCredentialsFileSchema.parse(
      createEmptyRevisionedFile({
        providers: {
          [options.providerId]: {
            providerId: options.providerId,
            apiKey: options.apiKey,
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
      providerId: options.providerId,
      modelId: options.modelId,
      contextWindow: 20,
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
      providerId: options.providerId,
      modelId: options.modelId,
      contextWindow: 20,
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
      providerId: options.providerId,
      modelId: options.modelId,
      contextWindow: 10,
      prompt: "review"
    })
  );

  const allWaifuIds = [options.waifuId, ...(options.extraWaifuIds ?? [])];
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
          enabledWaifuIds: allWaifuIds
        }
      }
    })
  );

  await storage.writeJson(
    `waifu:${options.waifuId}`,
    `user/waifus/${options.waifuId}/waifu.json`,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      id: options.waifuId,
      name: options.displayName,
      displayName: options.displayName,
      enabled: true,
      providerId: options.providerId,
      modelId: options.modelId,
      botId: options.botId,
      persona: options.persona,
      contextWindow: 30
    })
  );
}

// ---------------------------------------------------------------------------
// Live test suite
// ---------------------------------------------------------------------------

describeLive("waifu eval — tier 2 (WAIFUS_EVAL_LIVE=1)", () => {
  const modelId = process.env["WAIFUS_EVAL_MODEL"] ?? "gemini-3.1-flash-lite";
  const apiKey = process.env["WAIFUS_EVAL_API_KEY"];

  // describe.skip still executes this factory at collection — only throw when genuinely live.
  if (LIVE && !apiKey) {
    throw new Error(
      "WAIFUS_EVAL_API_KEY is required when WAIFUS_EVAL_LIVE=1. " +
        "Set it to your API key for the model provider."
    );
  }

  const providerId = inferProviderId(modelId);
  const credentials: PipelineCredentials = { apiKey };
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map(removeTempRoot));
    roots.length = 0;
  });

  /**
   * Helper: run one channel turn and capture the last generated waifu reply.
   */
  async function runAndCaptureWaifuReply(
    storage: StorageService,
    messages: ContextMessage[],
    targetWaifuId: string
  ): Promise<string | undefined> {
    let capturedReply: string | undefined;

    const realPipeline = createModelPipeline(modelId, credentials);
    const wrappedPipeline: ModelPipeline = {
      async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
        // Force the orchestrator to always reply with the target waifu
        void request;
        return {
          action: "reply",
          respondingWaifus: [{ waifuId: targetWaifuId, delaySeconds: 0 }],
          reasoning: "eval: forced reply from target waifu"
        };
      },
      async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
        if (!realPipeline.generateWaifu) {
          return { content: "(no waifu pipeline)" };
        }
        const result = await realPipeline.generateWaifu(request);
        capturedReply = result.content;
        return result;
      }
    };

    const discord = {
      sent: [] as Array<{ content: string; senderBotId?: string }>,
      async connect() {
        return { connected: true, orchestratorConnected: true, waifuBotCount: 1, warnings: [] };
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
      async fetchFreshContext() { return messages; },
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

    return capturedReply;
  }

  // ─── Scenario: naive long-persona, casual ping ────────────────────────────
  it(
    "long-persona scenario: reply ≤ 400 chars and passes validator",
    { timeout: 60_000 },
    async () => {
      const longPersonaScenario = EVAL_SCENARIOS.find((s) => s.key === "long-persona-length-cap");
      if (!longPersonaScenario) throw new Error("long-persona-length-cap scenario not found");

      const root = await makeTempRoot("eval-waifu-");
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);

      const yuki = longPersonaScenario.roster[0]!;
      await setupStorage(storage, {
        modelId,
        providerId,
        apiKey,
        waifuId: yuki.id,
        displayName: yuki.displayName,
        persona: yuki.persona,
        botId: yuki.botId
      });

      const reply = await runAndCaptureWaifuReply(storage, longPersonaScenario.messages, yuki.id);

      expect(reply).toBeDefined();
      const content = reply!;

      // Length constraint
      expect(content.length).toBeLessThanOrEqual(longPersonaScenario.expect.maxReplyChars ?? 400);

      // Validator passes
      const validationResult = validateWaifuOutput(content, {
        selfNames: [yuki.displayName, yuki.id],
        participantNames: ["Kevin", yuki.displayName, yuki.id],
        blockTags: [
          `${yuki.id}_identity`,
          `${yuki.id}_persona`,
          `${yuki.id}_schedule`,
          `${yuki.id}_relevant_memories`,
          `${yuki.id}_anchor`,
          "io_format",
          "output_contract",
          "room_info",
          "tools",
          "currently_doing",
          "director_note",
          "system_note"
        ],
        toolNames: ["add_memory", "PickNextWaifu", "orchestrator_decision", "dream_memories", "set_persona_digest"]
      });

      expect(validationResult.verdict).toBe("pass");
      console.log(`[long-persona] reply (${content.length} chars): ${content.slice(0, 120)}...`);
    }
  );

  // ─── Scenario: clean casual reply ────────────────────────────────────────
  it(
    "clean-reply scenario: simple greeting gets a natural reply that passes validator",
    { timeout: 60_000 },
    async () => {
      const root = await makeTempRoot("eval-waifu-clean-");
      roots.push(root);
      await ensureDataLayout(root);
      const storage = new StorageService(root);

      await setupStorage(storage, {
        modelId,
        providerId,
        apiKey,
        waifuId: "yuki",
        displayName: "Yuki",
        persona: "warm and curious, uses light humor, keeps replies short",
        botId: "yuki-bot"
      });

      const messages: ContextMessage[] = [
        {
          id: "m1",
          channelId: "ch-eval",
          guildId: "g-eval",
          authorKind: "user",
          authorId: "u1",
          authorBot: false,
          name: "Kevin",
          displayName: "Kevin",
          content: "hey everyone how's it going",
          timestamp: "2026-06-11T14:00:00Z",
          reactions: []
        }
      ];

      const reply = await runAndCaptureWaifuReply(storage, messages, "yuki");

      expect(reply).toBeDefined();
      const content = reply!;

      // Must not be empty
      expect(content.trim().length).toBeGreaterThan(0);

      // Validator must pass
      const validationResult = validateWaifuOutput(content, {
        selfNames: ["Yuki", "yuki"],
        participantNames: ["Kevin", "Yuki", "yuki"],
        blockTags: [
          "yuki_identity",
          "yuki_persona",
          "yuki_schedule",
          "yuki_relevant_memories",
          "yuki_anchor",
          "io_format",
          "output_contract",
          "room_info",
          "tools",
          "currently_doing",
          "director_note",
          "system_note"
        ],
        toolNames: ["add_memory", "PickNextWaifu", "orchestrator_decision", "dream_memories", "set_persona_digest"]
      });

      expect(validationResult.verdict).toBe("pass");
      console.log(`[clean-reply] reply (${content.length} chars): ${content.slice(0, 120)}`);
    }
  );
});
