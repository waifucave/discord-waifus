import { describe, expect, it } from "vitest";
import {
  DELETED_MESSAGE_BODY,
  MAX_EDIT_EVENTS_PER_MESSAGE,
  applyDeletes,
  applyEdit,
  deletedEntryIdsAfter,
  detectGapDeletes,
  entryRenderHash,
  isRedactedEntry,
  orderedEntries,
  pruneLedgerEntries,
  reconcileEntries,
  sealEntries
} from "../src/orchestration/context/ledger.js";
import { discordMessageRenderer, EMPTY_GUILD_DIRECTORY } from "../src/orchestration/context/messageRender.js";
import { ConversationLedgerSchema, type ConversationLedger } from "../src/shared/schemas/context.js";
import { BASE_TIME, raw } from "./contextFixtures.js";

const empty = (): ConversationLedger =>
  ConversationLedgerSchema.parse({ schemaVersion: 2, revision: 0, updatedAt: "2026-10-24T00:00:00.000Z", conversationKey: "g_100_200" });
const o = { dir: EMPTY_GUILD_DIRECTORY, timeZone: "UTC" };
const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000).toISOString();

/** A ledger of `count` messages with ids 1001.., the first `sealed` of them sealed (as a build would). */
function ledgerOf(count: number, sealed: number): ConversationLedger {
  const messages = Array.from({ length: count }, (_, i) => raw({ id: String(1001 + i), content: `m${i}`, createdAt: at(i) }));
  const { ledger } = reconcileEntries(empty(), messages, discordMessageRenderer, o);
  const ids = messages.slice(0, sealed).map((m) => m.id);
  return sealEntries(ledger, ids) ?? ledger;
}

const edited = (id: string, content: string, editedMinute: number, createdMinute = 0) =>
  raw({ id, content, createdAt: at(createdMinute), editedAt: at(editedMinute) });

