import { readFileSync, writeFileSync } from "node:fs";
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
  const originals = new Map(RELEASE_VERSION_FILES.map((name) => [name, readFileSync(path.join(root, name), "utf8")]));
  const prepared = prepareReleaseVersionFiles(originals, version);
  const restore = () => {
    const safe = [];
    for (const name of RELEASE_VERSION_FILES) {
      const current = readFileSync(path.join(root, name), "utf8");
      const original = originals.get(name);
      if (current === original) continue;
      let value, previous;
      try { value = JSON.parse(current); previous = JSON.parse(original); }
      catch { throw new Error(`Cannot safely restore ${name}; its content changed unexpectedly.`); }
      if (name === "remote-compatibility.json") value.discordWaifusVersion = previous.discordWaifusVersion;
      else {
        value.version = previous.version;
        if (name === "package-lock.json") value.packages[""].version = previous.packages[""].version;
      }
      if (JSON.stringify(value) !== JSON.stringify(previous)) {
        throw new Error(`Cannot safely restore ${name}; non-version content changed during release.`);
      }
      safe.push([name, original]);
    }
    for (const [name, value] of safe) writeFileSync(path.join(root, name), value);
  };
  try {
    for (const [name, value] of prepared) writeFileSync(path.join(root, name), value);
  } catch (error) {
    restore();
    throw error;
  }
  return restore;
}
