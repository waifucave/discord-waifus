// Orchestrator harness (spec 8.7): the director's RoleRenderer over the real ContextRuntime, its
// golden prompts, prefix stability as decision notes append, final-only decision notes, the
// JSON-schema text-line fallback, reply-required / budget state, and B28 owner policy.
import type { ChatMessage, TextBlock } from "@waifucave/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { stripCacheMarkers } from "../src/orchestration/context/builder.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { NoopCompaction, type BuiltPrompt, type PreparedContext } from "../src/orchestration/context/types.js";
import { forceReplyDecision } from "../src/orchestration/deterministicOrchestrator.js";
import {
  type OrchestratorTurn,
  assessOrchestratorTurn,
  buildCastCards,
  createOrchestratorRenderer,
  ledgerToContextMessages,
  orchestratorHeader,
  orchestratorPlace,
  orchestratorSystemPrompt,
  orchestratorTail,
  orchestratorTools,
  waifuAuthorMatcher
} from "../src/orchestration/orchestratorHarness.js";
import { decisionNoteFor } from "../src/orchestration/pipeline/timeline.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { ContextState, LedgerEntry } from "../src/shared/schemas/context.js";
import { WaifuConfigSchema, type OrchestratorDecisionHistoryEntry } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, fakeModel, noSnapshots, quietLogger } from "./contextFixtures.js";
import { serializePrompt } from "./golden/serialize.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const ORCHESTRATOR = { kind: "orchestrator" } as const;

const aria = WaifuConfigSchema.parse({
  ...createRevisionedBase(),
  id: "aria",
  name: "Aria",
  displayName: "Aria",
  botId: "aria-bot",
  modelId: "claude-test",
  persona: "Cheerful baker who over-explains recipes.",
  personaDigest: { voice: "Warm, quick, a little breathless.", role: "Food, comfort, cheering people up.", personaHash: "h1" },
  availability: { sleep: { enabled: true, start: "23:00", end: "07:00" }, busy: [] }
});
const riko = WaifuConfigSchema.parse({
  ...createRevisionedBase(),
  id: "riko",
  name: "Riko",
  displayName: "Riko",
  botId: "riko-bot",
  modelId: "deepseek-test",
  persona: "Deadpan drummer.",
  availability: { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [{ start: "14:00", end: "16:00", reason: "band practice" }] }
});
const CAST = buildCastCards([aria, riko], new Map([["riko", "rikorin"]]), (waifu) => waifu.id === "aria");
const IDS = ["aria", "riko"];
const isWaifu = waifuAuthorMatcher({ authorIds: ["aria-bot", "riko-bot"], names: ["Aria", "Riko"] });

function turn(o: Partial<OrchestratorTurn> = {}): OrchestratorTurn {
  return { replyRequired: false, directiveCount: 3, directiveCooldown: 3, pastDecisions: [], ...o };
}

function renderer(o: { turn?: OrchestratorTurn; ownerPolicy?: string; mode?: "model" | "deterministic" | "one-shot" } = {}) {
  return createOrchestratorRenderer({
    mode: o.mode ?? "model",
    cast: CAST,
    availableWaifuIds: IDS,
    place: orchestratorPlace("Bake Club", "general", "200"),
    pausePlanning: true,
    ownerPolicy: o.ownerPolicy ?? "Keep it PG. Riko never talks about her ex.",
    turn: o.turn ?? turn(),
    conversation: { guildId: "100", channelId: "200" },
    isWaifu
  });
}

async function harness() {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 5 * 60_000 };
  const storage = new StorageService(root);
  const store = new FileContextStore(storage, { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: NoopCompaction,
    messages: channel,
    images: new FakeImageFetcher(),
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC"
  });
  const prepare = (o: { turn?: OrchestratorTurn; text?: boolean } = {}) =>
    runtime.prepare({
      conversation: GUILD,
      agent: ORCHESTRATOR,
      model: fakeModel({ images: false }),
      backfillCap: 20,
      selfAuthorIds: [],
      render: renderer({ turn: o.turn }),
      ...(o.text ? { renderToolTurnsAsText: true } : {})
    });
  return { runtime, channel, clock, prepare };
}

