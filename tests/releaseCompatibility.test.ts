import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { rewriteRemoteCompatibilityVersion } from "../scripts/releaseCompatibility.mjs";

describe("release compatibility version transaction", () => {
  it("updates only the exact canonical app-version claim", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    const raw = await readFile(path.join(process.cwd(), "remote-compatibility.json"), "utf8");
    const next = packageJson.version.replace(/([0-9]+)$/u, (last) => String(Number(last) + 1));
    const rewritten = rewriteRemoteCompatibilityVersion(raw, packageJson.version, next);
    expect(JSON.parse(rewritten)).toEqual({ ...JSON.parse(raw), discordWaifusVersion: next });
    expect(rewritten).toMatch(/\n$/u);
    expect(() => rewriteRemoteCompatibilityVersion(rewritten, packageJson.version, next))
      .toThrow(/current package version/u);
  });

  it("refuses a noncanonical or version-drifted input", async () => {
    const raw = await readFile(path.join(process.cwd(), "remote-compatibility.json"), "utf8");
    const version = (JSON.parse(raw) as { discordWaifusVersion: string }).discordWaifusVersion;
    expect(() => rewriteRemoteCompatibilityVersion(JSON.stringify(JSON.parse(raw), null, 2), version, "9.0.0"))
      .toThrow(/canonical/u);
    expect(() => rewriteRemoteCompatibilityVersion(raw, "0.0.0", "9.0.0"))
      .toThrow(/current package version/u);
  });
});
