// Offline cache-hit simulation (spec 6.7 / 8.11).
//
// The REAL stack runs end to end with DEFAULT settings: FileContextStore on a temp dir, the real
// ContextRuntime + compaction service, the real waifu and orchestrator harnesses, and the real
// gateway pipeline (createGatewayModelPipeline over a real gateway) — only the network is fake.
// The fake `fetch` receives the exact wire body the anthropic-messages codec produces and applies
// Anthropic's caching rules to it (anthropicCacheSim.ts): at most 4 breakpoints, a hit only when a
// breakpoint's prefix matches a cached entry found within 20 blocks back, a 5-minute TTL; reads
// and writes are counted with the app's own token estimator.
//
// Targets (spec 8.11/8.11.1): cache-read ratio >= 0.8 for waifus in quiet rooms and DMs and for the
// orchestrator excluding its compaction calls; >= 0.75 for both in busy rooms (30+ messages between
// turns), where the new messages alone are ~18% of each prompt. A missed target is a finding about
// the prefix/breakpoint design, not a reason to loosen it further.
//
// The ratio is aggregated over every call of a scenario (cold start included). The fixture-
// independent prefix checks (expectWirePrefixStable / expectFullPrefixReuse) say whether the
// engine wastes anything; the ratio additionally depends on how large the static prefix is
// relative to the new messages per turn. CACHE_HIT_TRACE=1 prints one row per request;
// CACHE_HIT_FIXTURE=minimal swaps in a one-sentence persona and a two-character cast.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createGateway, type ResolvedModel, type Usage } from "@waifucave/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { emaTokenCalibration, contextSummarizer, createCompactionService } from "../../src/orchestration/context/compaction.js";
import { FileContextStore } from "../../src/orchestration/context/contextStore.js";
import { conversationKey, conversationLedgerPath, type ConversationRef } from "../../src/orchestration/context/keys.js";
import { ContextRuntime } from "../../src/orchestration/context/runtime.js";
import type { BuiltPrompt, MemorySnapshotProvider, PreparedContext } from "../../src/orchestration/context/types.js";
import {
  buildCastCards,
  createOrchestratorRenderer,
  orchestratorPlace,
  waifuAuthorMatcher,
  type OrchestratorTurn
} from "../../src/orchestration/orchestratorHarness.js";
import { createGatewayModelPipeline } from "../../src/orchestration/pipeline/gatewayPipeline.js";
import { decisionNoteFor } from "../../src/orchestration/pipeline/timeline.js";
import { waifuStopSequences } from "../../src/orchestration/responderExecutor.js";
import { ORCHESTRATOR_TOOL_NAME } from "../../src/orchestration/tools.js";
import { createUsageLedger } from "../../src/orchestration/usageLedger.js";
import { createWaifuHarness, waifuTools, type WaifuHarnessInput } from "../../src/orchestration/waifuHarness.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/shared/schemas/compaction.js";
import { createRevisionedBase } from "../../src/shared/schemas/common.js";
import { ConversationLedgerSchema } from "../../src/shared/schemas/context.js";
import { WaifuConfigSchema, type OrchestratorDecisionHistoryEntry } from "../../src/shared/schemas/domain.js";
import { UsageLedgerEntrySchema } from "../../src/shared/schemas/usage.js";
import { StorageService } from "../../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, quietLogger } from "../contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "../testUtils.js";
import {
  AnthropicCacheSim,
  CACHE_TTL_MS,
  LOOKBACK_BLOCKS,
  readRatio,
  tally,
  wireUsage,
  type CacheUsage,
  type WireBlock,
  type WireBody
} from "./anthropicCacheSim.js";

