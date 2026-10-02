export const INITIAL_HELPER_TARGETS = Object.freeze([
  { name: "@waifucave/ts-connect-darwin-arm64", os: "darwin", cpu: "arm64" },
  { name: "@waifucave/ts-connect-win32-x64", os: "win32", cpu: "x64" },
  { name: "@waifucave/ts-connect-win32-arm64", os: "win32", cpu: "arm64" },
  { name: "@waifucave/ts-connect-linux-x64", os: "linux", cpu: "x64" },
  { name: "@waifucave/ts-connect-linux-arm64", os: "linux", cpu: "arm64" }
].map(Object.freeze));

const exactVersion = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const helperPrefix = "@waifucave/ts-connect-";
const single = (value, expected) => Array.isArray(value) && value.length === 1 && value[0] === expected;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function validIntegrity(value) {
  if (typeof value !== "string" || !value.startsWith("sha512-")) return false;
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.length === 64 && bytes.toString("base64") === encoded;
}

/** Only the five reviewed native targets can enter the initial remote release. */
export function validateHelperReleasePins(pkg, lock) {
  const optional = pkg?.optionalDependencies;
  if (!object(optional) || !object(lock?.packages)) {
    throw new Error("Release requires an exact optional helper dependency for every supported target.");
  }
  const allowed = new Set(INITIAL_HELPER_TARGETS.map((target) => target.name));
  const declared = [optional, pkg.dependencies ?? {}, pkg.devDependencies ?? {}];
  for (const section of declared) {
    for (const name of Object.keys(section)) {
      if (name.startsWith(helperPrefix) && !allowed.has(name)) {
        throw new Error(`Release declares an unsupported helper target: ${name}`);
      }
    }
  }
  let releaseVersion;
  return INITIAL_HELPER_TARGETS.map((target) => {
    const version = optional[target.name];
    if (typeof version !== "string" || !exactVersion.test(version)
      || (releaseVersion !== undefined && version !== releaseVersion)) {
      throw new Error(`Release requires the same exact optional helper version for ${target.name}.`);
    }
    releaseVersion = version;
    const entry = lock.packages[`node_modules/${target.name}`];
    const resolved = `https://registry.npmjs.org/${target.name}/-/${target.name.slice("@waifucave/".length)}-${version}.tgz`;
    if (!object(entry) || entry.version !== version || entry.optional !== true
      || !single(entry.os, target.os) || !single(entry.cpu, target.cpu)
      || entry.resolved !== resolved || !validIntegrity(entry.integrity)) {
      throw new Error(`Helper lock metadata does not match the release: ${target.name}`);
    }
    return Object.freeze({ ...target, version, resolved, integrity: entry.integrity });
  });
}

/** Registry metadata must describe only the immutable, platform-selected binary package. */
export function validateRegistryHelper(metadata, pin) {
  if (!object(metadata) || metadata.name !== pin.name || metadata.version !== pin.version
    || !single(metadata.os, pin.os) || !single(metadata.cpu, pin.cpu)
    || metadata.license !== "SEE LICENSE IN LICENSE.txt"
    || ["scripts", "bin", "dependencies", "optionalDependencies", "peerDependencies"].some((key) => Object.hasOwn(metadata, key))
    || metadata.dist?.integrity !== pin.integrity || metadata.dist?.tarball !== pin.resolved) {
    throw new Error(`The registry helper differs from the reviewed release: ${pin.name}`);
  }
}
