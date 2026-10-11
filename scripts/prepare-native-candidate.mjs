import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { INITIAL_HELPER_TARGETS, validateRegistryHelper } from "./releaseHelperPackages.mjs";

const run = promisify(execFile);
const repository = "waifucave/discord-waifus";
const registry = "https://registry.npmjs.org";
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const digest = (bytes, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(bytes).digest(encoding);
const fail = () => { throw new Error("Native candidate validation failed."); };

export function nativeCandidateInputs(tag, helperVersion, appCommit, appSha256, packageSetSha256, helperSource = "draft", npmLatestPolicy = "absent") {
  if (typeof tag !== "string" || !tag.startsWith("v") || !semver.test(tag.slice(1))
    || typeof helperVersion !== "string" || !semver.test(helperVersion)
    || !/^[a-f0-9]{40}$/u.test(appCommit) || !/^[a-f0-9]{64}$/u.test(appSha256)
    || !/^[a-f0-9]{64}$/u.test(packageSetSha256) || !["draft", "npm-next"].includes(helperSource)) fail();
  validateLatestPolicy(npmLatestPolicy, helperVersion);
  if (npmLatestPolicy !== "absent" && helperSource !== "npm-next") fail();
  const appVersion = tag.slice(1);
  return { tag, appVersion, helperVersion, appCommit, appSha256, packageSetSha256, helperSource, npmLatestPolicy,
    appAsset: `waifucave-discord-waifus-${appVersion}-native-validation.tgz` };
}

function validateLatestPolicy(policy, version) {
  if (!["absent", "initial-0.1.12"].includes(policy)
    || (policy === "initial-0.1.12" && version !== "0.1.12")) fail();
}

export function nativeCandidatePackages(set, helperVersion) {
  if (set?.schemaVersion !== 1 || !Array.isArray(set.packages)
    || set.packages.length !== INITIAL_HELPER_TARGETS.length) fail();
  return INITIAL_HELPER_TARGETS.map(target => {
    const matches = set.packages.filter(pkg => pkg.name === target.name);
    if (matches.length !== 1) fail();
    const pkg = matches[0];
    if (pkg.version !== helperVersion || pkg.os !== target.os || pkg.cpu !== target.cpu
      || pkg.filename !== `waifucave-${target.name.slice("@waifucave/".length)}-${helperVersion}.tgz`
      || !Number.isSafeInteger(pkg.byteSize) || pkg.byteSize < 1 || pkg.byteSize > 256 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(pkg.sha256) || !/^[a-f0-9]{40}$/u.test(pkg.shasum)
      || typeof pkg.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(pkg.integrity)) fail();
    return pkg;
  });
}

export function verifyNativeCandidateBytes(bytes, expected) {
  if (bytes.length !== expected.byteSize || digest(bytes) !== expected.sha256
    || (expected.shasum !== undefined && digest(bytes, "sha1") !== expected.shasum)
    || (expected.integrity !== undefined && `sha512-${digest(bytes, "sha512", "base64")}` !== expected.integrity)) fail();
}

async function registryBytes(url, maximumBytes, timeoutMs, fetchRegistry) {
  const response = await fetchRegistry(url, {
    redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs)
  });
  const declaredSize = response.headers.get("content-length");
  if (response.status !== 200 || response.redirected || response.url !== url || !response.body
    || (declaredSize !== null && (!/^[0-9]+$/u.test(declaredSize) || Number(declaredSize) > maximumBytes))) {
    await response.body?.cancel();
    fail();
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) { await reader.cancel(); fail(); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  // Fetch can decode HTTP content encoding; bound the actual bytes independently
  // of the transport Content-Length. Tarball equality is checked against the set.
  return Buffer.concat(chunks, size);
}

/** Public registry reads only: no npm credentials, lifecycle scripts or redirect targets. */
export async function downloadNativeRegistryHelper(pkg, fetchRegistry = globalThis.fetch, latestPolicy = "absent") {
  validateLatestPolicy(latestPolicy, pkg?.version);
  const target = INITIAL_HELPER_TARGETS.find(value => value.name === pkg?.name);
  if (!target || pkg.os !== target.os || pkg.cpu !== target.cpu || !semver.test(pkg.version)
    || !Number.isSafeInteger(pkg.byteSize) || pkg.byteSize < 1 || pkg.byteSize > 256 * 1024 * 1024) fail();
  const metadataUrl = `${registry}/${pkg.name}`;
  const metadataBytes = await registryBytes(metadataUrl, 2 * 1024 * 1024, 30_000, fetchRegistry);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (metadata?.name !== pkg.name || metadata["dist-tags"]?.next !== pkg.version) fail();
  const latestAbsent = !Object.hasOwn(metadata["dist-tags"], "latest");
  if (latestPolicy === "absent" ? !latestAbsent : metadata["dist-tags"].latest !== "0.1.12") fail();
  const resolved = `${registry}/${pkg.name}/-/${pkg.name.slice("@waifucave/".length)}-${pkg.version}.tgz`;
  const version = metadata.versions?.[pkg.version];
  validateRegistryHelper(version, { ...pkg, resolved });
  if (version.dist.shasum !== pkg.shasum) fail();
  const bytes = await registryBytes(resolved, pkg.byteSize, 120_000, fetchRegistry);
  verifyNativeCandidateBytes(bytes, pkg);
  return { bytes, provenance: {
    kind: "npm-next", registry, metadataUrl, metadataSha256: digest(metadataBytes), tarballUrl: resolved,
    next: pkg.version, latestPolicy, latestAbsent, latest: latestAbsent ? null : metadata["dist-tags"].latest,
    integrity: pkg.integrity, shasum: pkg.shasum,
    downloadedAt: new Date().toISOString()
  } };
}

export function validateNativeCandidateApp(pkg, appVersion, helperVersion) {
  if (pkg?.name !== "@waifucave/discord-waifus" || pkg.version !== appVersion || pkg.private === true) fail();
  const expected = INITIAL_HELPER_TARGETS.map(target => target.name).sort();
  const actual = Object.keys(pkg.optionalDependencies ?? {}).filter(name => name.startsWith("@waifucave/ts-connect-")).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || expected.some(name => pkg.optionalDependencies[name] !== helperVersion)) fail();
  for (const section of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (Object.keys(section ?? {}).some(name => name.startsWith("@waifucave/ts-connect-"))) fail();
  }
}

