import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("node:child_process", () => ({ execFile: vi.fn(() => { throw new Error("Unexpected external command in mocked native-candidate test."); }) }));
import { INITIAL_HELPER_TARGETS } from "../scripts/releaseHelperPackages.mjs";
import {
  nativeCandidateInputs, nativeCandidatePackages, selectNativeCandidateDraft,
  validateNativeCandidateApp, verifyNativeCandidateBytes, downloadNativeRegistryHelper,
  prepareNativeCandidate
} from "../scripts/prepare-native-candidate.mjs";

const bytes = Buffer.from("reviewed candidate bytes");
const hash = (algorithm: string, encoding: "hex" | "base64" = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const input = () => nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64));
const packageSet = () => ({ schemaVersion: 1, packages: INITIAL_HELPER_TARGETS.map(target => ({
  ...target, version: "0.1.5", byteSize: bytes.length, filename: `waifucave-${target.name.slice("@waifucave/".length)}-0.1.5.tgz`,
  sha256: hash("sha256"), shasum: hash("sha1"), integrity: `sha512-${hash("sha512", "base64")}`
})) });
const draft = () => ({ tag_name: "v1.5.204", draft: true, target_commitish: "a".repeat(40), assets: [
  "package-set.json", input().appAsset, ...packageSet().packages.map(pkg => pkg.filename)
].map((name, index) => ({ name, id: index + 1, state: "uploaded", size: 100 })) });
const registry = "https://registry.npmjs.org";
const registryMetadata = (pkg = packageSet().packages[0]!) => ({ name: pkg.name,
  "dist-tags": { next: pkg.version }, versions: { [pkg.version]: {
    name: pkg.name, version: pkg.version, os: [pkg.os], cpu: [pkg.cpu], license: "SEE LICENSE IN LICENSE.txt",
    dist: { integrity: pkg.integrity, shasum: pkg.shasum,
      tarball: `${registry}/${pkg.name}/-/${pkg.name.slice("@waifucave/".length)}-${pkg.version}.tgz` }
  } } });
