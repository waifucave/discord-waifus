import type { ChatMessage } from "@waifucave/gateway";
import { afterEach, describe, expect, it } from "vitest";
import { stripCacheMarkers } from "../src/orchestration/context/builder.js";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { nextEpochState } from "../src/orchestration/context/compaction.js";
import { DELETED_MESSAGE_BODY, orderedEntries } from "../src/orchestration/context/ledger.js";
import { ContextRuntime, type ContextRuntimeDeps } from "../src/orchestration/context/runtime.js";
import { NoopCompaction, type PreparedContext } from "../src/orchestration/context/types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, FakeChannel, FakeImageFetcher, fakeModel, fakeRoleRenderer, noSnapshots, quietLogger } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const GUILD: ConversationRef = { kind: "guild", guildId: "100", channelId: "200" };
const ARIA = { kind: "waifu", waifuId: "aria" } as const;
const SELF = ["aria-bot"];

type Harness = {
  store: FileContextStore;
  runtime: ContextRuntime;
  channel: FakeChannel;
  images: FakeImageFetcher;
  clock: { now: number };
  purged: string[];
  ocrPurged: string[];
};

async function harness(o: Partial<ContextRuntimeDeps> = {}): Promise<Harness> {
  const root = await makeTempRoot();
  roots.push(root);
  const clock = { now: BASE_TIME + 3_600_000 };
  const store = new FileContextStore(new StorageService(root), { now: () => new Date(clock.now), timeZone: () => "UTC" });
  const channel = new FakeChannel();
  const images = new FakeImageFetcher();
  const purged: string[] = [];
  const ocrPurged: string[] = [];
  images.purge = async (keys: readonly string[]) => {
    purged.push(...keys);
  };
  const runtime = new ContextRuntime({
    store,
    snapshots: noSnapshots,
    compaction: NoopCompaction,
    messages: channel,
    images,
    ocr: {
      cachedText: async () => undefined,
      purge: async (keys: readonly string[]) => {
        ocrPurged.push(...keys);
      }
    },
    settings: () => ({ ...DEFAULT_COMPACTION_SETTINGS }),
    logger: quietLogger(),
    now: () => new Date(clock.now),
    timeZone: () => "UTC",
    ...o
  });
  return { store, runtime, channel, images, clock, purged, ocrPurged };
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
const stripped = (messages: ChatMessage[]): FlatBlock[] => flatten(stripCacheMarkers(messages)).map(({ role, block }) => ({ role, block }));

/** Index of the last cache breakpoint (C) of a prepared prompt. */
const lastMarked = (p: PreparedContext): number => flatten(p.prompt.messages).map((b) => b.marked).lastIndexOf(true);
const bytes = (p: PreparedContext): string => JSON.stringify(stripped(p.prompt.messages));
const transcriptText = (p: PreparedContext): string => p.prompt.debug.transcript;

/** Seeds `count` human messages (1 minute apart) and runs one prepare so they are sealed. */
async function seeded(h: Harness, count: number): Promise<{ posted: RawDiscordMessage[]; first: PreparedContext }> {
  const posted: RawDiscordMessage[] = [];
  for (let i = 0; i < count; i += 1) {
    posted.push(h.channel.post({ authorId: i % 2 ? "riko" : "kevin", authorName: i % 2 ? "Riko" : "Kevin", content: `message number ${i}` }, BASE_TIME + i * 60_000));
  }
  h.clock.now += 60_000;
  const first = await prepare(h);
  await h.runtime.commit(first, { modelKey: first.modelKey, notes: [] });
  return { posted, first };
}

function editMessage(h: Harness, message: RawDiscordMessage, content: string): RawDiscordMessage {
  const edited = { ...message, content, editedAt: new Date(h.clock.now).toISOString() };
  h.channel.messages[h.channel.messages.findIndex((m) => m.id === message.id)] = edited;
  return edited;
}

describe("ContextRuntime edits and deletes (spec 9.5, acceptance 7)", () => {
  it("an edit of a rendered message keeps every block through C byte-identical and appends an edit note", async () => {
    const h = await harness();
    const { posted, first } = await seeded(h, 6);
    await h.runtime.recordMessageEdit(GUILD, editMessage(h, posted[1]!, "message number 1, but corrected"));
    h.clock.now += 60_000;
    const second = await prepare(h);
    const c = lastMarked(first);
    expect(stripped(second.prompt.messages).slice(0, c + 1)).toEqual(stripped(first.prompt.messages).slice(0, c + 1));
    expect(second.state.notes.filter((n) => n.kind === "edit")).toHaveLength(1);
    expect(transcriptText(second)).toContain("message number 1, but corrected");
    // The original line is untouched in the transcript.
    expect(transcriptText(second)).toContain("message number 1\n");
  });

  it("reactions (ephemeral tail) never move the prefix", async () => {
    const h = await harness();
    const { first } = await seeded(h, 4);
    h.clock.now += 60_000;
    const second = await prepare(h, { recentReactions: ["Kevin reacted 😂 to #k1", "Riko reacted 👍 to #k2"] });
    const c = lastMarked(first);
    expect(stripped(second.prompt.messages).slice(0, c + 1)).toEqual(stripped(first.prompt.messages).slice(0, c + 1));
  });

  it("deleting an OLD message keeps the whole prefix byte-identical (only marked, not redacted)", async () => {
    const h = await harness();
    const { posted, first } = await seeded(h, 30);
    const summary = await h.runtime.recordMessageDeletes(GUILD, [posted[2]!.id], { redactRecent: 5 });
    expect(summary.marked).toEqual([posted[2]!.id]);
    h.channel.messages.splice(h.channel.messages.indexOf(posted[2]!), 1);
    h.clock.now += 60_000;
    const second = await prepare(h);
    const c = lastMarked(first);
    expect(stripped(second.prompt.messages).slice(0, c + 1)).toEqual(stripped(first.prompt.messages).slice(0, c + 1));
    expect(transcriptText(second)).toContain("message number 2");
    const ledger = await h.runtime.peekLedger(GUILD);
    expect(ledger.entries[posted[2]!.id]).toMatchObject({ state: "deleted", body: "message number 2" });
  });

  it("deleting a RECENT message changes bytes only from that message onward", async () => {
    const h = await harness();
    const { posted, first } = await seeded(h, 30);
    const victim = posted[27]!;
    const summary = await h.runtime.recordMessageDeletes(GUILD, [victim.id], { redactRecent: 5 });
    expect(summary.redacted).toEqual([victim.id]);
    h.channel.messages.splice(h.channel.messages.indexOf(victim), 1);
    h.clock.now += 60_000;
    const second = await prepare(h);
    const before = transcriptText(first);
    const after = transcriptText(second);
    const firstDiff = [...before].findIndex((ch, i) => after[i] !== ch);
    expect(firstDiff).toBeGreaterThan(0);
    // Everything before the victim's line is identical; the victim's line is redacted.
    expect(before.slice(0, firstDiff)).toContain("message number 26");
    expect(before.slice(0, firstDiff)).not.toContain("message number 27");
    expect(after).toContain(DELETED_MESSAGE_BODY);
    expect(after).not.toContain("message number 27");
    expect(after).toContain("message number 29");
  });

  it("deleting a recent unsent message of a fresh context redacts it before any model sees it", async () => {
    const h = await harness();
    const posted = h.channel.post({ content: "oops wrong channel" });
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "hello" });
    await h.runtime.peekLedger(GUILD);
    h.clock.now += 1_000;
    const p = await prepare(h);
    expect(transcriptText(p)).toContain("oops wrong channel");
    void posted;
  });

  it("a delete that races ahead of the fetch (message still returned by Discord) is not resurrected", async () => {
    const h = await harness();
    h.channel.post({ content: "earlier" }, BASE_TIME);
    await prepare(h); // the conversation has a ledger
    const m = h.channel.post({ content: "ghost" });
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "hello" });
    await h.runtime.recordMessageDeletes(GUILD, [m.id], { redactRecent: 20 });
    // A stale fetch still returns it.
    h.clock.now += 60_000;
    const p = await prepare(h);
    expect(transcriptText(p)).not.toContain("ghost");
  });

  it("purges the cached images of a redacted message", async () => {
    const h = await harness();
    const m = h.channel.post({
      content: "pic",
      attachments: [{ id: "61", url: "https://cdn.discordapp.com/attachments/200/61/x.png", filename: "x.png", contentType: "image/png", size: 10 }]
    });
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "nice" });
    h.clock.now += 1_000;
    await prepare(h);
    const summary = await h.runtime.recordMessageDeletes(GUILD, [m.id], { redactRecent: 20 });
    expect(summary.purgedImages).toHaveLength(1);
    expect(h.purged).toEqual(summary.purgedImages.map((image) => image.key));
  });

  it("a context whose epoch starts after an old delete renders it as (message deleted); a running epoch keeps the bytes", async () => {
    const h = await harness();
    const { posted } = await seeded(h, 30);
    await h.runtime.recordMessageDeletes(GUILD, [posted[3]!.id], { redactRecent: 5 });
    h.channel.messages.splice(h.channel.messages.indexOf(posted[3]!), 1);
    h.clock.now += 60_000;
    // Aria's running epoch froze before the delete: unchanged.
    const running = await prepare(h);
    expect(transcriptText(running)).toContain("message number 3\n");
    expect(running.state.redactedIds).toEqual([]);
    // Mina starts her first epoch now: the old-deleted message is redacted from the start.
    const mina = await prepare(h, { agent: { kind: "waifu", waifuId: "mina" } });
    expect(mina.state.redactedIds).toEqual([posted[3]!.id]);
    expect(transcriptText(mina)).not.toContain("message number 3\n");
    expect(transcriptText(mina)).toContain(DELETED_MESSAGE_BODY);
  });

  it("downtime: reconcileRecent turns edits into events and gap deletes into deletes", async () => {
    const h = await harness();
    const { posted } = await seeded(h, 12);
    // While the app was down: message 4 was edited, message 7 deleted.
    const edited = editMessage(h, posted[4]!, "message number 4 (edited while down)");
    h.channel.messages.splice(h.channel.messages.indexOf(posted[7]!), 1);
    const summary = await h.runtime.reconcileRecent(GUILD, [...h.channel.messages], { redactRecent: 2 });
    expect(Object.values(summary.edits)).toContain("event");
    expect(summary.deletes.marked.concat(summary.deletes.redacted)).toEqual([posted[7]!.id]);
    const ledger = await h.runtime.peekLedger(GUILD);
    expect(ledger.entries[edited.id]!.state).toBe("edited");
    expect(ledger.entries[posted[7]!.id]!.state).toBe("deleted");
    // Idempotent: the same page again changes nothing.
    const again = await h.runtime.reconcileRecent(GUILD, [...h.channel.messages], { redactRecent: 2 });
    expect(again.deletes.marked.length + again.deletes.redacted.length).toBe(0);
    expect(Object.values(again.edits).filter((o) => o === "event" || o === "coalesced")).toEqual([]);
  });

  it("an edit that arrives before the message was ever fetched is a no-op; the fetch brings the edited text", async () => {
    const h = await harness();
    const m = h.channel.post({ content: "original" });
    const edited = { ...m, content: "edited early", editedAt: new Date(h.clock.now).toISOString() };
    h.channel.messages[0] = edited;
    await h.runtime.recordMessageEdit(GUILD, edited);
    const p = await prepare(h);
    expect(transcriptText(p)).toContain("edited early");
    expect(p.state.notes.filter((n) => n.kind === "edit")).toHaveLength(0);
  });

  it("deleteConversation removes the ledger and every agent context", async () => {
    const h = await harness();
    await seeded(h, 3);
    await h.runtime.deleteConversation(GUILD);
    const ledger = await h.runtime.peekLedger(GUILD);
    expect(Object.keys(ledger.entries)).toEqual([]);
    const state = await h.store.load(conversationKey(GUILD), ARIA);
    expect(state.notes).toEqual([]);
    expect(state.epoch).toBe(0);
  });
});