function decision(id: string, o: Partial<OrchestratorDecisionHistoryEntry> = {}): OrchestratorDecisionHistoryEntry {
  return {
    id,
    guildId: "100",
    channelId: "200",
    action: "reply",
    respondingWaifus: [{ waifuId: "aria", delaySeconds: 2 }],
    reasoning: "Kevin asked Aria directly.",
    status: "completed",
    waifuMessageIds: [],
    responderOutcomes: [{ id: "o1", waifuId: "aria", source: "orchestrator", status: "sent", messageIds: ["x"] }],
    createdAt: new Date(BASE_TIME).toISOString(),
    ...o
  };
}

async function commitFinal(runtime: ContextRuntime, p: PreparedContext, entry: OrchestratorDecisionHistoryEntry) {
  const note = decisionNoteFor(entry);
  await runtime.commit(p, { notes: note ? [note] : [], modelKey: p.modelKey });
}

/** Messages with cache markers stripped and the ephemeral tail block removed. */
function withoutTail(prompt: BuiltPrompt): ChatMessage[] {
  const messages = stripCacheMarkers(prompt.messages);
  const last = messages[messages.length - 1]!;
  if (Array.isArray(last.content) && last.role === "user") {
    const blocks = [...last.content] as TextBlock[];
    expect(blocks[blocks.length - 1]!.text).toBe(prompt.debug.tail);
    blocks.pop();
    if (blocks.length === 0) messages.pop();
    else messages[messages.length - 1] = { ...last, content: blocks } as ChatMessage;
  }
  return messages;
}

/** Every block of `before` (tail removed) is unchanged at the start of `after`. */
function expectPrefix(before: BuiltPrompt, after: BuiltPrompt): void {
  const a = withoutTail(before);
  const b = stripCacheMarkers(after.messages);
  for (let i = 0; i < a.length; i += 1) {
    const prev = a[i]!;
    const next = b[i]!;
    expect(next.role, `message ${i}`).toBe(prev.role);
    if (i < a.length - 1 || !Array.isArray(prev.content)) {
      expect(next, `message ${i}`).toEqual(prev);
    } else {
      // The last message may have grown (more blocks in the same user/assistant turn).
      expect((next.content as unknown[]).slice(0, prev.content.length), `message ${i}`).toEqual(prev.content);
    }
  }
}

