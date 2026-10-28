// Step `living-cast-web-turn-cap-6-v1` (Living cast spec §31.4): `life.webFetch.maxPerTurn` still at
// the old default 3 becomes 6; any other value stays; a re-run changes nothing.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { SEND_CAP_STEP_ID } from "../src/backend/migrationSteps/livingCastSendCap.js";
import { migrateLivingCastWebTurnCap, WEB_TURN_CAP_STEP_ID } from "../src/backend/migrationSteps/livingCastWebTurnCap.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function rootWith(config?: string): Promise<string> {
  const dir = await makeTempRoot("dc-waifus-web-turn-cap-");
  roots.push(dir);
  if (config !== undefined) await writeFile(path.join(dir, "config.toml"), config);
  return dir;
}

describe("living-cast-web-turn-cap-6-v1 (§31.4)", () => {
  it("moves the old default 3 to 6, keeps every other key; a re-run changes nothing", async () => {
    const dataRoot = await rootWith("[life]\nmaxSendsPerTurn = 15\n\n[life.webFetch]\nmaxPerTurn = 3\nmaxPerWaifuPerDay = 20\n");
    expect(await migrateLivingCastWebTurnCap(dataRoot)).toBe(WEB_TURN_CAP_STEP_ID);
    const after = await readFile(path.join(dataRoot, "config.toml"), "utf8");
    expect(parseToml(after)).toEqual({ life: { maxSendsPerTurn: 15, webFetch: { maxPerTurn: 6, maxPerWaifuPerDay: 20 } } });
    expect((await loadAppConfig(dataRoot)).life.webFetch.maxPerTurn).toBe(6);
    expect(await migrateLivingCastWebTurnCap(dataRoot)).toBeUndefined();
    expect(await readFile(path.join(dataRoot, "config.toml"), "utf8")).toBe(after);
  });

  it("leaves the owner's own value, a config without it, a missing config; an unparsable one is incomplete", async () => {
    const own = await rootWith("[life.webFetch]\nmaxPerTurn = 2\n");
    expect(await migrateLivingCastWebTurnCap(own)).toBeUndefined();
    expect(await readFile(path.join(own, "config.toml"), "utf8")).toBe("[life.webFetch]\nmaxPerTurn = 2\n");
    expect(await migrateLivingCastWebTurnCap(await rootWith("[life]\nmaxSendsPerTurn = 3\n"))).toBeUndefined();
    expect(await migrateLivingCastWebTurnCap(await rootWith())).toBeUndefined();
    expect(await migrateLivingCastWebTurnCap(await rootWith("[life\nnope"))).toEqual({ incomplete: "config.toml could not be parsed" });
  });

  it("is a once step registered after the send cap, before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(WEB_TURN_CAP_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBeGreaterThan(ids.indexOf(SEND_CAP_STEP_ID));
    expect(at).toBeLessThan(ids.length - 1);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
  });
});
