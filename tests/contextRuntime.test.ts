import type { ChatMessage } from "@waifucave/gateway";
import { GatewayError } from "@waifucave/gateway";
import { access } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, stripCacheMarkers } from "../src/orchestration/context/builder.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { FrozenImageRenderer } from "../src/orchestration/context/images.js";
import { conversationKey, contextStatePath, type ConversationRef } from "../src/orchestration/context/keys.js";
import { orderedEntries } from "../src/orchestration/context/ledger.js";
import { ContextRuntime, type ContextRuntimeDeps } from "../src/orchestration/context/runtime.js";
import {
  NoopCompaction,
  type CompactionService,
  type MemorySnapshotProvider,
  type PreparedContext
} from "../src/orchestration/context/types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import { StorageService } from "../src/storage/storageService.js";
import {
  BASE_TIME,
  FakeChannel,
  FakeImageFetcher,
  fakeModel,
  fakeRoleRenderer,
  noSnapshots,
  quietLogger
} from "./contextFixtures.js";
import { serializePrompt } from "./golden/serialize.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const ARIA = { kind: "waifu", waifuId: "aria" } as const;
const SELF = ["aria-bot"];

type Harness = {
  root: string;
  store: FileContextStore;
  runtime: ContextRuntime;
  channel: FakeChannel;
  images: FakeImageFetcher;
  clock: { now: number };
};

async function harness(o: Partial<ContextRuntimeDeps> = {}): Promise<Harness> {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 3_600_000 };
  const storage = new StorageService(root);
  const store = new FileContextStore(storage, { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const images = new FakeImageFetcher();
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: NoopCompaction,
    messages: channel,
    images,
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC",
    ...o
  });
  return { root, store, runtime, channel, images, clock };
}

function prepare(h: Harness, extra: Partial<Parameters<ContextRuntime["prepare"]>[0]> = {}) {
  return h.runtime.prepare({
    conversation: GUILD,
    agent: ARIA,
    model: fakeModel(),
    backfillCap: 50,
    selfAuthorIds: SELF,
    render: fakeRoleRenderer(),
    ...extra
  });
}

type FlatBlock = { role: string; block: unknown };
/** Every content block in order (tool results as one block); `marked` = carries cacheControl. */
function flatten(messages: ChatMessage[]): Array<FlatBlock & { marked: boolean }> {
  const out: Array<FlatBlock & { marked: boolean }> = [];
  for (const m of messages) {
    if (m.role === "tool" || typeof m.content === "string") {
      out.push({ role: m.role, block: { ...m, cacheControl: undefined }, marked: Boolean(m.cacheControl) });
      continue;
    }
    for (const b of m.content) out.push({ role: m.role, block: b, marked: Boolean((b as { cacheControl?: unknown }).cacheControl) });
  }
  return out;
}

function stripped(messages: ChatMessage[]): FlatBlock[] {
  return flatten(stripCacheMarkers(messages)).map(({ role, block }) => ({ role, block }));
}