describe("orchestrator system prompt (A)", () => {
  it("states the six enforced policies, static casting cards, and the owner policy in model mode only", () => {
    const model = renderer({ mode: "model" }).system();
    for (const rule of ["1. Addressed means answered", "2. Humans present means a voice", "3. Cast alone gets one beat", "4. Pauses scale with the cold", "5. Directives are goals, and budgeted", "6. Images go to native viewers"]) {
      expect(model).toContain(rule);
    }
    expect(model).toContain("<waifu>\nid: aria · Aria · sees images natively\nVoice: Warm, quick, a little breathless.\nCast her when: Food, comfort, cheering people up.\n</waifu>");
    expect(model).toContain('id: riko · Riko · appears in this server as "rikorin"\nAbout: Deadpan drummer.');
    // B28: the owner's custom orchestrator.prompt reaches model mode as <owner_policy>.
    expect(model).toMatch(/<owner_policy>\nKeep it PG\. Riko never talks about her ex\.\n<\/owner_policy>$/);
    expect(renderer({ mode: "deterministic" }).system()).not.toContain("<owner_policy>");
    expect(renderer({ mode: "model", ownerPolicy: "   " }).system()).not.toContain("<owner_policy>");
    // Static: no time, availability or per-pass state.
    expect(model).not.toMatch(/likely asleep|busy: band practice|Reply required|Directive budget|\d\d:\d\d \(/);
  });

  it("gates the pause-length detail on promptSections.pausePlanning", () => {
    const withDetail = orchestratorSystemPrompt({ cast: CAST, pausePlanning: true });
    const without = orchestratorSystemPrompt({ cast: CAST, pausePlanning: false });
    expect(withDetail).toContain("3600s or more");
    expect(without).not.toContain("3600s or more");
    expect(without).toContain("4. Pauses scale with the cold.");
  });

  it("keeps the tool schema identical whatever the per-pass state", () => {
    const a = renderer({ turn: turn() }).tools();
    const b = renderer({ turn: turn({ replyRequired: true, directiveCount: 0 }) }).tools();
    expect(b).toEqual(a);
    expect(a).toEqual(orchestratorTools(IDS));
    expect(JSON.stringify(a)).toContain('"enum":["reply","no_reply"]');
  });
});

describe("orchestrator header (B) and tail", () => {
  const state = {
    epochStartedAt: new Date(BASE_TIME).toISOString(),
    timeZone: "UTC",
    summary: "Kevin and Aria planned a bake sale."
  } as ContextState;

  it("renders the summary, a roster availability snapshot at epoch start, and the place", () => {
    expect(orchestratorHeader({ cast: CAST, place: orchestratorPlace("Bake Club", "general", "200") }, state)).toBe(
      [
        "<conversation_summary>\nKevin and Aria planned a bake sale.\n</conversation_summary>",
        "<roster>\nAt the start of this context (Sat 24 Oct 2026 14:00):",
        "- aria (Aria): awake",
        "- riko (Riko): awake · busy: band practice\n</roster>",
        "<place>Bake Club › #general</place>"
      ].join("\n")
    );
  });

  it("states reply-required, the wake (B8) and an open/closed directive budget; ends with the call", () => {
    const now = new Date(BASE_TIME + 9.5 * 3_600_000); // 23:30 UTC: Aria is asleep
    const closed = orchestratorTail({
      cast: CAST,
      turn: turn({ replyRequired: true, directiveCount: 1, wake: { scheduledSeconds: 420, wakePlan: "have Riko pitch the gig", decidedAt: new Date(BASE_TIME).toISOString() } }),
      assessment: assessOrchestratorTurn([], { directiveCount: 1, directiveCooldown: 3, pastDecisions: [] }, now),
      now,
      timeZone: "UTC"
    });
    expect(closed).toContain("Now: Sat 24 Oct 2026 23:30.");
    expect(closed).toContain("- aria (Aria): likely asleep (sleep 23:00–07:00)");
    expect(closed).toContain('<wake>This pass is the wake you scheduled at 14:00: the 420s pause has elapsed with no new human message. Your plan was: "have Riko pitch the gig".');
    expect(closed).toContain('Reply required: yes. This is a manual /run: choose action "reply" with at least one waifu.');
    expect(closed).toContain("Directive budget: closed for 2 more decisions; directives are stripped, so leave directive null.");
    expect(closed).toMatch(/<\/status>\nCall orchestrator_decision\.$/);

    const open = orchestratorTail({ cast: CAST, turn: turn(), assessment: assessOrchestratorTurn([], turn(), now), now, timeZone: "UTC" });
    expect(open).toContain("Reply required: no.");
    expect(open).toContain("Directive budget: open.");
    expect(open).not.toContain("<wake>");
  });

  it("derives runtime notices from the transcript: a loop opens the budget the guardrail enforces", () => {
    const entries: LedgerEntry[] = [0, 1, 2, 3].map((i) => ({
      id: `e${i}`,
      seq: i + 1,
      authorId: i % 2 === 0 ? "aria-bot" : "riko-bot",
      authorName: i % 2 === 0 ? "Aria" : "Riko",
      authorIsBot: true,
      at: new Date(BASE_TIME + i * 120_000).toISOString(),
      kind: "default",
      body: i % 2 === 0 ? "volcano cake recipe needs molten chocolate centre" : "garage band rehearsal moved to thursday evening",
      images: [],
      state: "live",
      sealed: true
    }));
    const messages = ledgerToContextMessages(entries, { guildId: "100", channelId: "200", isWaifu });
    expect(messages.map((m) => m.authorKind)).toEqual(["waifu", "waifu", "waifu", "waifu"]);
    const assessment = assessOrchestratorTurn(messages, { directiveCount: 0, directiveCooldown: 3, pastDecisions: [] }, new Date(BASE_TIME + 600_000));
    expect(assessment.loop.suspected).toBe(true);
    expect(assessment.directiveBudgetOpen).toBe(true);
    expect(assessment.humanActiveNow).toBe(false);
    expect(assessment.runtimeNotice).toContain("same-speaker pairs");
  });

  it("joins a waifu's quick consecutive chunks and keeps other bots as non-human users (B10)", () => {
    const base = { kind: "default" as const, images: [], state: "live" as const, sealed: true };
    const entries: LedgerEntry[] = [
      { ...base, id: "1", seq: 1, authorId: "kev", authorName: "Kevin", authorIsBot: false, at: new Date(BASE_TIME).toISOString(), body: "hi" },
      { ...base, id: "2", seq: 2, authorId: "aria-bot", authorName: "Aria", authorIsBot: true, at: new Date(BASE_TIME + 1_000).toISOString(), body: "hey!" },
      { ...base, id: "3", seq: 3, authorId: "aria-bot", authorName: "Aria", authorIsBot: true, at: new Date(BASE_TIME + 3_000).toISOString(), body: "cake?" },
      { ...base, id: "4", seq: 4, authorId: "dyno", authorName: "Dyno", authorIsBot: true, at: new Date(BASE_TIME + 4_000).toISOString(), body: "level up", replyToId: "1" }
    ];
    const messages = ledgerToContextMessages(entries, { channelId: "200", isWaifu });
    expect(messages.map((m) => [m.authorKind, m.authorBot ?? false, m.content])).toEqual([
      ["user", false, "hi"],
      ["waifu", true, "hey!\ncake?"],
      ["user", true, "level up"]
    ]);
    expect(messages[1]!.sourceMessageIds).toEqual(["2", "3"]);
    expect(messages[2]!.replyTo).toMatchObject({ messageId: "1", authorName: "Kevin" });
  });
});

describe("director context through ContextRuntime", () => {
  it("golden: model mode with a past decision, a gap and new messages", async () => {
    const h = await harness();
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "Aria, what are you baking today?" });
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "lemon tarts!! want the recipe?" });
    const p1 = await h.prepare();
    await commitFinal(h.runtime, p1, decision("d1"));
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "later maybe, gotta run" }, BASE_TIME + 4 * 60_000);
    h.channel.post({ authorId: "riko-bot", authorName: "Riko", authorIsBot: true, content: "bye kevin" }, BASE_TIME + 3 * 3_600_000);
    h.clock.now = BASE_TIME + 3 * 3_600_000 + 60_000;
    const p2 = await h.prepare({ turn: turn({ directiveCount: 1 }) });
    expect(p2.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
    await expect(serializePrompt(p2.prompt)).toMatchFileSnapshot("./golden/__snapshots__/orchestrator-model.txt");
  });

  it("golden: reply-required wake pass", async () => {
    const h = await harness();
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "anyone up?" });
    const p1 = await h.prepare();
    await commitFinal(h.runtime, p1, decision("d1", {
      action: "no_reply",
      respondingWaifus: [],
      retriggerAfterSeconds: 420,
      wakePlan: "have Riko ask Kevin about the gig",
      responderOutcomes: []
    }));
    h.clock.now = BASE_TIME + 5 * 60_000 + 420_000;
    const p2 = await h.prepare({
      turn: turn({
        replyRequired: true,
        directiveCount: 0,
        pastDecisions: [{ action: "no_reply" }],
        wake: { scheduledSeconds: 420, wakePlan: "have Riko ask Kevin about the gig", decidedAt: new Date(BASE_TIME + 5 * 60_000).toISOString() }
      })
    });
    await expect(serializePrompt(p2.prompt)).toMatchFileSnapshot("./golden/__snapshots__/orchestrator-wake.txt");
  });

  it("stays prefix-stable over 20 turns as messages and decision notes append", async () => {
    const h = await harness();
    let previous: BuiltPrompt | undefined;
    for (let i = 0; i < 20; i += 1) {
      h.channel.post({ authorId: "kevin", authorName: "Kevin", content: `message ${i}` }, BASE_TIME + i * 90_000);
      if (i % 3 === 1) h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: `reply ${i}` }, BASE_TIME + i * 90_000 + 30_000);
      h.clock.now = BASE_TIME + i * 90_000 + 60_000;
      const p = await h.prepare({ turn: turn({ directiveCount: i % 4, replyRequired: i % 5 === 0 }) });
      expect(p.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
      if (previous) expectPrefix(previous, p.prompt);
      await commitFinal(h.runtime, p, decision(`d${i}`, i % 2 ? {} : { action: "no_reply", respondingWaifus: [], retriggerAfterSeconds: 100 + i, responderOutcomes: [] }));
      previous = p.prompt;
    }
    // Two builds over the same state are byte-identical.
    const a = await h.prepare();
    const b = await h.prepare();
    expect(stripCacheMarkers(b.prompt.messages)).toEqual(stripCacheMarkers(a.prompt.messages));
  });

  it("renders a decision only once it is final, anchored after the newest entry at that moment", async () => {
    const h = await harness();
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "Aria?" });
    const p1 = await h.prepare();
    // Still pending (responders running): nothing is written.
    await commitFinal(h.runtime, p1, decision("d1", { status: "pending" }));
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "here!" });
    const p2 = await h.prepare();
    expect(p2.prompt.debug.transcript).not.toContain("orchestrator_decision");
    // Final now: the note anchors to the newest ledger entry (Aria's reply) and stays frozen.
    await commitFinal(h.runtime, p2, decision("d1"));
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "yay" });
    const p3 = await h.prepare();
    const transcript = p3.prompt.debug.transcript;
    expect(transcript.indexOf("here!")).toBeLessThan(transcript.indexOf("[tool call orchestrator_decision]"));
    expect(transcript.indexOf("[tool result] sent")).toBeLessThan(transcript.indexOf("yay"));
    expect(p3.state.notes.filter((note) => note.kind === "decision")).toHaveLength(1);
    expectPrefix(p2.prompt, p3.prompt);
  });

  it("renders decisions as text lines on the JSON-schema fallback (no tool turns)", async () => {
    const h = await harness();
    h.channel.post({ authorId: "kevin", authorName: "Kevin", content: "Aria, cake?" });
    const p1 = await h.prepare({ text: true });
    await commitFinal(h.runtime, p1, decision("d1", {
      respondingWaifus: [{ waifuId: "aria", delaySeconds: 0, directive: { intent: "spotlight", goal: "answer Kevin" } }]
    }));
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "always!" });
    const p2 = await h.prepare({ text: true });
    expect(p2.prompt.messages.some((m) => m.role === "tool" || m.role === "assistant")).toBe(false);
    expect(p2.prompt.debug.transcript).toContain("[decision 14:00] reply → aria (spotlight) · sent");
    expect(p2.prompt.debug.transcript).not.toContain("answer Kevin");
  });
});

