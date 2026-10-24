import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { AgentConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";

// `contextWindow` is only the backfill cap (spec 8.9); compaction bounds the context afterwards.
// The dashboard field must say so and accept the schema's full range.
describe("contextWindow dashboard fields", () => {
  const SCHEMA_MAX = 200;

  it("the schemas accept up to 200", () => {
    expect(WaifuConfigSchema.shape.contextWindow.safeParse(SCHEMA_MAX).success).toBe(true);
    expect(WaifuConfigSchema.shape.contextWindow.safeParse(SCHEMA_MAX + 1).success).toBe(false);
    expect(AgentConfigSchema.shape.contextWindow.safeParse(SCHEMA_MAX).success).toBe(true);
    expect(AgentConfigSchema.shape.contextWindow.safeParse(SCHEMA_MAX + 1).success).toBe(false);
  });

  it.each(["src/frontend/screens/CastScreen.tsx", "src/frontend/screens/DirectionScreen.tsx"])(
    "%s labels it as the backfill window, with the schema max and a compaction hint",
    async (file) => {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain(">Context window<");
      const field = source.slice(source.indexOf("Messages loaded at start"));
      expect(field.length).toBeGreaterThan(0);
      const input = field.slice(0, field.indexOf("</div>"));
      expect(input).toContain(`max={${SCHEMA_MAX}}`);
      expect(input).toContain("contextWindow");
      expect(input).toMatch(/field-hint">Backfill[^<]*compaction keeps the context bounded/);
    }
  );
});
