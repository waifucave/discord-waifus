import { afterEach, describe, expect, it } from "vitest";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { ContextRuntime } from "../src/orchestration/context/runtime.js";
import { formatGapLabel, transitionMarker } from "../src/orchestration/context/timeFormat.js";
import { entryHeader, entryLine } from "../src/orchestration/context/transcript.js";
import { NoopCompaction, type MemorySnapshotProvider } from "../src/orchestration/context/types.js";
import {
  DM_DISCRETION_LINE,
  arrivalsSinceEpoch,
  createWaifuHarness,
  harnessTranscriptParagraph,
  waifuTools,
  type WaifuHarnessInput
} from "../src/orchestration/waifuHarness.js";
import { promptWithTail } from "../src/orchestration/responderExecutor.js";
import { VERBOSITY_PROFILES, retryNote } from "../src/orchestration/verbosity.js";
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
    people: [{ userId: "kevin", name: "Kevin" }],
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
    expect(system).toContain(harnessTranscriptParagraph("guild"));
    expect(system).toContain(DM_DISCRETION_LINE);
    expect(system).toContain("Each line break sends a separate Discord message.");
    expect(system).toContain(
      '<identity>\nYou are Aria — shown in this server as "Aria✨". The other character here is Riko, who writes their own messages; you write only yours.\n</identity>'
    );
    expect(system).toContain("<persona>\nAria is a sunny baker");
    expect(system).toContain("<style>\nWrite casual chat messages of one to three short lines");
    expect(system).toContain("Voice: Warm, quick, playful.\nDrives: Lightens the mood; loves food talk.");
    expect(system).toContain("<schedule>");
    expect(system).toContain("<tools>\nadd_memory");
    expect(system).toContain("PickNextWaifu");
    expect(system).toContain("<custom_instructions>\nNever talk about the secret recipe.\n</custom_instructions>");
    // No legacy protocol left.
    expect(system).not.toContain("replying to >");
    // Owner wording review.
    expect(system).toContain("`<direction>` is a private stage cue for your next message: follow it in your own words, never quote it.");
    expect(system).toContain("`↩Kevin` that it replies to an older message by Kevin");
    expect(system).toContain("Never start a message with `↩you` or `↩Name`.");
    expect(system).toContain("When someone corrects a fact about the world or about people, believe them and adjust");
    expect(system).toContain("What someone tells you in a private chat stays between you and that person unless they raise it first.");
    expect(system).not.toContain("you can still answer if");
  });

  it("roster wording reads sensibly with several characters and with none", () => {
    const several = createWaifuHarness(guildInput({ roster: ["Riko", "Mina"] })).system();
    expect(several).toContain(
      "The other characters here are Riko and Mina; each writes their own messages, and you write only yours."
    );
    const alone = createWaifuHarness(guildInput({ roster: [], serverNickname: undefined })).system();
    expect(alone).toContain("<identity>\nYou are Aria.\n</identity>");
  });

  it("DM harness: no `<direction>`, standard emoji only, no server emojis or pings", () => {
    const system = createWaifuHarness(
      guildInput({ conversation: DM, roster: [], place: { kind: "dm", userName: "Kevin" }, emojis: [], tools: [] })
    ).system();
    expect(system).toContain(harnessTranscriptParagraph("dm"));
    expect(harnessTranscriptParagraph("dm")).not.toContain("<direction>");
    expect(system).not.toContain("<direction>");
    expect(system).toContain("Use standard emoji only, and sparingly.");
    expect(system).not.toContain("<:name:>");
  });

  it("omits the schedule when scheduleInPrompt is off and the tools block without tools", () => {
    const system = createWaifuHarness(guildInput({ waifu: aria({ scheduleInPrompt: false, customInstructions: "" }), tools: [] })).system();
    expect(system).not.toContain("<schedule>");
    expect(system).not.toContain("<tools>");
    expect(system).not.toContain("<custom_instructions>");
  });

  it("the system prompt is static: identical across renders and independent of time", () => {
    const a = createWaifuHarness(guildInput()).system();
    const b = createWaifuHarness(
      guildInput({ activity: () => "sleepy", direction: "(spotlight) x", people: [{ userId: "kevin", name: "Kevin" }, { userId: "mina", name: "Mina" }] })
    ).system();
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
    const paragraph = harnessTranscriptParagraph("guild");
    // `[14:02 #k3] Kevin: text`
    expect(paragraph).toContain(`\`${entryLine(kevin, view)}\``);
    // `↩#…`, `↩you` and `↩Name` in headers
    expect(entryHeader(reply, view)).toBe("[14:02 #k4 ↩#k3]");
    expect(entryHeader(replyToMe, view)).toBe("[14:02 #k5 ↩you]");
    const olderKevin: LedgerEntry = { ...kevin, id: "9", seq: 9, replyToId: "8" };
    const lookupOlder = (id: string) => (id === "8" ? { ...kevin, id: "8" } : byId.get(id));
    expect(entryHeader(olderKevin, { ...view, lookup: lookupOlder })).toMatch(/↩Kevin\]$/);
    expect(paragraph).toContain("`↩#a1` means the message replies to message #a1");
    expect(paragraph).toContain("`↩you` that it replies to you");
    expect(paragraph).toContain("`↩Kevin` that it replies to an older message by Kevin");
    // `— 3 hours later —`
    const later = new Date(Date.parse(at) + 3 * 3_600_000).toISOString();
    expect(formatGapLabel(3 * 3_600_000)).toBe("3 hours later");
    expect(paragraph).toContain(`\`${transitionMarker(at, later, "UTC")}\``);
    // The note tags the renderer emits.
    for (const tag of ["<memory_note>", "<direction>", "<edit>"]) expect(paragraph).toContain(`\`${tag}\``);
    // Tool notes render as text lines (renderToolTurnsAsText): `[tool add_memory] {…} → saved`.
    expect(paragraph).toContain("`[tool add_memory] … → saved`");
    // The marker she may write is the parser's.
    expect(paragraph).toContain("start your message with `↩#k3 `");
  });

  it("tail: now, activity, arrivals since the epoch, direction, retry note, turn instruction", async () => {
    const harness = createWaifuHarness(
      guildInput({
        people: [{ userId: "kevin", name: "Kevin" }, { userId: "mina", name: "Mina" }],
        activity: () => "morning shift at the bakery"
      })
    );
    const state = { timeZone: "UTC", epochParticipantIds: ["kevin"] } as never;
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
    const steered = createWaifuHarness(guildInput({ direction: "(spotlight) answer Kevin" }));
    expect(steered.tail(state, new Date(Date.UTC(2026, 9, 24, 13, 0)), {})).toBe(
      ["Now: Sat 24 Oct 2026 13:00.", "<direction>(spotlight) answer Kevin</direction>", "Write Aria's next message."].join("\n")
    );
  });

  it("arrivals compare frozen participant ids, not display names", () => {
    const people = [
      { userId: "kevin", name: "Kev (renamed)" },
      { userId: "mina", name: "Kevin" },
      { name: "No Id" }
    ];
    // Kevin renamed himself: still not an arrival. Mina took the display name "Kevin": she is one.
    expect(arrivalsSinceEpoch(people, { epochParticipantIds: ["kevin"] })).toEqual(["Kevin"]);
    // No frozen participants (legacy state): nobody is announced.
    expect(arrivalsSinceEpoch(people, { epochParticipantIds: [] })).toEqual([]);
  });

  it("drops the activity line when she is free", () => {
    const tail = createWaifuHarness(guildInput({ activity: () => undefined })).tail(
      { timeZone: "UTC", epochParticipantIds: ["kevin"] } as never,
      new Date(Date.UTC(2026, 9, 24, 13, 0)),
      {}
    );
    expect(tail).not.toContain("awake and free");
    expect(tail).toBe("Now: Sat 24 Oct 2026 13:00.\nWrite Aria's next message.");
  });

  it("golden: guild turn (summary, memories, place, direction note, tool turn, tail)", async () => {
    const { store, channel, runtime, clock } = await engine();
    // A summary from an earlier compaction is part of the frozen epoch header.
    await store.update(conversationKey(GUILD), ARIA, (s) => ({ ...s, summary: "Kevin and Riko planned a bake sale for Saturday." }));
    channel.post({ content: "morning all" }, BASE_TIME);
    channel.post({ authorId: "riko", authorName: "Riko", authorIsBot: true, content: "who's bringing cake?" }, BASE_TIME + 60_000);
    // This turn's direction rides in the tail; it is persisted as a note when her turn commits.
    const harness = createWaifuHarness(guildInput({ direction: "(spotlight) volunteer to bake" }));
    const p1 = await runtime.prepare({
      conversation: GUILD,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: harness,
      renderToolTurnsAsText: true,
      participantIds: ["kevin"]
    });
    await runtime.commit(p1, {
      modelKey: p1.modelKey,
      notes: [
        { kind: "direction", text: "(spotlight) volunteer to bake" },
        { kind: "tool", callId: "call_1", name: "add_memory", arguments: '{"content":"Aria is baking for Saturday"}', result: "saved" }
      ]
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
      renderToolTurnsAsText: true,
      render: createWaifuHarness(guildInput({ people: [{ userId: "kevin", name: "Kevin" }, { userId: "mina", name: "Mina" }] }))
    });
    expect(p2.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
    // C1: tool notes are text, never tool_use / tool_result blocks.
    expect(p2.prompt.messages.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(p2.prompt.messages)).not.toContain('"toolCall"');
    expect(p2.prompt.debug.transcript).toContain('[tool add_memory] {"content":"Aria is baking for Saturday"} → saved');
    // The persisted direction renders before her reply.
    const t = p2.prompt.debug.transcript;
    expect(t.indexOf("<direction>(spotlight) volunteer to bake</direction>")).toBeLessThan(t.indexOf("(you) me!! lemon bars incoming"));
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
        people: [{ userId: "kevin", name: "Kevin" }],
        emojis: [],
        tools: [],
        activity: () => "sleepy"
      })
    });
    expect(p.prompt.promptCacheKey).toBe("waifu:aria:dm_kevin_aria");
    await expect(serializePrompt(p.prompt)).toMatchFileSnapshot("./golden/__snapshots__/waifuHarness-dm.txt");
  });

  it("golden: guild turn with the schedule omitted (scheduleInPrompt: false, spec 8.11)", async () => {
    const { channel, runtime } = await engine();
    channel.post({ content: "morning! are you at the bakery today?" }, BASE_TIME);
    const p = await runtime.prepare({
      conversation: GUILD,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: createWaifuHarness(guildInput({ waifu: aria({ scheduleInPrompt: false }), activity: () => "morning shift at the bakery" })),
      renderToolTurnsAsText: true,
      participantIds: ["kevin"]
    });
    expect(p.prompt.debug.system).not.toContain("<schedule>");
    expect(p.prompt.debug.system).not.toContain("morning shift at the bakery");
    expect(p.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
    await expect(serializePrompt(p.prompt)).toMatchFileSnapshot("./golden/__snapshots__/waifuHarness-guild-noschedule.txt");
  });

  it("golden: retry tail (spec 8.11)", async () => {
    const { channel, runtime } = await engine();
    channel.post({ content: "what are you baking today?" }, BASE_TIME);
    const harness = createWaifuHarness(guildInput({ direction: "(spotlight) answer Kevin" }));
    const p = await runtime.prepare({
      conversation: GUILD,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: harness,
      renderToolTurnsAsText: true,
      participantIds: ["kevin"]
    });
    const tail = harness.tail(p.state, new Date(BASE_TIME + 60_000), { retryNote: retryNote([{ check: "length", detail: "412 chars" }], VERBOSITY_PROFILES.chatty) });
    await expect(serializePrompt(promptWithTail(p.prompt, tail))).toMatchFileSnapshot("./golden/__snapshots__/waifuHarness-retry.txt");
  });
});