const response = (url: string, body: string | Buffer, init: ResponseInit = {}) => {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", { value: url });
  return result;
};
const temporaryRoots: string[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected real registry request in native-candidate test."); })));
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("public native candidate preparation", () => {
  it("requires canonical versions, a full source commit and both reviewed hashes", () => {
    expect(input().appVersion).toBe("1.5.204");
    expect(input().helperSource).toBe("draft");
    expect(nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64), "npm-next").helperSource).toBe("npm-next");
    for (const source of ["npm", "latest", "npm-next\n", "", null]) {
      expect(() => nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64), source)).toThrow();
    }
    for (const tag of ["main", "v01.5.204", "v1.5.204-beta", "v1.5.204\n"]) {
      expect(() => nativeCandidateInputs(tag, "0.1.5", "a".repeat(40), "b".repeat(64), "c".repeat(64))).toThrow();
    }
    expect(() => nativeCandidateInputs("v1.5.204", "latest", "a".repeat(40), "b".repeat(64), "c".repeat(64))).toThrow();
    expect(() => nativeCandidateInputs("v1.5.204", "0.1.5", "main", "b".repeat(64), "c".repeat(64))).toThrow();
    expect(() => nativeCandidateInputs("v1.5.204", "0.1.5", "a".repeat(40), "bad", "c".repeat(64))).toThrow();
  });

  it("downloads exact next bytes from the fixed registry with bounded, credential-free, nonredirecting requests", async () => {
    const pkg = packageSet().packages[0]!;
    const metadata = registryMetadata(pkg);
    const fetchRegistry = vi.fn(async (url: string) => response(url, url.endsWith(".tgz") ? bytes : JSON.stringify(metadata)));
    const downloaded = await downloadNativeRegistryHelper(pkg, fetchRegistry);
    expect(downloaded.bytes).toEqual(bytes);
    expect(downloaded.provenance).toMatchObject({ kind: "npm-next", registry, next: pkg.version, latestAbsent: true,
      integrity: pkg.integrity, shasum: pkg.shasum, tarballUrl: metadata.versions[pkg.version]!.dist.tarball });
    expect(fetchRegistry.mock.calls).toHaveLength(2);
    expect(fetchRegistry).toHaveBeenNthCalledWith(1, `${registry}/${pkg.name}`, expect.objectContaining({
      redirect: "error", credentials: "omit", signal: expect.any(AbortSignal)
    }));
    expect(fetchRegistry).toHaveBeenNthCalledWith(2, metadata.versions[pkg.version]!.dist.tarball, expect.objectContaining({
      redirect: "error", credentials: "omit", signal: expect.any(AbortSignal)
    }));
  });

  it.each(["tag", "latest", "identity", "version", "os", "cpu", "license", "scripts", "url", "integrity", "shasum"])("rejects unreviewed registry metadata: %s", async (change) => {
    const pkg = packageSet().packages[0]!;
    const metadata: any = registryMetadata(pkg);
    const version = metadata.versions[pkg.version];
    if (change === "tag") metadata["dist-tags"].next = "0.1.4";
    if (change === "latest") metadata["dist-tags"].latest = pkg.version;
    if (change === "identity") version.name = "@another/helper";
    if (change === "version") version.version = "0.1.4";
    if (change === "os") version.os = ["other"];
    if (change === "cpu") version.cpu = ["other"];
    if (change === "license") version.license = "MIT";
    if (change === "scripts") version.scripts = { postinstall: "unreviewed" };
    if (change === "url") version.dist.tarball = "https://unreviewed.example/helper.tgz";
    if (change === "integrity") version.dist.integrity = "sha512-changed";
    if (change === "shasum") version.dist.shasum = "d".repeat(40);
    const fetchRegistry = vi.fn(async (url: string) => response(url, JSON.stringify(metadata)));
    await expect(downloadNativeRegistryHelper(pkg, fetchRegistry)).rejects.toThrow();
    expect(fetchRegistry).toHaveBeenCalledTimes(1);
  });

  it.each(["redirect", "redirected-url", "metadata-size", "stream-size", "tarball-size", "digest"])("rejects unsafe registry responses: %s", async change => {
    const pkg = packageSet().packages[0]!;
    const fetchRegistry = vi.fn(async (url: string) => {
      if (!url.endsWith(".tgz")) {
        if (change === "redirect") return response(url, "", { status: 302, headers: { location: "https://other.example" } });
        if (change === "redirected-url") return response("https://other.example", JSON.stringify(registryMetadata(pkg)));
        if (change === "metadata-size") return response(url, "{}", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } });
        if (change === "stream-size") return response(url, Buffer.alloc(2 * 1024 * 1024 + 1));
        return response(url, JSON.stringify(registryMetadata(pkg)));
      }
      return response(url, change === "tarball-size" ? Buffer.concat([bytes, bytes]) : Buffer.alloc(bytes.length));
    });
    await expect(downloadNativeRegistryHelper(pkg, fetchRegistry)).rejects.toThrow();
  });

  it.each(["draft", "npm-next"])("preserves pinned draft app/set and records actual helper origin: %s", async helperSource => {
    const root = await mkdtemp(path.join(os.tmpdir(), "waifus-native-candidate-"));
    temporaryRoots.push(root);
    vi.stubEnv("GITHUB_REPOSITORY", "waifucave/discord-waifus");
    vi.stubEnv("GITHUB_OUTPUT", path.join(root, "outputs"));
    const setBytes = Buffer.from(JSON.stringify(packageSet()));
    const appBytes = Buffer.from("reviewed app archive");
    const release = draft();
    const assets = new Map(release.assets.map(asset => [asset.id,
      asset.name === "package-set.json" ? setBytes : asset.name === input().appAsset ? appBytes : bytes]));
    release.assets.forEach(asset => { asset.size = assets.get(asset.id)!.length; });
    const execute = vi.fn(async (command: string, args: string[]) => {
      if (command === "tar") return { stdout: JSON.stringify({ name: "@waifucave/discord-waifus", version: "1.5.204",
        optionalDependencies: Object.fromEntries(INITIAL_HELPER_TARGETS.map(target => [target.name, "0.1.5"])) }) };
      expect(command).toBe("gh");
      const endpoint = args[1]!;
      if (endpoint.endsWith("/commits/main")) return { stdout: JSON.stringify({ sha: "a".repeat(40) }) };
      if (endpoint.includes("/compare/")) return { stdout: JSON.stringify({ status: "identical", base_commit: { sha: "a".repeat(40) }, merge_base_commit: { sha: "a".repeat(40) } }) };
      if (endpoint.includes("/releases?")) return { stdout: JSON.stringify([[release]]) };
      return { stdout: assets.get(Number(endpoint.split("/").at(-1))) };
    });
    const fetchRegistry = vi.fn(async (url: string) => {
      const pkg = packageSet().packages.find(pkg => url === `${registry}/${pkg.name}` || url === registryMetadata(pkg).versions[pkg.version]!.dist.tarball)!;
      expect(pkg).toBeDefined();
      return response(url, url.endsWith(".tgz") ? bytes : JSON.stringify(registryMetadata(pkg)));
    });
    const args = ["v1.5.204", "0.1.5", "a".repeat(40), createHash("sha256").update(appBytes).digest("hex"),
      createHash("sha256").update(setBytes).digest("hex"), path.join(root, "candidate")];
    // Existing six-argument callers must keep their draft behavior.
    if (helperSource === "npm-next") args.push(helperSource);
    const result = await prepareNativeCandidate(args, { execute, fetchRegistry });
    expect(result.verifiedAssets).toBe(7);
    const manifest = JSON.parse(await readFile(path.join(root, "candidate/native-validation-assets.json"), "utf8"));
    expect(manifest.helperSource).toBe(helperSource);
    expect(manifest.files.filter((file: any) => file.filename.startsWith("waifucave-ts-connect-")).every((file: any) =>
      file.source.kind === (helperSource === "npm-next" ? "npm-next" : "github-draft"))).toBe(true);
    expect(manifest.files.filter((file: any) => !file.filename.startsWith("waifucave-ts-connect-")).every((file: any) => file.source.kind === "github-draft")).toBe(true);
    expect(fetchRegistry).toHaveBeenCalledTimes(helperSource === "npm-next" ? 10 : 0);
    expect(execute.mock.calls.filter(([command, args]) => command === "gh" && args[1]!.includes("/releases/assets/"))).toHaveLength(helperSource === "npm-next" ? 2 : 7);
    expect(await readFile(path.join(root, "outputs"), "utf8")).toContain(`helper_source=${helperSource}\n`);
  });

  it("accepts exactly the five reviewed package identities and checks every digest", () => {
    const approved = nativeCandidatePackages(packageSet(), "0.1.5");
    expect(approved).toHaveLength(5);
    for (const pkg of approved) expect(() => verifyNativeCandidateBytes(bytes, pkg)).not.toThrow();
    expect(() => verifyNativeCandidateBytes(Buffer.from("tampered"), approved[0])).toThrow();
    for (const field of ["sha256", "shasum", "integrity"] as const) {
      expect(() => verifyNativeCandidateBytes(bytes, { ...approved[0], [field]: "changed" })).toThrow();
    }
    for (const mutation of [
      (set: ReturnType<typeof packageSet>) => { set.packages.pop(); },
      (set: ReturnType<typeof packageSet>) => { set.packages[1] = set.packages[0]!; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.cpu = "x64"; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.version = "0.1.4"; },
      (set: ReturnType<typeof packageSet>) => { set.packages[0]!.filename = "../unreviewed.tgz"; }
    ]) {
      const set = packageSet(); mutation(set);
      expect(() => nativeCandidatePackages(set, "0.1.5")).toThrow();
    }
  });

  it("requires one unpublished draft at the reviewed source with no extra assets", () => {
    expect(selectNativeCandidateDraft([draft()], input()).draft).toBe(true);
    for (const releases of [[], [draft(), draft()], [{ ...draft(), draft: false }],
      [{ ...draft(), target_commitish: "main" }], [{ ...draft(), assets: draft().assets.slice(1) }],
      [{ ...draft(), assets: [...draft().assets, { id: 9, name: "source.zip", state: "uploaded", size: 10 }] }]]) {
      expect(() => selectNativeCandidateDraft(releases, input())).toThrow();
    }
  });

  it("requires the new app version and exact native optional dependencies", () => {
    const pkg = { name: "@waifucave/discord-waifus", version: "1.5.204", private: false,
      optionalDependencies: Object.fromEntries(INITIAL_HELPER_TARGETS.map(target => [target.name, "0.1.5"])) };
    expect(() => validateNativeCandidateApp(pkg, "1.5.204", "0.1.5")).not.toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, private: true }, "1.5.204", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp(pkg, "1.5.203", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp(pkg, "1.5.204", "0.1.6")).toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, dependencies: { "@waifucave/ts-connect-darwin-arm64": "0.1.5" } }, "1.5.204", "0.1.5")).toThrow();
    expect(() => validateNativeCandidateApp({ ...pkg, optionalDependencies: { ...pkg.optionalDependencies, "@waifucave/ts-connect-linux-armv7": "0.1.5" } }, "1.5.204", "0.1.5")).toThrow();
  });
});
