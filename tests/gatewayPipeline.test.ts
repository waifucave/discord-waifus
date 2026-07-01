import { describe, expect, it, vi } from "vitest";
import { createGateway } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { GatewayPipelineError } from "../src/orchestration/pipeline/params.js";
import { ContextMessage } from "../src/orchestration/context.js";
import type { ProviderRequest } from "../src/providers/types.js";

const msg = (over: Partial<ContextMessage>): ContextMessage => ({
  id: "m1", channelId: "c", authorKind: "user", authorId: "u1", name: "ann",
  displayName: "Ann", content: "hello", timestamp: "2026-06-12T10:00:00.000Z",
  reactions: [], ...over
});

const okFetch = (payload: unknown) => vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));

const makePipeline = (fetchImpl: typeof fetch, providerId = "deepseek", modelId = "deepseek-v4-flash") =>
  createGatewayModelPipeline({
    providerId, modelId, queryRole: "waifu",
    gateway: createGateway({ credentials: { deepseek: "sk-t", anthropic: "sk-a", openai: "sk-o", "google-ai-studio": "sk-g" }, fetchImpl })
  });

describe("generateWaifu (gateway)", () => {
  const baseRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "SYS",
    messages: [msg({}), msg({ id: "m2", authorKind: "waifu" as const, authorId: "bot-1", content: "yo" })],
    selfAuthorIds: ["bot-1"],
    temperature: 0.7,
    params: { "reasoning.enabled": false }
  };

  it("returns trimmed text content and flat usage", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "  hey there  " }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest);
    expect(result.content).toBe("hey there");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  // Legacy parity pin (postJsonAndExtractText, legacy pipelines.ts:837-840): a record extract
  // with a `content` field is returned as-is even when trimmed content is "" — never throws,
  // tool calls or not. This replaces a prior "throws on empty content" test that did not match
  // legacy behavior.
  it("resolves with empty content and no tools when the model returns whitespace only (legacy parity, no throw)", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "   " }, finish_reason: "stop" }], usage: {} });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu(baseRequest);
    expect(result.content).toBe("");
    expect(result.shortTermMemoryEntries).toBeUndefined();
  });

  it("resolves with empty content but surfaces add_memory on a tool-only reply (legacy parity, no throw)", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{
        message: {
          content: "   ",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "add_memory", arguments: JSON.stringify({ content: "Ann likes tea" }) } }
          ]
        },
        finish_reason: "tool_calls"
      }],
      usage: {}
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true
    });
    expect(result.content).toBe("");
    expect(result.shortTermMemoryEntries).toEqual(["Ann likes tea"]);
  });

  it("collects add_memory entries and a valid PickNextWaifu handoff", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{
        message: {
          content: "answer text",
          tool_calls: [
            { id: "c1", type: "function", function: { name: "add_memory", arguments: JSON.stringify({ content: "Ann likes tea" }) } },
            { id: "c2", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "riko" }) } }
          ]
        },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.content).toBe("answer text");
    expect(result.shortTermMemoryEntries).toEqual(["Ann likes tea"]);
    expect(result.pickedNextWaifuId).toBe("riko");
  });

  it("rejects an unavailable PickNextWaifu target", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: "text", tool_calls: [{ id: "c1", type: "function", function: { name: "PickNextWaifu", arguments: JSON.stringify({ waifuId: "ghost" }) } }] }, finish_reason: "stop" }],
      usage: {}
    });
    const result = await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, pickNextWaifuToolEnabled: true, availableWaifuIds: ["riko"]
    });
    expect(result.pickedNextWaifuId).toBeUndefined();
    expect(result.rejectedPickNextWaifu).toEqual({ reason: "unavailable_waifu", waifuId: "ghost" });
  });

  it("sends tools only when enabled, with auto toolChoice (wire golden)", async () => {
    const fetchImpl = okFetch({ id: "r1", choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: {} });
    await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      ...baseRequest, shortTermMemoryToolEnabled: true
    });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function.name).toBe("add_memory");
    expect(body.tool_choice === undefined || body.tool_choice === "auto").toBe(true);
    expect(body.temperature).toBe(0.7);
    expect(body.thinking).toEqual({ type: "disabled" });
  });
});