describe("ContextRuntime.prepare", () => {
  it("fetches, reconciles, seals, freezes the epoch and persists pending notes in one write", async () => {
    const h = await harness();
    h.channel.post({ content: "hi Aria" });
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "hello" });
    const renderer = fakeRoleRenderer();
    const p = await prepare(h, { render: renderer, pendingNotes: [{ kind: "direction", text: "be cheerful" }] });

    expect(h.channel.fetches).toEqual([{ afterMessageId: null, maxMessages: 50 }]);
    expect(p.transcript.map((e) => e.body)).toEqual(["hi Aria", "hello"]);
    expect(p.state.revision).toBeGreaterThan(0);
    expect(p.state.headerText).toContain("<place>");
    expect(p.state.timeZone).toBe("UTC");
    expect(p.state.notes).toEqual([{ kind: "direction", text: "be cheerful", id: "n1", seq: 1, anchorSeq: 2 }]);
    expect(p.state.lastUsedAt).toBe(new Date(h.clock.now).toISOString());
    const ledger = await h.store.loadLedger(p.key);
    expect(orderedEntries(ledger).every((e) => e.sealed)).toBe(true);

    // The direction is in the transcript of the very call it steers, as user content.
    const texts = flatten(p.prompt.messages).map((b) => (b.block as { text?: string }).text);
    expect(texts).toContain("<direction>be cheerful</direction>");
    expect(p.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(p.prompt.messages[0]!.role).toBe("system");
    expect(p.prompt.breakpoint).toEqual({ kind: "note", seq: 1 });
    expect(p.prompt.promptCacheKey).toBe("waifu:aria:g_100_200");
    expect([...p.prompt.refToMessageId.keys()]).toEqual(["a0", "a1"]);

    // Next pass downloads only what is new; the header stays frozen.
    h.channel.post({ content: "again" });
    const headerCalls: unknown[] = [];
    const r2 = { ...renderer, header: (...args: unknown[]) => (headerCalls.push(args), "changed header") };
    const p2 = await prepare(h, { render: r2 });
    expect(h.channel.fetches[1]!.afterMessageId).toBe(p.transcript[1]!.id);
    expect(headerCalls).toHaveLength(0);
    expect(p2.state.headerText).toBe(p.state.headerText);
  });

  it("selects the memory snapshot at epoch start only and appends memory notes mid-epoch", async () => {
    const calls: string[] = [];
    const snapshots: MemorySnapshotProvider = {
      selectSnapshot: async (i) => {
        calls.push(`select:${i.participants.map((p) => p.displayName).join(",")}`);
        return { ids: ["m1"], lines: ["- Kevin: likes cake (fact · 2 days ago)"] };
      },
      proposeInlineNotes: async (i) => {
        calls.push(`propose:new=${i.newParticipants.map((p) => p.displayName).join(",")}:exclude=${i.excludeIds.join(",")}:budget=${i.budget}`);
        return i.newParticipants.length ? [{ memoryIds: ["m2"], text: "- Mina: hates rain" }] : [];
      },
      markRetrieved: (ids) => calls.push(`retrieved:${ids.join(",")}`)
    };
    const h = await harness({ snapshots });
    h.channel.post({ content: "hi" });
    const p1 = await prepare(h);
    await h.runtime.commit(p1, { modelKey: p1.modelKey });
    h.channel.post({ authorId: "mina", authorName: "Mina", content: "hey all" });
    const p2 = await prepare(h);
    expect(calls).toEqual([
      "select:Kevin",
      "retrieved:m1",
      "propose:new=Mina:exclude=m1:budget=6",
      "retrieved:m2"
    ]);
    expect(p2.state.memoryNoteCount).toBe(1);
    expect(p2.state.notes.at(-1)).toMatchObject({ kind: "memory", memoryIds: ["m2"], anchorSeq: 2 });
    expect(p2.prompt.debug.header).toContain("likes cake");
  });

  it("appends one 'earlier messages not loaded' entry when the fetch did not reach the cursor", async () => {
    const h = await harness();
    h.channel.post({ content: "first" });
    const p1 = await prepare(h, { backfillCap: 3 });
    await h.runtime.commit(p1, { modelKey: p1.modelKey });
    for (let i = 0; i < 5; i += 1) h.channel.post({ content: `burst ${i}` });
    const p2 = await prepare(h, { backfillCap: 3 });
    expect(p2.state.cursorSeq).toBe(p1.state.cursorSeq);
    expect(p2.transcript.map((e) => e.body)).toEqual(["first", "— earlier messages not loaded —", "burst 2", "burst 3", "burst 4"]);
    // Nothing already rendered moved: the previous prompt is a prefix.
    const before = stripped(p1.prompt.messages).slice(0, -1);
    expect(stripped(p2.prompt.messages).slice(0, before.length)).toEqual(before);
  });

  it("bounds a new context's first epoch to the newest backfillCap ledger entries", async () => {
    const h = await harness();
    for (let i = 0; i < 8; i += 1) h.channel.post({ content: `m${i}` });
    const orchestrator = await prepare(h, { agent: { kind: "orchestrator" }, backfillCap: 20 });
    expect(orchestrator.transcript).toHaveLength(8);
    const waifu = await prepare(h, { backfillCap: 3 });
    expect(waifu.transcript.map((e) => e.body)).toEqual(["m5", "m6", "m7"]);
    expect(waifu.state.cursorSeq).toBe(5);
  });

  it("builds DM conversations under their own key and cache key", async () => {
    const h = await harness();
    const dm: ConversationRef = { kind: "dm", waifuId: "aria", userId: "555" };
    h.channel.post({ authorId: "555", authorName: "Kevin", content: "psst", guildId: undefined });
    const p = await prepare(h, { conversation: dm });
    expect(p.key).toBe("dm_555_aria");
    expect(p.prompt.promptCacheKey).toBe("waifu:aria:dm_555_aria");
    await expect(access(path.join(h.root, contextStatePath(conversationKey(dm), ARIA)))).resolves.toBeUndefined();
    expect(p.prompt.debug.transcript).toContain("Kevin: psst");
    await expect(serializePrompt(p.prompt)).toMatchFileSnapshot("./golden/__snapshots__/contextEngine-dm.txt");
  });
});

