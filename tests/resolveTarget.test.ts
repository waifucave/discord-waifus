import { describe, expect, it } from "vitest";
import { LEGACY_MODEL_MAP, resolveModelTarget } from "../src/orchestration/pipeline/resolveTarget.js";

describe("resolveModelTarget", () => {
  it("maps the four retired catalog ids per MIGRATION_PLAN §7.3", () => {
    expect(resolveModelTarget({ modelId: "gpt-4o" })).toEqual({ providerId: "openai", modelId: "gpt-5-mini", remapped: true });
    expect(resolveModelTarget({ modelId: "gpt-4o-mini" })).toEqual({ providerId: "openai", modelId: "gpt-5-nano", remapped: true });
    expect(resolveModelTarget({ modelId: "glm-5-turbo" })).toEqual({ providerId: "zai", modelId: "glm-5", remapped: true });
    expect(resolveModelTarget({ modelId: "gemini-3.5-flash" })).toEqual({ providerId: "google-ai-studio", modelId: "gemini-3-flash-preview", remapped: true });
    // removed in gateway 0.3.0 (2026-08 refresh): shut-down/delisted models remap to their announced replacements
    expect(resolveModelTarget({ modelId: "gemini-2-0-flash" })).toEqual({ providerId: "google-ai-studio", modelId: "gemini-3.6-flash", remapped: true });
    expect(resolveModelTarget({ modelId: "gemini-2.0-flash" })).toEqual({ providerId: "google-ai-studio", modelId: "gemini-3.6-flash", remapped: true });
    expect(resolveModelTarget({ modelId: "mimo-v2-flash" })).toEqual({ providerId: "xiaomi", modelId: "mimo-v2.5", remapped: true });
    expect(resolveModelTarget({ modelId: "trinity-large" })).toEqual({ providerId: "openrouter", modelId: "arcee-ai/trinity-large-thinking", remapped: true });
    expect(Object.keys(LEGACY_MODEL_MAP)).toHaveLength(8);
  });

  it("passes through ids that exist in the registry, deriving the native provider", () => {
    expect(resolveModelTarget({ modelId: "deepseek-v4-flash" })).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash", remapped: false });
    expect(resolveModelTarget({ modelId: "claude-haiku-4-5-20251001" })).toEqual({ providerId: "anthropic", modelId: "claude-haiku-4-5-20251001", remapped: false });
  });

  it("honors an explicit providerId when the pair exists", () => {
    expect(resolveModelTarget({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6" })).toEqual({ providerId: "openrouter", modelId: "moonshotai/kimi-k2.6", remapped: false });
  });

  it("throws a clear error for unknown ids", () => {
    expect(() => resolveModelTarget({ modelId: "totally-unknown" })).toThrow(/Unknown model/);
  });
});