describe("edits", () => {
  it("replace an unsealed entry in place (no event) and keep its seq", () => {
    const ledger = ledgerOf(3, 0);
    const result = applyEdit(ledger, edited("1002", "fixed", 5, 1), discordMessageRenderer, o);
    expect(result.outcome).toBe("replaced");
    expect(result.ledger.entries["1002"]).toMatchObject({ body: "fixed", seq: 2, sealed: false });
    expect(result.ledger.events).toEqual([]);
  });

  it("keep a sealed entry's body byte-identical and add one edit event anchored to the newest entry", () => {
    const ledger = ledgerOf(3, 3);
    const before = entryRenderHash(ledger.entries["1001"]!);
    const result = applyEdit(ledger, edited("1001", "actually saturday", 5), discordMessageRenderer, o);
    expect(result.outcome).toBe("event");
    expect(entryRenderHash(result.ledger.entries["1001"]!)).toBe(before);
    expect(result.ledger.entries["1001"]).toMatchObject({ state: "edited", editedAt: at(5), sealed: true });
    expect(result.ledger.events).toHaveLength(1);
    expect(result.ledger.events[0]).toMatchObject({
      kind: "edit",
      messageId: "1001",
      text: "actually saturday",
      anchorSeq: 3,
      sealed: false
    });
  });

  it("coalesce a second edit into the open event under a fresh seq", () => {
    let ledger = ledgerOf(2, 2);
    ledger = applyEdit(ledger, edited("1001", "v2", 5), discordMessageRenderer, o).ledger;
    const firstSeq = ledger.events[0]!.seq;
    const second = applyEdit(ledger, edited("1001", "v3", 6), discordMessageRenderer, o);
    expect(second.outcome).toBe("coalesced");
    expect(second.ledger.events).toHaveLength(1);
    expect(second.ledger.events[0]).toMatchObject({ text: "v3" });
    expect(second.ledger.events[0]!.seq).toBeGreaterThan(firstSeq);
  });

  it("cap converted edit events per message and only move editedAt afterwards", () => {
    let ledger = ledgerOf(2, 2);
    for (let i = 0; i < MAX_EDIT_EVENTS_PER_MESSAGE; i += 1) {
      ledger = applyEdit(ledger, edited("1001", `v${i}`, 5 + i), discordMessageRenderer, o).ledger;
      // A context converted the event: it is sealed, so the next edit opens a new one.
      ledger = sealEntries(ledger, [], ledger.events.map((e) => e.seq)) ?? ledger;
    }
    expect(ledger.events).toHaveLength(MAX_EDIT_EVENTS_PER_MESSAGE);
    const capped = applyEdit(ledger, edited("1001", "one more", 30), discordMessageRenderer, o);
    expect(capped.outcome).toBe("capped");
    expect(capped.ledger.events).toHaveLength(MAX_EDIT_EVENTS_PER_MESSAGE);
    expect(capped.ledger.entries["1001"]!.editedAt).toBe(at(30));
  });

  it("ignore a duplicate or out-of-order older edit (events arrive in any order)", () => {
    let ledger = ledgerOf(2, 2);
    ledger = applyEdit(ledger, edited("1001", "newer", 9), discordMessageRenderer, o).ledger;
    const older = applyEdit(ledger, edited("1001", "older", 4), discordMessageRenderer, o);
    expect(older.outcome).toBe("ignored");
    expect(older.ledger).toBe(ledger);
    const dup = applyEdit(ledger, edited("1001", "newer", 9), discordMessageRenderer, o);
    expect(dup.outcome).toBe("ignored");
  });

  it("ignore an edit that leaves the rendered text unchanged (embed-only update)", () => {
    const ledger = ledgerOf(1, 1);
    const result = applyEdit(ledger, edited("1001", "m0", 5), discordMessageRenderer, o);
    expect(result.outcome).toBe("ignored");
    expect(result.ledger.events).toEqual([]);
  });

  it("treat an edit of a message the ledger does not hold as unknown (it arrives already edited)", () => {
    const ledger = ledgerOf(1, 1);
    expect(applyEdit(ledger, edited("9999", "x", 5), discordMessageRenderer, o)).toMatchObject({ outcome: "unknown" });
    const later = reconcileEntries(ledger, [edited("9999", "arrives edited", 5, 2)], discordMessageRenderer, o).ledger;
    expect(later.entries["9999"]).toMatchObject({ body: "arrives edited", editedAt: at(5) });
    expect(later.events).toEqual([]);
  });

  it("clip very long edit text", () => {
    const ledger = ledgerOf(1, 1);
    const result = applyEdit(ledger, edited("1001", "x".repeat(900), 5), discordMessageRenderer, o);
    const event = result.ledger.events[0]!;
    expect(event.kind === "edit" && event.text.length).toBeLessThanOrEqual(500);
  });

  it("downtime: reconcile of a fetched page turns newer editedAt on sealed entries into events", () => {
    const ledger = ledgerOf(3, 3);
    const page = [raw({ id: "1001", content: "m0", createdAt: at(0) }), edited("1002", "m1 (fixed while down)", 40, 1), raw({ id: "1003", content: "m2", createdAt: at(2) })];
    const result = reconcileEntries(ledger, page, discordMessageRenderer, { ...o, now: new Date(BASE_TIME + 60 * 60_000) });
    expect(result.changed).toBe(true);
    expect(result.ledger.entries["1002"]!.body).toBe("m1");
    expect(result.ledger.events).toHaveLength(1);
    expect(result.ledger.events[0]).toMatchObject({ kind: "edit", messageId: "1002", text: "m1 (fixed while down)" });
    // Reconciling the same page again is a no-op.
    expect(reconcileEntries(result.ledger, page, discordMessageRenderer, o).changed).toBe(false);
  });

  it("an edit never resurrects a deleted entry", () => {
    const deleted = applyDeletes(ledgerOf(3, 3), ["1003"], { redactRecent: 20 }).ledger;
    expect(applyEdit(deleted, edited("1003", "zombie", 9, 2), discordMessageRenderer, o).outcome).toBe("ignored");
    expect(reconcileEntries(deleted, [raw({ id: "1003", content: "zombie", createdAt: at(2) })], discordMessageRenderer, o).changed).toBe(false);
  });
});

