import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRemoteCapabilitiesDocument,
  createRemoteProtocolFixtureSet,
  createRemoteProtocolJsonSchema,
  serializeCanonicalContractJson,
  serializeRemoteContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";
import {
  createHelperManifestFixtureSet,
  createHelperManifestJsonSchema,
  createRemoteAccessFixtureSet,
  createRemoteAccessJsonSchema
} from "../src/shared/schemas/remoteAccessContract.js";
import { createWipcFixtureSet } from "../src/shared/wipcContract.js";
import { createRemotePairingFixtureSet } from "../src/shared/remotePairingContract.js";
import { createPairConfirmationFixtureSet } from "../src/shared/pairConfirmationContract.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const contractRoot = path.join(repositoryRoot, "contracts", "remote", "v1");

const generatedFiles = new Map<string, string>([
  [
    path.join(contractRoot, "protocol.schema.json"),
    serializeRemoteContractJson(createRemoteProtocolJsonSchema())
  ],
  [
    path.join(contractRoot, "capabilities.json"),
    serializeRemoteContractJson(createRemoteCapabilitiesDocument())
  ],
  [
    path.join(contractRoot, "helper-manifest.schema.json"),
    serializeRemoteContractJson(createHelperManifestJsonSchema())
  ],
  [
    path.join(contractRoot, "remote-access.schema.json"),
    serializeRemoteContractJson(createRemoteAccessJsonSchema())
  ]
]);

for (const [relativePath, value] of createHelperManifestFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

for (const [relativePath, value] of createRemoteAccessFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

for (const [relativePath, value] of createRemoteProtocolFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

for (const [relativePath, value] of createWipcFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

for (const [relativePath, value] of createRemotePairingFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

for (const [relativePath, value] of createPairConfirmationFixtureSet()) {
  generatedFiles.set(
    path.join(contractRoot, relativePath),
    serializeCanonicalContractJson(value)
  );
}

async function checkGeneratedFiles(): Promise<void> {
  const mismatches: string[] = [];
  for (const [filePath, expected] of generatedFiles) {
    let actual: string;
    try {
      actual = await readFile(filePath, "utf8");
    } catch {
      mismatches.push(path.relative(repositoryRoot, filePath));
      continue;
    }
    if (actual !== expected) {
      mismatches.push(path.relative(repositoryRoot, filePath));
    }
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Remote contract files are missing or stale: ${mismatches.join(", ")}. Run npm run contracts:remote:generate.`
    );
  }
}

async function writeGeneratedFiles(): Promise<void> {
  await Promise.all(
    [...generatedFiles.keys()].map((filePath) => mkdir(path.dirname(filePath), { recursive: true }))
  );
  await Promise.all(
    [...generatedFiles].map(([filePath, contents]) => writeFile(filePath, contents, "utf8"))
  );
}

const mode = process.argv[2];
if (mode === "--check") {
  await checkGeneratedFiles();
} else if (mode === "--write") {
  await writeGeneratedFiles();
} else {
  throw new Error("Usage: generate-remote-contracts.ts --check | --write");
}
