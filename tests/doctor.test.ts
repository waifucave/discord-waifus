import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/cli/commands.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

type DoctorResult = {
  node: { version: string; ok: boolean };
  dataRoot: string;
  warnings: string[];
  schema: { unstamped: string[] };
  models: { unresolved: Array<{ scope: string; providerId: string | null; modelId: string }> };
  providersConfigured: string[];
  discord: { orchestratorConfigured: boolean; waifuBotCount: number };
};

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("waifus doctor: unresolved models and unstamped schema files", () => {
  it("surfaces an unresolved waifu model id and an unstamped file; a clean root has neither", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    await writeJson(root, "user/waifus/bogus-waifu/waifu.json", {
      schemaVersion: 2,
      revision: 0,
      updatedAt: new Date().toISOString(),
      id: "bogus-waifu",
      name: "Bogus",
      displayName: "Bogus",
      modelId: "bogus-model"
    });

    // A hand-written file left at schemaVersion 1, simulating a partially migrated root.
    await writeJson(root, "user/servers/stale-guild/server.json", {
      schemaVersion: 1,
      guildId: "stale-guild"
    });

    const { code, result } = await runDoctor(root);
    expect(code).toBe(0);
    expect(result.models.unresolved).toEqual([
      { scope: "waifu:bogus-waifu", providerId: null, modelId: "bogus-model" }
    ]);
    expect(result.schema.unstamped).toContain("user/servers/stale-guild/server.json");
  });

  it("reports empty arrays and no warnings for a freshly migrated, clean root", async () => {
    const root = await makeTempRoot();
    roots.push(root);

    const { code, result } = await runDoctor(root);
    expect(code).toBe(0);
    expect(result.schema.unstamped).toEqual([]);
    expect(result.models.unresolved).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("flags an unresolved agent model id with its scope", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    const configPath = path.join(root, "user", "orchestrator", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.providerId = "openai";
    config.modelId = "totally-unknown-model";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const { result } = await runDoctor(root);
    expect(result.models.unresolved).toEqual([
      { scope: "orchestrator", providerId: "openai", modelId: "totally-unknown-model" }
    ]);
  });
});

describe("waifus doctor: CLI resilience on unmigrated v1 installs", () => {
  it("does not crash on a v1 config.toml, and warns instead", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await downgradeConfigSchemaVersion(root, 1);

    const { code, result } = await runDoctor(root);
    expect(code).toBe(0);
    expect(result.warnings).toContain("unmigrated data root — run `waifus start` to migrate");
    expect(result.schema.unstamped).toContain("config.toml");
  });

  it("still throws on config.toml that is genuinely malformed (syntax error)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(path.join(root, "config.toml"), "not [ valid toml ::::", "utf8");

    await expect(runDoctor(root)).rejects.toThrow();
  });

  it("still throws when config.toml is invalid beyond just an old schemaVersion", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    const configPath = path.join(root, "config.toml");
    const parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
    parsed.schemaVersion = 1;
    (parsed.http as Record<string, unknown>).port = "not-a-number";
    await writeFile(configPath, `${stringifyToml(parsed)}\n`, "utf8");

    await expect(runDoctor(root)).rejects.toThrow();
  });
});

describe("waifus doctor: v1 providers.json / discord-bots.json report real data, not empties", () => {
  it("surfaces real provider ids and discord bot config from an unmigrated v1 root instead of hiding them", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeV1ProvidersFile(root, {
      openai: {
        providerId: "openai",
        apiKey: "sk-test-dummy-key",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });
    await writeV1DiscordBotsFile(root, {
      orchestrator: {
        id: "orchestrator-bot",
        displayName: "Orchestrator",
        token: "dummy-orchestrator-token",
        enabled: true
      },
      waifus: [
        { id: "waifu-bot-1", displayName: "Waifu One", token: "dummy-waifu-token", enabled: true }
      ]
    });

    const { code, result } = await runDoctor(root);
    expect(code).toBe(0);
    expect(result.warnings).toContain("unmigrated data root — run `waifus start` to migrate");
    expect(result.providersConfigured).toEqual(["openai"]);
    expect(result.discord.orchestratorConfigured).toBe(true);
    expect(result.discord.waifuBotCount).toBe(1);
  });

  it("still throws when a v1 providers.json record is genuinely invalid beyond just an old schemaVersion", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeV1ProvidersFile(root, {
      openai: {
        providerId: "openai",
        // apiKey intentionally omitted — a genuinely malformed credential record, not just a
        // stale schemaVersion.
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    });

    await expect(runDoctor(root)).rejects.toThrow();
  });
});

describe("waifus status/stop: tolerate unmigrated runtime files", () => {
  it("status reads a stale schemaVersion runtime.json/pid.json without crashing", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeRuntimeFiles(root, 1);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCommand(parseCliArgs(["status", "--data-root", root]));
    logSpy.mockRestore();

    expect(code).toBe(1); // the fixture pid (999999) is not alive
  });

  it("stop removes a stale pid.json even with an old schemaVersion", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeRuntimeFiles(root, 1, ["pid.json"]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const code = await runCommand(parseCliArgs(["stop", "--data-root", root]));
    logSpy.mockRestore();

    expect(code).toBe(0);
  });
});

async function runDoctor(root: string): Promise<{ code: number; result: DoctorResult }> {
  const logs: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    if (typeof message === "string") logs.push(message);
  });
  try {
    const code = await runCommand(parseCliArgs(["doctor", "--data-root", root]));
    const jsonLine = logs.find((line) => line.trim().startsWith("{"));
    if (!jsonLine) {
      throw new Error(`doctor did not print a JSON result; logs: ${JSON.stringify(logs)}`);
    }
    return { code, result: JSON.parse(jsonLine) as DoctorResult };
  } finally {
    logSpy.mockRestore();
  }
}

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeV1ProvidersFile(root: string, providers: Record<string, unknown>): Promise<void> {
  await writeJson(root, "user/providers.json", {
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    providers
  });
}

async function writeV1DiscordBotsFile(
  root: string,
  bots: { orchestrator: unknown; waifus: unknown[] }
): Promise<void> {
  await writeJson(root, "user/discord-bots.json", {
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date().toISOString(),
    orchestrator: bots.orchestrator,
    waifus: bots.waifus
  });
}

async function downgradeConfigSchemaVersion(root: string, schemaVersion: number): Promise<void> {
  const configPath = path.join(root, "config.toml");
  const parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
  parsed.schemaVersion = schemaVersion;
  await writeFile(configPath, `${stringifyToml(parsed)}\n`, "utf8");
}

async function writeRuntimeFiles(
  root: string,
  schemaVersion: number,
  only: Array<"runtime.json" | "pid.json"> = ["runtime.json", "pid.json"]
): Promise<void> {
  const now = new Date().toISOString();
  const state = {
    schemaVersion,
    pid: 999_999,
    startedAt: now,
    updatedAt: now,
    packageVersion: "0.0.0",
    port: 3888,
    dataRoot: root,
    mode: "start"
  };
  for (const name of only) {
    await writeJson(root, path.join("app", name), state);
  }
}