export function selectNativeCandidateDraft(releases, input) {
  if (!Array.isArray(releases)) fail();
  const matches = releases.filter(release => release.tag_name === input.tag);
  if (matches.length !== 1) fail();
  const release = matches[0];
  if (release.draft !== true || release.target_commitish !== input.appCommit || !Array.isArray(release.assets)) fail();
  const names = ["package-set.json", input.appAsset, ...INITIAL_HELPER_TARGETS.map(target =>
    `waifucave-${target.name.slice("@waifucave/".length)}-${input.helperVersion}.tgz`)].sort();
  if (JSON.stringify(release.assets.map(asset => asset.name).sort()) !== JSON.stringify(names)) fail();
  for (const asset of release.assets) {
    if (!Number.isSafeInteger(asset.id) || asset.id < 1 || asset.state !== "uploaded"
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 256 * 1024 * 1024) fail();
  }
  return release;
}

async function githubJson(endpoint, options, execute) {
  const { stdout } = await execute("gh", ["api", endpoint, ...options], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function prepareNativeCandidate(args, { execute = run, fetchRegistry = globalThis.fetch } = {}) {
  if (![6, 7, 8].includes(args.length) || process.env.GITHUB_REPOSITORY !== repository || !process.env.GITHUB_OUTPUT) fail();
  const input = nativeCandidateInputs(...args.slice(0, 5), args[6], args[7]);
  const main = await githubJson(`repos/${repository}/commits/main`, [], execute);
  if (!/^[a-f0-9]{40}$/u.test(main.sha)) fail();
  const comparison = await githubJson(`repos/${repository}/compare/${input.appCommit}...${main.sha}`, [], execute);
  if (!["ahead", "identical"].includes(comparison.status) || comparison.base_commit?.sha !== input.appCommit
    || comparison.merge_base_commit?.sha !== input.appCommit) fail();
  const pages = await githubJson(`repos/${repository}/releases?per_page=100`, ["--paginate", "--slurp"], execute);
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) fail();
  const release = selectNativeCandidateDraft(pages.flat(), input);
  const output = path.resolve(args[5]);
  // Refuse an existing output directory; no old or unreviewed assets can be mixed in.
  await mkdir(output, { mode: 0o700 });
  const files = [];
  const download = async name => {
    const asset = release.assets.find(value => value.name === name);
    if (!asset) fail();
    const { stdout } = await execute("gh", ["api", `repos/${repository}/releases/assets/${asset.id}`, "-H", "Accept: application/octet-stream"],
      { encoding: null, timeout: 120_000, maxBuffer: 256 * 1024 * 1024 });
    const sha256 = digest(stdout);
    if (stdout.length !== asset.size || (asset.digest != null && asset.digest !== `sha256:${sha256}`)) fail();
    await writeFile(path.join(output, name), stdout, { flag: "wx", mode: 0o600 });
    files.push({ filename: name, byteSize: stdout.length, sha256, source: { kind: "github-draft", assetId: asset.id } });
    return stdout;
  };
  const setBytes = await download("package-set.json");
  if (digest(setBytes) !== input.packageSetSha256) fail();
  for (const pkg of nativeCandidatePackages(JSON.parse(setBytes), input.helperVersion)) {
    if (input.helperSource === "draft") {
      verifyNativeCandidateBytes(await download(pkg.filename), pkg);
    } else {
      const { bytes, provenance } = await downloadNativeRegistryHelper(pkg, fetchRegistry, input.npmLatestPolicy);
      await writeFile(path.join(output, pkg.filename), bytes, { flag: "wx", mode: 0o600 });
      files.push({ filename: pkg.filename, byteSize: bytes.length, sha256: digest(bytes), source: provenance });
    }
  }
  const appBytes = await download(input.appAsset);
  if (digest(appBytes) !== input.appSha256) fail();
  const { stdout } = await execute("tar", ["-xOf", path.join(output, input.appAsset), "package/package.json"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 });
  validateNativeCandidateApp(JSON.parse(stdout), input.appVersion, input.helperVersion);
  const raw = Buffer.from(`${JSON.stringify({ schemaVersion: 1, ...input, publicMainCommit: main.sha,
    files: files.sort((a, b) => a.filename.localeCompare(b.filename, "en")) }, null, 2)}\n`);
  await writeFile(path.join(output, "native-validation-assets.json"), raw, { flag: "wx", mode: 0o600 });
  await writeFile(process.env.GITHUB_OUTPUT, `app_version=${input.appVersion}\nhelper_version=${input.helperVersion}\nhelper_source=${input.helperSource}\nnpm_latest_policy=${input.npmLatestPolicy}\napp_commit=${input.appCommit}\nmanifest_sha256=${digest(raw)}\n`, { flag: "a" });
  return { appVersion: input.appVersion, helperVersion: input.helperVersion, verifiedAssets: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(await prepareNativeCandidate(process.argv.slice(2)))}\n`);
  } catch {
    process.stderr.write("Native candidate validation failed.\n");
    process.exitCode = 1;
  }
}
