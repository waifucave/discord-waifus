import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import {
  ContextNoteSchema,
  ContextStateSchema,
  ConversationEventSchema,
  ConversationLedgerSchema,
  ConversationRefsSchema,
  LedgerEntrySchema,
  REF_COUNTER_START
} from "../src/shared/schemas/context.js";
import { ImageRefSchema, RawDiscordMessageSchema } from "../src/shared/schemas/discordMessage.js";
import {
  DmLimitStateSchema,
  DmRunRecordSchema,
  DmStateSchema,
  WaifuDmSettingsSchema
} from "../src/shared/schemas/dm.js";
import { UsageLedgerEntrySchema } from "../src/shared/schemas/usage.js";

const AT = "2026-10-23T12:00:00.000Z";
const base = { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: AT };

describe("RawDiscordMessageSchema", () => {
  const minimal = {
    id: "1",
    channelId: "2",
    authorId: "3",
    authorName: "Kevin",
    authorIsBot: false,
    createdAt: AT,
    type: 0,
    content: "hi",
    attachments: [],
    embeds: [],
    stickers: [],
    snapshots: [],
    mentions: { users: {}, roles: {}, channels: {} }
  };

  it("parses a minimal message and keeps optional fields absent", () => {
    const parsed = RawDiscordMessageSchema.parse(minimal);
    expect(parsed.guildId).toBeUndefined();
    expect(parsed.poll).toBeUndefined();
    expect(parsed.referenceMessageId).toBeUndefined();
  });

  it("parses attachments, polls, forwards and mentions", () => {
    const parsed = RawDiscordMessageSchema.parse({
      ...minimal,
      guildId: "9",
      attachments: [{ id: "a", url: "https://cdn.discordapp.com/x.png", filename: "x.png", size: 10, width: 4, height: 4 }],
      poll: { question: "Pizza?", answers: ["yes", "no"] },
      snapshots: [{ content: "fwd", attachments: [] }],
      referenceMessageId: "0",
      mentions: { users: { "7": "Aria" }, roles: {}, channels: { "8": "general" } }
    });
    expect(parsed.mentions.users["7"]).toBe("Aria");
    expect(parsed.poll?.answers).toEqual(["yes", "no"]);
  });

  it("rejects bad shapes", () => {
    expect(() => RawDiscordMessageSchema.parse({ ...minimal, createdAt: "yesterday" })).toThrow();
    expect(() => RawDiscordMessageSchema.parse({ ...minimal, attachments: undefined })).toThrow();
    expect(() => RawDiscordMessageSchema.parse({ ...minimal, mentions: { users: {} } })).toThrow();
    expect(() => RawDiscordMessageSchema.parse({ ...minimal, id: "" })).toThrow();
  });

  it("ImageRef requires a key and url", () => {
    expect(ImageRefSchema.parse({ key: "att:1", url: "https://cdn.discordapp.com/a.png" }).key).toBe("att:1");
    expect(ImageRefSchema.parse({ key: "att:1", url: "u", conversationKey: "g_1_2" }).conversationKey).toBe("g_1_2");
    expect(() => ImageRefSchema.parse({ url: "https://cdn.discordapp.com/a.png" })).toThrow();
    expect(() => ImageRefSchema.parse({ key: "att:1", url: "u", bytes: -1 })).toThrow();
  });
});

describe("ContextNoteSchema", () => {
  const anchor = { id: "n1", anchorSeq: 4, seq: 1 };

  it("accepts each note kind", () => {
    expect(ContextNoteSchema.parse({ kind: "memory", ...anchor, memoryIds: ["m1"], text: "likes tea" }).kind).toBe("memory");
    expect(ContextNoteSchema.parse({ kind: "direction", ...anchor, text: "be brief" }).kind).toBe("direction");
    expect(
      ContextNoteSchema.parse({ kind: "tool", ...anchor, callId: "c", name: "add_memory", arguments: "{}", result: "ok" }).kind
    ).toBe("tool");
    expect(
      ContextNoteSchema.parse({ kind: "decision", ...anchor, decisionId: "d", call: "{}", outcome: "sent" }).kind
    ).toBe("decision");
    expect(
      ContextNoteSchema.parse({ kind: "edit", ...anchor, eventSeq: 3, messageId: "m", authorName: "Kevin", text: "fixed" }).kind
    ).toBe("edit");
  });

  it("rejects unknown kinds, missing anchors and null anchors", () => {
    expect(() => ContextNoteSchema.parse({ kind: "other", ...anchor, text: "x" })).toThrow();
    expect(() => ContextNoteSchema.parse({ kind: "direction", id: "n", seq: 1, text: "x" })).toThrow();
    expect(() => ContextNoteSchema.parse({ kind: "direction", ...anchor, anchorSeq: null, text: "x" })).toThrow();
    expect(() => ContextNoteSchema.parse({ kind: "memory", ...anchor, text: "x" })).toThrow(); // memoryIds required
  });
});

