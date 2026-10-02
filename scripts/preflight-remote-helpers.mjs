#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { validateHelperReleasePins, validateRegistryHelper } from "./releaseHelperPackages.mjs";
import { prepareReleaseVersionFiles } from "./releaseVersions.mjs";

const execute = promisify(execFile);
const registry = "https://registry.npmjs.org";
const buildInfoFields = [
  "schemaVersion", "helperVersion", "releaseSequence", "releasedAt", "packageName", "target",
  "sourceCommit", "contractCommit", "forkCommit", "workerTrustRingSha256", "tailscale", "goVersion",
  "directOnlyBuildTag", "protocols", "capabilities"
];
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

async function npm(args) {
  const cli = process.env.npm_execpath;
  if (process.platform === "win32" && !cli) {
    throw new Error("Run the helper release preflight through npm on Windows.");
  }
  const result = await execute(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
    maxBuffer: 8 * 1024 * 1024, timeout: 180000,
    env: { ...process.env, NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false" }
  });
  return result.stdout;
}

export async function loadHelperReleaseRuntime(packageRoot) {
  const load = (file) => import(pathToFileURL(path.join(packageRoot, "dist", file)).href);
  const [binary, compatibility, trust] = await Promise.all([
    load("remote/helperBinary.js"), load("remote/componentCompatibility.js"), load("shared/helperManifestTrust.js")
  ]);
  const { HELPER_RELEASE_TRUST_ROOTS } = await load("remote/helperReleaseTrust.js");
  return { ...binary, ...compatibility, ...trust, HELPER_RELEASE_TRUST_ROOTS };
}

/** Verify signed contents across targets; native execution is a separate required CI gate. */
export async function verifyDownloadedHelpers({ runtime, pins, installRoot, appVersion, compatibility }) {
  const results = [];
  for (const pin of pins) {
    const packageRoot = path.join(installRoot, "node_modules", pin.name);
    const verified = await runtime.resolveTsConnectBinary({
      platform: pin.os, arch: pin.cpu, appVersion, compatibility,
      trustRoots: runtime.HELPER_RELEASE_TRUST_ROOTS,
      resolvePackageJson: async () => path.join(packageRoot, "package.json"),
      // This callback runs only after the production resolver has checked the
      // inventory, signatures, binary/notices hashes and compatibility. It avoids
      // executing foreign binaries; the native matrix uses the real version probe.
      probeBinary: async () => {
        const manifest = await readJson(path.join(packageRoot, "manifest.json"));
        return {
          ...Object.fromEntries(buildInfoFields.map((field) => [field, manifest[field]])),
          controlProfiles: runtime.HELPER_CONTROL_PROFILES_V1
        };
      }
    });
    if (verified.helperVersion !== pin.version) throw new Error(`Installed helper version differs: ${pin.name}`);
    results.push({
      name: pin.name, version: verified.helperVersion, releaseSequence: verified.releaseSequence,
      binarySha256: verified.binarySha256, signedContentsVerified: true, nativeExecutionVerified: false
    });
  }
  return results;
}

export async function preflightRemoteHelpers({ packageRoot, lockfile = path.join(packageRoot, "package-lock.json"), releaseVersion, runNpm = npm }) {
  const originals = new Map(await Promise.all([
    ["package.json", path.join(packageRoot, "package.json")], ["package-lock.json", lockfile],
    ["remote-compatibility.json", path.join(packageRoot, "remote-compatibility.json")]
  ].map(async ([name, file]) => [name, await readFile(file, "utf8")])));
  const prepared = releaseVersion ? prepareReleaseVersionFiles(originals, releaseVersion) : originals;
  const [pkg, lock, rawCompatibility] = [
    JSON.parse(prepared.get("package.json")), JSON.parse(prepared.get("package-lock.json")),
    JSON.parse(prepared.get("remote-compatibility.json"))
  ];
  if (pkg.version !== lock.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("Release package and lockfile versions disagree.");
  }
  const pins = validateHelperReleasePins(pkg, lock);
  const runtime = await loadHelperReleaseRuntime(packageRoot);
  const compatibility = runtime.parseRemoteCompatibilityV1(rawCompatibility, pkg.version);
  await Promise.all(pins.map(async (pin) => {
    let metadata;
    try {
      metadata = JSON.parse(await runNpm([
        "view", `${pin.name}@${pin.version}`, "name", "version", "os", "cpu", "license", "scripts", "bin",
        "dependencies", "optionalDependencies", "peerDependencies", "dist", "--json", `--registry=${registry}`
      ]));
    } catch {
      throw new Error(`Unable to verify registry metadata for ${pin.name}@${pin.version}.`);
    }
    validateRegistryHelper(metadata, pin);
  }));
  const results = [];
  for (const pin of pins) {
    const installRoot = await mkdtemp(path.join(tmpdir(), "waifus-helper-preflight-"));
    // npm still skips foreign optional packages under --force. Select each target
    // explicitly in its own inspection prefix; lifecycle scripts remain disabled.
    await runNpm([
      "install", "--prefix", installRoot, "--save-optional", "--save-exact", "--include=optional", "--ignore-scripts",
      `--os=${pin.os}`, `--cpu=${pin.cpu}`, "--no-audit", "--no-fund", `--registry=${registry}`,
      `${pin.name}@${pin.version}`
    ]);
    const installedLock = await readJson(path.join(installRoot, "package-lock.json"));
    const entry = installedLock.packages?.[`node_modules/${pin.name}`];
    if (entry?.version !== pin.version || entry?.integrity !== pin.integrity || entry?.resolved !== pin.resolved) {
      throw new Error(`Downloaded helper integrity changed during preflight: ${pin.name}`);
    }
    results.push(...await verifyDownloadedHelpers({ runtime, pins: [pin], installRoot, appVersion: pkg.version, compatibility }));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [packageRoot = process.cwd(), lockfile] = process.argv.slice(2);
  if (process.argv.length > 4) throw new Error("Usage: preflight-remote-helpers.mjs [package-root] [lockfile]");
  try {
    console.log(JSON.stringify(await preflightRemoteHelpers({ packageRoot: path.resolve(packageRoot), ...(lockfile ? { lockfile: path.resolve(lockfile) } : {}) })));
  } catch (error) {
    console.error(`Helper release preflight failed: ${error.code ?? error.message}`);
    process.exitCode = 1;
  }
}