const roots: string[] = [];
const ledgers: Array<{ flush(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(ledgers.splice(0).map((ledger) => ledger.flush()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

// ---------------------------------------------------------------------------------------------
// The cache model itself

describe("AnthropicCacheSim", () => {
  const clock = { now: 0 };
  const ephemeral = { type: "ephemeral" };
  // System (marked) + one user turn of `count` blocks, with breakpoints on the listed block indices.
  const request = (count: number, marked: number[], extra: Partial<WireBody> = {}): WireBody => ({
    system: [{ type: "text", text: "S ".repeat(400), cache_control: ephemeral }],
    messages: [
      {
        role: "user",
        content: Array.from({ length: count }, (_, i): WireBlock => ({
          type: "text",
          text: `block ${i} ${"x".repeat(60)}`,
          ...(marked.includes(i) ? { cache_control: ephemeral } : {})
        }))
      }
    ],
    ...extra
  });
  const fresh = (o: { minCacheableTokens?: number } = {}) => {
    clock.now = 0;
    return new AnthropicCacheSim({ now: () => clock.now, ...o });
  };

  it("writes on the first request and reads the written prefix on the next", () => {
    const sim = fresh();
    const first = sim.process(request(4, [3]));
    expect(first.read).toBe(0);
    expect(first.write).toBe(first.total);
    const second = sim.process(request(6, [3, 5]));
    expect(second.read).toBe(first.total);
    expect(second.read + second.write + second.uncached).toBe(second.total);
    expect(second.write).toBeGreaterThan(0);
  });

  it("rejects more than 4 breakpoints (Anthropic answers 400)", () => {
    expect(() => fresh().process(request(5, [0, 1, 2, 3, 4]))).toThrow(/more than 4 cache breakpoints/);
  });

  it(`finds an entry only within ${LOOKBACK_BLOCKS} blocks of a breakpoint`, () => {
    const sim = fresh();
    sim.process(request(4, [3])); // entry at flat block 4 (system is block 0)
    // Breakpoint at flat block 23: the entry is 19 blocks back -> found.
    expect(sim.process(request(23, [22])).hitIndex).toBe(4);
    const far = fresh();
    far.process(request(4, [3]));
    // Breakpoint at flat block 24: 20 back -> out of reach; only the system entry (A) hits.
    const missed = far.process(request(24, [23]));
    expect(missed.hitIndex).toBe(0);
    // ... unless a second breakpoint (C_prev) marks the old block: that is why C_prev exists.
    const bridged = fresh();
    bridged.process(request(4, [3]));
    expect(bridged.process(request(24, [3, 23])).hitIndex).toBe(4);
  });

  it("expires entries after the 5-minute TTL; a hit refreshes the entry", () => {
    const sim = fresh();
    sim.process(request(4, [3]));
    clock.now = CACHE_TTL_MS - 1_000;
    expect(sim.process(request(5, [3, 4])).read).toBeGreaterThan(0);
    clock.now += CACHE_TTL_MS - 1_000; // 4:59 after the refreshing hit
    expect(sim.process(request(6, [3, 5])).hitIndex).toBe(5); // the newest entry, written at the last request
    clock.now += CACHE_TTL_MS + 1_000;
    expect(sim.process(request(7, [3, 6])).read).toBe(0);
  });

  it("tool_choice / thinking changes invalidate message blocks but not tools + system", () => {
    const sim = fresh();
    const make = (extra: Partial<WireBody>) => request(4, [3], extra);
    const a = sim.process(make({ tool_choice: { type: "auto" } }));
    expect(sim.process(make({ tool_choice: { type: "auto" } })).read).toBe(a.total);
    const changed = sim.process(make({ tool_choice: { type: "none" } }));
    expect(changed.hitIndex).toBe(0); // system still cached
    expect(changed.read).toBeGreaterThan(0);
    expect(changed.read).toBeLessThan(a.total);
    const thinking = sim.process(make({ tool_choice: { type: "none" }, thinking: { type: "adaptive" } }));
    expect(thinking.hitIndex).toBe(0);
  });

  it("never caches a prefix shorter than minCacheableTokens", () => {
    const sim = fresh({ minCacheableTokens: 5_000 });
    expect(sim.process(request(3, [2])).write).toBe(0);
    expect(sim.process(request(3, [2])).read).toBe(0);
    const small = fresh({ minCacheableTokens: 100 });
    small.process(request(3, [2]));
    expect(small.process(request(4, [2, 3])).read).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixtures: cast, harnesses, a room that runs real turns

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const GUILD_KEY = conversationKey(GUILD);
const DM: ConversationRef = { kind: "dm", waifuId: "aria", userId: "kevin" };
const ARIA_AGENT = { kind: "waifu", waifuId: "aria" } as const;
const ORCH_AGENT = { kind: "orchestrator" } as const;
const SELF = ["aria-bot"];
const PROVIDER = "anthropic";
const MODEL_ID = "claude-sonnet-4-6";

// Fixture size matters: the cache-read ratio of a turn is (prompt - new content) / prompt, so a
// one-line persona and a two-character cast make every prompt small and every busy-room turn
// mostly new. The default fixture is a typical deployment (a character-card persona of about 350
// words, a four-character cast with digests); CACHE_HIT_FIXTURE=minimal runs the same scenarios
// with a one-sentence persona and a two-character cast (see the header note and the spec report).
const MINIMAL = process.env["CACHE_HIT_FIXTURE"] === "minimal";

const ARIA_PERSONA = MINIMAL
  ? "Aria is a sunny baker who teases her friends, never misses a pun, and cannot resist an unsolicited recipe."
  : [
      "Aria Moreau is twenty-six and runs the morning shift at a small family bakery two streets from the river. She grew up in the flat above the shop, learned to laminate dough before she learned to ride a bike, and still wakes at four without an alarm. Flour is permanently on her sleeves.",
      "She is warm, quick and a little theatrical. She teases the people she likes, never the people she doesn't know yet, and she cannot let a pun pass unanswered: if someone sets one up she will land it, then apologise for it, then do it again. When she is excited her sentences run together and she forgets punctuation; when she is tired she goes quiet and sends one-word replies with a single lemon emoji.",
      "She loves food talk of every kind: regional breads, the chemistry of caramel, why her sourdough starter is named Gerald, the ongoing feud with the oven that runs ten degrees hot. She will volunteer a recipe nobody asked for, and she is genuinely curious about what other people cooked last night. She keeps a notebook of customers' favourite orders and is quietly proud that she remembers them.",
      "She worries about the people in her circle and shows it by feeding them. If someone is upset she asks one gentle question and then offers a distraction rather than advice. She is honest when she doesn't know something and doesn't pretend to expertise outside baking, music and bad movies.",
      "Her friends here are Riko, who answers every pun with silence and a drum fill, Noa, who keeps the archive of everything anyone ever said and corrects dates, and Hana, who is competitive about every game including ones that are not games. Aria adores all three and says so only when they are not looking.",
      "Boundaries: she never discusses the secret family recipe, never gives medical advice, and steers away from anything cruel. She does not break character to explain that she is an AI character; if asked directly she answers lightly and moves on."
    ].join("\n\n");

const aria = WaifuConfigSchema.parse({
  ...createRevisionedBase(),
  id: "aria",
  name: "Aria",
  displayName: "Aria",
  botId: "aria-bot",
  modelId: MODEL_ID,
  persona: ARIA_PERSONA,
  availability: { sleep: { enabled: true, start: "23:00", end: "07:00" }, busy: [{ start: "09:00", end: "12:00", reason: "morning shift at the bakery" }] },
  verbosity: "chatty",
  customInstructions: "Never talk about the secret recipe.",
  personaDigest: { voice: "Warm, quick, playful; puns and food talk.", role: "Lightens the mood; loves food talk.", personaHash: "h" }
});
const sibling = (id: string, name: string, voice: string, role: string) =>
  WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id,
    name,
    displayName: name,
    botId: `${id}-bot`,
    modelId: MODEL_ID,
    persona: `${name}: ${voice}`,
    availability: { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [] },
    personaDigest: { voice, role, personaHash: id }
  });
const riko = sibling("riko", "Riko", "Deadpan, dry, answers in drum fills.", "Deflates a hype moment; music talk.");
const noa = sibling("noa", "Noa", "Precise, gentle, corrects dates.", "Recalls what was said before; history, trivia.");
const hana = sibling("hana", "Hana", "Loud, competitive, game-obsessed.", "Turns anything into a challenge; games.");
const WAIFUS = MINIMAL ? [aria, riko] : [aria, riko, noa, hana];
const ROSTER = WAIFUS.filter((waifu) => waifu.id !== "aria");
const CAST = buildCastCards(WAIFUS, new Map(), (waifu) => waifu.id === "aria");
const CAST_IDS = WAIFUS.map((waifu) => waifu.id);
const isWaifu = waifuAuthorMatcher({ authorIds: WAIFUS.map((waifu) => `${waifu.id}-bot`), names: WAIFUS.map((waifu) => waifu.name) });
const PEOPLE = [
  { userId: "kevin", name: "Kevin" },
  { userId: "mina", name: "Mina" },
  { userId: "sora", name: "Sora" }
];
const HUMANS = [
  { authorId: "kevin", authorName: "Kevin" },
  { authorId: "mina", authorName: "Mina" },
  { authorId: "sora", authorName: "Sora" }
];

const guildHarnessInput = (direction?: string): WaifuHarnessInput => ({
  waifu: aria,
  conversation: GUILD,
  roster: ROSTER.map((waifu) => waifu.name),
  serverNickname: "Aria✨",
  place: { kind: "guild", serverName: "Bake Club", channelName: "general" },
  people: PEOPLE,
  emojis: ["<:cake:>", "<a:party:>"],
  tools: waifuTools({ addMemory: true, pickNextWaifuIds: ROSTER.map((waifu) => waifu.id) }),
  activity: () => undefined,
  ...(direction ? { direction } : {})
});
const dmHarnessInput = (): WaifuHarnessInput => ({
  waifu: WaifuConfigSchema.parse({ ...aria, scheduleInPrompt: false, customInstructions: "", verbosity: "terse" }),
  conversation: DM,
  roster: [],
  place: { kind: "dm", userName: "Kevin" },
  people: [PEOPLE[0]!],
  emojis: [],
  tools: [],
  activity: () => undefined
});

const snapshots: MemorySnapshotProvider = {
  selectSnapshot: async () => ({
    ids: ["m1", "m2"],
    lines: [
      "- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)",
      "- Mina: is training for a marathon (event · learned in a private chat · 2 days ago)"
    ]
  }),
  proposeInlineNotes: async () => [],
  markRetrieved: () => undefined
};

const CHAT = [
  "lol that is wild",
  "wait what happened after that?",
  "i just got back from the store and they were completely out of lemons",
  "okay but who is actually bringing the cake on saturday",
  "not me, i have the thing at noon",
  "does anyone remember the name of that podcast",
  "ahaha stop",
  "honestly same",
  "that sounds like a plan, i'm in",
  "can someone send the link again?",
  "brb 5 min",
  "ok back, what did i miss",
  "you did NOT just say that",
  "the oven at my place runs hot so i always take them out early",
  "good morning everyone!!",
  "anyone up for a game later tonight?",
  "that was the best sourdough i've ever had, no joke",
  "ugh mondays",
  "ok that's fair",
  "send pics"
];
const REPLIES = [
  "ooh lemon tarts then!! i'll bring the cake, you bring the good mood",
  "haha okay okay, noted. also the oven thing is so true",
  "wait wait wait, say that again? i was stirring",
  "i'm in!! what time are we thinking",
  "that's a pun waiting to happen and you know it"
];

type RecordedCall = {
  label: string;
  kind: "reply" | "decision" | "compaction";
  spec: CacheUsage;
  realistic: CacheUsage;
  body: WireBody;
  at: number;
  /** Set after the call returns, for reply/decision calls: the epoch the prompt was built on. */
  epoch?: number;
};

function classify(body: WireBody): RecordedCall["kind"] {
  const last = body.messages.at(-1);
  const lastBlock = Array.isArray(last?.content) ? last.content.at(-1) : undefined;
  if (lastBlock?.type === "text" && String(lastBlock.text).startsWith("<compaction_request>")) return "compaction";
  const choice = body.tool_choice as { type?: string; name?: string } | undefined;
  return choice?.type === "tool" ? "decision" : "reply";
}

function marks(prompt: BuiltPrompt): number {
  return prompt.messages.reduce((sum, message) => {
    if (!Array.isArray(message.content)) return sum + (message.cacheControl ? 1 : 0);
    return sum + message.content.filter((block) => "cacheControl" in block && block.cacheControl).length + (message.cacheControl ? 1 : 0);
  }, 0);
}

function decisionEntry(id: string, createdAt: number, messageIds: string[], action: "reply" | "no_reply" = "reply"): OrchestratorDecisionHistoryEntry {
  return {
    id,
    guildId: "100",
    channelId: "200",
    action,
    respondingWaifus: action === "reply" ? [{ waifuId: "aria", delaySeconds: 2 }] : [],
    reasoning: "Kevin spoke and Aria fits.",
    status: "completed",
    waifuMessageIds: [],
    responderOutcomes: action === "reply" ? [{ id: `${id}-o`, waifuId: "aria", source: "orchestrator", status: "sent", messageIds }] : [],
    createdAt: new Date(createdAt).toISOString()
  };
}

class Room {
  readonly clock = { now: BASE_TIME + 30 * 60_000 };
  readonly calls: RecordedCall[] = [];
  readonly warnings: string[] = [];
  readonly channel = new FakeChannel();
  /** Which agent the next request belongs to (set by the turn helpers; groups divergence diagnostics). */
  label = "";
  readonly store: FileContextStore;
  readonly runtime: ContextRuntime;
  readonly compaction: ReturnType<typeof createCompactionService>;
  readonly pipeline: ReturnType<typeof createGatewayModelPipeline>;
  readonly ledger: ReturnType<typeof createUsageLedger>;
  readonly model: ResolvedModel;
  private readonly sims: { spec: AnthropicCacheSim; realistic: AnthropicCacheSim };
  private messageCounter = 0;
  private decisionCounter = 0;
  private responses = 0;

  private constructor(readonly root: string) {
    this.sims = {
      // The spec's three rules only.
      spec: new AnthropicCacheSim({ now: () => this.clock.now }),
      // Plus Sonnet's 1,024-token minimum cacheable prefix (reported, not asserted).
      realistic: new AnthropicCacheSim({ now: () => this.clock.now, minCacheableTokens: 1024 })
    };
    const fetchImpl: typeof fetch = async (_input, init) => this.anthropic(JSON.parse(String(init?.body)) as WireBody);
    const gateway = createGateway({ credentials: { [PROVIDER]: "sk-test" }, fetchImpl });
    this.model = gateway.getCapabilities(PROVIDER, MODEL_ID)!;
    this.ledger = createUsageLedger(root);
    ledgers.push(this.ledger);
    this.pipeline = createGatewayModelPipeline({
      providerId: PROVIDER,
      modelId: MODEL_ID,
      queryRole: "waifu",
      gateway,
      usageLedger: this.ledger,
      logger: { warn: (message: string) => void this.warnings.push(message) }
    });
    const now = () => new Date(this.clock.now);
    this.store = new FileContextStore(new StorageService(root), { now, timeZone: () => "UTC" });
    const logger = quietLogger();
    this.compaction = createCompactionService({ store: this.store, logger, now });
    this.runtime = new ContextRuntime({
      store: this.store,
      snapshots,
      compaction: this.compaction,
      messages: this.channel,
      images: new FakeImageFetcher(),
      settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }), // DEFAULT settings (spec 8.11)
      logger,
      now,
      timeZone: () => "UTC",
      calibrate: emaTokenCalibration
    });
  }

  static async create(): Promise<Room> {
    const root = await makeTempRoot();
    roots.push(root);
    return new Room(root);
  }

  /** The fake Anthropic: caches by the real wire body and answers like the model would. */
  private async anthropic(body: WireBody): Promise<Response> {
    const kind = classify(body);
    const spec = this.sims.spec.process(body, this.label);
    const realistic = this.sims.realistic.process(body, this.label);
    this.calls.push({ label: this.label, kind, spec, realistic, body, at: this.clock.now });
    this.responses += 1;
    const content: WireBlock[] =
      kind === "compaction"
        ? [{ type: "text", text: "I remember: Kevin is allergic to peanuts, Mina is training for a marathon, and we planned a bake sale on Saturday. Kevin keeps teasing me about puns; I tease back. Open question: who brings the cake." }]
        : kind === "decision"
          ? [{ type: "tool_use", id: `toolu_${this.responses}`, name: ORCHESTRATOR_TOOL_NAME, input: { action: "reply", respondingWaifus: [{ waifuId: "aria", delaySeconds: 2 }], reasoning: "A human spoke; Aria fits." } }]
          : [{ type: "text", text: REPLIES[this.responses % REPLIES.length]! }];
    return new Response(
      JSON.stringify({
        id: `msg_${this.responses}`,
        type: "message",
        role: "assistant",
        model: MODEL_ID,
        content,
        stop_reason: kind === "decision" ? "tool_use" : "end_turn",
        usage: wireUsage(spec, 40)
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  // -- the room ----------------------------------------------------------------------------

  /** Humans post `count` messages spread over `spreadMs`; the clock ends after the last one. */
  humans(count: number, spreadMs: number): void {
    const start = this.clock.now;
    for (let i = 0; i < count; i += 1) {
      const who = HUMANS[(this.messageCounter + i) % HUMANS.length]!;
      const content = CHAT[(this.messageCounter + i * 7) % CHAT.length]!;
      this.channel.post({ ...who, content }, start + Math.floor((i * spreadMs) / Math.max(1, count)));
    }
    this.messageCounter += count;
    this.clock.now = start + spreadMs + 1_000;
  }

  // -- agents -------------------------------------------------------------------------------

  async waifuTurn(o: { conversation?: ConversationRef; direction?: string; dm?: boolean } = {}): Promise<{ p: PreparedContext; calls: RecordedCall[] }> {
    const conversation = o.conversation ?? GUILD;
    const input = o.dm ? dmHarnessInput() : guildHarnessInput(o.direction);
    const harness = createWaifuHarness(input);
    const attribution = { agentId: "waifu-aria", waifuId: "aria", conversationKey: conversationKey(conversation), ...(o.dm ? {} : { guildId: "100", channelId: "200" }) };
    this.label = o.dm ? "waifu:dm" : "waifu";
    const before = this.calls.length;
    const p = await this.runtime.prepare({
      conversation,
      agent: ARIA_AGENT,
      model: this.model,
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: harness,
      renderToolTurnsAsText: true,
      participantIds: input.people.flatMap((person) => (person.userId ? [person.userId] : [])),
      params: {},
      summarize: contextSummarizer(this.pipeline, { toolChoice: "auto", params: {}, attribution }),
      memoryLimit: 12
    });
    expect(marks(p.prompt), "A, B, C_prev and C at most").toBeLessThanOrEqual(4);
    this.label = o.dm ? "waifu:dm" : "waifu";
    this.clock.now += 2_000;
    const result = await this.runtime.call(p, (prompt) =>
      this.pipeline.generateWaifu({
        modelId: MODEL_ID,
        prompt,
        params: {},
        stopSequences: waifuStopSequences(input.waifu, input.serverNickname),
        availableWaifuIds: input.tools.some((tool) => tool.name === "PickNextWaifu") ? ROSTER.map((waifu) => waifu.id) : [],
        attribution: { ...attribution, purpose: "waifu_reply" }
      })
    );
    const issued = this.calls.slice(before);
    const own = issued.filter((call) => call.kind === "reply").at(-1);
    if (own) own.epoch = p.state.epoch;
    await this.runtime.commit(p, {
      notes: o.direction ? [{ kind: "direction", text: o.direction }] : [],
      ...(result.usage ? { usage: result.usage } : {}),
      sentPrompt: p.prompt,
      modelKey: p.modelKey
    });
    this.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: result.content }, this.clock.now);
    await this.settle(conversation, ARIA_AGENT);
    return { p, calls: issued };
  }

  async orchestratorTurn(): Promise<{ p: PreparedContext; usage: Usage | undefined; calls: RecordedCall[] }> {
    const turn: OrchestratorTurn = { replyRequired: false, directiveCount: 3, directiveCooldown: 3, pastDecisions: [] };
    const renderer = createOrchestratorRenderer({
      mode: "model",
      cast: CAST,
      availableWaifuIds: CAST_IDS,
      place: orchestratorPlace("Bake Club", "general", "200"),
      pausePlanning: true,
      ownerPolicy: "Keep it PG. Riko never talks about her ex.",
      turn,
      conversation: { guildId: "100", channelId: "200" },
      isWaifu
    });
    const attribution = { agentId: "orchestrator", guildId: "100", channelId: "200", conversationKey: GUILD_KEY };
    this.label = "orchestrator";
    const before = this.calls.length;
    const p = await this.runtime.prepare({
      conversation: GUILD,
      agent: ORCH_AGENT,
      model: this.model,
      backfillCap: 20,
      selfAuthorIds: [],
      render: renderer,
      renderToolTurnsAsText: true,
      params: {},
      summarize: contextSummarizer(this.pipeline, { toolChoice: { name: ORCHESTRATOR_TOOL_NAME }, temperature: 0.2, params: {}, attribution })
    });
    expect(marks(p.prompt)).toBeLessThanOrEqual(4);
    this.label = "orchestrator";
    this.clock.now += 1_000;
    let usage: Usage | undefined;
    await this.runtime.call(p, (prompt) =>
      this.pipeline.decideOrchestrator!({
        modelId: MODEL_ID,
        messages: [],
        prompt,
        transcript: p.transcript,
        availableWaifuIds: CAST_IDS,
        temperature: 0.2,
        params: {},
        attribution: { ...attribution, purpose: "orchestrator" },
        onUsage: (reported) => {
          usage = reported;
        }
      })
    );
    const issued = this.calls.slice(before);
    const own = issued.filter((call) => call.kind === "decision").at(-1);
    if (own) own.epoch = p.state.epoch;
    return { p, usage, calls: issued };
  }

  /** As ChannelRunner.commitDecision: refs of what was produced, then the frozen decision note. */
  async commitDecision(p: PreparedContext, usage: Usage | undefined, producedMessageIds: string[]): Promise<void> {
    this.decisionCounter += 1;
    const entry = decisionEntry(`d${this.decisionCounter}`, this.clock.now, producedMessageIds);
    const refs = await this.runtime.assignRefs(p.conversation, producedMessageIds);
    const note = decisionNoteFor(entry, (id) => refs.get(id));
    await this.runtime.commit(p, { notes: note ? [note] : [], ...(usage ? { usage } : {}), modelKey: p.modelKey });
    await this.settle(p.conversation, ORCH_AGENT);
  }

  /** One director + waifu cycle on the guild channel: decide, reply, then record the outcome. */
  async cycle(o: { direction?: string } = {}): Promise<{ orchestrator: RecordedCall[]; waifu: RecordedCall[] }> {
    const orchestrator = await this.orchestratorTurn();
    this.clock.now += 1_000;
    const waifu = await this.waifuTurn({ direction: o.direction });
    const reply = this.channel.messages.at(-1)!;
    this.clock.now += 1_000;
    await this.commitDecision(orchestrator.p, orchestrator.usage, [reply.id]);
    return { orchestrator: orchestrator.calls, waifu: waifu.calls };
  }

  async settle(conversation: ConversationRef, agent: typeof ARIA_AGENT | typeof ORCH_AGENT): Promise<void> {
    await this.compaction.inFlight(conversationKey(conversation), agent)?.catch(() => undefined);
  }

  /** Edits the guild ledger under its lock (a Phase 5 edit/delete event or a state change). */
  async editLedger(fn: (ledger: { entries: Record<string, import("../../src/shared/schemas/context.js").LedgerEntry>; events: unknown[]; nextSeq: number }) => void): Promise<void> {
    const storage = new StorageService(this.root);
    await storage.updateRevisionedJson({
      resourceKey: `ledger:${GUILD_KEY}`,
      relativePath: conversationLedgerPath(GUILD_KEY),
      schema: ConversationLedgerSchema,
      fallback: await this.store.loadLedger(GUILD_KEY),
      transform: (ledger) => {
        const next = structuredClone(ledger);
        fn(next as never);
        return next;
      }
    });
  }

  async ledgerLines(): Promise<Array<ReturnType<typeof UsageLedgerEntrySchema.parse>>> {
    await this.ledger.flush();
    const day = new Date().toISOString().slice(0, 10);
    const text = await readFile(path.join(this.root, "user", "usage", `${day}.jsonl`), "utf8").catch(() => "");
    return text.split("\n").filter(Boolean).map((line) => UsageLedgerEntrySchema.parse(JSON.parse(line)));
  }

  // -- results ------------------------------------------------------------------------------

  select(label: string, kinds: RecordedCall["kind"][] = ["reply", "decision"]): RecordedCall[] {
    return this.calls.filter((call) => call.label === label && kinds.includes(call.kind));
  }

  /** Waifu targets count every call she makes (summarize calls included); the orchestrator's exclude compaction. */
  ratio(label: string, which: "spec" | "realistic" = "spec", kinds: RecordedCall["kind"][] = label.startsWith("waifu") ? ["reply", "compaction"] : ["decision"]): number {
    return readRatio(tally(this.select(label, kinds).map((call) => call[which])));
  }
}

function report(name: string, room: Room, labels: string[]): void {
  const lines = labels.map((label) => {
    const all = room.calls.filter((call) => call.label === label);
    const main = all.filter((call) => call.kind !== "compaction");
    const compaction = all.filter((call) => call.kind === "compaction");
    const t = tally(main.map((call) => call.spec));
    const withCompaction = tally(all.map((call) => call.spec));
    const sizes = main.map((call) => call.spec.total);
    return (
      `${name} · ${label}: ratio ${readRatio(t).toFixed(3)} over ${t.calls} calls (excluding ${compaction.length} compaction calls; ` +
      `including them ${readRatio(withCompaction).toFixed(3)}) · min-1024-token model ${readRatio(tally(main.map((call) => call.realistic))).toFixed(3)} · ` +
      `prompt ${Math.min(...sizes)}–${Math.max(...sizes)} tokens`
    );
  });
  console.info(`[cache-hit]\n${lines.join("\n")}`);
  if (process.env["CACHE_HIT_TRACE"] === "1") {
    const rows = room.calls.map((call, index) => {
      const u = call.spec;
      return `${String(index).padStart(3)} ${call.label.padEnd(12)} ${call.kind.padEnd(10)} epoch ${call.epoch ?? "-"} total ${String(u.total).padStart(5)} read ${String(u.read).padStart(5)} write ${String(u.write).padStart(5)} uncached ${String(u.uncached).padStart(5)} blocks ${String(u.blocks).padStart(4)} bp [${u.breakpoints.join(",")}] hit ${u.hitIndex ?? "-"} via ${u.hitBreakpoint ?? "-"} diverged ${u.divergedAt ?? "-"}`;
    });
    console.info(`[cache-hit trace ${name}]\n${rows.join("\n")}`);
  }
}

/**
 * Prefix invariant on the wire: a request's first divergence from the previous request of the same
 * agent starts after that previous request's last breakpoint (everything cached is unchanged).
 * Skipped across an epoch change and for compaction requests that deliberately change tool_choice.
 */
function expectWirePrefixStable(room: Room, label: string): void {
  const own = room.select(label, ["reply", "decision"]);
  for (let i = 1; i < own.length; i += 1) {
    const previous = own[i - 1]!;
    const current = own[i]!;
    if (current.epoch !== previous.epoch) continue;
    const lastBreakpoint = previous.spec.breakpoints.at(-1)!;
    if (current.spec.divergedAt !== undefined) {
      expect(current.spec.divergedAt, `${label} call ${i} diverged from the previous request at block ${current.spec.divergedAt}: ${current.spec.divergedText}`).toBeGreaterThan(lastBreakpoint);
    }
  }
}

/**
 * Fixture-independent efficiency check: within an epoch (and the TTL) every request reads at least
 * everything the previous request of the same agent cached through its last breakpoint (C).
 */
function expectFullPrefixReuse(room: Room, label: string): void {
  const own = room.select(label, ["reply", "decision"]);
  for (let i = 1; i < own.length; i += 1) {
    const previous = own[i - 1]!;
    const current = own[i]!;
    if (current.epoch !== previous.epoch || current.at - previous.at >= CACHE_TTL_MS) continue;
    expect(current.spec.read, `${label} call ${i} read less than the previous request cached`).toBeGreaterThanOrEqual(previous.spec.read + previous.spec.write);
  }
}

function expectBreakpointsHit(room: Room, label: string): void {
  for (const call of room.select(label, ["reply", "decision"]).slice(1)) {
    // After the first call every request must read at least breakpoint A (system + tools).
    expect(call.spec.read, `${label} read nothing at ${new Date(call.at).toISOString()}`).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Scenarios

describe("cache-hit simulation (default settings, real context engine + gateway pipeline)", () => {
  it("quiet room: waifu and orchestrator both read >= 0.8 of their input from the cache", { timeout: 60_000 }, async () => {
    const room = await Room.create();
    for (let i = 0; i < 24; i += 1) {
      room.humans(i % 3 === 0 ? 2 : 1, 20_000);
      await room.cycle({ direction: i % 2 === 0 ? "(spotlight) answer Kevin" : undefined });
      room.clock.now += 100_000; // turns about two minutes apart: inside the 5-minute TTL
    }
    report("quiet room", room, ["waifu", "orchestrator"]);
    expect(room.warnings.filter((w) => w.includes("cache_ignored"))).toEqual([]);
    expect(room.calls.some((call) => call.kind === "compaction")).toBe(false);
    expectWirePrefixStable(room, "waifu");
    expectWirePrefixStable(room, "orchestrator");
    expectBreakpointsHit(room, "waifu");
    expectBreakpointsHit(room, "orchestrator");
    expect(room.ratio("waifu")).toBeGreaterThanOrEqual(0.8);
    expect(room.ratio("orchestrator")).toBeGreaterThanOrEqual(0.8);
    // Exactly one usage-ledger line per model call.
    const lines = await room.ledgerLines();
    expect(lines).toHaveLength(room.calls.length);
    expect(lines.every((line) => line.status === "ok" && line.usageKnown)).toBe(true);
  });

  describe("busy room (30+ messages between a waifu's turns)", () => {
    // 20 turns, 30-38 new messages before each: more than LOOKBACK_BLOCKS blocks, so only C_prev
    // can reach the previous request's cache entry. With default settings 700 messages compact
    // several times (maxMessages 150). One run is shared by the tests below.
    const BURST = [34, 31, 38, 33, 36, 30, 35, 32, 37, 31, 34, 33, 36, 30, 35, 32, 38, 31, 34, 33];
    let shared: Promise<Room> | undefined;
    const busyRoom = () =>
      (shared ??= (async () => {
        const room = await Room.create();
        for (const count of BURST) {
          room.humans(count, 150_000);
          await room.cycle({ direction: "(spotlight) answer Kevin" });
          room.clock.now += 20_000;
        }
        report("busy room", room, ["waifu", "orchestrator"]);
        return room;
      })());

    it("every request reads everything the previous one cached (C_prev bridges the 20-block lookback)", { timeout: 120_000 }, async () => {
      const room = await busyRoom();
      expect(BURST.every((count) => count > LOOKBACK_BLOCKS)).toBe(true);
      for (const label of ["waifu", "orchestrator"]) {
        expectWirePrefixStable(room, label);
        expectFullPrefixReuse(room, label);
        expectBreakpointsHit(room, label);
      }
      const compactions = room.calls.filter((call) => call.kind === "compaction");
      expect(compactions.length).toBeGreaterThan(0);
      const lines = await room.ledgerLines();
      expect(lines).toHaveLength(room.calls.length);
      expect(lines.filter((line) => line.purpose === "compaction")).toHaveLength(compactions.length);
    });

    // Busy-room target is 0.75 (spec 8.11.1): ~35 genuinely new messages are
    // 17-19% of each prompt and can never be cache reads, so 0.8 is not reachable by construction
    // with small static prefixes. Prefix reuse itself is asserted exactly by the wire-level test above.
    it("waifu: cache-read ratio >= 0.75", { timeout: 120_000 }, async () => {
      expect((await busyRoom()).ratio("waifu")).toBeGreaterThanOrEqual(0.75);
    });

    it("orchestrator: cache-read ratio >= 0.75", { timeout: 120_000 }, async () => {
      expect((await busyRoom()).ratio("orchestrator")).toBeGreaterThanOrEqual(0.75);
    });
  });

  it("DM: a private chat reads >= 0.8 (driving prepare with a dm conversation; the DM runner is Phase 5)", { timeout: 60_000 }, async () => {
    const room = await Room.create();
    for (let i = 0; i < 24; i += 1) {
      room.humans(i % 4 === 0 ? 2 : 1, 15_000);
      await room.waifuTurn({ conversation: DM, dm: true });
      room.clock.now += 80_000;
    }
    report("DM", room, ["waifu:dm"]);
    const first = room.select("waifu:dm")[0]!;
    expect(first.body.tools).toBeUndefined(); // no tools in a DM
    expectWirePrefixStable(room, "waifu:dm");
    expectBreakpointsHit(room, "waifu:dm");
    expect(room.ratio("waifu:dm")).toBeGreaterThanOrEqual(0.8);
    const lines = await room.ledgerLines();
    expect(lines).toHaveLength(room.calls.length);
    expect(new Set(lines.map((line) => line.conversationKey))).toEqual(new Set([conversationKey(DM)]));
  });

  it("compaction: the request reuses her cached prefix, the next epoch re-reads the system prompt, and hits recover", { timeout: 120_000 }, async () => {
    const room = await Room.create();
    for (let i = 0; i < 8; i += 1) {
      room.humans(2, 20_000);
      await room.cycle();
      room.clock.now += 100_000;
    }
    const replyBefore = room.select("waifu").at(-1)!;
    const decisionBefore = room.select("orchestrator").at(-1)!;
    expect(room.calls.some((call) => call.kind === "compaction")).toBe(false);

    // A burst past maxMessages (150): both contexts compact inside their next prepare.
    room.humans(160, 120_000);
    const burst = await room.cycle();
    const waifuCompaction = burst.waifu.find((call) => call.kind === "compaction")!;
    const orchestratorCompaction = burst.orchestrator.find((call) => call.kind === "compaction")!;
    expect(waifuCompaction).toBeDefined();
    expect(orchestratorCompaction).toBeDefined();
    const state = await room.store.load(GUILD_KEY, ARIA_AGENT);
    expect(state.lastCompaction).toMatchObject({ trigger: "messages", ok: true });
    expect(state.epoch).toBe(1);

    // Waifu: same tools, tool choice, thinking config and system as her reply call, so the
    // prefix she cached last turn is read (spec 8.9: changing any of them invalidates it).
    expect(waifuCompaction.body.tools).toEqual(replyBefore.body.tools);
    expect(waifuCompaction.body.tool_choice).toEqual(replyBefore.body.tool_choice);
    expect(waifuCompaction.body.thinking).toEqual(replyBefore.body.thinking);
    expect(waifuCompaction.body.system).toEqual(replyBefore.body.system);
    expect(waifuCompaction.spec.read).toBeGreaterThanOrEqual(replyBefore.spec.read + replyBefore.spec.write);
    expect(waifuCompaction.spec.divergedAt ?? Infinity).toBeGreaterThan(replyBefore.spec.breakpoints.at(-1)!);

    // Orchestrator: its reply call forces the decision tool, so summarizing uses tool_choice
    // `none` — Anthropic drops the cached messages but tools + system (breakpoint A) still hit.
    expect(orchestratorCompaction.body.tool_choice).toEqual({ type: "none" });
    expect(orchestratorCompaction.body.tools).toEqual(decisionBefore.body.tools);
    expect(orchestratorCompaction.spec.read).toBeGreaterThan(0);
    expect(orchestratorCompaction.spec.read).toBeLessThan(decisionBefore.spec.read);

    // The first waifu request on the new epoch still reads the static system prompt (A); the
    // header and kept window are rewritten once; two turns later she is back to full hits.
    const afterCompaction = room.select("waifu").at(-1)!;
    expect(afterCompaction.epoch).toBe(1);
    expect(afterCompaction.spec.read).toBeGreaterThan(0);
    expect(afterCompaction.spec.write).toBeGreaterThan(afterCompaction.spec.read * 0.1); // header + kept window rewritten once
    const recovered: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      room.clock.now += 100_000;
      room.humans(2, 20_000);
      const next = await room.cycle();
      recovered.push(next.waifu[0]!.spec.read / next.waifu[0]!.spec.total);
    }
    console.info(`[cache-hit] compaction · waifu: compaction call read ${waifuCompaction.spec.read}/${waifuCompaction.spec.total} tokens (prefix of her previous request: ${replyBefore.spec.read + replyBefore.spec.write}); ` +
      `orchestrator compaction read ${orchestratorCompaction.spec.read}/${orchestratorCompaction.spec.total}; ` +
      `first request after: ${(afterCompaction.spec.read / afterCompaction.spec.total).toFixed(3)}; then ${recovered.map((r) => r.toFixed(3)).join(", ")}`);
    expect(recovered.slice(1).every((ratio) => ratio >= 0.8)).toBe(true);
    expectWirePrefixStable(room, "waifu");
    expectWirePrefixStable(room, "orchestrator");
    const lines = await room.ledgerLines();
    expect(lines).toHaveLength(room.calls.length);
    expect(lines.filter((line) => line.purpose === "compaction")).toHaveLength(2);
  });

  it("deletion: an edit event and a deleted message leave every cached block untouched", { timeout: 60_000 }, async () => {
    const room = await Room.create();
    for (let i = 0; i < 6; i += 1) {
      room.humans(2, 20_000);
      await room.cycle();
      room.clock.now += 100_000;
    }
    const victim = room.channel.messages[2]!;
    const edited = room.channel.messages[4]!;
    const beforeWaifu = room.select("waifu").at(-1)!;
    // Phase 5 events: the engine converts `edit` events into append-only edit notes; `delete`
    // events and the `deleted` state are audit-only (the frozen body stays in the transcript).
    await room.editLedger((ledger) => {
      ledger.entries[victim.id] = { ...ledger.entries[victim.id]!, state: "deleted" };
      const seq = ledger.entries[edited.id]!.seq;
      const newest = Math.max(...Object.values(ledger.entries).map((entry) => entry.seq));
      ledger.events.push(
        { kind: "delete", seq: 1, at: new Date(room.clock.now).toISOString(), messageId: victim.id, anchorSeq: newest },
        { kind: "edit", seq: 2, at: new Date(room.clock.now).toISOString(), messageId: edited.id, anchorSeq: newest, authorId: edited.authorId, text: "edited: actually saturday works", sealed: false }
      );
      void seq;
    });
    for (let i = 0; i < 6; i += 1) {
      room.humans(2, 20_000);
      await room.cycle();
      room.clock.now += 100_000;
    }
    const turns = room.select("waifu");
    const afterDeletion = turns[turns.indexOf(beforeWaifu) + 1]!;
    expect(afterDeletion.spec.read).toBeGreaterThanOrEqual(beforeWaifu.spec.read + beforeWaifu.spec.write);
    expect(afterDeletion.spec.divergedAt ?? Infinity).toBeGreaterThan(beforeWaifu.spec.breakpoints.at(-1)!);
    const state = await room.store.load(GUILD_KEY, ARIA_AGENT);
    expect(state.notes.filter((note) => note.kind === "edit")).toHaveLength(1);
    expectWirePrefixStable(room, "waifu");
    expectWirePrefixStable(room, "orchestrator");
    report("deletion", room, ["waifu", "orchestrator"]);
    expect(room.ratio("waifu")).toBeGreaterThanOrEqual(0.8);
    expect(room.ratio("orchestrator")).toBeGreaterThanOrEqual(0.8);
  });

  it("a gap longer than the TTL is one full miss for each agent, then hits resume", { timeout: 60_000 }, async () => {
    const room = await Room.create();
    for (let i = 0; i < 4; i += 1) {
      room.humans(1, 5_000);
      await room.cycle();
      room.clock.now += 60_000;
    }
    room.clock.now += CACHE_TTL_MS + 30_000;
    room.humans(1, 5_000);
    const stale = await room.cycle();
    expect(stale.waifu[0]!.spec.read).toBe(0);
    expect(stale.orchestrator[0]!.spec.read).toBe(0);
    room.clock.now += 60_000;
    room.humans(1, 5_000);
    const warm = await room.cycle();
    expect(warm.waifu[0]!.spec.read / warm.waifu[0]!.spec.total).toBeGreaterThanOrEqual(0.8);
    expect(warm.orchestrator[0]!.spec.read / warm.orchestrator[0]!.spec.total).toBeGreaterThanOrEqual(0.8);
  });
});