describe("ContextStateSchema", () => {
  const minimal = {
    ...base,
    conversationKey: "g_1_2",
    agentId: "waifu-aria",
    epoch: 0,
    epochStartedAt: AT,
    lastUsedAt: AT,
    timeZone: "UTC"
  };

  it("fills defaults for everything optional", () => {
    const state = ContextStateSchema.parse(minimal);
    expect(state).toMatchObject({
      cursorSeq: null,
      cursorMessageId: null,
      lastBreakpoint: null,
      summary: null,
      headerText: null,
      memorySnapshotIds: [],
      memoryNoteCount: 0,
      imageModes: {},
      inlineImageCount: 0,
      notes: [],
      noteSeq: 0,
      tokenCalibration: {}
    });
    expect(state.lastCompaction).toBeUndefined();
  });

  it("round-trips a full state", () => {
    const full = {
      ...minimal,
      epoch: 3,
      cursorSeq: 10,
      cursorMessageId: "99",
      lastBreakpoint: { kind: "note", seq: 2 },
      summary: "They talked about tea.",
      headerText: "<header/>",
      memorySnapshotIds: ["m1"],
      memoryNoteCount: 1,
      imageModes: { "att:1": { mode: "inline" }, "att:2": { mode: "text", text: "[image: a cat]" } },
      inlineImageCount: 1,
      notes: [{ kind: "direction", id: "n1", anchorSeq: 10, seq: 1, text: "go" }],
      noteSeq: 1,
      tokenCalibration: { "anthropic:claude": { ratio: 1.1, samples: 4, updatedAt: AT } },
      lastCompaction: { at: AT, trigger: "tokens", ok: false, error: "timeout" }
    };
    expect(ContextStateSchema.parse(full)).toEqual(full);
  });

  it("rejects bad shapes", () => {
    expect(() => ContextStateSchema.parse({ ...minimal, epoch: -1 })).toThrow();
    expect(() => ContextStateSchema.parse({ ...minimal, timeZone: undefined })).toThrow();
    expect(() => ContextStateSchema.parse({ ...minimal, lastBreakpoint: { kind: "tail", seq: 1 } })).toThrow();
    expect(() => ContextStateSchema.parse({ ...minimal, imageModes: { k: { mode: "text" } } })).toThrow();
    expect(() => ContextStateSchema.parse({ ...minimal, lastCompaction: { at: AT, trigger: "sometimes", ok: true } })).toThrow();
    expect(() => ContextStateSchema.parse({ ...minimal, schemaVersion: 1 })).toThrow();
  });
});

describe("ConversationRefsSchema", () => {
  it("starts the counter at 360 (ref a0)", () => {
    const refs = ConversationRefsSchema.parse({ ...base, conversationKey: "g_1_2" });
    expect(refs.counter).toBe(REF_COUNTER_START);
    expect((360).toString(36)).toBe("a0");
    expect(refs.refs).toEqual({});
  });

  it("rejects non-string refs", () => {
    expect(() => ConversationRefsSchema.parse({ ...base, conversationKey: "g_1_2", refs: { "1": 5 } })).toThrow();
  });
});

describe("ConversationLedgerSchema", () => {
  const entry = {
    id: "100",
    seq: 1,
    authorId: "3",
    authorName: "Kevin",
    authorIsBot: false,
    at: AT,
    kind: "default",
    body: "hello",
    state: "live",
    sealed: false
  };

  it("defaults an empty ledger and entry images", () => {
    const ledger = ConversationLedgerSchema.parse({ ...base, conversationKey: "g_1_2" });
    expect(ledger).toMatchObject({ nextSeq: 1, entries: {}, events: [] });
    expect(LedgerEntrySchema.parse(entry).images).toEqual([]);
  });

  it("parses entries and edit/delete events", () => {
    const ledger = ConversationLedgerSchema.parse({
      ...base,
      conversationKey: "g_1_2",
      nextSeq: 3,
      entries: { "100": entry },
      events: [
        { kind: "edit", seq: 2, at: AT, messageId: "100", anchorSeq: 1, authorId: "3", text: "hello!", sealed: true },
        { kind: "delete", seq: 3, at: AT, messageId: "100", anchorSeq: 1 }
      ]
    });
    expect(ledger.events).toHaveLength(2);
  });

  it("rejects bad shapes", () => {
    expect(() => LedgerEntrySchema.parse({ ...entry, kind: "weird" })).toThrow();
    expect(() => LedgerEntrySchema.parse({ ...entry, state: "gone" })).toThrow();
    expect(() => LedgerEntrySchema.parse({ ...entry, sealed: undefined })).toThrow();
    expect(() =>
      ConversationEventSchema.parse({ kind: "edit", seq: 1, at: AT, messageId: "1", anchorSeq: 0, authorId: "3", text: "x".repeat(501), sealed: false })
    ).toThrow();
    expect(() => ConversationEventSchema.parse({ kind: "react", seq: 1, at: AT })).toThrow();
  });
});

