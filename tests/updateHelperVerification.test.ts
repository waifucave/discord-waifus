import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { helperVerificationRequired, verifyStagedUpdate } from "../src/backend/updates/runner.js";
import { PACKAGE_NAME } from "../src/backend/updates/control.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function stagedPackage(version: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const root = await makeTempRoot("waifus-staged-update-");
  roots.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: PACKAGE_NAME,
    version,
    ...overrides
  }));
  for (const file of ["bin/waifus.mjs", "dist/cli/main.js", "dist-frontend/index.html", "dist-remote-shell/index.html"]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "x");
  }
  return root;
}

async function dataRoot(remote: "missing" | "disabled" | "enabled" | "corrupt"): Promise<string> {
  const root = await makeTempRoot("waifus-update-role-");
  roots.push(root);
  if (remote === "missing") return root;
  await ensureDataLayout(root);
  const file = remoteStatePaths(root).hostConfig;
  if (remote === "corrupt") {
    await writeFile(file, "{", { mode: 0o600 });
    return root;
  }
  const config = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...config, enabled: remote === "enabled" }), { mode: 0o600 });
  return root;
}

describe("staged update verification", () => {
  it("verifies the app package alone when no role uses Remote Access", async () => {
    const root = await stagedPackage("2.111.3");
    await expect(verifyStagedUpdate(root, "2.111.3", { helper: false })).resolves.toBeUndefined();
  });

  it("keeps helper pins, compatibility and signatures mandatory when Remote Access is in use", async () => {
    const root = await stagedPackage("2.111.3");
    await expect(verifyStagedUpdate(root, "2.111.3", { helper: true })).rejects.toThrow("candidate_invalid");
  });

  it("still rejects an invalid app package without helper verification", async () => {
    const wrongVersion = await stagedPackage("2.111.4");
    await expect(verifyStagedUpdate(wrongVersion, "2.111.3", { helper: false })).rejects.toThrow("candidate_invalid");
    const privatePackage = await stagedPackage("2.111.3", { private: true });
    await expect(verifyStagedUpdate(privatePackage, "2.111.3", { helper: false })).rejects.toThrow("candidate_invalid");
    const wrongName = await stagedPackage("2.111.3", { name: "@waifucave/other" });
    await expect(verifyStagedUpdate(wrongName, "2.111.3", { helper: false })).rejects.toThrow("candidate_invalid");
    const empty = await stagedPackage("2.111.3");
    await writeFile(path.join(empty, "dist/cli/main.js"), "");
    await expect(verifyStagedUpdate(empty, "2.111.3", { helper: false })).rejects.toThrow("candidate_invalid");
  });
});

describe("helper verification requirement", () => {
  const supported = { platform: "darwin", arch: "arm64" } as const;

  it("is not required for hosts whose Remote Access is disabled or never configured", async () => {
    const roles = [
      { role: "host" as const, dataRoot: await dataRoot("disabled") },
      { role: "host" as const, dataRoot: await dataRoot("missing") }
    ];
    expect(await helperVerificationRequired(roles, supported)).toBe(false);
  });

  it("is required for an enabled host or any remote gateway role", async () => {
    expect(await helperVerificationRequired([
      { role: "host", dataRoot: await dataRoot("disabled") },
      { role: "host", dataRoot: await dataRoot("enabled") }
    ], supported)).toBe(true);
    expect(await helperVerificationRequired([
      { role: "remote", dataRoot: await dataRoot("missing") }
    ], supported)).toBe(true);
  });

  it("fails closed to strict verification when the remote config is unreadable", async () => {
    expect(await helperVerificationRequired([
      { role: "host", dataRoot: await dataRoot("corrupt") }
    ], supported)).toBe(true);
  });

  it("is never required on platforms without a helper package", async () => {
    const roles = [
      { role: "host" as const, dataRoot: await dataRoot("enabled") },
      { role: "remote" as const, dataRoot: await dataRoot("enabled") }
    ];
    expect(await helperVerificationRequired(roles, { platform: "darwin", arch: "x64" })).toBe(false);
    expect(await helperVerificationRequired(roles, { platform: "linux", arch: "arm" })).toBe(false);
    expect(await helperVerificationRequired(roles, { platform: "freebsd", arch: "x64" })).toBe(false);
  });
});
