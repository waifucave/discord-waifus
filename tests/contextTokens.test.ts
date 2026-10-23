import { Registry, type ChatMessage, type ResolvedModel } from "@waifucave/gateway";
import { describe, expect, it } from "vitest";
import { estimateTokens, resolveTokenBudget } from "../src/orchestration/context/tokens.js";
import { NoopCompaction } from "../src/orchestration/context/types.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";

const settings = { ...DEFAULT_COMPACTION_SETTINGS };

function model(contextTokens: number, maxOutputTokens: number): ResolvedModel {
  return { limits: { contextTokens, maxOutputTokens } } as ResolvedModel;
}

describe("estimateTokens", () => {
  it("is chars / 3.5 rounded up", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(35) }])).toBe(10);
    expect(estimateTokens([{ role: "user", content: "x".repeat(36) }])).toBe(11);
    expect(estimateTokens([])).toBe(0);
  });

  it("scales by the calibration ratio", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(350) }];
    expect(estimateTokens(messages)).toBe(100);
    expect(estimateTokens(messages, undefined, 1.5)).toBe(150);
    expect(estimateTokens(messages, undefined, 0.5)).toBe(50);
  });

  it("counts text blocks, tool calls, reasoning and tool results", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: [{ type: "text", text: "a".repeat(35) }] },
      { role: "user", content: [{ type: "text", text: "b".repeat(35) }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "c".repeat(7) },
          { type: "toolCall", id: "1", name: "tool", arguments: "x".repeat(28) }
        ]
      },
      { role: "tool", toolCallId: "1", content: "d".repeat(35) }
    ];
    // 35 + 35 + 7 + 4 + 28 + 35 = 144 chars
    expect(estimateTokens(messages)).toBe(Math.ceil(144 / 3.5));
  });

  it("adds a flat 1,000 tokens per image, unaffected by the ratio", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "x".repeat(35) },
          { type: "image", mimeType: "image/png", data: "A".repeat(100_000) },
          { type: "image", mimeType: "image/png", data: "B".repeat(100_000) }
        ]
      }
    ];
    expect(estimateTokens(messages)).toBe(10 + 2_000);
    expect(estimateTokens(messages, undefined, 2)).toBe(20 + 2_000);
  });

  it("includes tool definitions", () => {
    const tools = [{ name: "t", parameters: { type: "object" } }];
    const withTools = estimateTokens([], tools);
    expect(withTools).toBe(Math.ceil(JSON.stringify(tools[0]).length / 3.5));
    expect(withTools).toBeGreaterThan(0);
  });
});

describe("resolveTokenBudget", () => {
  it("subtracts the configured maxOutputTokens from contextTokens × triggerRatio", () => {
    expect(resolveTokenBudget(model(200_000, 64_000), { maxOutputTokens: 4_000 }, settings)).toEqual({
      contextTokens: 200_000,
      maxOutputTokens: 4_000,
      triggerRatio: 0.7,
      budgetTokens: 136_000
    });
  });

  it("defaults the output reserve to min(model max, 8192)", () => {
    expect(resolveTokenBudget(model(200_000, 64_000), {}, settings).budgetTokens).toBe(140_000 - 8_192);
    expect(resolveTokenBudget(model(100_000, 4_096), {}, settings)).toMatchObject({
      maxOutputTokens: 4_096,
      budgetTokens: 70_000 - 4_096
    });
  });

  it("ignores unusable maxOutputTokens params and honours the trigger ratio", () => {
    const bad = resolveTokenBudget(model(100_000, 4_096), { maxOutputTokens: "lots" }, { ...settings, triggerRatio: 0.5 });
    expect(bad).toMatchObject({ maxOutputTokens: 4_096, triggerRatio: 0.5, budgetTokens: 50_000 - 4_096 });
  });

  it("never goes negative", () => {
    expect(resolveTokenBudget(model(10_000, 8_000), { maxOutputTokens: 9_000 }, settings).budgetTokens).toBe(0);
  });

  it("works with a real gateway catalog model", () => {
    const real = Registry.load().resolve("deepseek", "deepseek-v4-pro");
    expect(real).toBeDefined();
    const budget = resolveTokenBudget(real!, {}, settings);
    expect(budget.contextTokens).toBe(real!.limits.contextTokens);
    expect(budget.budgetTokens).toBeGreaterThan(0);
  });
});

describe("NoopCompaction", () => {
  it("never triggers and has nothing in flight", async () => {
    expect(NoopCompaction.inFlight("g_1_2" as never, { kind: "orchestrator" })).toBeUndefined();
    expect(
      NoopCompaction.check({
        state: {} as never,
        prompt: {} as never,
        budget: { contextTokens: 1, maxOutputTokens: 1, triggerRatio: 0.7, budgetTokens: 0 },
        settings
      })
    ).toBeUndefined();
    await expect(
      NoopCompaction.compact({
        conversation: { kind: "guild", guildId: "1", channelId: "2" },
        agent: { kind: "orchestrator" },
        prompt: {} as never,
        trigger: "manual",
        summarize: async () => "",
        settings
      })
    ).resolves.toBeUndefined();
  });
});
