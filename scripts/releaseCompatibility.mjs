function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortedJson(value[key])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortedJson(value))}\n`;
}

/** Change only the root-version claim, preserving a strict canonical compatibility table. */
export function rewriteRemoteCompatibilityVersion(raw, oldVersion, newVersion) {
  const value = JSON.parse(raw);
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || raw !== canonicalJson(value)
    || value.schemaVersion !== 1
    || value.discordWaifusVersion !== oldVersion
  ) {
    throw new Error("Remote compatibility metadata is not canonical or does not match the current package version.");
  }
  return canonicalJson({ ...value, discordWaifusVersion: newVersion });
}
