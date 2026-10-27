// Step `living-cast-drop-rest-notice-ratio-v1` (Living cast spec §26): `life.restNoticeRatio` is
// dropped from config.toml (the file archived first); nothing else changes; a re-run changes nothing.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { DROP_REST_NOTICE_RATIO_STEP_ID, migrateLivingCastDropRestNoticeRatio } from "../src/backend/migrationSteps/livingCastRestNoticeRatio.js";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { loadAppConfig } from "../src/config/appConfig.js";
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

  it("is a once step registered after the bed time step, before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(DROP_REST_NOTICE_RATIO_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBeGreaterThan(ids.indexOf("living-cast-bed-time-v1"));
    expect(at).toBe(ids.length - 2);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
  });
});