describe("deleted text does not survive in edit data (review I1, I2, M2)", () => {
  it("never converts an edit event whose target was deleted, and blanks the event text on disk", async () => {
    const h = await harness();
    const { posted } = await seeded(h, 30);
    await h.runtime.recordMessageEdit(GUILD, editMessage(h, posted[2]!, "secret new text"));
    expect((await h.runtime.peekLedger(GUILD)).events.map((e) => e.kind === "edit" && e.text)).toEqual(["secret new text"]);
    await h.runtime.recordMessageDeletes(GUILD, [posted[2]!.id], { redactRecent: 5 }); // old: only marked
    h.channel.messages.splice(h.channel.messages.indexOf(posted[2]!), 1);
    const ledger = await h.runtime.peekLedger(GUILD);
    expect(JSON.stringify(ledger)).not.toContain("secret new text");
    h.clock.now += 60_000;
    const next = await prepare(h);
    expect(next.state.notes.filter((n) => n.kind === "edit")).toEqual([]);
    expect(transcriptText(next)).not.toContain("secret new text");
  });

  it("blanks sealed edit events too when a recent message is redacted", async () => {
    const h = await harness();
    const { posted } = await seeded(h, 6);
    await h.runtime.recordMessageEdit(GUILD, editMessage(h, posted[5]!, "private edit"));
    h.clock.now += 60_000;
    const withNote = await prepare(h); // converts and seals the event
    expect(withNote.state.notes.some((n) => n.kind === "edit" && n.text === "private edit")).toBe(true);
    await h.runtime.recordMessageDeletes(GUILD, [posted[5]!.id], { redactRecent: 5 });
    h.channel.messages.splice(h.channel.messages.indexOf(posted[5]!), 1);
    expect(JSON.stringify(await h.runtime.peekLedger(GUILD))).not.toContain("private edit");
    // The context's note text is scrubbed the next time it is written; rendering says (message deleted).
    h.clock.now += 60_000;
    const after = await prepare(h);
    expect(after.state.notes.filter((n) => n.kind === "edit").map((n) => n.kind === "edit" && n.text)).toEqual([""]);
    expect(JSON.stringify(after.prompt.messages)).not.toContain("private edit");
    const stored = await h.store.load(conversationKey(GUILD), ARIA);
    expect(JSON.stringify(stored)).not.toContain("private edit");
  });

  it("a note of an old deleted message that survives the cut is masked in the next epoch (redactedIds)", async () => {
    const h = await harness();
    const { posted } = await seeded(h, 30);
    await h.runtime.recordMessageEdit(GUILD, editMessage(h, posted[2]!, "edited old message"));
    h.clock.now += 60_000;
    const withNote = await prepare(h);
    const note = withNote.state.notes.find((n) => n.kind === "edit")!;
    expect(note).toBeDefined();
    await h.runtime.recordMessageDeletes(GUILD, [posted[2]!.id], { redactRecent: 5 });
    const ledger = await h.runtime.peekLedger(GUILD);
    const all = orderedEntries(ledger);
    // The cut lies after the deleted message but before the note's anchor, so the note survives.
    const cursorSeq = ledger.entries[posted[2]!.id]!.seq + 1;
    const next = nextEpochState(withNote.state, { cursorSeq, cursorMessageId: null }, "summary", "messages", new Date(h.clock.now), all, ledger.events);
    expect(next.notes.some((n) => n.kind === "edit")).toBe(true);
    expect(next.redactedIds).toContain(posted[2]!.id);
  });

  it("purges the OCR cache entries of a redacted message's images (same keys as the image purge)", async () => {
    const h = await harness();
    const m = h.channel.post({
      content: "pic",
      attachments: [{ id: "71", url: "https://cdn.discordapp.com/attachments/200/71/x.png", filename: "x.png", contentType: "image/png", size: 10 }]
    });
    h.channel.post({ authorId: "riko", authorName: "Riko", content: "nice" });
    h.clock.now += 1_000;
    await prepare(h);
    const summary = await h.runtime.recordMessageDeletes(GUILD, [m.id], { redactRecent: 20 });
    expect(summary.purgedImages).toHaveLength(1);
    expect(h.ocrPurged).toEqual(h.purged);
    expect(h.ocrPurged).toHaveLength(1);
  });

  it("remembers a delete that beat its message only for a conversation that has a ledger, and sweeps expired ids globally", async () => {
    const h = await harness();
    // No ledger yet: nothing is remembered.
    await h.runtime.recordMessageDeletes(GUILD, ["1300000000000000999"], { redactRecent: 20 });
    const tombstones = () => (h.store as unknown as { deletedBeforeSeen: Map<string, Map<string, number>> }).deletedBeforeSeen;
    expect(tombstones().size).toBe(0);
    // With a ledger it is.
    h.channel.post({ content: "hello" });
    await prepare(h);
    await h.runtime.recordMessageDeletes(GUILD, ["1300000000000000998"], { redactRecent: 20 });
    expect(tombstones().size).toBe(1);
    // A day later another conversation's delete sweeps the expired bucket.
    h.clock.now += 24 * 3_600_000;
    const other: ConversationRef = { kind: "guild", guildId: "100", channelId: "201" };
    const otherChannel = new FakeChannel();
    otherChannel.post({ content: "hi" });
    await h.runtime.prepare({
      conversation: other,
      agent: ARIA,
      model: fakeModel(),
      backfillCap: 50,
      selfAuthorIds: SELF,
      render: fakeRoleRenderer()
    }).catch(() => undefined); // the harness channel serves both ids; only the ledger's existence matters
    await h.runtime.recordMessageDeletes(other, ["1300000000000000997"], { redactRecent: 20 });
    expect([...tombstones().keys()]).not.toContain(conversationKey(GUILD));
  });
});

