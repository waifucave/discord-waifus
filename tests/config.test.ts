import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import { PREBUILT_WAIFUS } from "../src/config/prebuiltWaifus.js";
import { DATA_ROOT_ENV, getDataRoot } from "../src/config/paths.js";
import { loadAppConfig } from "../src/config/appConfig.js";
import { redactSecrets } from "../src/backend/redaction.js";
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
    await expect(access(path.join(root, "user", "waifus"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "user", "servers"))).resolves.toBeUndefined();

    const config = await loadAppConfig(root);
    expect(config.http.port).toBe(3888);
    expect(config.runtime.autoConnectDiscord).toBe(true);
  });

  it("seeds editable prebuilt waifus only once per data root", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await ensureDataLayout(root);

    const first = PREBUILT_WAIFUS[0];
    const firstPath = path.join(root, "user", "waifus", first.id, "waifu.json");
    const seeded = JSON.parse(await readFile(firstPath, "utf8"));
    expect(seeded.displayName).toBe(first.displayName);
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
});
