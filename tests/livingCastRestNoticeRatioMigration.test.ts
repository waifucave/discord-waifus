// Step `living-cast-drop-rest-notice-ratio-v1` (Living cast spec §26): `life.restNoticeRatio` is
// dropped from config.toml (the file archived first); nothing else changes; a re-run changes nothing.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { DROP_REST_NOTICE_RATIO_STEP_ID, migrateLivingCastDropRestNoticeRatio } from "../src/backend/migrationSteps/livingCastRestNoticeRatio.js";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { z } from "zod";
import { loadAppConfig, mergeAppConfigPatch } from "../src/config/appConfig.js";
import { runMigrations } from "../src/backend/migrations.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function root(): Promise<string> {
  const dir = await makeTempRoot("dc-waifus-rest-ratio-");
  roots.push(dir);
  return dir;
}

const CONFIG = `[compaction]
triggerRatio = 0.75

[life]
maxTurnMs = 120000
restNotice = true
restNoticeRatio = 0.8
restSummaryMinChars = 300
`;

describe("living-cast-drop-rest-notice-ratio-v1 (§26)", () => {
  it("drops life.restNoticeRatio, keeps every other key, archives the file first; a re-run changes nothing", async () => {
    const dataRoot = await root();
    await writeFile(path.join(dataRoot, "config.toml"), CONFIG);
    expect(await migrateLivingCastDropRestNoticeRatio(dataRoot)).toBe(DROP_REST_NOTICE_RATIO_STEP_ID);
    const after = await readFile(path.join(dataRoot, "config.toml"), "utf8");
    const parsed = parseToml(after) as { life: Record<string, unknown>; compaction: Record<string, unknown> };
    expect(parsed.life).toEqual({ maxTurnMs: 120000, restNotice: true, restSummaryMinChars: 300 });
    expect(parsed.compaction).toEqual({ triggerRatio: 0.75 });
    expect(await readFile(path.join(dataRoot, "user/.archive/living-cast/rest-notice-ratio/config.toml"), "utf8")).toBe(CONFIG);
    expect(await migrateLivingCastDropRestNoticeRatio(dataRoot)).toBeUndefined();
    expect(await readFile(path.join(dataRoot, "config.toml"), "utf8")).toBe(after);
    const config = await loadAppConfig(dataRoot);
    expect(config.life.restSummaryMinChars).toBe(300);
    expect(config.compaction).toMatchObject({ triggerRatio: 0.75, emergencyRatio: 0.9 });
  });

  it("leaves a config without the key, a missing config and an unparsable one alone", async () => {
    const plain = await root();
    await writeFile(path.join(plain, "config.toml"), "[life]\nrestNotice = false\n");
    expect(await migrateLivingCastDropRestNoticeRatio(plain)).toBeUndefined();
    expect(await readFile(path.join(plain, "config.toml"), "utf8")).toBe("[life]\nrestNotice = false\n");
    expect(await migrateLivingCastDropRestNoticeRatio(await root())).toBeUndefined();
    const broken = await root();
    await writeFile(path.join(broken, "config.toml"), "[life\nrestNoticeRatio = ");
    expect(await migrateLivingCastDropRestNoticeRatio(broken)).toMatchObject({ incomplete: expect.any(String) });
  });

  it("a rest point of 0.9 or more (allowed up to 0.95 before §26) gets an emergency above it, archived first; one set already is kept", async () => {
    const high = await root();
    const text = "[compaction]\ntriggerRatio = 0.92\n";
    await writeFile(path.join(high, "config.toml"), text);
    expect(await migrateLivingCastDropRestNoticeRatio(high)).toBe(DROP_REST_NOTICE_RATIO_STEP_ID);
    expect(parseToml(await readFile(path.join(high, "config.toml"), "utf8"))).toEqual({ compaction: { triggerRatio: 0.92, emergencyRatio: 0.96 } });
    expect(await readFile(path.join(high, "user/.archive/living-cast/rest-notice-ratio/config.toml"), "utf8")).toBe(text);
    const top = await root();
    await writeFile(path.join(top, "config.toml"), "[compaction]\ntriggerRatio = 0.95\n");
    await migrateLivingCastDropRestNoticeRatio(top);
    expect(parseToml(await readFile(path.join(top, "config.toml"), "utf8"))).toEqual({ compaction: { triggerRatio: 0.95, emergencyRatio: 0.99 } });
    const set = await root();
    await writeFile(path.join(set, "config.toml"), "[compaction]\ntriggerRatio = 0.92\nemergencyRatio = 0.95\n");
    expect(await migrateLivingCastDropRestNoticeRatio(set)).toBeUndefined();
    const low = await root();
    await writeFile(path.join(low, "config.toml"), "[compaction]\ntriggerRatio = 0.85\n");
    expect(await migrateLivingCastDropRestNoticeRatio(low)).toBeUndefined();
  });

  it("a config whose rest point is at or above its emergency still loads and boots (clamped), but an update making it so is refused", async () => {
    for (const text of ["[compaction]\ntriggerRatio = 0.92\n", "[compaction]\ntriggerRatio = 0.92\nemergencyRatio = 0.95\n", "[compaction]\ntriggerRatio = 0.92\nemergencyRatio = 0.9\n"]) {
      // Loading never throws, before or after the migrations run.
      const before = await root();
      await writeFile(path.join(before, "config.toml"), text);
      const loaded = await loadAppConfig(before);
      expect(loaded.compaction.triggerRatio).toBe(0.92);
      expect(loaded.compaction.emergencyRatio).toBeGreaterThan(0.92);
      await runMigrations(before, { appVersion: "3.4.0-test" });
      const booted = await loadAppConfig(before);
      expect(booted.compaction.emergencyRatio).toBeGreaterThan(booted.compaction.triggerRatio);
    }
    const current = await loadAppConfig(await root());
    expect(() => mergeAppConfigPatch(current, { compaction: { triggerRatio: 0.92 } })).toThrow(z.ZodError);
    expect(() => mergeAppConfigPatch(current, { compaction: { emergencyRatio: 0.7 } })).toThrow(/emergencyRatio/u);
    expect(mergeAppConfigPatch(current, { compaction: { triggerRatio: 0.92, emergencyRatio: 0.95 } }).compaction).toMatchObject({ triggerRatio: 0.92, emergencyRatio: 0.95 });
  });

  it("is a once step registered after the bed time step, before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(DROP_REST_NOTICE_RATIO_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBeGreaterThan(ids.indexOf("living-cast-bed-time-v1"));
    expect(at).toBe(ids.length - 2);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
  });
});
