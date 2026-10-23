import { describe, expect, it } from "vitest";
import {
  LEGACY_SERVER_CONTEXT_WINDOWS,
  legacyServerContextWindow,
  resolveContextCap,
  type ContextCapKind
} from "../src/orchestration/contextWindows.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ServerConfigSchema, type ServerConfig } from "../src/shared/schemas/domain.js";

function server(contextWindows: ServerConfig["contextWindows"]): ServerConfig {
  return ServerConfigSchema.parse({ ...createRevisionedBase(), guildId: "g1", contextWindows });
}

describe("resolveContextCap (B29)", () => {
  const kinds: ContextCapKind[] = ["orchestrator", "waifu", "stageManager"];

  it("falls back to the agent/waifu value when the server has no override", () => {
    for (const kind of kinds) {
      expect(resolveContextCap(kind, server({}), { contextWindow: 37 })).toBe(37);
    }
  });

  it("prefers an explicit server override", () => {
    const s = server({ orchestrator: 11, waifu: 22, stageManager: 33 });
    expect(resolveContextCap("orchestrator", s, { contextWindow: 99 })).toBe(11);
    expect(resolveContextCap("waifu", s, { contextWindow: 99 })).toBe(22);
    expect(resolveContextCap("stageManager", s, { contextWindow: 99 })).toBe(33);
  });

  it("overrides per kind independently", () => {
    const s = server({ waifu: 22 });
    expect(resolveContextCap("waifu", s, { contextWindow: 50 })).toBe(22);
    expect(resolveContextCap("orchestrator", s, { contextWindow: 20 })).toBe(20);
    expect(resolveContextCap("stageManager", s, { contextWindow: 80 })).toBe(80);
  });

  it("an override that happens to equal the old default is still an override", () => {
    expect(resolveContextCap("waifu", server({ waifu: 50 }), { contextWindow: 120 })).toBe(50);
  });

  it("allows caps up to 200", () => {
    expect(resolveContextCap("waifu", server({ waifu: 200 }), { contextWindow: 50 })).toBe(200);
    expect(() => server({ waifu: 201 })).toThrow();
  });

  it("DMs pass undefined and always use the waifu value", () => {
    for (const kind of kinds) {
      expect(resolveContextCap(kind, undefined, { contextWindow: 64 })).toBe(64);
    }
  });
});

describe("server contextWindows schema", () => {
  it("defaults to no overrides", () => {
    expect(ServerConfigSchema.parse({ ...createRevisionedBase(), guildId: "g1" }).contextWindows).toEqual({});
  });

  it("still reads files written with all three keys", () => {
    const s = server({ orchestrator: 20, waifu: 50, stageManager: 80 });
    expect(s.contextWindows).toEqual({ orchestrator: 20, waifu: 50, stageManager: 80 });
  });
});

describe("legacyServerContextWindow (pre-T5 read sites)", () => {
  it("keeps the old effective value: explicit key, else the old 20/50/80 default", () => {
    expect(LEGACY_SERVER_CONTEXT_WINDOWS).toEqual({ orchestrator: 20, waifu: 50, stageManager: 80 });
    const empty = server({});
    expect(legacyServerContextWindow("orchestrator", empty)).toBe(20);
    expect(legacyServerContextWindow("waifu", empty)).toBe(50);
    expect(legacyServerContextWindow("stageManager", empty)).toBe(80);
    expect(legacyServerContextWindow("waifu", server({ waifu: 7 }))).toBe(7);
  });
});
