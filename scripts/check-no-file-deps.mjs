#!/usr/bin/env node
// Blocks publishing while any dependency is a file: spec — a published file:
// dep is unresolvable for consumers. P6 swaps @waifucave/gateway to a pinned
// registry version (MIGRATION_PLAN §8), after which this passes again.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const offenders = Object.entries({ ...pkg.dependencies, ...pkg.optionalDependencies }).filter(
  ([, spec]) => typeof spec === "string" && spec.startsWith("file:")
);
if (offenders.length > 0) {
  console.error(
    `Refusing to publish with file: dependencies: ${offenders
      .map(([name, spec]) => `${name}@${spec}`)
      .join(", ")}`
  );
  console.error("Swap to a pinned registry version (MIGRATION_PLAN §8 P6) before publishing.");
  process.exit(1);
}