describe("reply-required enforcement", () => {
  // Always available (the deterministic decider reads host-local schedules).
  const free = { sleep: { enabled: false, start: "00:00", end: "00:00" }, busy: [] };
  const cast = [
    { waifuId: "aria", names: ["Aria"], authorIds: ["aria-bot"], availability: free },
    { waifuId: "riko", names: ["Riko"], authorIds: ["riko-bot"], availability: free }
  ];
  const now = new Date(BASE_TIME + 3_600_000);

  it("turns a pause into a structural reply", () => {
    const messages = ledgerToContextMessages(
      [{ id: "1", seq: 1, authorId: "aria-bot", authorName: "Aria", authorIsBot: true, at: new Date(BASE_TIME).toISOString(), kind: "default", body: "anyone?", images: [], state: "live", sealed: true }],
      { channelId: "200", isWaifu }
    );
    const forced = forceReplyDecision({ messages, cast, now });
    expect(forced).toMatchObject({ action: "reply", respondingWaifus: [{ waifuId: "riko" }] });
    expect(forced!.reasoning).toContain("reply required");
  });

  it("keeps the structural pick when there is one, and gives up only for an empty cast", () => {
    const messages = ledgerToContextMessages(
      [{ id: "1", seq: 1, authorId: "kev", authorName: "Kevin", authorIsBot: false, at: new Date(BASE_TIME).toISOString(), kind: "default", body: "Aria, you there?", images: [], state: "live", sealed: true }],
      { channelId: "200", isWaifu }
    );
    expect(forceReplyDecision({ messages, cast, now })).toMatchObject({ action: "reply", respondingWaifus: [{ waifuId: "aria" }] });
    expect(forceReplyDecision({ messages, cast: [], now })).toBeUndefined();
  });
});
