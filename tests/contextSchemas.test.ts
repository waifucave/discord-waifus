import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import { ConversationRefsSchema, REF_COUNTER_START } from "../src/shared/schemas/context.js";
import { ImageRefSchema, RawDiscordMessageSchema } from "../src/shared/schemas/discordMessage.js";
import {
  DmLimitStateSchema,
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

describe("UsageLedgerEntrySchema", () => {
  const entry = {
    at: AT,
    purpose: "life",
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
      turnId: "turn-1",
      thinkingBlocksDropped: 2,
      costUsd: 0.01,
      finishReason: "stop",
      estimatedInputTokens: 95
    });
    expect(full.costUsd).toBe(0.01);
    expect(full.turnId).toBe("turn-1");
    expect(full.thinkingBlocksDropped).toBe(2);
  });

  it("reads the Living cast purposes and the retired ones (old ledger lines stay readable)", () => {
    for (const purpose of ["life", "maintenance", "detector", "compaction", "assistant", "waifu_reply", "orchestrator", "one_shot", "dream"]) {
      expect(UsageLedgerEntrySchema.parse({ ...entry, purpose }).purpose).toBe(purpose);
    }
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
      limitNotice: "",
      sleepNotice: ""
    });
  });

  it("treats rateLimit null as unlimited, not as 'use the default'", () => {
    expect(WaifuDmSettingsSchema.parse({ rateLimit: null }).rateLimit).toBeNull();
  });

  it("rejects out-of-range limits and long notices", () => {
    expect(() => WaifuDmSettingsSchema.parse({ rateLimit: { maxReplies: 0, windowMinutes: 60 } })).toThrow();
    expect(() => WaifuDmSettingsSchema.parse({ rateLimit: { maxReplies: 5, windowMinutes: 10081 } })).toThrow();
    expect(() => WaifuDmSettingsSchema.parse({ limitNotice: "x".repeat(301) })).toThrow();
    expect(() => WaifuDmSettingsSchema.parse({ sleepNotice: "x".repeat(301) })).toThrow();
  });

  it("parses DM state and limiter counters (Living cast: no run records; sleep notice and auto ids)", () => {
    const state = DmStateSchema.parse({ ...base, waifuId: "aria", userId: "3", botId: "aria", recentRuns: [], pendingTriggerMessageId: "1" });
    expect(state).not.toHaveProperty("recentRuns");
    expect(state).not.toHaveProperty("pendingTriggerMessageId");
    const limits = DmLimitStateSchema.parse({ ...base, waifuId: "aria", userId: "3" });
    expect(limits.replyTimestamps).toEqual([]);
    expect(limits.autoMessageIds).toEqual([]);
    expect(DmLimitStateSchema.parse({ ...base, waifuId: "aria", userId: "3", sleepNoticeSentFor: AT }).sleepNoticeSentFor).toBe(AT);
    expect(() =>
      DmLimitStateSchema.parse({ ...base, waifuId: "aria", userId: "3", replyTimestamps: Array(1001).fill(AT) })
    ).toThrow();
  });
});