describe("decideOrchestrator (gateway)", () => {
  const orchRequest: ProviderRequest = {
    modelId: "deepseek-v4-flash",
    systemPrompt: "ORCH SYSTEM",
    trailingPrompt: "Decide now.",
    messages: [msg({})],
    availableWaifuIds: ["yuki"],
    replyRequired: false,
    directiveBudgetOpen: true,
    params: { "reasoning.enabled": true, "reasoning.effort": "high" }
  };

  it("forces the decision tool, disables thinking via pre-conform, parses the decision", async () => {
    const decision = { action: "reply", respondingWaifus: [{ waifuId: "yuki", delaySeconds: 2, directive: { intent: "spotlight", goal: "greet Ann" } }], reasoning: "Ann said hi" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const parsed = await pipeline.decideOrchestrator!(orchRequest);
    expect(parsed.action).toBe("reply");
    expect(parsed.respondingWaifus[0]).toMatchObject({ waifuId: "yuki", directive: { intent: "spotlight", goal: "greet Ann" } });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "orchestrator_decision" } });
    // pre-conform disables thinking when forcing a tool; the gateway may still emit
    // reasoning_effort on the wire as a separate parameter — what matters is thinking is off.
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("rejects a decision violating the zod refinements", async () => {
    const bad = { action: "reply", respondingWaifus: [], reasoning: "contradiction" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(bad) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest)).rejects.toThrow(GatewayPipelineError);
  });

  it("enforces replyRequired: a no_reply decision under /run throws", async () => {
    const noReply = { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "nothing to say" };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(noReply) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(
      makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!({ ...orchRequest, replyRequired: true })
    ).rejects.toThrow(/requires action=reply/);
  });

  it("accepts retriggerAfterSeconds: null on a reply decision (live Haiku parity)", async () => {
    // Live Haiku returns an explicit null (not an omitted key) for retriggerAfterSeconds
    // on reply decisions — the RawOrchestratorDecisionSchema accepts it and
    // normalizeOrchestratorDecision maps null -> undefined before the strict schema,
    // which rejects retriggerAfterSeconds being present at all on a reply.
    const decision = {
      action: "reply",
      respondingWaifus: [{ waifuId: "yuki", delaySeconds: 1, directive: null }],
      retriggerAfterSeconds: null,
      reasoning: "Ann said hi"
    };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const parsed = await makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest);
    expect(parsed.action).toBe("reply");
    expect(parsed.retriggerAfterSeconds).toBeUndefined();
  });

  it("defaults a respondingWaifus entry missing delaySeconds to 0", async () => {
    const decision = {
      action: "reply",
      respondingWaifus: [{ waifuId: "yuki" }],
      reasoning: "Ann said hi"
    };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const parsed = await makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest);
    expect(parsed.respondingWaifus[0]).toMatchObject({ waifuId: "yuki", delaySeconds: 0 });
  });

  it("degrades a malformed directive to undefined instead of failing the decision", async () => {
    // normalizeRawDirective drops the directive (returns undefined, never throws) when:
    // (1) intent isn't one of MODEL_DIRECTIVE_INTENTS ("bogus" here), or
    // (2) goal is present but blank after trim (whitespace-only).
    const decision = {
      action: "reply",
      respondingWaifus: [
        { waifuId: "yuki", delaySeconds: 0, directive: { intent: "bogus", goal: "a real goal" } },
        { waifuId: "yuki", delaySeconds: 0, directive: { intent: "spotlight", goal: "   " } }
      ],
      reasoning: "Ann said hi"
    };
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "orchestrator_decision", arguments: JSON.stringify(decision) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const parsed = await makePipeline(fetchImpl as unknown as typeof fetch).decideOrchestrator!(orchRequest);
    expect(parsed.action).toBe("reply");
    expect(parsed.respondingWaifus[0].directive).toBeUndefined();
    expect(parsed.respondingWaifus[1].directive).toBeUndefined();
  });
});

