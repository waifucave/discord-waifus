import type { ChatMessage } from "@waifucave/gateway";
import { describe, expect, it } from "vitest";
import { FrozenImageRenderer } from "../src/orchestration/context/images.js";
import { renderTranscript, type TranscriptInput } from "../src/orchestration/context/transcript.js";
import {
  ContextStateSchema,
  type ContextNote,
  type LedgerEntry
} from "../src/shared/schemas/context.js";
import { BASE_TIME, FakeImageFetcher } from "./contextFixtures.js";

const at = (minutes: number) => new Date(BASE_TIME + minutes * 60_000).toISOString();
const state = (patch: Record<string, unknown> = {}) =>
  ContextStateSchema.parse({
    schemaVersion: 2,
    revision: 1,
    updatedAt: at(0),
    conversationKey: "g_100_200",
    agentId: "waifu-aria",
    epoch: 0,
    epochStartedAt: at(0),
    lastUsedAt: at(0),
    timeZone: "UTC",
    ...patch
  });

let seq = 0;
function entry(p: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  seq += 1;
  return {
    seq,
    authorId: "kevin",
    authorName: "Kevin",
    authorIsBot: false,
    at: at(seq),
    kind: "default",
    body: `msg ${p.id}`,
    images: [],
    state: "live",
    sealed: false,
    ...p
  };
}

/** Every transcript text block must end with "\n" (wires that join blocks with "" stay readable). */
function textOf(text: string): string {
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1);
}

/** What a wire that joins a message's text blocks with "" (OpenAI chat) sends. */
function joined(messages: ChatMessage[]): string[] {
  return messages.map((m) =>
    typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
  );
}

/** [role, ...text] per message; images as "<image>", tool calls as "call:name(args)". */
function flat(messages: ChatMessage[]): string[][] {
  return messages.map((m) => {
    if (m.role === "tool") return ["tool", `${m.toolCallId}=${m.content}`];
    if (typeof m.content === "string") return [m.role, m.content];
    return [
      m.role,
      ...m.content.map((b) =>
        b.type === "text" ? textOf(b.text) : b.type === "image" ? "<image>" : b.type === "toolCall" ? `call:${b.name}(${b.arguments})#${b.id}` : "<reasoning>"
      )
    ];
  });
}

async function render(o: {
  entries: LedgerEntry[];
  notes?: ContextNote[];
  before?: LedgerEntry[];
  text?: boolean;
  images?: FakeImageFetcher;
  st?: ReturnType<typeof state>;
}) {
  const refs = new Map(o.entries.filter((e) => !e.id.startsWith("gap:")).map((e, i) => [e.id, (360 + i).toString(36)]));
  const all = new Map([...(o.before ?? []), ...o.entries].map((e) => [e.id, e]));
  const st = o.st ?? state();
  const input: TranscriptInput = {
    entries: o.entries,
    notes: o.notes ?? [],
    state: st,
    selfAuthorIds: ["aria-bot"],
    refs,
    lookup: (id) => all.get(id),
    timeZone: "UTC",
    renderToolTurnsAsText: o.text,
    images: new FrozenImageRenderer({ fetcher: o.images ?? new FakeImageFetcher(), acceptsImages: true, maxInlinePerEpoch: 8 })
  };
  return renderTranscript(input);
}

