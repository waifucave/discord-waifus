// A runtime.json/pid.json left by a 2.x host must still be readable by the 3.0 CLI, so `status`,
// `doctor` and `stop` can find and report an old host right after an upgrade.
import { describe, expect, it } from "vitest";
import { RuntimeStateReadSchema } from "../src/cli/hostIdentity.js";

const legacyHostState = {
  schemaVersion: 1,
  pid: 4242,
  startedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:05:00.000Z",
  packageVersion: "2.111.2",
  port: 3888,
  dataRoot: "/data",
  mode: "foreground",
  paused: false,
  discord: { connected: true, orchestratorConnected: true, waifuBotCount: 5, warnings: [] },
  queues: { active: 0, configuredGuilds: 1 }
};

describe("RuntimeStateReadSchema", () => {
  it("reads a 2.x host's state, treating its old discord block as not connected", () => {
    const state = RuntimeStateReadSchema.parse(legacyHostState);
    expect(state.pid).toBe(4242);
    expect(state.discord).toEqual({ connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] });
  });

  it("keeps a current discord block as written", () => {
    const discord = { connected: true, houseConnected: true, waifuBotCount: 2, warnings: ["w"] };
    expect(RuntimeStateReadSchema.parse({ ...legacyHostState, discord }).discord).toEqual(discord);
  });
});
