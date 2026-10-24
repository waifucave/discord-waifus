import type { ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { describe, expect, it } from "vitest";
import { installedCatalog } from "../src/models/catalog.js";
import { estimateTokens, IMAGE_TOKENS, resolveTokenBudget } from "../src/orchestration/context/tokens.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/shared/schemas/compaction.js";

const settings = { ...DEFAULT_COMPACTION_SETTINGS };

describe("estimateTokens", () => {
  it("is chars / 3.5 rounded up", () => {
    expect(estimateTokens([{ role: "user", content: "x".repeat(35) }])).toBe(10);
    expect(estimateTokens([{ role: "user", content: "x".repeat(36) }])).toBe(11);
    expect(estimateTokens([])).toBe(0);
  });

  it("scales by the calibration ratio", () => {
    const messages: ProviderMessageLike[] = [{ role: "user", content: "x".repeat(350) }];
    expect(estimateTokens(messages)).toBe(100);
    expect(estimateTokens(messages, { ratio: 1.5 })).toBe(150);
    expect(estimateTokens(messages, { ratio: 0.5 })).toBe(50);
  });

  it("counts system blocks, text, tool calls, thinking and tool results", () => {
    const messages: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "b".repeat(35) }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "c".repeat(7), signature: "" },
          { type: "tool_use", id: "1", name: "tool", input: { a: "x".repeat(20) } }
        ]
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "d".repeat(35) }] }
    ];
    // system 35 + 35 + 7 + 4 + JSON {"a":"xxxx…"} (28) + 35 = 144 chars
    expect(estimateTokens(messages, { system: ["a".repeat(35)] })).toBe(Math.ceil(144 / 3.5));
  });

  it("adds a flat 1,000 tokens per image, unaffected by the ratio", () => {
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "x".repeat(10_000) } };
    const messages: ProviderMessageLike[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(35) }, image] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: [image] }] }
    ];
    expect(estimateTokens(messages)).toBe(10 + 2 * IMAGE_TOKENS);
    expect(estimateTokens(messages, { ratio: 2 })).toBe(20 + 2 * IMAGE_TOKENS);
  });

  it("includes tool definitions", () => {
    const tools = [{ name: "send", description: "Send a message.", inputSchema: { type: "object" } }];
    expect(estimateTokens([], { tools })).toBe(Math.ceil(JSON.stringify(tools[0]).length / 3.5));
  });
});

describe("resolveTokenBudget", () => {
  it("subtracts the requested max output from contextWindow × triggerRatio", () => {
    expect(resolveTokenBudget({ contextWindow: 200_000, maxOutputTokens: 64_000 }, settings, 4_000)).toEqual({
      contextTokens: 200_000,
      maxOutputTokens: 4_000,
      triggerRatio: settings.triggerRatio,
      budgetTokens: Math.floor(200_000 * settings.triggerRatio - 4_000)
    });
  });

  it("defaults the output reserve to min(model max, 8192)", () => {
    expect(resolveTokenBudget({ contextWindow: 100_000, maxOutputTokens: 64_000 }, settings).maxOutputTokens).toBe(8_192);
    expect(resolveTokenBudget({ contextWindow: 100_000, maxOutputTokens: 2_000 }, settings).maxOutputTokens).toBe(2_000);
    expect(resolveTokenBudget({ contextWindow: 100_000 }, settings).maxOutputTokens).toBe(8_192);
  });

  it("ignores unusable requested caps and honours the trigger ratio", () => {
    expect(resolveTokenBudget({ contextWindow: 100_000 }, { triggerRatio: 0.5 }, Number.NaN).budgetTokens).toBe(50_000 - 8_192);
    expect(resolveTokenBudget({ contextWindow: 100_000 }, { triggerRatio: 0.5 }, -1).budgetTokens).toBe(50_000 - 8_192);
  });

  it("never goes negative", () => {
    expect(resolveTokenBudget({ contextWindow: 4_000 }, settings, 10_000).budgetTokens).toBe(0);
  });

  it("works with a real winter catalog row", () => {
    const row = installedCatalog().models.find((model) => model.key === "anthropic/claude-sonnet-5-5");
    expect(row).toBeDefined();
    const contextWindow = row!.contextWindow.value as number;
    expect(resolveTokenBudget({ contextWindow }, settings).budgetTokens).toBeGreaterThan(0);
  });
});
