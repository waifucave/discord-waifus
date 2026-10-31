import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import { PREBUILT_BIO_MAX_CHARS, PREBUILT_WAIFUS } from "../src/config/prebuiltWaifus.js";
import { DATA_ROOT_ENV, getDataRoot } from "../src/config/paths.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { redactSecrets } from "../src/backend/redaction.js";
import { CURRENT_SCHEMA_VERSION } from "../src/shared/schemas/common.js";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessTrustIndexV1Schema
} from "../src/shared/schemas/remoteAccess.js";
import { RemoteAccessConfigV1Schema } from "../src/shared/schemas/remoteLifecycle.js";
import {
  IDENTITY_RESET_PATH_OWNERSHIP,
  REMOTE_STATE_RELATIVE_PATHS,
  remoteStatePaths
} from "../src/remote/paths.js";
import {
  ServerConfigSchema,
  WaifuConfigSchema
} from "../src/shared/schemas/domain.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("data root and config", () => {
  it("uses DC_WAIFUS_HOME when provided", () => {
    expect(getDataRoot({ [DATA_ROOT_ENV]: "/tmp/example-waifus" })).toBe("/tmp/example-waifus");
  });

  it("initializes the expected backend data layout and default config", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    await expect(access(path.join(root, "app", "logs"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "app", "cache"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "app", "cache", "ocr", "results-v2"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "app", "tmp", "ocr"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "user", "waifus"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "user", "servers"))).resolves.toBeUndefined();

    const remotePaths = remoteStatePaths(root);
    for (const directory of [
      remotePaths.hostStateRoot,
      remotePaths.trustRoot,
      remotePaths.operationsRoot,
      remotePaths.auditRoot,
      remotePaths.remoteGatewayStateRoot,
      remotePaths.dashboardCacheRoot,
      remotePaths.hostRuntimeRoot,
      remotePaths.remoteGatewayRuntimeRoot
    ]) {
      await expect(access(directory)).resolves.toBeUndefined();
    }
    const remoteConfig = RemoteAccessConfigV1Schema.parse(
      JSON.parse(await readFile(remotePaths.hostConfig, "utf8"))
    );
    const installation = RemoteAccessInstallationStateV1Schema.parse(
      JSON.parse(await readFile(remotePaths.installation, "utf8"))
    );
    const trust = RemoteAccessTrustIndexV1Schema.parse(
      JSON.parse(await readFile(remotePaths.trustIndex, "utf8"))
    );
    expect(remoteConfig).toMatchObject({
      revision: "0",
      enabled: false,
      displayName: "Discord Waifus Host"
    });
    expect(installation.activationReference).toBeNull();
    expect(trust).toEqual({
      version: 1,
      trustEpochHighWater: "0",
      resetTombstone: "0",
      pairs: []
    });
    for (const filePath of [remotePaths.hostConfig, remotePaths.installation, remotePaths.trustIndex]) {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }

    const config = await loadAppConfig(root);
    expect(config.http.port).toBe(3888);
    expect(config.runtime.autoConnectDiscord).toBe(true);
    expect(config.ocr).toMatchObject({
      enabled: true,
      engine: "auto",
      cacheTtlHours: 168,
      timeoutMs: 1500,
      maxImageBytes: 8 * 1024 * 1024,
      maxImagesPerModelCall: 4,
      maxTextCharsPerImage: 1500
    });
  });

  it("keeps independent installation IDs per DC_WAIFUS_HOME and never rewrites existing state", async () => {
    const firstRoot = await makeTempRoot();
    const secondRoot = await makeTempRoot();
    roots.push(firstRoot, secondRoot);
    const firstResolved = getDataRoot({ [DATA_ROOT_ENV]: firstRoot });
    const secondResolved = getDataRoot({ [DATA_ROOT_ENV]: secondRoot });
    await Promise.all([ensureDataLayout(firstResolved), ensureDataLayout(secondResolved)]);
    const firstPaths = remoteStatePaths(firstResolved);
    const secondPaths = remoteStatePaths(secondResolved);
    const firstBefore = await readFile(firstPaths.installation, "utf8");
    const firstConfigBefore = await readFile(firstPaths.hostConfig, "utf8");
    const first = RemoteAccessInstallationStateV1Schema.parse(JSON.parse(firstBefore));
    const second = RemoteAccessInstallationStateV1Schema.parse(
      JSON.parse(await readFile(secondPaths.installation, "utf8"))
    );

    expect(first.installationId).not.toBe(second.installationId);
    await ensureDataLayout(firstResolved);
    expect(await readFile(firstPaths.installation, "utf8")).toBe(firstBefore);
    expect(await readFile(firstPaths.hostConfig, "utf8")).toBe(firstConfigBefore);
  });

  it("initializes one stable installation under concurrent layout calls", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await Promise.all(Array.from({ length: 12 }, () => ensureDataLayout(root)));
    const paths = remoteStatePaths(root);
    const installation = RemoteAccessInstallationStateV1Schema.parse(
      JSON.parse(await readFile(paths.installation, "utf8"))
    );
    expect(installation.vaultLabel).toBe(
      `waifus.installation.v1.${installation.installationId}`
    );
    expect(RemoteAccessTrustIndexV1Schema.safeParse(
      JSON.parse(await readFile(paths.trustIndex, "utf8"))
    ).success).toBe(true);
  });

  it("freezes disjoint clean/runtime and identity-reset path ownership", () => {
    expect(REMOTE_STATE_RELATIVE_PATHS).toMatchObject({
      hostStateRoot: "app/remote-access",
      remoteGatewayStateRoot: "app/remote-gateway",
      dashboardCacheRoot: "app/cache/remote-dashboard",
      hostRuntimeRoot: "app/tmp/remote-host",
      remoteGatewayRuntimeRoot: "app/tmp/remote-gateway",
      hostLog: "app/logs/remote-host.log",
      remoteGatewayLog: "app/logs/remote-gateway.log"
    });
    const cleared = new Set(IDENTITY_RESET_PATH_OWNERSHIP.clearAfterVerifiedHelperReceipt);
    const rewritten = new Set(IDENTITY_RESET_PATH_OWNERSHIP.rewriteAfterVerifiedHelperReceipt);
    const verified = new Set(IDENTITY_RESET_PATH_OWNERSHIP.verifyAfterHelperReceipt);
    const preserved = new Set(IDENTITY_RESET_PATH_OWNERSHIP.preserve);
    expect([...cleared].filter((value) => rewritten.has(value) || preserved.has(value))).toEqual([]);
    expect([...rewritten].filter((value) => preserved.has(value))).toEqual([]);
    expect(cleared).toEqual(new Set([
      "app/remote-access/trust",
      "app/remote-gateway/origins-v1.json",
      "app/remote-gateway/remembered-hosts-v1.json",
      "app/cache/remote-dashboard"
    ]));
    expect(rewritten).toEqual(new Set([
      "app/remote-access/config.json",
      "app/remote-access/trust/index.json",
      "app/remote-access/trust/local-deny-v1.json"
    ]));
    expect(verified).toEqual(new Set(["app/remote-access/installation.json"]));
    expect(preserved).toEqual(new Set([
      "app/remote-access/operations",
      "app/remote-access/audit",
      "app/remote-access/reset-tombstone.json"
    ]));
  });

  it("fills OCR defaults when loading older config files", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(
      path.join(root, "config.toml"),
      [
        `schemaVersion = ${CURRENT_SCHEMA_VERSION}`,
        "",
        "[http]",
        "host = \"127.0.0.1\"",
        "port = 3888",
        "",
        "[runtime]",
        "autoConnectDiscord = true",
        "paused = false",
        "",
        "[frontend]",
        ""
      ].join("\n")
    );

    const config = await loadAppConfig(root);
    expect(config.ocr.enabled).toBe(true);
    expect(config.ocr.engine).toBe("auto");
  });

  it("loads a config.toml with the [life] keys of her day and bed time, without them (spec §38)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(
      path.join(root, "config.toml"),
      [`schemaVersion = ${CURRENT_SCHEMA_VERSION}`, "", "[life]", "morningLinesPerPlace = 12", "dayStartHourLocal = 9", "busyEngagedMinutes = 20", "bedDozeMinutes = 30", "dreamAfterAsleepMinutes = 5", "maintenanceHourLocal = 4", ""].join("\n")
    );
    const config = await loadAppConfig(root);
    expect(config.life.maintenanceHourLocal).toBe(4);
    for (const key of ["morningLinesPerPlace", "dayStartHourLocal", "busyEngagedMinutes", "bedDozeMinutes", "dreamAfterAsleepMinutes"]) expect(config.life).not.toHaveProperty(key);
  });

  it("keeps legacy Tesseract OCR configs as system Tesseract", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(
      path.join(root, "config.toml"),
      [
        `schemaVersion = ${CURRENT_SCHEMA_VERSION}`,
        "",
        "[http]",
        "host = \"127.0.0.1\"",
        "port = 3888",
        "",
        "[runtime]",
        "autoConnectDiscord = true",
        "paused = false",
        "",
        "[frontend]",
        "",
        "[ocr]",
        "enabled = true",
        "engine = \"tesseract\"",
        "cacheTtlHours = 24",
        "timeoutMs = 1500",
        `maxImageBytes = ${8 * 1024 * 1024}`,
        "maxImagesPerModelCall = 4",
        "maxTextCharsPerImage = 1500"
      ].join("\n")
    );

    const config = await loadAppConfig(root);
    expect(config.ocr.engine).toBe("system-tesseract");
  });

  it("seeds editable prebuilt waifus only once per data root", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    const first = PREBUILT_WAIFUS[0];
    const firstPath = path.join(root, "user", "waifus", first.id, "waifu.json");
    const seeded = JSON.parse(await readFile(firstPath, "utf8"));
    expect(seeded.displayName).toBe(first.displayName);
    // No bed time and no day file any more (spec §38): she is around at any hour.
    expect(seeded).not.toHaveProperty("availability");
    expect(seeded).not.toHaveProperty("scheduleInPrompt");
    expect(seeded.dm).not.toHaveProperty("sleepNotice");
    expect(seeded).not.toHaveProperty("tools");
    expect(seeded).not.toHaveProperty("params");
    expect(seeded).not.toHaveProperty("contextWindow");
    expect(seeded).not.toHaveProperty("promptLayout");
    expect(seeded.model).toBeUndefined();
    expect(seeded.botId).toBeUndefined();

    await rm(path.join(root, "user", "waifus", first.id), { recursive: true, force: true });
    await ensureDataLayout(root);
    await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("seeds the whole default cast with her Discord bio and username (Living cast §17)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    const marker = JSON.parse(await readFile(path.join(root, "user", "waifus", ".prebuilt-seed.json"), "utf8"));
    expect(marker.waifuIds).toEqual(PREBUILT_WAIFUS.map((waifu) => waifu.id));
    for (const waifu of PREBUILT_WAIFUS) {
      const seeded = JSON.parse(await readFile(path.join(root, "user", "waifus", waifu.id, "waifu.json"), "utf8"));
      expect(seeded.persona).toBe(waifu.persona);
      expect(seeded).not.toHaveProperty("verbosity");
      expect(seeded.wakeOnName).toBe(waifu.wakeOnName ?? true);
      expect(seeded.bio).toBe(waifu.bio);
      expect(seeded.username).toBe(waifu.username);
    }
  });

  it("ships the owner's twenty-one default waifus with valid bios and Discord usernames", () => {
    expect(PREBUILT_WAIFUS.map((waifu) => waifu.name)).toEqual([
      "Aria", "Lumi", "Riko", "Yuna", "Hinata", "Airi", "Mio", "Sora", "Alya", "Rem", "Raphtalia",
      "Mizuhara", "Ayame", "Angel", "Makima", "Saber", "Esdeath", "Akame", "C.C.", "Power", "Zero Two"
    ]);
    const ids = PREBUILT_WAIFUS.map((waifu) => waifu.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Names that are common words in chat don't wake her by name.
    expect(PREBUILT_WAIFUS.filter((waifu) => waifu.wakeOnName === false).map((waifu) => waifu.id).sort()).toEqual(["angel", "power", "rem", "saber"]);
    for (const waifu of PREBUILT_WAIFUS) {
      expect(waifu.id).toBe(waifu.name.toLowerCase().replace(/\./g, "").replace(/\s+/g, "-"));
      expect(waifu.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(waifu.displayName).toBe(waifu.name);
      const words = waifu.persona.split(/\s+/).length;
      expect(words, waifu.id).toBeGreaterThanOrEqual(120);
      expect(words, waifu.id).toBeLessThanOrEqual(220);
      expect(waifu.bio && [...waifu.bio].length, waifu.id).toBeLessThanOrEqual(PREBUILT_BIO_MAX_CHARS);
      expect(waifu.bio?.trim(), waifu.id).toBeTruthy();
      const username = waifu.username ?? "";
      expect([...username].length, waifu.id).toBeGreaterThanOrEqual(2);
      expect([...username].length, waifu.id).toBeLessThanOrEqual(32);
      expect(username).toBe(username.trim());
      expect(username).not.toMatch(/[@#:]|```|discord|clyde|everyone|here/i);
      expect(waifu).not.toHaveProperty("availability");
      expect(WaifuConfigSchema.parse({ schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: "2026-10-25T00:00:00.000Z", ...waifu }).persona).toBe(waifu.persona);
    }
  });

  it("redacts known secret fields and token-like strings", () => {
    const redacted = redactSecrets({
      provider: {
        apiKey: "sk-test_12345678901234567890",
        nested: "token sk-test_12345678901234567890"
      },
      safe: "visible"
    });
    expect(redacted.provider.apiKey).toBe("[REDACTED]");
    expect(redacted.provider.nested).toContain("[REDACTED]");
    expect(redacted.safe).toBe("visible");
  });

  it("has no server-level tool gates and drops legacy per-waifu tool gates", () => {
    const now = "2026-05-16T12:00:00.000Z";
    const server = ServerConfigSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now,
      guildId: "guild-1",
      tools: { pickNextWaifu: false, shortTermMemory: true }
    });
    // Living cast §11.2: server `tools` retired (living-cast-server-fields-v1 removes stored ones).
    expect(server).not.toHaveProperty("tools");

    const waifu = WaifuConfigSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      updatedAt: now,
      id: "legacy-tools",
      name: "Legacy Tools",
      displayName: "Legacy Tools",
      persona: "",
      tools: {
        toolUse: false,
        pickNextWaifu: true,
        shortTermMemory: false
      }
    });
    // Living cast L1 dropped `tools.toolUse` (every life has the full tool set).
    expect(waifu).not.toHaveProperty("tools");
    expect(waifu).not.toHaveProperty("promptLayout");
  });

  it("an older waifu document with a bed time, busy blocks, scheduleInPrompt and a sleep notice still loads, without them (spec §38)", () => {
    const waifu = WaifuConfigSchema.parse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      updatedAt: "2026-05-16T12:00:00.000Z",
      id: "old",
      name: "Old",
      displayName: "Old",
      persona: "",
      availability: {
        bedTime: { enabled: true, start: "23:00", end: "07:00" },
        busy: [{ start: "09:00", end: "10:00", reason: "class" }]
      },
      scheduleInPrompt: false,
      dm: { allowDms: true, sleepNotice: "asleep, back at 8" }
    });
    expect(waifu).not.toHaveProperty("availability");
    expect(waifu).not.toHaveProperty("scheduleInPrompt");
    expect(waifu.dm).toEqual({ allowDms: true, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "" });
  });
});
