import { readFile } from "node:fs/promises";
import path from "node:path";
import { createGateway, GatewayError, type ChatRequest, type ChatResponse } from "@waifucave/gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stripCacheMarkers } from "../src/orchestration/context/builder.js";
import {
  CALIBRATION_ALPHA,
  ContextCompactionService,
  compactionInstruction,
  compactionMaxOutputTokens,
  compactionMessages,
  compactionToolChoice,
  contextSummarizer,
  effectiveKeepRecent,
  createCompactionService,
  emaTokenCalibration
} from "../src/orchestration/context/compaction.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { ContextRuntime, type ContextRuntimeDeps } from "../src/orchestration/context/runtime.js";
import type { CompactionService } from "../src/orchestration/context/types.js";
import { conversationKey, conversationLedgerPath, type ConversationRef } from "../src/orchestration/context/keys.js";
import { orderedEntries } from "../src/orchestration/context/ledger.js";
import type { BuiltPrompt, PreparedContext } from "../src/orchestration/context/types.js";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";
import { createUsageLedger } from "../src/orchestration/usageLedger.js";
import { DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "../src/shared/schemas/compaction.js";
import { ConversationLedgerSchema, type ContextState, type LedgerEntry } from "../src/shared/schemas/context.js";
import { UsageLedgerEntrySchema } from "../src/shared/schemas/usage.js";
import { StorageService } from "../src/storage/storageService.js";
import {
  ADD_MEMORY_TOOL,
  BASE_TIME,
  FakeChannel,
  FakeImageFetcher,
  fakeModel,
  fakeRoleRenderer,
  noSnapshots,
  quietLogger
} from "./contextFixtures.js";
import { serializeMessages, serializeTools } from "./golden/serialize.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const ledgers: Array<{ flush(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((l) => l.flush()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const KEY = conversationKey(GUILD);
const ARIA = { kind: "waifu", waifuId: "aria" } as const;
const SELF = ["aria-bot"];

type ContextEngine = { runtime: ContextRuntime; compaction: CompactionService };

/** What the production wiring (T3 appRuntime) does: app defaults overlaid with the server override. */
function settingsFor(defaults: CompactionSettings) {
  return (server?: { compaction?: Partial<CompactionSettings> }) => ({ ...defaults, ...(server?.compaction ?? {}) });
}

type Harness = {
  root: string;
  store: FileContextStore;
  engine: ContextEngine;
  channel: FakeChannel;
  clock: { now: number };
  observed: Array<[ConversationRef, number]>;
  logs: string[];
};

async function harness(o: { settings?: Partial<CompactionSettings>; deps?: Partial<ContextRuntimeDeps> } = {}): Promise<Harness> {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 5 * 3_600_000 };
  const store = new FileContextStore(new StorageService(root), { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const observed: Array<[ConversationRef, number]> = [];
  const logs: string[] = [];
  const logger = { ...quietLogger(), info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m) };
  const now = () => new Date(clock.now);
  const compaction = createCompactionService({
    store,
    logger,
    now,
    observeThrough: (conversation, seq) => void observed.push([conversation, seq])
  });
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction,
    messages: channel,
    images: new FakeImageFetcher(),
    settings: settingsFor({ ...DEFAULT_COMPACTION_SETTINGS, ...o.settings }),
    logger,
    now,
    timeZone: () => "UTC",
    calibrate: emaTokenCalibration,
    ...o.deps
  });
  const engine: ContextEngine = { runtime, compaction };
  return { root, store, engine, channel, clock, observed, logs };
}

function post(h: Harness, count: number, from = 0) {
  for (let i = from; i < from + count; i += 1) h.channel.post({ content: `m${i + 1}` });
}