describe("UsageLedgerEntrySchema", () => {
  const entry = {
    at: AT,
    purpose: "waifu_reply",
    providerId: "anthropic",
    modelId: "claude-x",
    status: "ok",
    usageKnown: true,
    inputTokens: 100,
    outputTokens: 20,
    durationMs: 900
  };

  it("parses a minimal ok entry and optional attribution/cost fields", () => {
    expect(UsageLedgerEntrySchema.parse(entry).cacheReadTokens).toBeUndefined();
    const full = UsageLedgerEntrySchema.parse({
      ...entry,
      agentId: "waifu-aria",
      waifuId: "aria",
      guildId: "1",
      channelId: "2",
      conversationKey: "g_1_2",
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 5,
      costUsd: 0.01,
      finishReason: "stop",
      estimatedInputTokens: 95
    });
    expect(full.costUsd).toBe(0.01);
  });

  it("accepts failed calls with unknown usage", () => {
    const parsed = UsageLedgerEntrySchema.parse({
      ...entry,
      status: "failed",
      usageKnown: false,
      inputTokens: 0,
      outputTokens: 0,
      errorKind: "context_overflow"
    });
    expect(parsed.errorKind).toBe("context_overflow");
  });

  it("rejects unknown purposes, statuses and negative counts", () => {
    expect(() => UsageLedgerEntrySchema.parse({ ...entry, purpose: "chatting" })).toThrow();
    expect(() => UsageLedgerEntrySchema.parse({ ...entry, status: "partial" })).toThrow();
    expect(() => UsageLedgerEntrySchema.parse({ ...entry, inputTokens: -1 })).toThrow();
    expect(() => UsageLedgerEntrySchema.parse({ ...entry, usageKnown: undefined })).toThrow();
  });
});

describe("DM schemas", () => {
  it("applies the spec defaults", () => {
    expect(WaifuDmSettingsSchema.parse({})).toEqual({
      allowDms: false,
      rateLimit: { maxReplies: 30, windowMinutes: 60 },
      notifyWhenLimited: true,
      limitNotice: ""
    });
  });

  it("treats rateLimit null as unlimited, not as 'use the default'", () => {
    expect(WaifuDmSettingsSchema.parse({ rateLimit: null }).rateLimit).toBeNull();
  });

  it("rejects out-of-range limits and long notices", () => {
    expect(() => WaifuDmSettingsSchema.parse({ rateLimit: { maxReplies: 0, windowMinutes: 60 } })).toThrow();
    expect(() => WaifuDmSettingsSchema.parse({ rateLimit: { maxReplies: 5, windowMinutes: 10081 } })).toThrow();
    expect(() => WaifuDmSettingsSchema.parse({ limitNotice: "x".repeat(301) })).toThrow();
  });

  it("parses DM state, run records and limiter counters", () => {
    expect(DmRunRecordSchema.parse({ id: "r", at: AT, triggerMessageId: "1", status: "sent" }).messageIds).toEqual([]);
    expect(() => DmRunRecordSchema.parse({ id: "r", at: AT, triggerMessageId: "1", status: "ghosted" })).toThrow();
    expect(DmStateSchema.parse({ ...base, waifuId: "aria", userId: "3", botId: "aria" }).recentRuns).toEqual([]);
    expect(DmLimitStateSchema.parse({ ...base, waifuId: "aria", userId: "3" }).replyTimestamps).toEqual([]);
    expect(() =>
      DmLimitStateSchema.parse({ ...base, waifuId: "aria", userId: "3", replyTimestamps: Array(1001).fill(AT) })
    ).toThrow();
  });
});
