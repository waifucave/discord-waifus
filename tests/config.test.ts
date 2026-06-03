import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import { PREBUILT_WAIFUS } from "../src/config/prebuiltWaifus.js";
import { DATA_ROOT_ENV, getDataRoot } from "../src/config/paths.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { redactSecrets } from "../src/backend/redaction.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";
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
    await expect(access(path.join(root, "app", "cache", "ocr", "results"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "app", "tmp", "ocr"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "user", "waifus"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "user", "servers"))).resolves.toBeUndefined();

    const config = await loadAppConfig(root);
    expect(config.http.port).toBe(3888);
    expect(config.runtime.autoConnectDiscord).toBe(true);
    expect(config.ocr).toMatchObject({
      enabled: true,
      engine: "auto",
      cacheTtlHours: 24,
      timeoutMs: 1500,
      maxImageBytes: 8 * 1024 * 1024,
      maxImagesPerModelCall: 4,
      maxTextCharsPerImage: 1500
    });
  });

  it("fills OCR defaults when loading older config files", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(
      path.join(root, "config.toml"),
      [
        "schemaVersion = 1",
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

  it("keeps legacy Tesseract OCR configs as system Tesseract", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);
    await writeFile(
      path.join(root, "config.toml"),
      [
        "schemaVersion = 1",
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
    expect(seeded.availability.sleep.enabled).toBe(true);
    expect(seeded.availability.busy.length).toBeGreaterThan(0);
    expect(seeded.tools).toEqual({ toolUse: true, pickNextWaifu: true, shortTermMemory: true });
    expect(seeded.modelId).toBeUndefined();
    expect(seeded.botId).toBeUndefined();

    await rm(path.join(root, "user", "waifus", first.id), { recursive: true, force: true });
    await ensureDataLayout(root);
    await expect(access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("rejects overlapping busy intervals in waifu availability", () => {
    expect(() =>
      WaifuConfigSchema.parse({
        schemaVersion: 1,
        revision: 0,
        updatedAt: "2026-05-16T12:00:00.000Z",
        id: "overlap",
        name: "Overlap",
        displayName: "Overlap",
        persona: "",
        availability: {
          sleep: { enabled: true, start: "23:00", end: "07:00" },
          busy: [
            { start: "09:00", end: "10:00", reason: "class" },
            { start: "09:30", end: "11:00", reason: "work" }
          ]
        }
      })
    ).toThrow(/Busy intervals cannot overlap/);
  });
});