type SummarizeCall = { prompt: BuiltPrompt; instruction: string };
function summarizer(impl: (call: SummarizeCall, index: number) => Promise<string> = async (_c, n) => `summary ${n + 1}`) {
  const calls: SummarizeCall[] = [];
  const fn = async (prompt: BuiltPrompt, instruction: string) => {
    const call = { prompt, instruction };
    calls.push(call);
    return impl(call, calls.length - 1);
  };
  return { fn, calls };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function prepare(h: Harness, extra: Partial<Parameters<ContextEngine["runtime"]["prepare"]>[0]> = {}) {
  return h.engine.runtime.prepare({
    conversation: GUILD,
    agent: ARIA,
    model: fakeModel(),
    backfillCap: 200,
    selfAuthorIds: SELF,
    render: fakeRoleRenderer(),
    ...extra
  });
}

async function settle(h: Harness) {
  await (h.engine.compaction.inFlight(KEY, ARIA) ?? Promise.resolve()).catch(() => undefined);
}

async function editLedger(h: Harness, fn: (entries: Record<string, LedgerEntry>, ledger: { events: unknown[] }) => void) {
  const storage = new StorageService(h.root);
  await storage.updateRevisionedJson({
    resourceKey: `ledger:${KEY}`,
    relativePath: conversationLedgerPath(KEY),
    schema: ConversationLedgerSchema,
    fallback: await h.store.loadLedger(KEY),
    transform: (ledger) => {
      const next = structuredClone(ledger);
      fn(next.entries, next as unknown as { events: unknown[] });
      return next;
    }
  });
}

const refOf = (p: PreparedContext | BuiltPrompt, body: string, transcript: LedgerEntry[]) => {
  const prompt = "prompt" in p ? p.prompt : p;
  const entry = transcript.find((e) => e.body === body)!;
  return prompt.messageIdToRef.get(entry.id)!;
};

const SMALL = { maxMessages: 20, keepRecent: 5 } satisfies Partial<CompactionSettings>;

describe("compaction settings and helpers", () => {
  it("clamps keepRecent to 60% of maxMessages", () => {
    expect(effectiveKeepRecent({ keepRecent: 30, maxMessages: 150 })).toBe(30);
    expect(effectiveKeepRecent({ keepRecent: 100, maxMessages: 150 })).toBe(90);
    expect(effectiveKeepRecent({ keepRecent: 30, maxMessages: 20 })).toBe(12);
  });

  it("caps the output at max(1500, thinking budget + 1500) within the model limit", () => {
    expect(compactionMaxOutputTokens(undefined)).toBe(1500);
    expect(compactionMaxOutputTokens({ maxOutputTokens: 200 })).toBe(1500);
    expect(compactionMaxOutputTokens({ "reasoning.budgetTokens": 4000 })).toBe(5500);
    expect(compactionMaxOutputTokens({ "reasoning.enabled": false, "reasoning.budgetTokens": 4000 })).toBe(1500);
    expect(compactionMaxOutputTokens({ "reasoning.budgetTokens": 30_000 }, { limits: { contextTokens: 1, maxOutputTokens: 8192 } })).toBe(8192);
  });

  it("keeps the reply tool choice for waifus; a forced tool becomes none where supported, else auto", () => {
    expect(compactionToolChoice("auto", ["auto", "named"])).toBe("auto");
    expect(compactionToolChoice(undefined, ["auto"])).toBeUndefined();
    expect(compactionToolChoice({ name: "orchestrator_decision" }, ["auto", "none", "named"])).toBe("none");
    expect(compactionToolChoice({ name: "orchestrator_decision" }, ["auto", "named"])).toBe("auto");
    expect(compactionToolChoice("none", ["auto"])).toBe("auto");
  });

  it("instructions name the keep-from ref, deleted refs and the per-role focus", () => {
    const waifu = compactionInstruction({ agent: ARIA, keepFromRef: "k9", keepCount: 30, deletedRefs: ["k3", "k7"], hasPreviousSummary: true });
    expect(waifu).toContain("Messages from #k9 on stay verbatim");
    expect(waifu).toContain("Leave out messages #k3, #k7 — their authors deleted them.");
    expect(waifu).toContain("replaces the earlier <conversation_summary>");
    expect(waifu).toContain("your future self");
    const director = compactionInstruction({ agent: { kind: "orchestrator" }, keepCount: 4, deletedRefs: [], hasPreviousSummary: false });
    expect(director).toContain("The newest 4 messages stay verbatim");
    expect(director).toContain("pacing");
    expect(director).not.toContain("Leave out");
  });
});

describe("token calibration EMA", () => {
  const state = (calibration: ContextState["tokenCalibration"] = {}) => ({ tokenCalibration: calibration }) as ContextState;
  const now = new Date(BASE_TIME);
  const call = (s: ContextState, input: number, raw: number) =>
    emaTokenCalibration({ state: s, prompt: {} as BuiltPrompt, rawEstimate: raw, usage: { inputTokens: input, outputTokens: 1 }, modelKey: "p:m", now });

  it("seeds with the clamped observation, then moves by alpha 0.3", () => {
    const first = call(state(), 1200, 1000)!;
    expect(first["p:m"]).toEqual({ ratio: 1.2, samples: 1, updatedAt: now.toISOString() });
    const second = call(state(first), 2000, 1000)!;
    expect(second["p:m"]!.ratio).toBeCloseTo(1.2 + CALIBRATION_ALPHA * (2 - 1.2));
    expect(second["p:m"]!.samples).toBe(2);
  });

  it("clamps to [0.5, 2.5] and skips unusable samples", () => {
    expect(call(state(), 10_000, 1000)!["p:m"]!.ratio).toBe(2.5);
    expect(call(state(), 10, 1000)!["p:m"]!.ratio).toBe(0.5);
    expect(call(state(), 0, 1000)).toBeUndefined();
    expect(call(state(), 100, 0)).toBeUndefined();
  });

  it("runs on commit through the runtime calibrate hook and keeps other models' ratios", async () => {
    const h = await harness();
    post(h, 3);
    const p1 = await prepare(h);
    const raw = p1.prompt.estimatedTokens; // ratio 1 on the first build
    await h.engine.runtime.commit(p1, { modelKey: p1.modelKey, usage: { inputTokens: raw * 2, outputTokens: 5 } });
    expect((await h.store.load(KEY, ARIA)).tokenCalibration[p1.modelKey]!.ratio).toBeCloseTo(2, 1);
    const p2 = await prepare(h);
    expect(p2.prompt.estimatedTokens).toBeGreaterThan(raw * 1.8);
    await h.engine.runtime.commit(p2, { modelKey: p2.modelKey, usage: { inputTokens: 1, outputTokens: 5 } });
    const after = (await h.store.load(KEY, ARIA)).tokenCalibration[p1.modelKey]!;
    expect(after.samples).toBe(2);
    expect(after.ratio).toBeCloseTo(2 + CALIBRATION_ALPHA * (0.5 - 2), 1);
  });
});

describe("compaction request shape (prefix reuse)", () => {
  it("is the prompt through C with the tail replaced by the instruction", async () => {
    const h = await harness();
    post(h, 3);
    const p = await prepare(h);
    const messages = compactionMessages(p.prompt, "INSTRUCTION");
    // Every message but the last is identical, cache markers included.
    expect(messages.slice(0, -1)).toEqual(p.prompt.messages.slice(0, -1));
    const before = p.prompt.messages.at(-1)!.content as Array<{ text?: string }>;
    const after = messages.at(-1)!.content as Array<{ text?: string }>;
    expect(before.at(-1)!.text).toBe(p.prompt.debug.tail);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).toEqual({ type: "text", text: "INSTRUCTION" });
    // The input prompt is not mutated.
    expect((p.prompt.messages.at(-1)!.content as unknown[]).length).toBe(before.length);
  });

  it("opens a new user turn when the transcript ends with an assistant turn", async () => {
    const h = await harness();
    post(h, 1);
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "hey" });
    const p = await prepare(h);
    expect(p.prompt.messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: p.prompt.debug.tail }] });
    const messages = compactionMessages(p.prompt, "INSTRUCTION");
    expect(messages.slice(0, -1)).toEqual(p.prompt.messages.slice(0, -1));
    expect(messages.at(-1)).toEqual({ role: "user", content: [{ type: "text", text: "INSTRUCTION" }] });
  });
});

