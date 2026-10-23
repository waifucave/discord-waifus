#!/usr/bin/env node
// Blocks publishing while any dependency is a file: spec — a published file:
// dep is unresolvable for consumers (e.g. a local `npm link`ed gateway checkout).
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const offenders = Object.entries({
  ...pkg.dependencies,
  ...pkg.optionalDependencies,
  ...pkg.peerDependencies
}).filter(([, spec]) => typeof spec === "string" && spec.startsWith("file:"));
if (offenders.length > 0) {
  console.error(
    `Refusing to publish with file: dependencies: ${offenders
      .map(([name, spec]) => `${name}@${spec}`)
      .join(", ")}`
  );
  console.error("Swap to a pinned registry version before publishing.");
  process.exit(1);
}
