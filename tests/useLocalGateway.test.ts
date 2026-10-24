import { execFileSync } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/use-local-gateway.mjs");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots.length = 0;
});

type Fixture = { app: string; source: string; target: string };

// A throwaway "app" whose scripts/ holds a copy of the real script (so appRoot is the temp app)
// and a fake gateway checkout the script is pointed at through WAIFUS_GATEWAY_DIR.
async function makeFixture(): Promise<Fixture & { root: string }> {
  const root = await makeTempRoot("dc-waifus-gw-");
  roots.push(root);
  const app = path.join(root, "app");
  const source = path.join(root, "gateway");
  await mkdir(path.join(app, "scripts"), { recursive: true });
  await mkdir(path.join(app, "node_modules", "@waifucave"), { recursive: true });
  await copyFile(SCRIPT, path.join(app, "scripts", "use-local-gateway.mjs"));
  await mkdir(path.join(source, "dist"), { recursive: true });
  await mkdir(path.join(source, "data"), { recursive: true });
  await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "@waifucave/gateway", version: "9.9.9" }));
  await writeFile(path.join(source, "dist", "index.js"), "export const built = true;\n");
  await writeFile(path.join(source, "data", "models.json"), "{}\n");
  return { root, app, source, target: path.join(app, "node_modules", "@waifucave", "gateway") };
}

function run(fx: Fixture): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [path.join(fx.app, "scripts", "use-local-gateway.mjs")], {
      env: { ...process.env, WAIFUS_GATEWAY_DIR: fx.source },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { status: 0, output };
  } catch (error) {
    const failed = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
  }
}

describe("scripts/use-local-gateway.mjs", () => {
  it("copies dist, data and package.json into a fresh node_modules entry", async () => {
    const fx = await makeFixture();
    expect(run(fx).status).toBe(0);
    expect(await readFile(path.join(fx.target, "dist", "index.js"), "utf8")).toContain("built");
    expect(await readFile(path.join(fx.target, "data", "models.json"), "utf8")).toBe("{}\n");
    expect(JSON.parse(await readFile(path.join(fx.target, "package.json"), "utf8")).version).toBe("9.9.9");
    expect((await lstat(fx.target)).isSymbolicLink()).toBe(false);
  });

  it("replaces a previous real install without leaving stale files", async () => {
    const fx = await makeFixture();
    await mkdir(path.join(fx.target, "dist"), { recursive: true });
    await writeFile(path.join(fx.target, "dist", "stale.js"), "old");
    expect(run(fx).status).toBe(0);
    await expect(stat(path.join(fx.target, "dist", "stale.js"))).rejects.toThrow();
    await expect(stat(path.join(fx.target, "dist", "index.js"))).resolves.toBeDefined();
  });

  it("never deletes the gateway checkout when node_modules entry is an npm link to it", async () => {
    const fx = await makeFixture();
    await symlink(fx.source, fx.target, "dir");

    const result = run(fx);

    expect(result.status).toBe(0);
    expect(result.output).toMatch(/npm link/i);
    // The checkout is intact...
    expect(await readFile(path.join(fx.source, "dist", "index.js"), "utf8")).toContain("built");
    expect(await readFile(path.join(fx.source, "data", "models.json"), "utf8")).toBe("{}\n");
    expect(await readFile(path.join(fx.source, "package.json"), "utf8")).toContain("9.9.9");
    // ...and the link was replaced by a real directory holding a copy.
    expect((await lstat(fx.target)).isSymbolicLink()).toBe(false);
    expect(await realpath(fx.target)).not.toBe(await realpath(fx.source));
    expect(await readFile(path.join(fx.target, "dist", "index.js"), "utf8")).toContain("built");
  });

  it("leaves the target of a link to some other directory untouched", async () => {
    const fx = await makeFixture();
    const elsewhere = path.join(fx.root, "elsewhere");
    await mkdir(path.join(elsewhere, "dist"), { recursive: true });
    await writeFile(path.join(elsewhere, "dist", "keep.js"), "keep");
    await symlink(elsewhere, fx.target, "dir");

    expect(run(fx).status).toBe(0);

    expect(await readFile(path.join(elsewhere, "dist", "keep.js"), "utf8")).toBe("keep");
    expect((await lstat(fx.target)).isSymbolicLink()).toBe(false);
    await expect(readlink(fx.target)).rejects.toThrow();
  });

  it("errors clearly when the gateway has not been built", async () => {
    const fx = await makeFixture();
    await writeFile(path.join(fx.source, "dist", "index.js"), "x");
    await (await import("node:fs/promises")).rm(path.join(fx.source, "dist"), { recursive: true });
    const result = run(fx);
    expect(result.status).not.toBe(0);
    expect(result.output).toMatch(/npm run build/);
  });
});
