// Spec 8.0 / 8.12: exactly one `role:"system"` message, always first, in every prompt the app
// sends. This test runs EVERY harness through the real pipeline and inspects what reaches the
// gateway: waifu (guild, DM, retry tail, tool notes, after a compaction), orchestrator (text and
// tool-turn renderings, after a compaction), the compaction/summarize requests of both, the
// reviewer, observer, dream, persona digest, the dashboard assistant, and the JSON-schema
// fallback that appends a nudge to a decision call.
import { afterEach, describe, expect, it } from "vitest";
import { createGateway, type ChatRequest, type ChatResponse } from "@waifucave/gateway";
import { contextSummarizer, createCompactionService } from "../src/orchestration/context/compaction.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { buildCastCards, createOrchestratorRenderer, orchestratorPlace, waifuAuthorMatcher } from "../src/orchestration/orchestratorHarness.js";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { promptWithTail } from "../src/orchestration/responderExecutor.js";
import { ORCHESTRATOR_TOOL_NAME } from "../src/orchestration/tools.js";
import { createWaifuHarness, waifuTools } from "../src/orchestration/waifuHarness.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, noSnapshots, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const DM: ConversationRef = { kind: "dm", waifuId: "aria", userId: "kevin" };
const ARIA = { kind: "waifu", waifuId: "aria" } as const;
const DIRECTOR = { kind: "orchestrator" } as const;
const PROVIDER = "deepseek";
const MODEL = "deepseek-v4-flash";

const aria = WaifuConfigSchema.parse({
  ...createRevisionedBase(),
  id: "aria",
  name: "Aria",
  displayName: "Aria",
  botId: "aria-bot",
  persona: "A cheerful baker.",
  availability: { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [] }
});
const CAST = buildCastCards([aria], new Map(), () => false);
const isWaifu = waifuAuthorMatcher({ authorIds: ["aria-bot"], names: ["Aria"] });

const response = (content: ChatResponse["content"], finishReason: ChatResponse["finishReason"] = "stop"): ChatResponse => ({
  id: "r",
  provider: PROVIDER,
  model: MODEL,
  content,
  finishReason,
  usage: { inputTokens: 100, outputTokens: 10 },
  warnings: []
});

