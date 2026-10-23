import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileContextStore } from "../src/orchestration/context/contextStore.js";
import { conversationKey, contextStatePath, conversationLedgerPath } from "../src/orchestration/context/keys.js";
import {
  EARLIER_MESSAGES_NOT_LOADED,
  orderedEntries,
  pruneLedgerEntries,
  reconcileEntries,
  sealEntries
} from "../src/orchestration/context/ledger.js";
import { discordMessageRenderer, EMPTY_GUILD_DIRECTORY } from "../src/orchestration/context/messageRender.js";
import { ConversationLedgerSchema, type ConversationLedger } from "../src/shared/schemas/context.js";
import { StorageService } from "../src/storage/storageService.js";
import { BASE_TIME, raw } from "./contextFixtures.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

const empty = (): ConversationLedger =>
  ConversationLedgerSchema.parse({ schemaVersion: 2, revision: 0, updatedAt: "2026-10-24T00:00:00.000Z", conversationKey: "g_100_200" });
const o = { dir: EMPTY_GUILD_DIRECTORY, timeZone: "UTC" };
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000).toISOString();

describe("ledger reconcile", () => {
  it("creates one entry per Discord message in first-seen order (late arrivals append)", () => {
    const a = raw({ id: "1001", content: "a", createdAt: at(0) });
    const b = raw({ id: "1002", content: "b", createdAt: at(1) });
    let { ledger } = reconcileEntries(empty(), [b, a], discordMessageRenderer, o);
    expect(orderedEntries(ledger).map((e) => [e.id, e.seq])).toEqual([["1001", 1], ["1002", 2]]);
    // A message older than both, seen later, still appends.
    const late = raw({ id: "1000", content: "late", createdAt: at(-5) });
    ({ ledger } = reconcileEntries(ledger, [late], discordMessageRenderer, o));
    expect(orderedEntries(ledger).map((e) => e.id)).toEqual(["1001", "1002", "1000"]);
    expect(ledger.nextSeq).toBe(4);
  });

  it("never merges consecutive messages of the same author", () => {
    const { ledger } = reconcileEntries(empty(), [raw({ id: "1", content: "x" }), raw({ id: "2", content: "y" })], discordMessageRenderer, o);
    expect(Object.keys(ledger.entries)).toHaveLength(2);
  });

  it("replaces an unsealed entry whose rendering changed, keeping seq and the frozen author name", () => {
    let { ledger } = reconcileEntries(empty(), [raw({ id: "1", content: "teh cake" })], discordMessageRenderer, o);
    ({ ledger } = reconcileEntries(
      ledger,
      [raw({ id: "1", content: "the cake", authorName: "Kev (renamed)", editedAt: at(1) })],
      discordMessageRenderer,
      o
    ));
    expect(ledger.entries["1"]).toMatchObject({ seq: 1, body: "the cake", authorName: "Kevin", sealed: false, editedAt: at(1) });
  });

  it("never rewrites a sealed entry (Phase 4), but refreshes re-signed image URLs in place", () => {
    const image = { id: "9", url: "https://cdn.discordapp.com/attachments/200/9/a.png?ex=1", filename: "a.png", contentType: "image/png", size: 10 };
    let { ledger } = reconcileEntries(empty(), [raw({ id: "1", content: "v1", attachments: [image] })], discordMessageRenderer, o);
    ledger = sealEntries(ledger, ["1"])!;
    const resigned = { ...image, url: "https://cdn.discordapp.com/attachments/200/9/a.png?ex=2" };
    const result = reconcileEntries(ledger, [raw({ id: "1", content: "v2 edited", attachments: [resigned] })], discordMessageRenderer, o);
    expect(result.changed).toBe(true);
    expect(result.ledger.entries["1"]).toMatchObject({ body: "v1", sealed: true });
    expect(result.ledger.entries["1"]!.images[0]!.url).toBe(resigned.url);
    expect(reconcileEntries(result.ledger, [raw({ id: "1", content: "v3", attachments: [resigned] })], discordMessageRenderer, o).changed).toBe(false);
  });

  it("drops system messages the renderer drops", () => {
    const { ledger, changed } = reconcileEntries(empty(), [raw({ id: "1", type: 8 })], discordMessageRenderer, o);
    expect(changed).toBe(false);
    expect(ledger.entries).toEqual({});
  });

  it("inserts one 'earlier messages not loaded' entry before the first new message", () => {
    let { ledger } = reconcileEntries(empty(), [raw({ id: "1", content: "old" })], discordMessageRenderer, o);
    ({ ledger } = reconcileEntries(
      ledger,
      [raw({ id: "1", content: "old" }), raw({ id: "50", content: "new1" }), raw({ id: "51", content: "new2" })],
      discordMessageRenderer,
      { ...o, gapBeforeNew: true }
    ));
    expect(orderedEntries(ledger).map((e) => [e.id, e.body])).toEqual([
      ["1", "old"],
      ["gap:50", EARLIER_MESSAGES_NOT_LOADED],
      ["50", "new1"],
      ["51", "new2"]
    ]);
  });

  it("seals entries and edit events", () => {
    const { ledger } = reconcileEntries(empty(), [raw({ id: "1" }), raw({ id: "2" })], discordMessageRenderer, o);
    const withEvent: ConversationLedger = {
      ...ledger,
      events: [{ kind: "edit", seq: 1, at: at(0), messageId: "1", anchorSeq: 2, authorId: "kevin", text: "x", sealed: false }]
    };
    const sealed = sealEntries(withEvent, ["1"], [1])!;
    expect(sealed.entries["1"]!.sealed).toBe(true);
    expect(sealed.entries["2"]!.sealed).toBe(false);
    expect(sealed.events[0]).toMatchObject({ sealed: true });
    expect(sealEntries(sealed, ["1"], [1])).toBeUndefined();
  });
});

