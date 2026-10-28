// Step `living-cast-send-cap-15-v1` (Living cast spec §27.1): `life.maxSendsPerTurn` still at the old
// default 8 becomes 15; any other value stays; a re-run changes nothing.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_STEPS } from "../src/backend/migrations.js";
import { migrateLivingCastSendCap, SEND_CAP_STEP_ID } from "../src/backend/migrationSteps/livingCastSendCap.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempRoot(root);
});

async function rootWith(config?: string): Promise<string> {
  const dir = await makeTempRoot("dc-waifus-send-cap-");
  roots.push(dir);
  if (config !== undefined) await writeFile(path.join(dir, "config.toml"), config);
  return dir;
}

describe("living-cast-send-cap-15-v1 (§27.1)", () => {
  it("moves the old default 8 to 15, keeps every other key; a re-run changes nothing", async () => {
    const dataRoot = await rootWith("[life]\nmaxSendsPerTurn = 8\nmaxSendPlacesPerTurn = 3\n");
    expect(await migrateLivingCastSendCap(dataRoot)).toBe(SEND_CAP_STEP_ID);
    const after = await readFile(path.join(dataRoot, "config.toml"), "utf8");
    expect(parseToml(after)).toEqual({ life: { maxSendsPerTurn: 15, maxSendPlacesPerTurn: 3 } });
    expect((await loadAppConfig(dataRoot)).life.maxSendsPerTurn).toBe(15);
    expect(await migrateLivingCastSendCap(dataRoot)).toBeUndefined();
    expect(await readFile(path.join(dataRoot, "config.toml"), "utf8")).toBe(after);
  });

  it("leaves the owner's own value, a config without it, a missing config; an unparsable one is incomplete", async () => {
    const own = await rootWith("[life]\nmaxSendsPerTurn = 6\n");
    expect(await migrateLivingCastSendCap(own)).toBeUndefined();
    expect(await readFile(path.join(own, "config.toml"), "utf8")).toBe("[life]\nmaxSendsPerTurn = 6\n");
    expect(await migrateLivingCastSendCap(await rootWith("[http]\nport = 3888\n"))).toBeUndefined();
    expect(await migrateLivingCastSendCap(await rootWith())).toBeUndefined();
    expect(await migrateLivingCastSendCap(await rootWith("[life\nnope"))).toEqual({ incomplete: "config.toml could not be parsed" });
  });

  it("is a once step registered before the schema stamp", () => {
    const ids = MIGRATION_STEPS.map((step) => step.id);
    const at = ids.indexOf(SEND_CAP_STEP_ID);
    expect(MIGRATION_STEPS[at]!.frequency).toBe("once");
    expect(at).toBe(ids.length - 2);
    expect(ids.at(-1)).toMatch(/^stamp-schema-version-/u);
  });
});
