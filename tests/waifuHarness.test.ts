import { afterEach, describe, expect, it } from "vitest";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { formatGapLabel, transitionMarker } from "../src/orchestration/context/timeFormat.js";
import { entryHeader, entryLine } from "../src/orchestration/context/transcript.js";
import { NoopCompaction, type MemorySnapshotProvider } from "../src/orchestration/context/types.js";
import {
  DM_DISCRETION_LINE,
  HARNESS_TRANSCRIPT_PARAGRAPH,
  createWaifuHarness,
  waifuTools,
  type WaifuHarnessInput
} from "../src/orchestration/waifuHarness.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { LedgerEntry } from "../src/shared/schemas/context.js";
import { WaifuConfigSchema, type WaifuConfig } from "../src/shared/schemas/domain.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, fakeModel, quietLogger } from "./contextFixtures.js";
import { serializePrompt } from "./golden/serialize.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const DM: ConversationRef = { kind: "dm", waifuId: "aria", userId: "kevin" };
const ARIA = { kind: "waifu", waifuId: "aria" } as const;
const SELF = ["aria-bot"];

function aria(over: Partial<WaifuConfig> = {}): WaifuConfig {
  return WaifuConfigSchema.parse({
    ...createRevisionedBase(),
    id: "aria",
    name: "Aria",
    displayName: "Aria",
    persona: "Aria is a sunny baker who teases her friends and never misses a pun.",
    availability: {
      sleep: { enabled: true, start: "23:00", end: "07:00" },
      busy: [{ start: "09:00", end: "12:00", reason: "morning shift at the bakery" }]
    },
    verbosity: "chatty",
    customInstructions: "Never talk about the secret recipe.",
    personaDigest: { voice: "Warm, quick, playful.", role: "Lightens the mood; loves food talk.", personaHash: "h" },
    ...over
  });
}

function guildInput(over: Partial<WaifuHarnessInput> = {}): WaifuHarnessInput {
  return {
    waifu: aria(),
    conversation: GUILD,
    roster: ["Riko"],
    serverNickname: "Aria✨",
    place: { kind: "guild", serverName: "Bake Club", channelName: "general" },
    people: ["Kevin"],
    emojis: ["<:cake:>", "<a:party:>"],
    tools: waifuTools({ addMemory: true, pickNextWaifuIds: ["riko"] }),
    activity: () => undefined,
    ...over
  };
}

const snapshots: MemorySnapshotProvider = {
  selectSnapshot: async () => ({
    ids: ["m1", "m2"],
    lines: [
      "- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)",
      "- Riko: is training for a marathon (event · learned in a private chat · 2 days ago)"
    ]
  }),
  proposeInlineNotes: async () => [],
  markRetrieved: () => undefined
};