describe("ledger pruning (spec 8.1)", () => {
  const ledgerOf = (count: number, replies: Record<string, string> = {}) =>
    reconcileEntries(
      empty(),
      Array.from({ length: count }, (_, i) =>
        raw({ id: String(1000 + i), content: `m${i}`, ...(replies[String(1000 + i)] ? { referenceMessageId: replies[String(1000 + i)] } : {}) })
      ),
      discordMessageRenderer,
      o
    ).ledger;

  it("prunes below the minimum active cursor and never at or above it", () => {
    const pruned = pruneLedgerEntries(ledgerOf(10), { activeCursors: [6, 4] })!;
    expect(orderedEntries(pruned.ledger).map((e) => e.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(pruned.removedIds).toEqual(["1000", "1001", "1002"]);
  });

  it("keeps reply targets of kept entries (so ↩Name never changes)", () => {
    const pruned = pruneLedgerEntries(ledgerOf(10, { "1008": "1000" }), { activeCursors: [6] })!;
    expect(orderedEntries(pruned.ledger).map((e) => e.seq)).toEqual([1, 6, 7, 8, 9, 10]);
  });

  it("an active context with a null cursor protects everything", () => {
    expect(pruneLedgerEntries(ledgerOf(10), { activeCursors: [8, null] })).toBeUndefined();
  });

  it("with no active context only the cap applies", () => {
    expect(pruneLedgerEntries(ledgerOf(10), { activeCursors: [], cap: 20 })).toBeUndefined();
    const pruned = pruneLedgerEntries(ledgerOf(10), { activeCursors: [], cap: 4 })!;
    expect(orderedEntries(pruned.ledger).map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  });
});

describe("FileContextStore", () => {
  async function store(now = () => new Date(BASE_TIME)) {
    const root = await makeTempRoot();
    roots.push(root);
    const storage = new StorageService(root);
    return { root, storage, store: new FileContextStore(storage, { now, timeZone: () => "UTC" }) };
  }
  const key = conversationKey({ kind: "guild", guildId: "100", channelId: "200" });
  const waifu = { kind: "waifu", waifuId: "aria" } as const;

  it("returns an unpersisted default state (revision 0) and persists updates", async () => {
    const { root, store: s } = await store();
    const initial = await s.load(key, waifu);
    expect(initial).toMatchObject({ revision: 0, epoch: 0, cursorSeq: null, headerText: null, timeZone: "UTC", agentId: "waifu-aria" });
    const updated = await s.update(key, waifu, (st) => ({ ...st, summary: "hi" }));
    expect(updated.revision).toBe(1);
    const file = JSON.parse(await readFile(path.join(root, contextStatePath(key, waifu)), "utf8"));
    expect(file.summary).toBe("hi");
  });

  it("serializes concurrent updates of one context on a real temp root", async () => {
    const { store: s } = await store();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        s.update(key, waifu, (st) => ({ ...st, memorySnapshotIds: [...st.memorySnapshotIds, `m${i}`] }))
      )
    );
    const final = await s.load(key, waifu);
    expect(final.revision).toBe(25);
    expect(new Set(final.memorySnapshotIds).size).toBe(25);
  });

  it("concurrent reconciles and ref assignment never lose entries or reuse refs", async () => {
    const { root, store: s } = await store();
    const batches = Array.from({ length: 10 }, (_, b) =>
      Array.from({ length: 5 }, (_, i) => raw({ id: String(5000 + b * 5 + i), content: `b${b}m${i}` }))
    );
    await Promise.all(batches.map((batch) => s.reconcileLedger(key, batch, discordMessageRenderer)));
    const entries = orderedEntries(await s.loadLedger(key));
    expect(entries).toHaveLength(50);
    expect(new Set(entries.map((e) => e.seq)).size).toBe(50);
    const ids = entries.map((e) => e.id);
    const maps = await Promise.all([s.assignRefs(key, ids), s.assignRefs(key, ids.slice(10)), s.assignRefs(key, ids)]);
    const refs = await s.loadRefs(key);
    expect(Object.keys(refs.refs)).toHaveLength(50);
    expect(new Set(Object.values(refs.refs)).size).toBe(50);
    for (const map of maps) for (const [id, ref] of map) expect(refs.refs[id]).toBe(ref);
    expect(JSON.parse(await readFile(path.join(root, conversationLedgerPath(key)), "utf8")).nextSeq).toBe(51);
  });

  it("commitPrepare seals, updates state and prunes below active cursors in one locked write", async () => {
    let now = BASE_TIME;
    const { store: s } = await store(() => new Date(now));
    await s.reconcileLedger(key, Array.from({ length: 6 }, (_, i) => raw({ id: String(7000 + i) })), discordMessageRenderer);
    await s.assignRefs(key, Array.from({ length: 6 }, (_, i) => String(7000 + i)));
    // An idle orchestrator context (> 7 days) does not hold the floor.
    await s.update(key, { kind: "orchestrator" }, (st) => ({ ...st, cursorSeq: 0, lastUsedAt: new Date(now - 8 * 86_400_000).toISOString() }));
    const state = await s.commitPrepare(key, waifu, {
      sealIds: ["7003", "7004", "7005"],
      update: (st) => ({ ...st, cursorSeq: 3, lastUsedAt: new Date(now).toISOString() })
    });
    expect(state.cursorSeq).toBe(3);
    const ledger = await s.loadLedger(key);
    expect(orderedEntries(ledger).map((e) => [e.seq, e.sealed])).toEqual([[3, false], [4, true], [5, true], [6, true]]);
    expect(Object.keys((await s.loadRefs(key)).refs).sort()).toEqual(["7002", "7003", "7004", "7005"]);
    expect(await s.pruneConversation(key)).toEqual({ removed: 0 });
  });

  it("deleteConversation removes contexts, refs and ledger", async () => {
    const { store: s } = await store();
    await s.reconcileLedger(key, [raw({ id: "1" })], discordMessageRenderer);
    await s.update(key, waifu, (st) => st);
    await s.deleteConversation(key);
    expect(await s.listContextAgentIds(key)).toEqual([]);
    expect((await s.loadLedger(key)).entries).toEqual({});
    expect((await s.load(key, waifu)).revision).toBe(0);
  });
});