describe("deletes (hybrid rule)", () => {
  it("redact an unsealed entry in place", () => {
    const ledger = ledgerOf(3, 1);
    const result = applyDeletes(ledger, ["1003"], { redactRecent: 0 });
    expect(result.redacted).toEqual(["1003"]);
    expect(result.ledger.entries["1003"]).toMatchObject({ body: DELETED_MESSAGE_BODY, state: "deleted", images: [] });
    expect(result.ledger.events.at(-1)).toMatchObject({ kind: "delete", messageId: "1003" });
  });

  it("redact a sealed entry among the newest redactRecent", () => {
    const result = applyDeletes(ledgerOf(10, 10), ["1009"], { redactRecent: 3 });
    expect(result.redacted).toEqual(["1009"]);
    expect(result.ledger.entries["1009"]!.body).toBe(DELETED_MESSAGE_BODY);
  });

  it("only mark an old sealed entry: bytes the model saw are unchanged", () => {
    const ledger = ledgerOf(10, 10);
    const before = entryRenderHash(ledger.entries["1002"]!);
    const result = applyDeletes(ledger, ["1002"], { redactRecent: 3 });
    expect(result.marked).toEqual(["1002"]);
    expect(result.redacted).toEqual([]);
    expect(result.ledger.entries["1002"]).toMatchObject({ body: "m1", state: "deleted" });
    expect(entryRenderHash(result.ledger.entries["1002"]!)).toBe(before);
    expect(result.purgedImages).toEqual([]);
  });

  it("report unknown ids, ignore repeated deletes and drop open edit events of the message", () => {
    let ledger = ledgerOf(4, 4);
    ledger = applyEdit(ledger, edited("1004", "edited", 8, 3), discordMessageRenderer, o).ledger;
    expect(ledger.events).toHaveLength(1);
    const result = applyDeletes(ledger, ["1004", "1004", "nope"], { redactRecent: 20 });
    expect(result.unknown).toEqual(["nope"]);
    expect(result.redacted).toEqual(["1004"]);
    expect(result.ledger.events.filter((e) => e.kind === "edit")).toEqual([]);
    expect(result.ledger.events.filter((e) => e.kind === "delete")).toHaveLength(1);
    const again = applyDeletes(result.ledger, ["1004"], { redactRecent: 20 });
    expect(again.ledger).toBe(result.ledger);
  });

  it("purge the images of redacted entries", () => {
    const withImage = raw({
      id: "1001",
      content: "look",
      createdAt: at(0),
      attachments: [{ id: "61", url: "https://cdn.discordapp.com/attachments/200/61/x.png", filename: "x.png", contentType: "image/png", size: 10 }]
    });
    const { ledger } = reconcileEntries(empty(), [withImage], discordMessageRenderer, o);
    expect(ledger.entries["1001"]!.images.length).toBe(1);
    const result = applyDeletes(ledger, ["1001"], { redactRecent: 20 });
    expect(result.purgedImages).toHaveLength(1);
    expect(result.ledger.entries["1001"]!.images).toEqual([]);
  });

  it("isRedactedEntry: redacted body, or marked and listed in the context's redactedIds", () => {
    const ledger = ledgerOf(10, 10);
    const marked = applyDeletes(ledger, ["1002"], { redactRecent: 3 }).ledger.entries["1002"]!;
    expect(isRedactedEntry(marked)).toBe(false);
    expect(isRedactedEntry(marked, ["1002"])).toBe(true);
    const redacted = applyDeletes(ledger, ["1010"], { redactRecent: 3 }).ledger.entries["1010"]!;
    expect(isRedactedEntry(redacted)).toBe(true);
    expect(isRedactedEntry(ledger.entries["1003"]!, ["1003"])).toBe(false);
  });

  it("deletedEntryIdsAfter lists deleted entries newer than the epoch cursor", () => {
    const ledger = applyDeletes(ledgerOf(10, 10), ["1002", "1008"], { redactRecent: 1 }).ledger;
    expect(deletedEntryIdsAfter(orderedEntries(ledger), null).sort()).toEqual(["1002", "1008"]);
    expect(deletedEntryIdsAfter(orderedEntries(ledger), 5)).toEqual(["1008"]);
  });

  it("detectGapDeletes finds ledger entries missing from the middle of a contiguous page", () => {
    const ledger = ledgerOf(6, 6);
    const page = ["1001", "1002", "1004", "1006"].map((id, i) => raw({ id, content: "x", createdAt: at(Number(id) - 1001 + i * 0) }));
    // 1003 and 1005 lie between the oldest and the newest page entry but are not in it.
    expect(detectGapDeletes(ledger, page).sort()).toEqual(["1003", "1005"]);
    expect(detectGapDeletes(ledger, [])).toEqual([]);
  });
});

describe("pruning", () => {
  it("drops events together with the entries they target", () => {
    let ledger = ledgerOf(30, 30);
    ledger = applyEdit(ledger, edited("1001", "old edit", 99), discordMessageRenderer, o).ledger;
    ledger = applyEdit(ledger, edited("1030", "new edit", 99, 29), discordMessageRenderer, o).ledger;
    ledger = applyDeletes(ledger, ["1002"], { redactRecent: 1 }).ledger;
    expect(ledger.events).toHaveLength(3);
    const pruned = pruneLedgerEntries(ledger, { activeCursors: [20], protectNewest: 5 });
    expect(pruned).toBeDefined();
    expect(pruned!.removedIds).toContain("1001");
    expect(pruned!.ledger.events.map((e) => e.messageId)).toEqual(["1030"]);
  });

  it("keeps everything at or above an active cursor, including edit events there", () => {
    let ledger = ledgerOf(30, 30);
    ledger = applyEdit(ledger, edited("1025", "mid edit", 99, 24), discordMessageRenderer, o).ledger;
    const pruned = pruneLedgerEntries(ledger, { activeCursors: [20], protectNewest: 5 })!;
    expect(pruned.ledger.entries["1025"]).toBeDefined();
    expect(pruned.ledger.events).toHaveLength(1);
  });
});

describe("out-of-order arrival", () => {
  it("a delete before the message is ever seen leaves it unknown; the store tombstone covers the race", () => {
    const ledger = ledgerOf(2, 2);
    const result = applyDeletes(ledger, ["5000"], { redactRecent: 20 });
    expect(result.unknown).toEqual(["5000"]);
    expect(result.ledger).toBe(ledger);
    // The tombstone is fed back as skipIds so a stale fetch cannot add the message afterwards.
    const stale = reconcileEntries(ledger, [raw({ id: "5000", content: "ghost", createdAt: at(9) })], discordMessageRenderer, {
      ...o,
      skipIds: new Set(["5000"])
    });
    expect(stale.ledger.entries["5000"]).toBeUndefined();
  });
});
