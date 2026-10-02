import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { rewriteRemoteCompatibilityVersion } from "./releaseCompatibility.mjs";

export const RELEASE_VERSION_FILES = Object.freeze(["package.json", "package-lock.json", "remote-compatibility.json"]);

export function isPlainReleaseVersion(version) {
  return typeof version === "string" && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(version);
}

export function prepareReleaseVersionFiles(originals, version) {
  if (!isPlainReleaseVersion(version)) throw new Error("Release version must be a plain SemVer without leading zeroes.");
  const pkg = JSON.parse(originals.get("package.json"));
  const lock = JSON.parse(originals.get("package-lock.json"));
  if (pkg.version !== lock.version || lock.packages?.[""]?.version !== pkg.version) {
    throw new Error("Package and lockfile versions disagree before release.");
  }
  const compatibility = rewriteRemoteCompatibilityVersion(originals.get("remote-compatibility.json"), pkg.version, version);
  pkg.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  return new Map([
    ["package.json", `${JSON.stringify(pkg, null, 2)}\n`],
    ["package-lock.json", `${JSON.stringify(lock, null, 2)}\n`],
    ["remote-compatibility.json", compatibility]
  ]);
}

export function beginReleaseVersionUpdate(root, version) {
  const originals = new Map(RELEASE_VERSION_FILES.map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]));
  const prepared = prepareReleaseVersionFiles(originals, version);
  const ownedTemps = new Set();
  const stages = [];
  const cleanup = () => {
    for (const file of ownedTemps) fs.rmSync(file, { force: true });
    ownedTemps.clear();
  };
  function stage(name, contents, mode) {
    const file = path.join(root, `.${name}.waifus-release-${randomBytes(12).toString("hex")}.tmp`);
    const fd = fs.openSync(file, "wx", mode);
    ownedTemps.add(file);
    try { fs.writeFileSync(fd, contents, "utf8"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return file;
  }
  // Complete every new file and recovery copy before replacing any original.
  // Renames are atomic per file; this is not a multi-file crash-recovery journal.
  try {
    for (const name of RELEASE_VERSION_FILES) {
      const target = path.join(root, name);
      const info = fs.lstatSync(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Release metadata must be a regular file: ${name}`);
      const next = stage(name, prepared.get(name), info.mode & 0o777);
      const backup = stage(name, originals.get(name), info.mode & 0o777);
      stages.push({ name, target, next, backup });
    }
  } catch (error) { cleanup(); throw error; }

  let finished = false;
  const finish = () => { cleanup(); finished = true; };
  const restore = () => {
    if (finished) return;
    const safe = [];
    for (const entry of stages) {
      const current = fs.readFileSync(entry.target, "utf8");
      if (current === originals.get(entry.name)) continue;
      if (current !== prepared.get(entry.name)) {
        throw new Error(`Cannot safely restore ${entry.name}; non-version content changed or owned version bytes were replaced. Recovery copies remain beside the originals.`);
      }
      safe.push(entry);
    }
    for (const entry of safe) {
      fs.renameSync(entry.backup, entry.target);
      ownedTemps.delete(entry.backup);
    }
    finish();
  };
  try {
    for (const entry of stages) {
      if (fs.readFileSync(entry.target, "utf8") !== originals.get(entry.name)) {
        throw new Error(`Release metadata changed before replacement: ${entry.name}`);
      }
      fs.renameSync(entry.next, entry.target);
      ownedTemps.delete(entry.next);
    }
  } catch (error) {
    restore();
    throw error;
  }
  return Object.assign(restore, { finish });
}
