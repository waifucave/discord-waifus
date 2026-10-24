#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { INITIAL_HELPER_TARGETS } from "./releaseHelperPackages.mjs";

const execute = promisify(execFile);
const names = new Set(["@waifucave/discord-waifus", "@starlight-ai/discord-waifus", ...INITIAL_HELPER_TARGETS.map(item => item.name)]);
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = () => { throw new Error("Verified archive publication failed."); };

export function publicationInputs(args) {
  const [archive, sha256, name, version, tag, confirmation] = args;
  if (args.length !== 6 || typeof archive !== "string" || !archive.endsWith(".tgz")
    || !/^[a-f0-9]{64}$/u.test(sha256) || !names.has(name) || !semver.test(version)
    || !["latest", "next"].includes(tag) || confirmation !== "--yes") fail();
  return { archive: path.resolve(archive), sha256, name, version, tag };
}

async function runPublisher(args, options) {
  const cli = process.env.npm_execpath;
  const child = spawn(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
    ...options, stdio: "inherit", shell: false
  });
  await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("npm publisher could not start.")));
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("npm publisher did not succeed.")));
  });
}

/** Publish the reviewed bytes from a neutral path, never the operator's checkout.
 * npm's tarball manifest adds _from/_resolved to public registry metadata.
 * This Unix-only release tool does not limit the app's supported platforms.
 */
export async function publishVerifiedArchive(args, { inspect = execute, publish = runPublisher } = {}) {
  const input = publicationInputs(args);
  if (!["darwin", "linux"].includes(process.platform)) fail();
  const info = await lstat(input.archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024 * 1024) fail();
  const bytes = await readFile(input.archive);
  if (hash(bytes) !== input.sha256) fail();
  // Do not use os.tmpdir(): it commonly contains the account name on Windows
  // and can be overridden to a personally named path on other platforms.
  const temporaryRoot = await realpath("/tmp");
  if (!["/tmp", "/private/tmp"].includes(temporaryRoot)) fail();
  const staging = await mkdtemp(path.join(temporaryRoot, "waifus-publish-"));
  try {
    const stageInfo = await lstat(staging);
    if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || (stageInfo.mode & 0o777) !== 0o700
      || stageInfo.uid !== process.getuid()) fail();
    const stagedArchive = path.join(staging, "package.tgz");
    await writeFile(stagedArchive, bytes, { flag: "wx", mode: 0o600 });
    const metadata = JSON.parse((await inspect("tar", ["-xOf", stagedArchive, "package/package.json"], {
      encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30000
    })).stdout);
    if (metadata.name !== input.name || metadata.version !== input.version || metadata.private === true
      || ["_from", "_resolved", "_where"].some(key => Object.hasOwn(metadata, key))) fail();
    if (hash(await readFile(stagedArchive)) !== input.sha256) fail();
    await publish(["publish", "./package.tgz", "--access", "public", "--tag", input.tag,
      "--registry=https://registry.npmjs.org", "--ignore-scripts", "--provenance=false"], { cwd: staging });
    return { name: input.name, version: input.version, tag: input.tag, sha256: input.sha256, uploadAccepted: true };
  } finally {
    // Only the newly created, exact staging directory is owned by this invocation.
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await publishVerifiedArchive(process.argv.slice(2)))); }
  catch { console.error("Verified archive publication failed; inspect npm's sanitized error above."); process.exitCode = 1; }
}