describe("prefix stability (spec 8.3 acceptance)", () => {
  it("holds for 20 scripted turns: every block through the previous C is unchanged, one system message", async () => {
    const h = await harness();
    h.channel.post({ content: "hi Aria!" });
    let previous: PreparedContext | undefined;
    for (let turn = 0; turn < 20; turn += 1) {
      h.clock.now += 60_000;
      const p = await prepare(h, {
        pendingNotes: turn % 3 === 0 ? [{ kind: "direction", text: `turn ${turn} goal` }] : []
      });
      expect(p.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
      expect(p.prompt.messages[0]!.role).toBe("system");
      const markers = flatten(p.prompt.messages).filter((b) => b.marked).length;
      expect(markers).toBeLessThanOrEqual(4);

      if (previous) {
        const prev = flatten(previous.prompt.messages);
        const cIndex = prev.map((b) => b.marked).lastIndexOf(true);
        expect(cIndex).toBeGreaterThan(1);
        const prevStripped = stripped(previous.prompt.messages).slice(0, cIndex + 1);
        expect(stripped(p.prompt.messages).slice(0, cIndex + 1)).toEqual(prevStripped);
      }
      await h.runtime.commit(p, {
        modelKey: p.modelKey,
        notes: turn % 4 === 1 ? [{ kind: "tool", callId: `c${turn}`, name: "add_memory", arguments: "{}", result: "saved" }] : []
      });
      // Her reply lands in Discord, then a human answers (plus an occasional image / gap).
      h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: `reply ${turn}` }, h.clock.now + 1_000);
      h.clock.now += turn === 9 ? 3 * 3_600_000 : 30_000;
      h.channel.post(
        {
          content: `human ${turn}`,
          ...(turn % 5 === 2
            ? { attachments: [{ id: String(9000 + turn), url: `https://cdn.discordapp.com/attachments/200/${9000 + turn}/x.png`, filename: "x.png", contentType: "image/png", size: 10 }] }
            : {})
        },
        h.clock.now
      );
      previous = p;
    }
  });

  it("two builds over the same input are byte-identical", async () => {
    const h = await harness();
    h.channel.post({ content: "one", attachments: [{ id: "77", url: "https://cdn.discordapp.com/attachments/200/77/x.png", filename: "x.png", contentType: "image/png", size: 10 }] });
    h.channel.post({ authorId: "aria-bot", content: "two" });
    const p = await prepare(h, { pendingNotes: [{ kind: "direction", text: "d" }] });
    const ledger = orderedEntries(await h.store.loadLedger(p.key));
    const refs = new Map(Object.entries((await h.store.loadRefs(p.key)).refs));
    const build = () =>
      buildContext(
        {
          conversation: GUILD,
          agent: ARIA,
          model: fakeModel(),
          state: p.state,
          systemText: "sys",
          headerText: p.state.headerText ?? "",
          transcript: ledger,
          events: [],
          selfAuthorIds: SELF,
          refs,
          tail: "tail",
          tools: []
        },
        new FrozenImageRenderer({ fetcher: h.images, acceptsImages: true, maxInlinePerEpoch: 8 })
      );
    const [a, b] = [await build(), await build()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(p.prompt.messages).replace(/You are Aria\. Static harness text\./, "sys").replace(/"text":"Now [^"]*"/, '"text":"tail"'));

    // And a re-prepare with no new input renders the same messages (markers aside).
    await h.runtime.commit(p, { modelKey: p.modelKey });
    const again = await prepare(h);
    expect(stripped(again.prompt.messages)).toEqual(stripped(p.prompt.messages));
  });

  it("busy room: 30+ messages between turns → C_prev marks the previous C block", async () => {
    const h = await harness();
    h.channel.post({ content: "start" });
    const p1 = await prepare(h);
    await h.runtime.commit(p1, { modelKey: p1.modelKey });
    const previousC = p1.prompt.breakpoint!;
    for (let i = 0; i < 35; i += 1) h.channel.post({ authorId: i % 2 ? "riko" : "mina", authorName: i % 2 ? "Riko" : "Mina", content: `chatter ${i}` });
    const p2 = await prepare(h);
    expect(p2.state.lastBreakpoint).toEqual(previousC);
    const blocks = flatten(p2.prompt.messages);
    const markedTexts = blocks.filter((b) => b.marked).map((b) => (b.block as { text: string }).text);
    expect(markedTexts).toHaveLength(4); // A, B, C_prev, C
    const previousCText = (flatten(p1.prompt.messages).filter((b) => b.marked).at(-1)!.block as { text: string }).text;
    expect(previousCText).toBe("[14:00 #a0] Kevin: start");
    expect(markedTexts[2]).toBe(previousCText);
    expect(markedTexts[3]).toContain("chatter 34");
    expect(p2.prompt.breakpoint).toEqual({ kind: "entry", seq: 36 });
  });

  it("C never lands on an image or a tool result; the tail is never marked", async () => {
    const h = await harness();
    h.channel.post({ content: "pic", attachments: [{ id: "88", url: "https://cdn.discordapp.com/attachments/200/88/x.png", filename: "x.png", contentType: "image/png", size: 10 }] });
    const p1 = await prepare(h);
    const blocks = flatten(p1.prompt.messages);
    const marked = blocks.filter((b) => b.marked);
    expect(marked.every((b) => (b.block as { type?: string }).type === "text")).toBe(true);
    expect(blocks.at(-1)!.marked).toBe(false);
    expect((blocks.at(-1)!.block as { text: string }).text).toMatch(/^Now /);
    expect(blocks.some((b) => (b.block as { type?: string }).type === "image")).toBe(true);

    await h.runtime.commit(p1, { modelKey: p1.modelKey, notes: [{ kind: "tool", callId: "t1", name: "add_memory", arguments: "{}", result: "ok" }] });
    const p2 = await prepare(h);
    expect(p2.prompt.breakpoint).toEqual({ kind: "entry", seq: 1 });
    const last = p2.prompt.messages.at(-2)!;
    expect(last.role).toBe("tool");
    expect(last.cacheControl).toBeUndefined();
  });

  it("golden: guild first epoch with notes, tool turn and an image", async () => {
    const h = await harness();
    h.channel.post({ content: "morning! <t:1792850400:R>" }, BASE_TIME);
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "look at this", attachments: [{ id: "91", url: "https://cdn.discordapp.com/attachments/200/91/cake.png", filename: "cake.png", contentType: "image/png", size: 10 }] }, BASE_TIME + 60_000);
    const p1 = await prepare(h, { pendingNotes: [{ kind: "direction", text: "Compliment Riko's cake." }] });
    await h.runtime.commit(p1, { modelKey: p1.modelKey, notes: [{ kind: "tool", callId: "call_1", name: "add_memory", arguments: '{"content":"Riko bakes"}', result: "saved" }] });
    h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: "that cake is gorgeous", referenceMessageId: p1.transcript[1]!.id }, BASE_TIME + 120_000);
    h.channel.post({ content: "agreed", referenceMessageId: p1.transcript[1]!.id }, BASE_TIME + 4 * 3_600_000);
    h.clock.now = BASE_TIME + 4 * 3_600_000 + 30_000;
    const p2 = await prepare(h);
    await expect(serializePrompt(p2.prompt)).toMatchFileSnapshot("./golden/__snapshots__/contextEngine-guild.txt");
  });
});