/** A gateway that records every chat request and answers with something each caller can parse. */
function capturingGateway() {
  const real = createGateway({});
  const calls: ChatRequest[] = [];
  const gateway = new Proxy(real, {
    get(target, prop) {
      if (prop === "chat") {
        return async (request: ChatRequest) => {
          calls.push(request);
          const choice = request.toolChoice;
          if (typeof choice === "object" && choice.name === ORCHESTRATOR_TOOL_NAME) {
            return response([{ type: "toolCall", id: "c", name: choice.name, arguments: JSON.stringify({ action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 120, wakePlan: "wait", reasoning: "quiet" }) }], "tool_calls");
          }
          if (typeof choice === "object") return response([{ type: "toolCall", id: "c", name: choice.name, arguments: "{}" }], "tool_calls");
          return response([{ type: "text", text: "a summary or a reply" }]);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { gateway: gateway as never, calls, real };
}

function expectOneSystemFirst(calls: readonly ChatRequest[], from: number): void {
  expect(calls.length).toBeGreaterThan(from);
  for (const [index, call] of calls.slice(from).entries()) {
    const systems = call.messages.filter((message) => message.role === "system");
    expect(systems, `request ${from + index}`).toHaveLength(1);
    expect(call.messages[0]!.role, `request ${from + index}`).toBe("system");
    expect(JSON.stringify(call.messages)).not.toContain("<system_note>");
  }
}

describe("exactly one system message in every built prompt", () => {
  it("holds for every harness, every rendering and every pipeline call path", { timeout: 60_000 }, async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const { gateway, calls, real } = capturingGateway();
    const pipeline = createGatewayModelPipeline({ providerId: PROVIDER, modelId: MODEL, queryRole: "waifu", gateway });
    const model = real.getCapabilities(PROVIDER, MODEL)!;
    const clock = { now: BASE_TIME + 3_600_000 };
    const now = () => new Date(clock.now);
    const store = new FileContextStore(new StorageService(root), { now, timeZone: () => "UTC" });
    const channel = new FakeChannel();
    const runtime = new ContextRuntime({
      store,
      snapshots: noSnapshots,
      compaction: createCompactionService({ store, logger: quietLogger(), now }),
      messages: channel,
      images: new FakeImageFetcher(),
      settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, maxMessages: 20, keepRecent: 5 }),
      logger: quietLogger(),
      now,
      timeZone: () => "UTC"
    });
    const say = (count: number, from = 0) => {
      for (let i = 0; i < count; i += 1) channel.post({ content: `message ${from + i + 1}` }, BASE_TIME + (from + i) * 30_000);
    };
    const waifuInput = (conversation: ConversationRef) => ({
      waifu: aria,
      conversation,
      roster: [],
      place: conversation.kind === "dm" ? ({ kind: "dm", userName: "Kevin" } as const) : ({ kind: "guild", serverName: "Bake Club", channelName: "general" } as const),
      people: [{ userId: "kevin", name: "Kevin" }],
      emojis: [],
      tools: conversation.kind === "dm" ? [] : waifuTools({ addMemory: true, pickNextWaifuIds: [] }),
      activity: () => undefined
    });
    const attribution = { agentId: "waifu-aria", waifuId: "aria" };
    const waifuTurn = async (conversation: ConversationRef, o: { retry?: boolean } = {}) => {
      const harness = createWaifuHarness(waifuInput(conversation));
      const p = await runtime.prepare({
        conversation,
        agent: ARIA,
        model,
        backfillCap: 50,
        selfAuthorIds: ["aria-bot"],
        render: harness,
        renderToolTurnsAsText: true,
        participantIds: ["kevin"],
        params: {},
        summarize: contextSummarizer(pipeline, { toolChoice: "auto", params: {}, attribution })
      });
      const sent = o.retry ? promptWithTail(p.prompt, harness.tail(p.state, p.startedAt, { retryNote: "Your last draft was too long." })) : p.prompt;
      await pipeline.generateWaifu({ modelId: MODEL, prompt: sent, params: {}, attribution: { ...attribution, purpose: "waifu_reply" } });
      await runtime.commit(p, {
        notes: [{ kind: "tool", callId: "t1", name: "add_memory", arguments: '{"content":"x"}', result: "saved" }],
        modelKey: p.modelKey,
        sentPrompt: sent
      });
      return p;
    };
    const directorTurn = async (textTurns: boolean) => {
      const renderer = createOrchestratorRenderer({
        mode: "model",
        cast: CAST,
        availableWaifuIds: ["aria"],
        place: orchestratorPlace("Bake Club", "general", "200"),
        pausePlanning: true,
        turn: { replyRequired: false, directiveCount: 3, directiveCooldown: 3, pastDecisions: [] },
        conversation: { guildId: "100", channelId: "200" },
        isWaifu
      });
      const p = await runtime.prepare({
        conversation: GUILD,
        agent: DIRECTOR,
        model,
        backfillCap: 20,
        selfAuthorIds: [],
        render: renderer,
        renderToolTurnsAsText: textTurns,
        params: {},
        summarize: contextSummarizer(pipeline, { toolChoice: { name: ORCHESTRATOR_TOOL_NAME }, params: {}, attribution: { agentId: "orchestrator" } })
      });
      await pipeline.decideOrchestrator!({ modelId: MODEL, messages: [], prompt: p.prompt, transcript: p.transcript, availableWaifuIds: ["aria"] });
      await runtime.commit(p, {
        notes: [{ kind: "decision", decisionId: "d", call: JSON.stringify({ action: "no_reply", retriggerAfterSeconds: 120 }), outcome: "no reply", at: new Date(clock.now).toISOString() }],
        modelKey: p.modelKey
      });
      return p;
    };

    // Waifu: guild first epoch, a second turn with a tool note, a retry tail, a DM.
    say(4);
    await waifuTurn(GUILD);
    await waifuTurn(GUILD);
    await waifuTurn(GUILD, { retry: true });
    await waifuTurn(DM);
    expectOneSystemFirst(calls, 0);
    const afterWaifu = calls.length;

    // Orchestrator: text-line decisions and (the tool-turn rendering) real tool turns.
    await directorTurn(true);
    await directorTurn(false);
    expectOneSystemFirst(calls, afterWaifu);
    const afterDirector = calls.length;

    // Compaction of both contexts (message count over the limit): the summarize requests and
    // the first prompt of the new epoch.
    say(30, 4);
    const compacted = await waifuTurn(GUILD);
    const compactedDirector = await directorTurn(true);
    expect(compacted.state.epoch).toBeGreaterThan(0);
    expect(compactedDirector.state.epoch).toBeGreaterThan(0);
    expect(compacted.state.summary).toBeTruthy();
    expectOneSystemFirst(calls, afterDirector);
    expect(calls.slice(afterDirector).some((call) => JSON.stringify(call.messages).includes("<compaction_request>"))).toBe(true);
    const afterCompaction = calls.length;

    // Background agents and the other call paths.
    await pipeline.decideReviewer!({ modelId: MODEL, messages: [], message: "hi there", authorName: "Aria", systemPrompt: "Flag brand names." }).catch(() => undefined);
    await pipeline.decideStageManagerObservations!({ modelId: MODEL, messages: [], availableWaifuIds: ["aria"], observerInput: "Transcript:", systemPrompt: "Track food facts." }).catch(() => undefined);
    await pipeline.decideDream!({ modelId: MODEL, messages: [], memories: [], observations: [], availableWaifuIds: ["aria"], systemPrompt: "Keep pinned jokes." }).catch(() => undefined);
    await pipeline.generatePersonaDigest!({ modelId: MODEL, messages: [], personaText: "A cheerful baker." }).catch(() => undefined);
    await pipeline.generateAssistantTurn!({
      modelId: MODEL,
      messages: [{ role: "system", content: "You are the assistant." }, { role: "user", content: "hi" }],
      tools: [],
      executeTool: async () => "[]"
    });
    expectOneSystemFirst(calls, afterCompaction);
    expect(calls.length - afterCompaction).toBe(5);
  });

  it("holds on the JSON-schema decision fallback, where the nudge is a final user message", async () => {
    const { gateway, calls } = capturingGateway();
    const pipeline = createGatewayModelPipeline({ providerId: "openrouter", modelId: "meta/muse-spark-1.1", queryRole: "waifu", gateway });
    await pipeline.decideReviewer!({ modelId: "meta/muse-spark-1.1", messages: [], message: "hi" }).catch(() => undefined);
    await pipeline.decideOrchestrator!({
      modelId: "meta/muse-spark-1.1",
      messages: [],
      prompt: {
        messages: [
          { role: "system", content: [{ type: "text", text: "director" }] },
          { role: "user", content: [{ type: "text", text: "Call orchestrator_decision." }] }
        ],
        tools: [{ name: ORCHESTRATOR_TOOL_NAME, parameters: { type: "object", properties: {} } }],
        promptCacheKey: "orchestrator:g_1_2"
      } as never,
      availableWaifuIds: ["aria"]
    }).catch(() => undefined);
    expectOneSystemFirst(calls, 0);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const last = call.messages.at(-1)!;
      expect(last.role).toBe("user");
      expect(JSON.stringify(last.content)).toContain("Return the arguments for");
    }
  });
});