describe("renderTranscript", () => {
  it("renders headers, merges non-self turns with one block per message, self turns as assistant", async () => {
    seq = 0;
    const entries = [
      entry({ id: "1", body: "hi" }),
      entry({ id: "2", authorId: "riko", authorName: "Riko", body: "yo" }),
      entry({ id: "3", authorId: "aria-bot", authorName: "Aria", body: "hey both" }),
      entry({ id: "4", authorId: "aria-bot", authorName: "Aria", body: "cake?" }),
      entry({ id: "5", body: "yes" })
    ];
    const out = await render({ entries });
    expect(flat(out.messages)).toEqual([
      ["user", "— Sat 24 Oct —", "[14:01 #a0] Kevin: hi", "[14:02 #a1] Riko: yo"],
      ["assistant", "hey both", "cake?"],
      ["user", "[14:05 #a4] Kevin: yes"]
    ]);
    expect(out.textBlocks.map((p) => `${p.address.kind}#${p.address.seq}`)).toEqual(["entry#1", "entry#2", "entry#3", "entry#4", "entry#5"]);
  });

  it.each([
    ["a transcript entry", "1", "[14:02 #a1 ↩#a0] Riko: ok"],
    ["the viewer's own message", "self", "[14:02 #a1 ↩you] Riko: ok"],
    ["a message before the cursor", "old", "[14:02 #a1 ↩Mina] Riko: ok"],
    ["an unknown message", "missing", "[14:02 #a1] Riko: ok"]
  ])("reply to %s", async (_name, target, expected) => {
    seq = 0;
    const before = [
      { ...entry({ id: "old", authorId: "mina", authorName: "Mina" }), seq: -1 },
      { ...entry({ id: "self", authorId: "aria-bot", authorName: "Aria" }), seq: -2 }
    ];
    seq = 0;
    const entries = [entry({ id: "1", body: "hi" }), entry({ id: "2", authorId: "riko", authorName: "Riko", body: "ok", replyToId: target })];
    const out = await render({ entries, before });
    expect(flat(out.messages)[0]![3]).toBe(expected);
  });

  it("inserts gap and day-change marker blocks between entries", async () => {
    seq = 0;
    const entries = [
      entry({ id: "1", at: "2026-10-24T20:00:00.000Z" }),
      entry({ id: "2", at: "2026-10-24T20:40:00.000Z" }),
      entry({ id: "3", at: "2026-10-25T09:00:00.000Z" })
    ];
    const out = await render({ entries });
    expect(flat(out.messages)).toEqual([
      [
        "user",
        "— Sat 24 Oct —",
        "[20:00 #a0] Kevin: msg 1",
        "— 40 minutes later —",
        "[20:40 #a1] Kevin: msg 2",
        "— 12 hours later · Sun 25 Oct —",
        "[09:00 #a2] Kevin: msg 3"
      ]
    ]);
  });

  it("renders notes after their anchor by seq; notes anchored before the transcript lead it", async () => {
    seq = 10;
    const entries = [entry({ id: "1" }), entry({ id: "2" })]; // seq 11, 12
    const notes: ContextNote[] = [
      { kind: "direction", id: "n3", seq: 3, anchorSeq: 11, text: "tease Kevin" },
      { kind: "memory", id: "n1", seq: 1, anchorSeq: 5, memoryIds: ["m1"], text: "- Kevin: allergic to peanuts" },
      { kind: "memory", id: "n2", seq: 2, anchorSeq: 11, memoryIds: ["m2"], text: "- Kevin: likes cake" }
    ];
    const out = await render({ entries, notes });
    expect(flat(out.messages)).toEqual([
      [
        "user",
        "<memory_note>- Kevin: allergic to peanuts</memory_note>",
        "— Sat 24 Oct —",
        "[14:11 #a0] Kevin: msg 1",
        "<memory_note>- Kevin: likes cake</memory_note>",
        "<direction>tease Kevin</direction>",
        "[14:12 #a1] Kevin: msg 2"
      ]
    ]);
    expect(out.textBlocks.map((p) => `${p.address.kind}#${p.address.seq}`)).toEqual(["note#1", "entry#11", "note#2", "note#3", "entry#12"]);
  });

  it("renders tool and decision notes as tool-call turns, or as text lines without tools", async () => {
    seq = 0;
    const entries = [entry({ id: "1" }), entry({ id: "2", authorId: "aria-bot", body: "noted!" })];
    const notes: ContextNote[] = [
      { kind: "tool", id: "n1", seq: 1, anchorSeq: 1, callId: "call.1", name: "add_memory", arguments: '{"content":"x"}', result: "saved" },
      { kind: "decision", id: "n2", seq: 2, anchorSeq: 2, decisionId: "d1", call: "reply → Aria", outcome: "sent" }
    ];
    const tools = await render({ entries, notes });
    expect(flat(tools.messages)).toEqual([
      ["user", "— Sat 24 Oct —", "[14:01 #a0] Kevin: msg 1"],
      ["assistant", 'call:add_memory({"content":"x"})#call_1'],
      ["tool", "call_1=saved"],
      ["assistant", "noted!", "call:orchestrator_decision(reply → Aria)#d1"],
      ["tool", "d1=sent"]
    ]);
    // The last text block is the self entry (tool results never carry C).
    expect(tools.textBlocks.at(-1)!.address).toEqual({ kind: "entry", seq: 2 });

    const text = await render({ entries, notes, text: true });
    expect(flat(text.messages)).toEqual([
      ["user", "— Sat 24 Oct —", "[14:01 #a0] Kevin: msg 1", '[tool add_memory] {"content":"x"} → saved'],
      ["assistant", "noted!"],
      ["user", "[decision 14:02] reply → Aria · sent"]
    ]);
  });

  it("renders the not-loaded entry, images and edit notes", async () => {
    seq = 0;
    const fetcher = new FakeImageFetcher();
    fetcher.failKeys.set("att:8", "too_large");
    const entries = [
      entry({ id: "1" }),
      entry({ id: "gap:2", authorId: "system", authorName: "", kind: "system", body: "— earlier messages not loaded —" }),
      entry({
        id: "2",
        body: "look",
        images: [
          { key: "att:7", url: "https://cdn.discordapp.com/attachments/1/7/a.png" },
          { key: "att:8", url: "https://cdn.discordapp.com/attachments/1/8/b.png" }
        ]
      })
    ];
    const notes: ContextNote[] = [
      { kind: "edit", id: "n1", seq: 1, anchorSeq: 3, eventSeq: 1, messageId: "1", authorName: "Kevin", text: "msg 1 (fixed)" },
      { kind: "edit", id: "n2", seq: 2, anchorSeq: 3, eventSeq: 2, messageId: "old", authorName: "Mina", text: "typo" }
    ];
    const out = await render({ entries, notes, images: fetcher });
    expect(flat(out.messages)).toEqual([
      [
        "user",
        "— Sat 24 Oct —",
        "[14:01 #a0] Kevin: msg 1",
        "— earlier messages not loaded —",
        "[14:03 #a1] Kevin: look",
        "<image>",
        "[image]",
        "<edit>Kevin edited #a0: msg 1 (fixed)</edit>",
        "<edit>Mina edited an earlier message: typo</edit>"
      ]
    ]);
    // The text-mode image block belongs to its entry; the inline image is never addressable.
    expect(out.textBlocks.map((p) => `${p.address.kind}#${p.address.seq}`)).toEqual(["entry#1", "entry#2", "entry#3", "entry#3", "note#1", "note#2"]);
  });

  it("keeps separators when a wire joins text blocks with \"\" (split replies, merged human turns)", async () => {
    seq = 0;
    const entries = [
      entry({ id: "1", body: "start" }),
      entry({ id: "2", authorId: "riko", authorName: "Riko", body: "hi" }),
      entry({ id: "3", authorId: "aria-bot", body: "first chunk" }),
      entry({ id: "4", authorId: "aria-bot", body: "second chunk" })
    ];
    const out = await render({ entries });
    expect(joined(out.messages)).toEqual([
      "— Sat 24 Oct —\n[14:01 #a0] Kevin: start\n[14:02 #a1] Riko: hi\n",
      "first chunk\nsecond chunk\n"
    ]);
    // Appending a message never edits the previous block.
    const more = await render({ entries: [...entries, entry({ id: "5", authorId: "aria-bot", body: "third" })] });
    const before = out.messages[1]!.content as Array<{ text: string }>;
    const after = more.messages[1]!.content as Array<{ text: string }>;
    expect(after.slice(0, before.length)).toEqual(before);
    expect(joined(more.messages)[1]).toBe("first chunk\nsecond chunk\nthird\n");
  });
});