describe("gatewayPipeline.summarizeContext", () => {
  type Script = Array<ChatResponse | ((r: ChatRequest) => ChatResponse)>;
  function fakeGateway(script: Script) {
    const real = createGateway({});
    const calls: ChatRequest[] = [];
    const gateway = new Proxy(real, {
      get(target, prop) {
        if (prop === "chat") {
          return async (request: ChatRequest) => {
            calls.push(request);
            const next = script.shift();
            if (!next) throw new Error("no scripted response left");
            return typeof next === "function" ? next(request) : next;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    return { gateway: gateway as never, calls, real };
  }
  const reply = (content: ChatResponse["content"]): ChatResponse => ({
    id: "r", provider: "deepseek", model: "deepseek-v4-flash", content, finishReason: "stop", usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 800 }, warnings: []
  });

  async function pipelineHarness(script: Script) {
    const root = await makeTempRoot();
    roots.push(root);
    const ledger = createUsageLedger(root);
    ledgers.push(ledger);
    const g = fakeGateway(script);
    const pipeline = createGatewayModelPipeline({ providerId: "deepseek", modelId: "deepseek-v4-flash", queryRole: "waifu", gateway: g.gateway, usageLedger: ledger });
    const lines = async () => {
      await ledger.flush();
      const day = new Date().toISOString().slice(0, 10);
      const text = await readFile(path.join(root, "user", "usage", `${day}.jsonl`), "utf8").catch(() => "");
      return text.split("\n").filter(Boolean).map((l) => UsageLedgerEntrySchema.parse(JSON.parse(l)));
    };
    return { pipeline, calls: g.calls, real: g.real, lines };
  }

  it("sends the same system, tools, tool choice and params as the reply call, differing only by the tail", async () => {
    const h = await harness();
    h.channel.post({ content: "hi Aria" }, BASE_TIME);
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "I baked a lemon tart" }, BASE_TIME + 60_000);
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "ooh share it" }, BASE_TIME + 120_000);
    h.channel.post({ content: "she never shares" }, BASE_TIME + 180_000);
    const p = await prepare(h);
    const { pipeline, calls, lines } = await pipelineHarness([reply([{ type: "text", text: " Riko bakes tarts. " }, { type: "toolCall", id: "t", name: "add_memory", arguments: "{}" }])]);
    const replyParams = { temperature: 0.8, stopSequences: ["\n[", "Aria:"] };
    const summarize = contextSummarizer(pipeline, {
      toolChoice: "auto",
      params: replyParams,
      attribution: { waifuId: "aria", agentId: "waifu-aria", conversationKey: KEY, guildId: "100", channelId: "200" }
    });
    const instruction = compactionInstruction({ agent: ARIA, keepFromRef: "a3", keepCount: 1, deletedRefs: ["a1"], hasPreviousSummary: false });
    const text = await summarize(p.prompt, instruction);
    expect(text).toBe("Riko bakes tarts."); // tool calls ignored

    const request = calls[0]!;
    expect(request.messages).toEqual(compactionMessages(p.prompt, instruction));
    expect(request.messages.slice(0, -1)).toEqual(p.prompt.messages.slice(0, -1));
    expect(stripCacheMarkers(request.messages)[0]).toEqual(stripCacheMarkers(p.prompt.messages)[0]);
    expect(request.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(request.tools).toEqual(p.prompt.tools);
    expect(request.toolChoice).toBe("auto");
    expect(request.params).toEqual({ temperature: 0.8, maxOutputTokens: 1500 }); // stop sequences dropped
    expect(request.promptCacheKey).toBe(p.prompt.promptCacheKey);

    const [line] = await lines();
    expect(line).toMatchObject({ purpose: "compaction", waifuId: "aria", agentId: "waifu-aria", conversationKey: KEY, status: "ok", cacheReadTokens: 800 });

    await expect(
      [
        `toolChoice: ${JSON.stringify(request.toolChoice)}`,
        `params: ${JSON.stringify(request.params)}`,
        `tools:\n${serializeTools(request.tools ?? [])}`,
        "",
        serializeMessages(request.messages)
      ].join("\n")
    ).toMatchFileSnapshot("./golden/__snapshots__/compaction-request.txt");
  });

  it("orchestrator: a forced reply tool becomes none (or auto when unsupported)", async () => {
    const h = await harness();
    post(h, 2);
    const p = await prepare(h, { agent: { kind: "orchestrator" }, render: fakeRoleRenderer("Director", [{ name: "orchestrator_decision", parameters: { type: "object" } }]) });
    const { pipeline, calls, real } = await pipelineHarness([reply([{ type: "text", text: "room notes" }])]);
    await pipeline.summarizeContext!({ prompt: p.prompt, instruction: "x", toolChoice: { name: "orchestrator_decision" } });
    const supported = real.getCapabilities("deepseek", "deepseek-v4-flash")!.features.tools.toolChoice;
    expect(calls[0]!.toolChoice).toBe(supported?.includes("none") ? "none" : "auto");
    expect(calls[0]!.tools).toEqual(p.prompt.tools);
  });

  it("a 200-message conversation compacts end to end with a correct cursor and summary", async () => {
    const h = await harness();
    post(h, 200);
    const { pipeline, calls } = await pipelineHarness([reply([{ type: "text", text: "Long story short." }])]);
    const handed: BuiltPrompt[] = [];
    const inner = contextSummarizer(pipeline, { toolChoice: "auto", params: {} });
    const p = await prepare(h, {
      summarize: (prompt, instruction) => {
        handed.push(prompt);
        return inner(prompt, instruction);
      }
    });
    expect(calls).toHaveLength(1);
    expect(handed[0]!.transcriptCount).toBe(200);
    // Messages through C equal the prompt handed to compaction (markers stripped).
    const sent = stripCacheMarkers(calls[0]!.messages);
    const original = stripCacheMarkers(handed[0]!.messages);
    expect(sent.slice(0, -1)).toEqual(original.slice(0, -1));
    expect(p.state).toMatchObject({ epoch: 1, summary: "Long story short.", cursorSeq: 170 });
    expect(p.transcript.map((e) => e.body)).toEqual(Array.from({ length: 30 }, (_, i) => `m${171 + i}`));
    expect(p.prompt.debug.header).toContain("<conversation_summary>Long story short.</conversation_summary>");
    expect(p.state.lastCompaction).toMatchObject({ trigger: "messages", ok: true });
  });
});

describe("ContextCompactionService triggers", () => {
  it("messages: rolls the epoch over with summary, cursor, fresh header and dropped notes (edits included)", async () => {
    const h = await harness({ settings: SMALL });
    post(h, 10);
    const p1 = await prepare(h, { pendingNotes: [{ kind: "direction", text: "d1" }] });
    await h.engine.runtime.commit(p1, { modelKey: p1.modelKey, notes: [{ kind: "tool", callId: "c1", name: "add_memory", arguments: "{}", result: "ok" }] });
    const firstId = p1.transcript[0]!.id;
    post(h, 2, 10);
    await prepare(h, { agent: { kind: "orchestrator" } });
    await editLedger(h, (_entries, ledger) => {
      ledger.events.push({ kind: "edit", seq: 1, at: new Date(h.clock.now).toISOString(), messageId: firstId, anchorSeq: 12, authorId: "kevin", text: "m1 (edited)", sealed: false });
    });
    const p2 = await prepare(h);
    expect(p2.state.notes.map((n) => n.kind)).toEqual(["direction", "tool", "edit"]);
    await h.engine.runtime.commit(p2, { modelKey: p2.modelKey });

    post(h, 15, 12); // 27 messages > maxMessages 20
    const s = summarizer();
    const p3 = await prepare(h, { summarize: s.fn, pendingNotes: [{ kind: "direction", text: "d3" }] });

    expect(s.calls).toHaveLength(1);
    const handed = s.calls[0]!;
    expect(handed.prompt.transcriptCount).toBe(27);
    expect(handed.prompt.debug.transcript).toContain("<edit>");
    const keepRef = handed.prompt.messageIdToRef.get(orderedEntries(await h.store.loadLedger(KEY))[22]!.id)!;
    expect(handed.instruction).toContain(`Messages from #${keepRef} on stay verbatim`);

    expect(p3.state).toMatchObject({ epoch: 1, summary: "summary 1", cursorSeq: 22, memoryNoteCount: 0, inlineImageCount: 0 });
    expect(p3.state.lastCompaction).toMatchObject({ trigger: "messages", ok: true });
    expect(p3.transcript.map((e) => e.body)).toEqual(["m23", "m24", "m25", "m26", "m27"]);
    expect(p3.prompt.debug.header).toContain("<conversation_summary>summary 1</conversation_summary>");
    // Notes before the cursor (direction, tool, edit) are gone; only this turn's pending note remains.
    expect(p3.state.notes).toEqual([expect.objectContaining({ kind: "direction", text: "d3", anchorSeq: 27 })]);
    expect(p3.prompt.debug.transcript).not.toContain("<edit>");
    expect(h.observed).toEqual([[GUILD, 22]]);
  });

  it("tokens: an estimate over the budget compacts even below maxMessages", async () => {
    const h = await harness({ settings: SMALL });
    for (let i = 0; i < 10; i += 1) h.channel.post({ content: `${i} ${"word ".repeat(120)}` });
    const s = summarizer();
    const model = fakeModel({ contextTokens: 2_000 });
    const p = await prepare(h, { summarize: s.fn, model, params: { maxOutputTokens: 100 } });
    expect(s.calls).toHaveLength(1);
    expect(p.state.lastCompaction).toMatchObject({ trigger: "tokens", ok: true });
    expect(p.transcript).toHaveLength(5);
  });

  it("does not trigger under both limits, when disabled, or with nothing to summarize", async () => {
    const service = new ContextCompactionService({ store: {} as never, logger: quietLogger() });
    const prompt = { estimatedTokens: 100, transcriptCount: 10 } as BuiltPrompt;
    const budget = { contextTokens: 1000, maxOutputTokens: 100, triggerRatio: 0.7, budgetTokens: 600 };
    const settings = { ...DEFAULT_COMPACTION_SETTINGS, maxMessages: 20 };
    const state = {} as ContextState;
    expect(service.check({ state, prompt, budget, settings })).toBeUndefined();
    expect(service.check({ state, prompt: { ...prompt, estimatedTokens: 601 }, budget, settings })).toBe("tokens");
    expect(service.check({ state, prompt: { ...prompt, transcriptCount: 21 }, budget, settings })).toBe("messages");
    expect(service.check({ state, prompt: { ...prompt, transcriptCount: 21 }, budget, settings: { ...settings, enabled: false } })).toBeUndefined();
    expect(service.check({ state, prompt: { estimatedTokens: 5000, transcriptCount: 1 } as BuiltPrompt, budget, settings })).toBeUndefined();
  });

  it("overflow: call() compacts, rebuilds and retries once; a second overflow surfaces", async () => {
    const h = await harness();
    post(h, 6);
    const s = summarizer();
    const p = await prepare(h, { summarize: s.fn });
    expect(s.calls).toHaveLength(0);
    const seen: number[] = [];
    const result = await h.engine.runtime.call(p, async (prompt) => {
      seen.push(prompt.transcriptCount);
      if (seen.length === 1) throw new GatewayError("context_overflow", "prompt too long");
      return "sent";
    });
    expect(result).toBe("sent");
    expect(seen).toEqual([6, 3]); // 6 ≤ keepRecent → keep half
    expect(p.state).toMatchObject({ epoch: 1, summary: "summary 1" });
    expect(p.state.lastCompaction).toMatchObject({ trigger: "overflow", ok: true });
    const again = new GatewayError("context_overflow", "still too long");
    await expect(h.engine.runtime.call(p, async () => { throw again; })).rejects.toBe(again);
  });

  it("overflow: a failed compaction surfaces the original overflow error", async () => {
    const h = await harness();
    post(h, 6);
    const p = await prepare(h, { summarize: async () => { throw new Error("summarizer down"); } });
    const overflow = new GatewayError("context_overflow", "prompt too long");
    await expect(h.engine.runtime.call(p, async () => { throw overflow; })).rejects.toBe(overflow);
    expect((await h.store.load(KEY, ARIA)).lastCompaction).toMatchObject({ trigger: "overflow", ok: false, error: "summarizer down" });
  });

  it("manual: compactNow compacts on demand", async () => {
    const h = await harness();
    post(h, 8);
    const s = summarizer();
    await h.engine.runtime.compactNow({
      conversation: GUILD, agent: ARIA, model: fakeModel(), backfillCap: 200, selfAuthorIds: SELF, render: fakeRoleRenderer(), summarize: s.fn
    });
    const state = await h.store.load(KEY, ARIA);
    expect(state).toMatchObject({ epoch: 1, summary: "summary 1", cursorSeq: 4, headerText: null });
    expect(state.lastCompaction).toMatchObject({ trigger: "manual", ok: true });
  });

  it("post-reply: commit starts a background compaction when the reported usage is over budget", async () => {
    const h = await harness();
    post(h, 6);
    const s = summarizer();
    const p = await prepare(h, { summarize: s.fn });
    await h.engine.runtime.commit(p, { modelKey: p.modelKey, usage: { inputTokens: 1_000_000, outputTokens: 10 } });
    expect(h.engine.compaction.inFlight(KEY, ARIA)).toBeDefined();
    await settle(h);
    expect(s.calls).toHaveLength(1);
    const state = await h.store.load(KEY, ARIA);
    expect(state).toMatchObject({ epoch: 1, summary: "summary 1" });
    expect(state.lastCompaction).toMatchObject({ trigger: "tokens", ok: true });
  });

  it("per-server settings (runtime settings(server)) decide the trigger", async () => {
    const h = await harness({ settings: SMALL });
    post(h, 25);
    const s = summarizer();
    const server = { compaction: { maxMessages: 30 } } as never;
    const p = await prepare(h, { summarize: s.fn, server });
    expect(s.calls).toHaveLength(0);
    expect(p.state.epoch).toBe(0);
    await prepare(h, { summarize: s.fn });
    expect(s.calls).toHaveLength(1);
  });
});

describe("ContextCompactionService concurrency", () => {
  it("joins an in-flight compaction per (conversation, agent): one summarize call", async () => {
    const h = await harness({ settings: SMALL });
    post(h, 25);
    const gate = deferred<string>();
    const s = summarizer(() => gate.promise);
    const a = prepare(h, { summarize: s.fn });
    const b = prepare(h, { summarize: s.fn });
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    expect(h.engine.compaction.inFlight(KEY, ARIA)).toBeDefined();
    await new Promise((r) => setTimeout(r, 30)); // b reaches the join
    gate.resolve("joined summary");
    const [pa, pb] = await Promise.all([a, b]);
    expect(s.calls).toHaveLength(1);
    expect(pa.state.epoch).toBe(1);
    expect(pb.state.epoch).toBe(1);
    expect(pb.prompt.debug.header).toContain("joined summary");
    expect(h.engine.compaction.inFlight(KEY, ARIA)).toBeUndefined();
  });

  it("dedupes direct compact() calls; different agents compact independently", async () => {
    const h = await harness({ settings: SMALL });
    post(h, 8);
    const p = await prepare(h);
    const o = await prepare(h, { agent: { kind: "orchestrator" } });
    const gate = deferred<string>();
    const s = summarizer(() => gate.promise);
    const input = { conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual" as const, summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS, ...SMALL } };
    const one = h.engine.compaction.compact(input);
    const two = h.engine.compaction.compact(input);
    const director = h.engine.compaction.compact({ ...input, agent: { kind: "orchestrator" }, prompt: o.prompt });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.calls).toHaveLength(2);
    gate.resolve("S");
    await Promise.all([one, two, director]);
    expect((await h.store.load(KEY, ARIA)).epoch).toBe(1);
    expect((await h.store.load(KEY, { kind: "orchestrator" })).epoch).toBe(1);
  });

  it("timeout: the reply gets a one-off hard-truncated prompt; compaction lands in the background", async () => {
    const h = await harness({ settings: { ...SMALL, waitTimeoutMs: 20 } });
    post(h, 25);
    const gate = deferred<string>();
    const s = summarizer(() => gate.promise);
    const p = await prepare(h, { summarize: s.fn });
    expect(p.transcript.map((e) => e.body)).toEqual(["m21", "m22", "m23", "m24", "m25"]);
    expect(p.state.epoch).toBe(0);
    expect(p.state.cursorSeq).toBe(0); // stored cursor unchanged
    gate.resolve("late summary");
    await settle(h);
    const state = await h.store.load(KEY, ARIA);
    expect(state).toMatchObject({ epoch: 1, summary: "late summary", cursorSeq: 20 });
    const next = await prepare(h, { summarize: s.fn });
    expect(next.prompt.debug.header).toContain("late summary");
    expect(next.transcript).toHaveLength(5);
    expect(s.calls).toHaveLength(1);
  });

  it("abort is not a timeout: prepare rejects, persists nothing, and compaction still finishes", async () => {
    const h = await harness({ settings: { ...SMALL, waitTimeoutMs: 5_000 } });
    post(h, 25);
    const gate = deferred<string>();
    const s = summarizer(() => gate.promise);
    const controller = new AbortController();
    const running = prepare(h, { summarize: s.fn, signal: controller.signal });
    await vi.waitFor(() => expect(s.calls).toHaveLength(1));
    controller.abort(new Error("run superseded"));
    await expect(running).rejects.toThrow(/superseded/);
    expect(orderedEntries(await h.store.loadLedger(KEY)).every((e) => !e.sealed)).toBe(true);
    expect((await h.store.load(KEY, ARIA)).revision).toBe(0);
    gate.resolve("after abort");
    await settle(h);
    expect(await h.store.load(KEY, ARIA)).toMatchObject({ epoch: 1, summary: "after abort", cursorSeq: 20 });
  });

  it("a compact() waiter's abort rejects that waiter only", async () => {
    const h = await harness();
    post(h, 6);
    const p = await prepare(h);
    const gate = deferred<string>();
    const s = summarizer(() => gate.promise);
    const controller = new AbortController();
    const input = { conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual" as const, summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } };
    const waiter = h.engine.compaction.compact({ ...input, signal: controller.signal });
    controller.abort(new Error("gone"));
    await expect(waiter).rejects.toThrow("gone");
    gate.resolve("S");
    await settle(h);
    expect((await h.store.load(KEY, ARIA)).summary).toBe("S");
  });

  it("commitPrepare conflict: an epoch change during the summarize call discards the result", async () => {
    const h = await harness();
    post(h, 8);
    const p = await prepare(h);
    await h.engine.runtime.commit(p, { modelKey: p.modelKey });
    const s = summarizer(async () => {
      await h.store.update(KEY, ARIA, (st) => ({ ...st, epoch: st.epoch + 1, summary: "someone else's" }));
      return "mine";
    });
    await h.engine.compaction.compact({ conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual", summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } });
    const state = await h.store.load(KEY, ARIA);
    expect(state).toMatchObject({ epoch: 1, summary: "someone else's", cursorSeq: 0 });
    expect(state.lastCompaction).toBeUndefined();
    expect(h.logs).toContain("Compaction discarded: the context changed epoch meanwhile");
    expect(h.observed).toEqual([]);
  });

  it("a same-epoch change during the summarize call is merged: newer notes survive", async () => {
    const h = await harness();
    post(h, 8);
    const p = await prepare(h);
    const s = summarizer(async () => {
      await h.engine.runtime.commit(p, { modelKey: p.modelKey, notes: [{ kind: "tool", callId: "late", name: "add_memory", arguments: "{}", result: "ok" }] });
      return "merged";
    });
    await h.engine.compaction.compact({ conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual", summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } });
    const state = await h.store.load(KEY, ARIA);
    expect(state).toMatchObject({ epoch: 1, summary: "merged", cursorSeq: 4 });
    expect(state.notes).toEqual([expect.objectContaining({ kind: "tool", callId: "late", anchorSeq: 8 })]);
  });
});

describe("ContextCompactionService outcomes", () => {
  it("retries once with the instruction repeated when no text comes back", async () => {
    const h = await harness();
    post(h, 6);
    const p = await prepare(h);
    const s = summarizer(async (_c, n) => (n === 0 ? "   " : "second try"));
    await h.engine.compaction.compact({ conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual", summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } });
    expect(s.calls).toHaveLength(2);
    expect(s.calls[1]!.instruction).toContain("Your previous reply contained no summary text.");
    expect(s.calls[1]!.instruction).toContain(s.calls[0]!.instruction);
    expect((await h.store.load(KEY, ARIA)).summary).toBe("second try");
  });

  it("records a failure and backs off automatic triggers for a while", async () => {
    const h = await harness({ settings: SMALL });
    post(h, 10);
    const p0 = await prepare(h);
    await h.engine.runtime.commit(p0, { modelKey: p0.modelKey });
    post(h, 15, 10);
    const s = summarizer(async () => "");
    const p = await prepare(h, { summarize: s.fn });
    expect(s.calls).toHaveLength(2);
    expect(p.transcript).toHaveLength(25); // failed: the full prompt is sent
    expect(p.state.lastCompaction).toMatchObject({ trigger: "messages", ok: false, error: "The model returned no summary text." });
    await prepare(h, { summarize: s.fn });
    expect(s.calls).toHaveLength(2); // backoff
    h.clock.now += 6 * 60_000;
    const ok = summarizer();
    const after = await prepare(h, { summarize: ok.fn });
    expect(ok.calls).toHaveLength(1);
    expect(after.state.lastCompaction).toMatchObject({ ok: true });
  });

  it("lists summarized messages deleted by their authors; kept ones are not listed", async () => {
    const h = await harness();
    post(h, 8);
    const p0 = await prepare(h);
    await h.engine.runtime.commit(p0, { modelKey: p0.modelKey });
    await editLedger(h, (entries) => {
      for (const entry of Object.values(entries)) if (entry.body === "m2" || entry.body === "m8") entry.state = "deleted";
    });
    const p = await prepare(h);
    const s = summarizer();
    await h.engine.compaction.compact({ conversation: GUILD, agent: ARIA, prompt: p.prompt, trigger: "manual", summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } });
    const m2 = refOf(p, "m2", p.transcript);
    const m8 = refOf(p, "m8", p.transcript);
    expect(s.calls[0]!.instruction).toContain(`Leave out messages #${m2} — their authors deleted them.`);
    expect(s.calls[0]!.instruction).not.toContain(`#${m8} —`);
  });

  it("never compacts from a hard-truncated prompt", async () => {
    const h = await harness();
    post(h, 10);
    const p = await prepare(h);
    const truncated: BuiltPrompt = {
      ...p.prompt,
      transcriptCount: 3,
      messageIdToRef: new Map([...p.prompt.messageIdToRef].slice(-3))
    };
    const s = summarizer();
    await h.engine.compaction.compact({ conversation: GUILD, agent: ARIA, prompt: truncated, trigger: "overflow", summarize: s.fn, settings: { ...DEFAULT_COMPACTION_SETTINGS } });
    expect(s.calls).toHaveLength(0);
    expect((await h.store.load(KEY, ARIA)).epoch).toBe(0);
  });
});
