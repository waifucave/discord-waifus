#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = Object.freeze([
  "bin/waifus.mjs",
  "contracts/remote/v1/capabilities.json",
  "contracts/remote/v1/fixtures/crypto/helper-manifest-trust-v1.json",
  "contracts/remote/v1/helper-manifest.schema.json",
  "contracts/remote/v1/protocol.schema.json",
  "contracts/remote/v1/remote-access.schema.json",
  "dist-frontend/index.html",
  "dist-frontend/waifus-dashboard-manifest.json",
  "dist-remote-shell/index.html",
  "dist/remote/helperBinary.js",
  "dist/remote/helperPackageManifest.js",
  "dist/remote/helperReleaseTrust.js",
  "dist/remote/productionHelper.js",
  "dist/shared/helperManifestTrust.js",
  "remote-compatibility.json"
]);

const FORBIDDEN_PATHS = Object.freeze([
  /^\.dc-waifus(?:\/|$)/u,
  /^\.env(?:\.|$)/u,
  /^\.git(?:\/|$)/u,
  /^\.github(?:\/|$)/u,
  /^new providers\.md$/u,
  /^research(?:\/|$)/u,
  /^src(?:\/|$)/u,
  /(?:^|\/)id_(?:ed25519|rsa)(?:\.|$)/u,
  /(?:^|\/)(?:private[-_]?key|private[-_]?seed|signing[-_]?seed)(?:\.|$)/iu,
  /(?:^|\/)ts-connect(?:\/|$)/u
]);

function fail(message) {
  throw new Error(`Root npm package audit failed: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value;
}

export function auditRootPackageInventory(report) {
  if (!Array.isArray(report) || report.length !== 1) {
    fail("npm pack must report exactly one root package.");
  }
  const entry = object(report[0], "npm pack entry");
  if (!Array.isArray(entry.files) || entry.files.length < REQUIRED_FILES.length) {
    fail("npm pack did not report a complete file inventory.");
  }
  const paths = entry.files.map((raw, index) => {
    const file = object(raw, `npm pack file ${index}`);
    if (typeof file.path !== "string" || file.path.length === 0 || file.path.startsWith("/")) {
      fail("npm pack returned an invalid package-relative path.");
    }
    return file.path;
  });
  if (new Set(paths).size !== paths.length) {
    fail("npm pack returned duplicate paths.");
  }
  for (const required of REQUIRED_FILES) {
    if (!paths.includes(required)) fail(`required file is missing: ${required}`);
  }
  for (const packagePath of paths) {
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(packagePath))) {
      fail(`forbidden local, source, or secret-shaped path is present: ${packagePath}`);
    }
  }
  return Object.freeze({ fileCount: paths.length, paths: Object.freeze(paths) });
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath || process.argv.length !== 3) {
    throw new Error("Usage: audit-root-package.mjs <npm-pack-json-path>");
  }
  const result = auditRootPackageInventory(JSON.parse(readFileSync(reportPath, "utf8")));
  console.log(`verified root npm package inventory (${result.fileCount} files)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