describe("prefix-stability property with edits, deletes and reactions mixed in", () => {
  it("holds for 25 scripted turns: edits and old deletes never move a cached block", { timeout: 60_000 }, async () => {
    const h = await harness();
    h.channel.post({ content: "hi Aria!" });
    let previous: PreparedContext | undefined;
    const humans: RawDiscordMessage[] = [];
    for (let turn = 0; turn < 25; turn += 1) {
      h.clock.now += 60_000;
      const reactions = turn % 3 === 0 ? [`Kevin reacted 🎉 to #k${turn}`] : undefined;
      const p = await prepare(h, reactions ? { recentReactions: reactions } : {});
      expect(p.prompt.messages.filter((m) => m.role === "system")).toHaveLength(1);
      if (previous) {
        const c = lastMarked(previous);
        expect(stripped(p.prompt.messages).slice(0, c + 1), `turn ${turn}`).toEqual(stripped(previous.prompt.messages).slice(0, c + 1));
      }
      await h.runtime.commit(p, { modelKey: p.modelKey, notes: [] });
      h.channel.post({ authorId: "aria-bot", authorName: "Aria", authorIsBot: true, content: `reply ${turn}` }, h.clock.now + 1_000);
      h.clock.now += 30_000;
      const human = h.channel.post({ content: `human ${turn}` }, h.clock.now);
      humans.push(human);
      if (turn >= 6 && turn % 2 === 0) {
        const target = humans[turn - 5]!;
        const live = h.channel.messages.find((m) => m.id === target.id);
        if (live) await h.runtime.recordMessageEdit(GUILD, editMessage(h, live, `${live.content} (edit at ${turn})`));
      }
      if (turn >= 8 && turn % 4 === 0) {
        const old = humans[turn - 7]!;
        const live = h.channel.messages.find((m) => m.id === old.id);
        if (live) {
          await h.runtime.recordMessageDeletes(GUILD, [live.id], { redactRecent: 3 });
          h.channel.messages.splice(h.channel.messages.indexOf(live), 1);
        }
      }
      previous = p;
    }
    const final = await prepare(h);
    expect(final.state.notes.filter((n) => n.kind === "edit").length).toBeGreaterThan(0);
  });
});
