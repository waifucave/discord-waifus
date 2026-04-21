import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export function resolveBundledPnpmBin(): string {
  const pnpmPackageJson = require.resolve("pnpm");
  return path.join(path.dirname(pnpmPackageJson), "bin", "pnpm.cjs");
}