describe("decideReviewer (gateway)", () => {
  it("forces review_message and parses the verdict", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "review_message", arguments: JSON.stringify({ hallucination: true }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    const verdict = await pipeline.decideReviewer!({ modelId: "deepseek-v4-flash", messages: [msg({})], message: "suspect text" });
    expect(verdict).toEqual({ hallucination: true });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "review_message" } });
    expect(JSON.stringify(body.messages)).toContain("suspect text");
  });
});

describe("decideStageManagerObservations (gateway)", () => {
  it("forces record_observations and parses observations; model-provided entities survive", async () => {
    // RawStageManagerObservationSchema now carries entities through (the model's own list is the
    // only source for caseless names the app-side fallback can't extract); shared with legacy.
    const observations = [{ waifuId: "yuki", content: "Ann prefers tea", importance: 3, kind: "preference", entities: ["Ann"] }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record_observations", arguments: JSON.stringify({ observations }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideStageManagerObservations!({
      modelId: "deepseek-v4-flash", messages: [msg({})], availableWaifuIds: ["yuki"]
    });
    expect(out).toEqual([{ waifuId: "yuki", content: "Ann prefers tea", importance: 3, kind: "preference", entities: ["Ann"] }]);
  });

  it("coerces stringified importance ('3') to integer 3 (I1 fix)", async () => {
    const observations = [{ waifuId: "yuki", content: "Ann works remotely", importance: "3", kind: "fact" }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "record_observations", arguments: JSON.stringify({ observations }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideStageManagerObservations!({
      modelId: "deepseek-v4-flash", messages: [msg({})], availableWaifuIds: ["yuki"]
    });
    expect(out).toEqual([{ waifuId: "yuki", content: "Ann works remotely", importance: 3, kind: "fact", entities: [] }]);
  });
});

describe("decideDream (gateway)", () => {
  const dreamRequest = {
    modelId: "deepseek-v4-flash",
    messages: [],
    memories: [{ memoryIndex: 1, waifuId: "yuki", content: "old note", kind: "note" as const, strength: 2, ageDays: 10, daysSinceRetrieved: 5 }],
    observations: [],
    availableWaifuIds: ["yuki"]
  };

  it("forces dream_memories and parses ops", async () => {
    const ops = [{ op: "decay", memoryIndex: 1, strength: 1 }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dream_memories", arguments: JSON.stringify({ ops }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideDream!(dreamRequest);
    expect(out).toEqual([{ op: "decay", memoryIndex: 1, strength: 1 }]);
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
    expect(JSON.stringify(body.messages)).toContain("old note");
  });

  it("normalizes a flat google-wire 'add' op into nested memory shape (C1 fix)", async () => {
    // Gemini returns flat ops (fields hoisted to op level, no nested memory object).
    // normalizeDreamOp must fold them into the canonical DreamOp shape.
    const flatOp = { op: "add", waifuId: "yuki", content: "new memory", kind: "preference", strength: 4 };
    const fetchImpl = okFetch({
      candidates: [{
        content: { parts: [{ functionCall: { name: "dream_memories", args: { ops: [flatOp] } } }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch, "google-ai-studio", "gemini-2.5-flash-lite").decideDream!(dreamRequest);
    // Canonical normalized shape: waifuId/content/kind/strength lifted into memory sub-object;
    // entities defaults to [] by DreamOpSchema.
    expect(out).toEqual([{
      op: "add",
      memory: { waifuId: "yuki", content: "new memory", kind: "preference", strength: 4, entities: [] }
    }]);
  });

  it("normalizes a flat google-wire 'promote' op with patch fields (C1 fix)", async () => {
    // Gemini flat promote: memoryIndex + kind/strength at top level (no nested patch object).
    const flatOp = { op: "promote", memoryIndex: 1, kind: "preference", strength: 3 };
    const fetchImpl = okFetch({
      candidates: [{
        content: { parts: [{ functionCall: { name: "dream_memories", args: { ops: [flatOp] } } }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 }
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch, "google-ai-studio", "gemini-2.5-flash-lite").decideDream!(dreamRequest);
    // Canonical normalized shape: kind/strength lifted into patch sub-object;
    // patch.content absent (undefined stripped), DreamOpSchema defaults patch to {}.
    expect(out).toEqual([{
      op: "promote",
      memoryIndex: 1,
      patch: { kind: "preference", strength: 3 }
    }]);
  });

  // Per-op tolerance parity (legacy parseDreamOps, legacy pipelines.ts:1416-1432): one bad op
  // must not fail the whole chunk — only the invalid op is dropped.
  it("skips an invalid op and returns only the valid ones (per-op tolerance, legacy parity)", async () => {
    const ops = [{ op: "decay", memoryIndex: 1, strength: 1 }, { op: "bogus" }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dream_memories", arguments: JSON.stringify({ ops }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).decideDream!(dreamRequest);
    expect(out).toEqual([{ op: "decay", memoryIndex: 1, strength: 1 }]);
  });

  // Message parity (legacy parseDreamOps throw when validOps.length === 0): "No valid dream
  // ops. Invalid ops: ..." — wrapped as a GatewayPipelineError by parseForcedCall.
  it("throws when every op in the chunk is invalid", async () => {
    const ops = [{ op: "bogus" }, { op: "add" }];
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "dream_memories", arguments: JSON.stringify({ ops }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const promise = makePipeline(fetchImpl as unknown as typeof fetch).decideDream!(dreamRequest);
    await expect(promise).rejects.toBeInstanceOf(GatewayPipelineError);
    await expect(promise).rejects.toThrow(/No valid dream ops\. Invalid ops:/);
  });
});

describe("generatePersonaDigest (gateway)", () => {
  it("forces set_persona_digest and returns voice/role", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "dry wit", role: "older sister" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const out = await makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "PERSONA TEXT"
    });
    expect(out).toEqual({ voice: "dry wit", role: "older sister" });
  });

  it("throws on malformed digest", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: JSON.stringify({ voice: "" }) } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    await expect(makePipeline(fetchImpl as unknown as typeof fetch).generatePersonaDigest!({
      modelId: "deepseek-v4-flash", messages: [], personaText: "X"
    })).rejects.toThrow();
  });

  it("surfaces the raw tool-call arguments in error details when digest args fail validation", async () => {
    const rawArguments = JSON.stringify({ voice: "" });
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: rawArguments } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    let caught: unknown;
    try {
      await pipeline.generatePersonaDigest!({ modelId: "deepseek-v4-flash", messages: [], personaText: "X" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayPipelineError);
    expect((caught as GatewayPipelineError).details).toMatchObject({ text: rawArguments });
    expect((caught as GatewayPipelineError & { details: { error?: string } }).details?.error).toEqual(expect.any(String));
  });

  it("surfaces the raw tool-call arguments in error details on malformed JSON", async () => {
    const rawArguments = "{not json";
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "set_persona_digest", arguments: rawArguments } }] }, finish_reason: "tool_calls" }],
      usage: {}
    });
    const pipeline = makePipeline(fetchImpl as unknown as typeof fetch);
    let caught: unknown;
    try {
      await pipeline.generatePersonaDigest!({ modelId: "deepseek-v4-flash", messages: [], personaText: "X" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GatewayPipelineError);
    expect((caught as GatewayPipelineError).details).toMatchObject({ text: rawArguments });
    expect((caught as GatewayPipelineError & { details: { error?: string } }).details?.error).toEqual(expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// Cross-wire golden matrix — Task 8 (P3a)
// Each test drives the REAL gateway codecs with a fake fetch and pins the
// wire shape end-to-end.  Adjust comments record every pin that had to be
// corrected against the initial task spec.
// ---------------------------------------------------------------------------
describe("cross-wire goldens", () => {
  // -------------------------------------------------------------------------
  // 1. anthropic-messages wire — generateWaifu
  //    haiku has multipleSystemMessages:false → mid/trailing blocks become
  //    user turns wrapped in <system_note>...</system_note>.
  //    The anthropic codec joins all top-level {role:"system"} turns into
  //    body.system as a plain string.
  // -------------------------------------------------------------------------
  it("anthropic generateWaifu: correct URL, headers, system, system_note turns, max_tokens, content, usage", async () => {
    const payload = {
      id: "m1",
      content: [{ type: "text", text: "hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 }
    };
    const fetchImpl = okFetch(payload);

    const result = await makePipeline(fetchImpl as unknown as typeof fetch, "anthropic", "claude-haiku-4-5-20251001").generateWaifu({
      modelId: "claude-haiku-4-5-20251001",
      systemPrompt: "SYS",
      midSystemBlock: "MID",
      trailingSystemBlock: "TRAIL",
      messages: [
        msg({}),
        msg({ id: "m2", authorKind: "waifu" as const, authorId: "bot-1", content: "yo" })
      ],
      selfAuthorIds: ["bot-1"],
      temperature: 0.7,
      maxOutputTokens: 300,
      params: { "reasoning.enabled": false }
    });

    // URL and auth header
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-a");

    // Wire body
    const body = JSON.parse((init as RequestInit).body as string);

    // Top-level system is the plain systemPrompt string (anthropic codec joins system turns)
    expect(body.system).toBe("SYS");

    // MID injected as a user turn (haiku: multipleSystemMessages:false → <system_note>)
    // Note: JSON.stringify encodes newlines as \n (two chars), so we search the
    // serialised form. Actual wire text is <system_note>\nMID\n</system_note>.
    const messagesJson = JSON.stringify(body.messages);
    expect(messagesJson).toContain("<system_note>\\nMID\\n</system_note>");
    // TRAIL appended as a user turn
    expect(messagesJson).toContain("<system_note>\\nTRAIL\\n</system_note>");

    // Self-waifu message ("yo") → assistant turn
    const assistantTurns: Array<{ role: string }> = body.messages.filter((m: { role: string }) => m.role === "assistant");
    expect(assistantTurns.length).toBeGreaterThanOrEqual(1);

    // max_tokens
    expect(body.max_tokens).toBe(300);

    // Result
    expect(result.content).toBe("hello!");
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  // -------------------------------------------------------------------------
  // 2. openai-responses wire — decideOrchestrator
  //    gpt-5.4-nano is on the openai-responses codec.
  //    tool_choice shape on this wire: {type:"function", name:"orchestrator_decision"}
  //    (NOT the openai-chat shape {type:"function", function:{name:...}}).
  //    tools shape: {type:"function", name:..., description:..., parameters:...}
  //    body key is "input" (not "messages").
  // -------------------------------------------------------------------------
  it("openai-responses decideOrchestrator: URL, auth, tool_choice shape, tools shape, parsed decision", async () => {
    const decision = { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 600, reasoning: "quiet" };
    const payload = {
      id: "resp1",
      status: "completed",
      output: [{
        type: "function_call",
        call_id: "c1",
        name: "orchestrator_decision",
        arguments: JSON.stringify(decision)
      }],
      usage: { input_tokens: 4, output_tokens: 3 }
    };
    const fetchImpl = okFetch(payload);

    const orchRequest = {
      modelId: "gpt-5.4-nano",
      systemPrompt: "ORCH",
      trailingPrompt: "Decide now.",
      messages: [msg({})],
      availableWaifuIds: ["yuki"],
      replyRequired: false,
      directiveBudgetOpen: true,
      // No reasoning — gpt-5.4-nano is a responses-wire model; no reasoning.enabled param needed
      params: { "reasoning.enabled": false }
    };

    const parsed = await makePipeline(fetchImpl as unknown as typeof fetch, "openai", "gpt-5.4-nano").decideOrchestrator!(orchRequest);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-o");

    const body = JSON.parse((init as RequestInit).body as string);

    // responses wire: forced-tool shape has no nested .function wrapper
    expect(body.tool_choice).toEqual({ type: "function", name: "orchestrator_decision" });

    // tools: top-level name (responses format, not openai-chat's function.name)
    expect(body.tools[0]).toMatchObject({ type: "function", name: "orchestrator_decision" });

    // Parsed decision
    expect(parsed.action).toBe("no_reply");
    expect(parsed.retriggerAfterSeconds).toBe(600);
  });

  // -------------------------------------------------------------------------
  // 3. google-generative-language wire — decideDream
  //    gemini-2.5-flash-lite supports named toolChoice.
  //    toolConfig shape: {functionCallingConfig:{mode:"ANY", allowedFunctionNames:["dream_memories"]}}
  //    gatewayPipeline uses flatDreamToolParameters (no additionalProperties).
  //    URL includes /v1beta/models/gemini-2.5-flash-lite:generateContent.
  //    Header: x-goog-api-key.
  // -------------------------------------------------------------------------
  it("google decideDream: URL, header, toolConfig ANY+allowedFunctionNames, no additionalProperties, parsed ops", async () => {
    const payload = {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: "dream_memories",
              args: { ops: [{ op: "decay", memoryIndex: 1, strength: 1 }] }
            }
          }]
        },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 }
    };
    const fetchImpl = okFetch(payload);

    const dreamRequest = {
      modelId: "gemini-2.5-flash-lite",
      messages: [],
      memories: [{
        memoryIndex: 1,
        waifuId: "yuki",
        content: "old note",
        kind: "note" as const,
        strength: 2,
        ageDays: 10,
        daysSinceRetrieved: 5
      }],
      observations: [],
      availableWaifuIds: ["yuki"]
    };

    const ops = await makePipeline(fetchImpl as unknown as typeof fetch, "google-ai-studio", "gemini-2.5-flash-lite").decideDream!(dreamRequest);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toContain("/v1beta/models/gemini-2.5-flash-lite:generateContent");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("sk-g");

    const body = JSON.parse((init as RequestInit).body as string);

    // Named toolChoice on google wire → mode:ANY + allowedFunctionNames
    expect(body.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["dream_memories"] }
    });

    // Flat schema (no additionalProperties) — verify by stringifying
    const schemaJson = JSON.stringify(body.tools[0].functionDeclarations[0].parameters);
    expect(schemaJson).not.toContain("additionalProperties");

    // Parsed ops
    expect(ops).toEqual([{ op: "decay", memoryIndex: 1, strength: 1 }]);
  });

  // -------------------------------------------------------------------------
  // 4. DeepSeek thinking-drop golden — generateWaifu
  //    reasoning:{enabled:true} triggers the "thinking-drops-sampling"
  //    constraint: temperature and topP are dropped from the wire body.
  //    The wire body should carry thinking:{type:"enabled"} but NOT temperature.
  //    stream must also be absent (not a streaming call).
  // -------------------------------------------------------------------------
  it("deepseek thinking-drop: thinking:{type:'enabled'} present, temperature absent, stream absent", async () => {
    const fetchImpl = okFetch({
      id: "r1",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    });

    await makePipeline(fetchImpl as unknown as typeof fetch).generateWaifu({
      modelId: "deepseek-v4-flash",
      systemPrompt: "SYS",
      messages: [msg({})],
      selfAuthorIds: [],
      temperature: 0.7,
      params: { "reasoning.enabled": true }
    });

    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);

    // thinking block must be present and enabled
    expect(body.thinking).toEqual({ type: "enabled" });

    // temperature must be absent (dropped by thinking-drops-sampling constraint)
    expect(body).not.toHaveProperty("temperature");

    // no stream flag on a non-streaming call
    expect(body).not.toHaveProperty("stream");
  });
});