async function engine() {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 30 * 60_000 };
  const store = new FileContextStore(new StorageService(root), { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const runtime = new ContextRuntime({
    store,
    snapshots,
    compaction: NoopCompaction,
    messages: channel,
    images: new FakeImageFetcher(),
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC"
  });
  return { store, channel, runtime, clock };
}

describe("waifu harness", () => {
  it("system prompt: harness, identity/roster, persona, style, schedule, tools, custom, DM discretion", () => {
    const system = createWaifuHarness(guildInput()).system();
    expect(system.startsWith("<harness>\n")).toBe(true);
    expect(system).toContain(HARNESS_TRANSCRIPT_PARAGRAPH);
    expect(system).toContain(DM_DISCRETION_LINE);
    expect(system).toContain('<identity>\nYou are Aria — shown in this server as "Aria✨". The other characters here are Riko;');
    expect(system).toContain("<persona>\nAria is a sunny baker");
    expect(system).toContain("<style>\nWrite casual chat messages of one to three short lines");
    expect(system).toContain("Voice: Warm, quick, playful.\nDrives: Lightens the mood; loves food talk.");
    expect(system).toContain("<schedule>");
    expect(system).toContain("<tools>\nadd_memory");
    expect(system).toContain("PickNextWaifu");
    expect(system).toContain("<custom_instructions>\nNever talk about the secret recipe.\n</custom_instructions>");
    // No legacy protocol left.
    expect(system).not.toContain("replying to >");
  });

  it("omits the schedule when scheduleInPrompt is off and the tools block without tools", () => {
    const system = createWaifuHarness(guildInput({ waifu: aria({ scheduleInPrompt: false, customInstructions: "" }), tools: [] })).system();
    expect(system).not.toContain("<schedule>");
    expect(system).not.toContain("<tools>");
    expect(system).not.toContain("<custom_instructions>");
  });

  it("the system prompt is static: identical across renders and independent of time", () => {
    const a = createWaifuHarness(guildInput()).system();
    const b = createWaifuHarness(guildInput({ activity: () => "sleepy", people: ["Kevin", "Mina"] })).system();
    expect(b).toBe(a);
  });

  it("the transcript paragraph matches the T2 renderer", () => {
    const at = new Date(Date.UTC(2026, 9, 24, 14, 2)).toISOString();
    const kevin: LedgerEntry = {
      id: "1", seq: 1, authorId: "kevin", authorName: "Kevin", authorIsBot: false, at, kind: "default",
      body: "text", images: [], state: "live", sealed: true
    };
    const own: LedgerEntry = { ...kevin, id: "0", seq: 0, authorId: "aria-bot", authorName: "Aria", body: "hi" };
    const reply: LedgerEntry = { ...kevin, id: "2", seq: 2, replyToId: "1" };
    const replyToMe: LedgerEntry = { ...kevin, id: "3", seq: 3, replyToId: "0" };
    const refs = new Map([["1", "k3"], ["2", "k4"], ["3", "k5"], ["0", "a1"]]);
    const byId = new Map([kevin, own, reply, replyToMe].map((e) => [e.id, e]));
    const view = { refs, lookup: (id: string) => byId.get(id), selfAuthorIds: SELF, timeZone: "UTC" };
    // `[14:02 #k3] Kevin: text`
    expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain(`\`${entryLine(kevin, view)}\``);
    // `↩#…` and `↩you` in headers
    expect(entryHeader(reply, view)).toBe("[14:02 #k4 ↩#k3]");
    expect(entryHeader(replyToMe, view)).toBe("[14:02 #k5 ↩you]");
    expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain("`↩#a1` in a header");
    expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain("`↩you` means it replies to you");
    // `— 3 hours later —`
    const later = new Date(Date.parse(at) + 3 * 3_600_000).toISOString();
    expect(formatGapLabel(3 * 3_600_000)).toBe("3 hours later");
    expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain(`\`${transitionMarker(at, later, "UTC")}\``);
    // The note tags the renderer emits.
    for (const tag of ["<memory_note>", "<direction>", "<edit>"]) expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain(`\`${tag}\``);
    // The marker she may write is the parser's.
    expect(HARNESS_TRANSCRIPT_PARAGRAPH).toContain("start your message with `↩#k3 `");
  });

  it("tail: now, activity, arrivals since the epoch, retry note, turn instruction", async () => {
    const harness = createWaifuHarness(guildInput({ people: ["Kevin", "Mina"], activity: () => "morning shift at the bakery" }));
    const state = { timeZone: "UTC", headerText: "<place>\nBake Club › #general\nPeople here: Kevin\n</place>" } as never;
    const tail = harness.tail(state, new Date(Date.UTC(2026, 9, 24, 10, 5)), { retryNote: "Your last draft was rejected: x. Write it again." });
    expect(tail).toBe(
      [
        "Now: Sat 24 Oct 2026 10:05.",
        "You're busy: morning shift at the bakery.",
        "Also here now: Mina.",
        "Your last draft was rejected: x. Write it again.",
        "Write Aria's next message."
      ].join("\n")
    );
  });

  it("golden: guild turn (summary, memories, place, direction note, tool turn, tail)", async () => {
    const { store, channel, runtime, clock } = await engine();
    // A summary from an earlier compaction is part of the frozen epoch header.
    await store.update(conversationKey(GUILD), ARIA, (s) => ({ ...s, summary: "Kevin and Riko planned a bake sale for Saturday." }));
    channel.post({ content: "morning all" }, BASE_TIME);
    channel.post({ authorId: "riko", authorName: "Riko", authorIsBot: true, content: "who's bringing cake?" }, BASE_TIME + 60_000);
    const harness = createWaifuHarness(guildInput());
    const p1 = await runtime.prepare({
      conversation: GUILD,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: harness,
      pendingNotes: [{ kind: "direction", text: "(spotlight) volunteer to bake" }]
    });
    await runtime.commit(p1, {
      modelKey: p1.modelKey,
      notes: [{ kind: "tool", callId: "call_1", name: "add_memory", arguments: '{"content":"Aria is baking for Saturday"}', result: "saved" }]
    });
    channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "me!! lemon bars incoming", referenceMessageId: p1.transcript[1]!.id }, BASE_TIME + 120_000);
    channel.post({ authorId: "mina", authorName: "Mina", content: "can i help?" }, BASE_TIME + 5 * 60_000);
    clock.now = BASE_TIME + 6 * 60_000;
    const p2 = await runtime.prepare({
      conversation: GUILD,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: createWaifuHarness(guildInput({ people: ["Kevin", "Mina"] }))
    });
    expect(p2.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
    await expect(serializePrompt(p2.prompt)).toMatchFileSnapshot("./golden/__snapshots__/waifuHarness-guild.txt");
  });

  it("golden: DM turn (no schedule, no tools, private place)", async () => {
    const { channel, runtime } = await engine();
    channel.post({ content: "hey, can i tell you something?" }, BASE_TIME);
    const p = await runtime.prepare({
      conversation: DM,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: createWaifuHarness({
        waifu: aria({ scheduleInPrompt: false, verbosity: "terse", customInstructions: "" }),
        conversation: DM,
        roster: [],
        place: { kind: "dm", userName: "Kevin" },
        people: ["Kevin"],
        emojis: [],
        tools: [],
        activity: () => "sleepy"
      })
    });
    expect(p.prompt.promptCacheKey).toBe("waifu:aria:dm_kevin_aria");
    await expect(serializePrompt(p.prompt)).toMatchFileSnapshot("./golden/__snapshots__/waifuHarness-dm.txt");
  });
});
