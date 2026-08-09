import { z } from "zod";
import {
  CanonicalReleasedAtSchema,
  GitCommitSha1Schema,
  HELPER_PACKAGE_TARGETS,
  HelperManifestSchema,
  HelperTargetSchema,
  PositiveUint64DecimalSchema,
  ProtocolRangeSchema,
  ReleaseKeyIdListSchema,
  Sha256HexSchema
} from "./remoteAccess.js";
import {
  CapabilityNameListSchema,
  CapabilityNameSchema,
  SemVerSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";
import type { ContractJson } from "./remoteProtocolContract.js";

export const HELPER_MANIFEST_SCHEMA_ID =
  "https://waifucave.com/contracts/remote/v1/helper-manifest.schema.json";

type ContractJsonObject = { [key: string]: ContractJson };

const registeredSchemas: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["CanonicalReleasedAt", CanonicalReleasedAtSchema],
  ["CapabilityName", CapabilityNameSchema],
  ["CapabilityNameList", CapabilityNameListSchema],
  ["GitCommitSha1", GitCommitSha1Schema],
  ["HelperManifest", HelperManifestSchema],
  ["HelperTarget", HelperTargetSchema],
  ["PositiveUint64Decimal", PositiveUint64DecimalSchema],
  ["ProtocolRange", ProtocolRangeSchema],
  ["ReleaseKeyIdList", ReleaseKeyIdListSchema],
  ["SemVer", SemVerSchema],
  ["Sha256Hex", Sha256HexSchema],
  ["Uint64Decimal", Uint64DecimalSchema]
];

function helperTargetMatrix(): ContractJson[] {
  return HELPER_PACKAGE_TARGETS.map((entry) => ({
    properties: {
      binary: {
        properties: {
          relativePath: {
            const: entry.target.os === "win32" ? "bin/ts-connect.exe" : "bin/ts-connect"
          }
        },
        required: ["relativePath"]
      },
      packageName: { const: entry.packageName },
      target: { const: entry.target }
    },
    required: ["binary", "packageName", "target"]
  }));
}

function addNonStructuralContractConstraints(definitions: Record<string, ContractJsonObject>): void {
  definitions.CapabilityNameList.uniqueItems = true;
  definitions.CapabilityNameList["x-waifus-ascii-sorted"] = true;

  definitions.ReleaseKeyIdList.uniqueItems = true;
  definitions.ReleaseKeyIdList["x-waifus-ascii-sorted"] = true;

  definitions.PositiveUint64Decimal.not = { const: "0" };
  definitions.CanonicalReleasedAt.format = "waifus-rfc3339-whole-second";
  definitions.ProtocolRange["x-waifus-ordered-fields"] = ["minimumMinor", "maximumMinor"];

  definitions.HelperManifest.allOf = [
    { oneOf: helperTargetMatrix() },
    {
      "x-waifus-semver-ordered-fields": [
        "minimumDiscordWaifusVersion",
        "maximumDiscordWaifusVersionExclusive"
      ]
    }
  ];
}

export function createHelperManifestJsonSchema(): ContractJsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of registeredSchemas) {
    schema.register(registry, { id });
  }
  const generated = z.toJSONSchema(registry, {
    uri: (id) => `#/$defs/${id}`
  }) as { schemas: Record<string, Record<string, unknown>> };
  const definitions: Record<string, ContractJsonObject> = {};
  for (const [id, schema] of Object.entries(generated.schemas)) {
    const definition = { ...schema } as Record<string, unknown>;
    delete definition.$schema;
    delete definition.$id;
    definitions[id] = definition as ContractJsonObject;
  }
  addNonStructuralContractConstraints(definitions);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: HELPER_MANIFEST_SCHEMA_ID,
    title: "Waifus ts-connect Helper Manifest V1",
    description:
      "Signed canonical manifest for one target-specific direct-only ts-connect helper package.",
    $ref: "#/$defs/HelperManifest",
    $defs: definitions
  };
}

