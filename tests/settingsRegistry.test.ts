// The settings registry (Living cast §14.2, overhaul §10.2–§10.3): every setting is documented and
// reachable. Walks every group's schema: a leaf without a registry entry, a key without help, an
// HTTP route missing from the route manifest, or an example the schema rejects fails here.
import { describe, expect, it } from "vitest";
import { ROUTE_POLICY_MANIFEST } from "../src/api/routePolicyManifest.js";
import { DEFAULT_APP_CONFIG } from "../src/shared/schemas/config.js";
import { allKeyInfos, coerceValue, findKey, groupKeyInfos, schemaAt, schemaLeaves, getPath, typeLabel } from "../src/shared/settings/introspect.js";
import { RESOURCE_TOPICS, SETTING_GROUPS } from "../src/shared/settings/registry.js";

const manifest = new Set(ROUTE_POLICY_MANIFEST.map((route) => `${route.method} ${route.path}`));

describe("settings registry", () => {
  it.each(SETTING_GROUPS.map((group) => [group.id, group] as const))("%s: every schema leaf is a documented key, and every key is a leaf", (_id, group) => {
    const leaves = schemaLeaves(group).sort();
    expect(leaves).toEqual(Object.keys(group.keys).sort());
    for (const info of groupKeyInfos(group)) expect(info.help.length, info.id).toBeGreaterThan(15);
    expect(groupKeyInfos(group)).toHaveLength(Object.keys(group.keys).length);
  });

  it("every group's routes are in the route manifest", () => {
    for (const group of SETTING_GROUPS) {
      expect(manifest.has(`${group.read.method} ${group.read.path}`), group.id).toBe(true);
      expect(manifest.has(`${group.write.method} ${group.write.path}`), group.id).toBe(true);
      if (group.list) expect(manifest.has(`${group.list.method} ${group.list.path}`), group.id).toBe(true);
    }
    for (const topic of RESOURCE_TOPICS) for (const route of topic.routes) expect(manifest.has(`${route.method} ${route.path}`), `${topic.id} ${route.path}`).toBe(true);
  });

  it("every writable key has an example that the CLI coerces and the schema accepts", () => {
    for (const info of allKeyInfos()) {
      if (info.flags.readOnly || info.flags.secret) continue;
      expect(info.example, info.id).toBeDefined();
      const coerced = coerceValue(info, info.example!);
      expect(coerced, info.id).toMatchObject({ ok: true });
      const group = SETTING_GROUPS.find((candidate) => candidate.id === info.group)!;
      const leaf = schemaAt(group.schema, info.path) as { safeParse: (value: unknown) => { success: boolean } };
      expect(leaf.safeParse((coerced as { value: unknown }).value).success, info.id).toBe(true);
    }
  });

  it("a record's identity fields have no default (its defaults are parsed from an example seed)", () => {
    for (const id of ["waifu.id", "waifu.name", "waifu.displayName", "bot.displayName"]) expect(findKey(id)?.default, id).toBeUndefined();
    expect(findKey("waifu.enabled")?.default).toBe(true);
    expect(findKey("waifu.life.dailyBudgetUsd")?.default).toBeNull();
  });

  it("app defaults come from the parsed default config", () => {
    for (const info of groupKeyInfos(SETTING_GROUPS.find((group) => group.id === "app")!)) {
      expect(info.default, info.id).toEqual(getPath(DEFAULT_APP_CONFIG, info.path));
    }
  });

  it("a numeric key's bounds are the schema's: the CLI accepts exactly what the schema accepts at each edge (review r2)", () => {
    const exclusive: string[] = [];
    for (const info of allKeyInfos()) {
      if (info.type !== "integer" && info.type !== "number") continue;
      const group = SETTING_GROUPS.find((candidate) => candidate.id === info.group)!;
      const leaf = schemaAt(group.schema, info.path) as { safeParse: (value: unknown) => { success: boolean } };
      if (info.min !== undefined) {
        expect(leaf.safeParse(info.min).success, `${info.id} min`).toBe(!info.minExclusive);
        expect(coerceValue(info, String(info.min)).ok, `${info.id} min`).toBe(!info.minExclusive);
        if (info.minExclusive) exclusive.push(info.id);
      }
      if (info.max !== undefined) {
        expect(leaf.safeParse(info.max).success, `${info.id} max`).toBe(true);
        expect(coerceValue(info, String(info.max)).ok, `${info.id} max`).toBe(true);
      }
    }
    expect(exclusive).toEqual(expect.arrayContaining(["app.models.maxOutputUsdPerMTok", "waifu.life.dailyBudgetUsd"]));
    expect(typeLabel(findKey("waifu.life.dailyBudgetUsd")!)).toBe("number >0–10000 or null [USD]");
  });

  it("covers the Living cast keys (§11.3) with their bounds", () => {
    const expectations: Array<[string, number | undefined, number | undefined]> = [
      ["life.maxConcurrentTurns", 1, 16],
      ["life.maxToolRounds", 1, 30],
      ["life.maxTurnMs", 30_000, 600_000],
      ["life.maxLogMessages", 50, 2_000],
      ["life.maxContextTokens", 32_000, 100_000],
      ["life.maxInlineImagesPerEpoch", 0, 20],
      ["life.maxInlineImageBytesPerEpoch", 0, 20_971_520],
      ["life.maxSendPlacesPerTurn", 1, 10],
      ["life.maxSendsPerTurn", 1, 50],
      ["life.maxWakesPerUserPerHour", 1, 200],
      ["life.maxWatchFiresPerDay", 1, 100],
      ["life.maxWaifuTriggeredTurns", 0, 100],
      ["life.maintenanceHourLocal", 0, 23],
      ["search.maxPerSecond", 0, 10],
      ["search.maxPerDay", 0, 10_000],
      ["search.maxPerWaifuPerDay", 0, 10_000],
      ["life.webFetch.maxPerWaifuPerDay", 0, 500],
      ["life.webFetch.maxPerTurn", 0, 20],
      ["life.webFetch.directMaxChars", 0, 20_000],
      ["life.webFetch.maxBytes", 65_536, 10_485_760],
      ["life.webFetch.timeoutMs", 2_000, 60_000],
      ["life.webFetch.maxRedirects", 0, 10],
      ["life.webFetch.cacheMinutes", 0, 1_440],
      ["discord.debounce.dmMs", 0, 120_000],
      ["discord.debounce.dmMaxWaitMs", 0, 300_000]
    ];
    for (const [key, min, max] of expectations) {
      const info = findKey(`app.${key}`);
      expect(info, key).toBeDefined();
      expect([info!.min, info!.max], key).toEqual([min, max]);
    }
    for (const key of ["life.webFetch.model", "models.allowed", "models.maxOutputUsdPerMTok", "detector.target", "discord.dm.resumeWindowMinutes", "compaction.enabled", "compaction.triggerRatio", "compaction.waitTimeoutMs"]) {
      expect(findKey(key), key).toBeDefined();
    }
    for (const key of ["waifu.model", "waifu.life.dailyBudgetUsd", "waifu.dm.sleepNotice", "waifu.wakeOnName", "server.detector.target", "channel.threads"]) {
      expect(findKey(key), key).toBeDefined();
    }
    expect(findKey("app.life.maxSendsPerTurn")).toMatchObject({ type: "integer", default: 8 });
    expect(findKey("waifu.life.dailyBudgetUsd")).toMatchObject({ nullable: true, default: null });
    expect(findKey("waifu.verbosity")).toMatchObject({ type: "enum", enum: ["terse", "chatty", "expressive"], default: "terse" });
    expect(findKey("app.ocr.engine")).toMatchObject({ type: "enum" });
  });

  it("coerces command-line strings", () => {
    const sends = findKey("app.life.maxSendsPerTurn")!;
    expect(coerceValue(sends, "12")).toEqual({ ok: true, value: 12 });
    expect(coerceValue(sends, "0")).toMatchObject({ ok: false });
    expect(coerceValue(sends, "1.5")).toMatchObject({ ok: false });
    expect(coerceValue(findKey("app.ocr.enabled")!, "off")).toEqual({ ok: true, value: false });
    expect(coerceValue(findKey("waifu.model")!, "openrouter/anthropic/claude-haiku-5.5@high")).toEqual({
      ok: true,
      value: { providerId: "openrouter", modelId: "anthropic/claude-haiku-5.5", effort: "high" }
    });
    expect(coerceValue(findKey("waifu.life.dailyBudgetUsd")!, "null")).toEqual({ ok: true, value: null });
    expect(coerceValue(findKey("app.life.maxSendsPerTurn")!, "null")).toMatchObject({ ok: false });
    expect(coerceValue(findKey("channel.enabledWaifuIds")!, "aria, mina")).toEqual({ ok: true, value: ["aria", "mina"] });
    expect(coerceValue(findKey("app.models.allowed")!, '["a/b"]')).toEqual({ ok: true, value: ["a/b"] });
  });
});