describe("ContextRuntime compaction seam", () => {
  function compactingService(o: { trigger?: boolean; hang?: boolean } = {}) {
    const compactCalls: string[] = [];
    let store!: FileContextStore;
    const service: CompactionService & { attach(s: FileContextStore): void } = {
      attach: (s) => (store = s),
      check: ({ state }) => (o.trigger && state.epoch === 0 ? "messages" : undefined),
      compact: async (i) => {
        compactCalls.push(i.trigger);
        if (o.hang) return new Promise(() => undefined);
        const key = conversationKey(i.conversation);
        const ledger = orderedEntries(await store.loadLedger(key));
        await store.update(key, i.agent, (s) => ({
          ...s,
          epoch: s.epoch + 1,
          summary: `summary of ${ledger.length - 1}`,
          cursorSeq: ledger.at(-2)!.seq,
          headerText: null,
          notes: [],
          lastBreakpoint: null
        }));
      },
      inFlight: () => undefined
    };
    return { service, compactCalls };
  }

  it("check → compact → rebuild on the new epoch", async () => {
    const { service, compactCalls } = compactingService({ trigger: true });
    const h = await harness({ compaction: service });
    service.attach(h.store);
    for (let i = 0; i < 4; i += 1) h.channel.post({ content: `m${i}` });
    const p = await prepare(h, { summarize: async () => "unused", pendingNotes: [{ kind: "direction", text: "go" }] });
    expect(compactCalls).toEqual(["messages"]);
    expect(p.state.epoch).toBe(1);
    expect(p.transcript.map((e) => e.body)).toEqual(["m3"]);
    expect(p.prompt.debug.header).toContain("summary of 3");
    expect(p.state.notes.map((n) => n.kind)).toEqual(["direction"]);
  });

  it("on timeout sends a one-off hard-truncated prompt and keeps the cursor", async () => {
    const { service } = compactingService({ trigger: true, hang: true });
    const h = await harness({ compaction: service, settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, waitTimeoutMs: 10, keepRecent: 5 }) });
    service.attach(h.store);
    for (let i = 0; i < 12; i += 1) h.channel.post({ content: `m${i}` });
    const p = await prepare(h, { summarize: async () => "unused" });
    expect(p.transcript.map((e) => e.body)).toEqual(["m7", "m8", "m9", "m10", "m11"]);
    expect(p.state.cursorSeq).toBe(0);
    expect(p.state.epoch).toBe(0);
  });

  it("call: context_overflow → forced compact + rebuild + one retry; a second overflow surfaces", async () => {
    const { service, compactCalls } = compactingService();
    const h = await harness({ compaction: service });
    service.attach(h.store);
    for (let i = 0; i < 3; i += 1) h.channel.post({ content: `m${i}` });
    const p = await prepare(h, { summarize: async () => "s" });
    const seen: number[] = [];
    const result = await h.runtime.call(p, async (prompt) => {
      seen.push(prompt.transcriptCount);
      if (seen.length === 1) throw new GatewayError("context_overflow", "too long");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(compactCalls).toEqual(["overflow"]);
    expect(seen).toEqual([3, 1]);
    expect(p.prompt.transcriptCount).toBe(1);

    const overflow = new GatewayError("context_overflow", "still too long");
    await expect(h.runtime.call(p, async () => { throw overflow; })).rejects.toBe(overflow);
    const other = new Error("boom");
    await expect(h.runtime.call(p, async () => { throw other; })).rejects.toBe(other);
  });

  it("commit stores the breakpoint, appends notes at the newest entry and runs the calibration hook", async () => {
    const hook: unknown[] = [];
    const h = await harness({
      calibrate: ({ usage, rawEstimate, modelKey, now }) => {
        hook.push({ input: usage.inputTokens, rawEstimate, modelKey });
        return { [modelKey]: { ratio: usage.inputTokens / rawEstimate, samples: 1, updatedAt: now.toISOString() } };
      }
    });
    h.channel.post({ content: "x" });
    const p = await prepare(h);
    h.channel.post({ content: "arrived during generation" });
    await prepare(h, { agent: { kind: "orchestrator" } }); // another agent reconciles it meanwhile
    await h.runtime.commit(p, {
      modelKey: p.modelKey,
      usage: { inputTokens: 500, outputTokens: 10 },
      notes: [{ kind: "tool", callId: "c", name: "add_memory", arguments: "{}", result: "ok" }]
    });
    const state = await h.store.load(p.key, ARIA);
    expect(state.lastBreakpoint).toEqual(p.prompt.breakpoint);
    expect(state.notes.at(-1)).toMatchObject({ kind: "tool", anchorSeq: 2 });
    expect(hook).toEqual([{ input: 500, rawEstimate: p.prompt.estimatedTokens, modelKey: "anthropic:claude-test" }]);
    expect(state.tokenCalibration["anthropic:claude-test"]!.ratio).toBeCloseTo(500 / p.prompt.estimatedTokens);
  });
});