function helperManifestFixture(
  packageTarget: (typeof HELPER_PACKAGE_TARGETS)[number]
): ContractJsonObject {
  return {
    schemaVersion: 1,
    helperVersion: "0.1.0",
    releaseSequence: "1",
    releasedAt: "2026-08-09T10:20:30Z",
    packageName: packageTarget.packageName,
    target: { ...packageTarget.target },
    binary: {
      relativePath: packageTarget.target.os === "win32"
        ? "bin/ts-connect.exe"
        : "bin/ts-connect",
      byteSize: "9007199254740992",
      sha256: "1".repeat(64)
    },
    protocols: {
      ipc: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      coordination: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      directService: { major: 1, minimumMinor: 0, maximumMinor: 0 },
      helperManifest: { major: 1, minimumMinor: 0, maximumMinor: 0 }
    },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.dashboard.manifest.v1",
      "waifus.http.v1",
      "waifus.principal.v1",
      "waifus.sse.cursor.v1",
      "waifus.stream.cancel.v1"
    ],
    minimumDiscordWaifusVersion: "1.5.203",
    maximumDiscordWaifusVersionExclusive: "1.6.0",
    sourceCommit: "2".repeat(40),
    contractCommit: "3".repeat(40),
    forkCommit: "4".repeat(40),
    workerTrustRingSha256: "5".repeat(64),
    tailscale: {
      tag: "v1.102.2",
      commit: "eb67e5dcbe145d63e1128b9b4b630f8a82da101f"
    },
    goVersion: "go1.26.5",
    directOnlyBuildTag: "waifus_direct_only",
    ossNoticeSha256: "6".repeat(64),
    releaseKeyIds: ["waifucave-ts-connect-release-2026-01"]
  };
}

function cloneFixture(value: ContractJsonObject): ContractJsonObject {
  return JSON.parse(JSON.stringify(value)) as ContractJsonObject;
}

export function createHelperManifestFixtureSet(): ReadonlyMap<string, ContractJsonObject> {
  const fixtures = new Map<string, ContractJsonObject>();
  for (const packageTarget of HELPER_PACKAGE_TARGETS) {
    const slug = packageTarget.packageName.replace("@waifucave/ts-connect-", "");
    fixtures.set(
      `fixtures/helper-manifest/valid/${slug}.json`,
      helperManifestFixture(packageTarget)
    );
  }

  const base = helperManifestFixture(HELPER_PACKAGE_TARGETS[3]);

  const targetMismatch = cloneFixture(base);
  targetMismatch.target = { os: "darwin", arch: "arm64" };
  fixtures.set("fixtures/helper-manifest/invalid/target-mismatch.json", targetMismatch);

  const unsafeBinary = cloneFixture(base);
  (unsafeBinary.binary as ContractJsonObject).relativePath = "../../ts-connect";
  fixtures.set("fixtures/helper-manifest/invalid/unsafe-binary-path.json", unsafeBinary);

  const numericSequence = cloneFixture(base);
  numericSequence.releaseSequence = 1;
  fixtures.set("fixtures/helper-manifest/invalid/release-sequence-number.json", numericSequence);

  const fractionalTime = cloneFixture(base);
  fractionalTime.releasedAt = "2026-08-09T10:20:30.000Z";
  fixtures.set("fixtures/helper-manifest/invalid/noncanonical-released-at.json", fractionalTime);

  const reverseRange = cloneFixture(base);
  reverseRange.minimumDiscordWaifusVersion = "2.0.0";
  reverseRange.maximumDiscordWaifusVersionExclusive = "1.9.0";
  fixtures.set("fixtures/helper-manifest/invalid/reverse-app-range.json", reverseRange);

  const missingTrustRing = cloneFixture(base);
  delete missingTrustRing.workerTrustRingSha256;
  fixtures.set("fixtures/helper-manifest/invalid/missing-worker-trust-ring.json", missingTrustRing);

  const unsortedCapabilities = cloneFixture(base);
  unsortedCapabilities.capabilities = ["waifus.stream.cancel.v1", "waifus.http.v1"];
  fixtures.set("fixtures/helper-manifest/invalid/unsorted-capabilities.json", unsortedCapabilities);

  const unknownField = cloneFixture(base);
  unknownField.controlUrl = "https://example.invalid";
  fixtures.set("fixtures/helper-manifest/invalid/unknown-field.json", unknownField);

  return fixtures;
}
