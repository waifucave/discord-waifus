import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ADMIN_AUDIT_RETENTION_SECONDS,
  AdministrativeAuditRecordV1Schema,
  COMPLETED_OPERATION_RETENTION_SECONDS,
  EventCursorSchema,
  MAX_ADMIN_AUDIT_RECORD_BYTES,
  OperationAcceptedV1Schema,
  OperationStatusV1Schema,
  StreamSnapshotRequiredV1Schema,
  UNRESOLVED_OPERATION_RETENTION_SECONDS
} from "./adminOperations.js";
import {
  ApprovalReceiptV1Schema,
  CanonicalReleasedAtSchema,
  CanonicalIdentityBundleCborSchema,
  DASHBOARD_ASSET_MAX_BYTES,
  DashboardAssetContentTypeSchema,
  DashboardAssetSchema,
  DashboardManifestSchema,
  GetResetStatusCommandSchema,
  GitCommitSha1Schema,
  HELPER_PACKAGE_TARGETS,
  HelperManifestSchema,
  HelperTargetSchema,
  IdentityResetReceiptV1Schema,
  PairConfirmationV1Schema,
  PairControlCapabilitiesPayloadV1Schema,
  PairControlEndpointAckPayloadV1Schema,
  PairControlEndpointGenerationPayloadV1Schema,
  PairControlErrorPayloadV1Schema,
  PairControlHelloPayloadV1Schema,
  PairControlPresencePayloadV1Schema,
  PairControlReconnectPayloadV1Schema,
  PairControlRecordV1Schema,
  PairControlRevocationAckPayloadV1Schema,
  PairControlRevocationPayloadV1Schema,
  PairControlTypeV1Schema,
  PairControlUnsignedRecordV1Schema,
  PositiveUint64DecimalSchema,
  ProtocolRangeSchema,
  ResetIdentityCommandSchema,
  ReleaseKeyIdListSchema,
  Sha256HexSchema
} from "./remoteAccess.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  CanonicalTargetSchema,
  CapabilityNameListSchema,
  CapabilityNameSchema,
  DeviceRoleV1Schema,
  HttpMethodSchema,
  PrincipalStableIdSchema,
  ProtocolVersionSchema,
  SemVerSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "./remoteProtocolContract.js";

export const HELPER_MANIFEST_SCHEMA_ID =
  "https://waifucave.com/contracts/remote/v1/helper-manifest.schema.json";
export const REMOTE_ACCESS_SCHEMA_ID =
  "https://waifucave.com/contracts/remote/v1/remote-access.schema.json";

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

const remoteAccessRegisteredSchemas: ReadonlyArray<readonly [string, z.ZodType]> = [
  ["AdministrativeAuditRecordV1", AdministrativeAuditRecordV1Schema],
  ["ApprovalReceiptV1", ApprovalReceiptV1Schema],
  ["Base64Url16Bytes", Base64Url16BytesSchema],
  ["Base64Url32Bytes", Base64Url32BytesSchema],
  ["CanonicalIdentityBundleCbor", CanonicalIdentityBundleCborSchema],
  ["CanonicalTarget", CanonicalTargetSchema],
  ["DashboardAssetContentType", DashboardAssetContentTypeSchema],
  ["DashboardAssetV1", DashboardAssetSchema],
  ["DashboardManifestV1", DashboardManifestSchema],
  ["DeviceRoleV1", DeviceRoleV1Schema],
  ["GetResetStatusCommand", GetResetStatusCommandSchema],
  ["HttpMethod", HttpMethodSchema],
  ["IdentityResetReceiptV1", IdentityResetReceiptV1Schema],
  ["EventCursorV1", EventCursorSchema],
  ["OperationAcceptedV1", OperationAcceptedV1Schema],
  ["OperationStatusV1", OperationStatusV1Schema],
  ["PairConfirmationV1", PairConfirmationV1Schema],
  ["PairControlCapabilitiesPayloadV1", PairControlCapabilitiesPayloadV1Schema],
  ["PairControlEndpointAckPayloadV1", PairControlEndpointAckPayloadV1Schema],
  ["PairControlEndpointGenerationPayloadV1", PairControlEndpointGenerationPayloadV1Schema],
  ["PairControlErrorPayloadV1", PairControlErrorPayloadV1Schema],
  ["PairControlHelloPayloadV1", PairControlHelloPayloadV1Schema],
  ["PairControlPresencePayloadV1", PairControlPresencePayloadV1Schema],
  ["PairControlReconnectPayloadV1", PairControlReconnectPayloadV1Schema],
  ["PairControlRecordV1", PairControlRecordV1Schema],
  ["PairControlRevocationAckPayloadV1", PairControlRevocationAckPayloadV1Schema],
  ["PairControlRevocationPayloadV1", PairControlRevocationPayloadV1Schema],
  ["PairControlTypeV1", PairControlTypeV1Schema],
  ["PairControlUnsignedRecordV1", PairControlUnsignedRecordV1Schema],
  ["PositiveUint64Decimal", PositiveUint64DecimalSchema],
  ["PrincipalStableId", PrincipalStableIdSchema],
  ["ProtocolVersion", ProtocolVersionSchema],
  ["ResetIdentityCommand", ResetIdentityCommandSchema],
  ["StreamSnapshotRequiredV1", StreamSnapshotRequiredV1Schema],
  ["Uint64Decimal", Uint64DecimalSchema]
];

export function createRemoteAccessJsonSchema(): ContractJsonObject {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of remoteAccessRegisteredSchemas) {
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

  definitions.PositiveUint64Decimal.not = { const: "0" };
  definitions.CanonicalTarget.format = "waifus-origin-form-target-v1";
  definitions.CanonicalIdentityBundleCbor.format = "waifus-canonical-cbor-base64url-v1";
  definitions.CanonicalIdentityBundleCbor["x-waifus-maximum-decoded-bytes"] = 1_200;
  const approvalProperties = definitions.ApprovalReceiptV1.properties as ContractJsonObject;
  const sasIndices = approvalProperties.sasIndices as ContractJsonObject;
  sasIndices.minItems = 5;
  sasIndices.maxItems = 5;
  definitions.ApprovalReceiptV1["x-waifus-expiry-window-seconds"] = 120;
  definitions.ApprovalReceiptV1["x-waifus-matching-discriminators"] = {
    approvingPrincipal: {
      local: { browserBinding: "local" },
      remote_device: { browserBinding: "remote" }
    }
  };
  definitions.ApprovalReceiptV1["x-waifus-distinct-fields"] = [
    ["hostIdentityBundleCbor", "remoteIdentityBundleCbor"],
    ["hostIdentityBundleHash", "remoteIdentityBundleHash"]
  ];
  definitions.IdentityResetReceiptV1["x-waifus-distinct-fields"] = [
    ["oldInstallationPublicKey", "newInstallationPublicKey"],
    ["oldFingerprint", "newFingerprint"]
  ];
  definitions.DashboardAssetV1["x-waifus-normalized-relative-path-field"] = "path";
  definitions.DashboardAssetV1["x-waifus-content-type-derived-from"] = "path";
  definitions.DashboardAssetV1["x-waifus-maximum-byte-size"] = DASHBOARD_ASSET_MAX_BYTES;
  definitions.DashboardManifestV1["x-waifus-build-id"] = {
    algorithm: "SHA-256",
    encoding: "lowercase hex",
    input: "RFC 8785 canonical manifest object with buildId omitted"
  };
  definitions.DashboardManifestV1["x-waifus-assets-ascii-sorted-unique"] = true;
  definitions.DashboardManifestV1["x-waifus-required-asset"] = "index.html";
  definitions.DashboardManifestV1["x-waifus-maximum-raw-bytes"] = 4 * 1024 * 1024;
  definitions.EventCursorV1.format = "waifus-event-cursor-v1";
  definitions.EventCursorV1["x-waifus-stream-epoch-bytes"] = 16;
  definitions.EventCursorV1["x-waifus-sequence"] = "canonical uint64 decimal";
  definitions.OperationAcceptedV1["x-waifus-status-url-derived-from"] = "operationId";
  definitions.OperationStatusV1["x-waifus-status-url-derived-from"] = "operationId";
  definitions.OperationStatusV1["x-waifus-completed-retention-seconds"] = Number(
    COMPLETED_OPERATION_RETENTION_SECONDS
  );
  definitions.OperationStatusV1["x-waifus-unresolved-retention-seconds"] = Number(
    UNRESOLVED_OPERATION_RETENTION_SECONDS
  );
  definitions.AdministrativeAuditRecordV1["x-waifus-retention-seconds"] = Number(
    ADMIN_AUDIT_RETENTION_SECONDS
  );
  definitions.AdministrativeAuditRecordV1["x-waifus-maximum-raw-bytes"] =
    MAX_ADMIN_AUDIT_RECORD_BYTES;
  definitions.AdministrativeAuditRecordV1["x-waifus-forbidden-content"] = [
    "request_body",
    "response_body",
    "result",
    "secret_free_text"
  ];
  definitions.PairControlEndpointGenerationPayloadV1["x-waifus-sha256-of"] = {
    digestField: "ciphertextSha256",
    decodedBase64UrlField: "ciphertext"
  };
  definitions.PairControlRecordV1["x-waifus-maximum-raw-bytes"] = 2_048;
  definitions.PairControlRecordV1["x-waifus-transport-type-matrix"] = {
    websocket: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    https_publish: [1, 2, 3, 4, 5, 6, 9],
    https_revoke: [7],
    https_revocation_ack: [8],
    https_poll: [1, 2, 3, 4, 5, 6, 7, 8, 9]
  };
  definitions.PairControlRecordV1["x-waifus-transport-directions"] = {
    websocket: "ingress_and_delivery",
    https_publish: "ingress",
    https_revoke: "ingress",
    https_revocation_ack: "ingress",
    https_poll: "delivery_only"
  };
  definitions.PairControlRecordV1["x-waifus-first-ingress-timestamp-skew-seconds"] = 60;
  definitions.PairControlRecordV1["x-waifus-shared-side-high-water"] = [
    "connectionGeneration",
    "sequence"
  ];

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: REMOTE_ACCESS_SCHEMA_ID,
    title: "Waifus Remote Access Wire Contracts V1",
    description:
      "Operational recovery, dashboard manifests, attended approval, pairing confirmation, pair-control, and installation-reset wire records shared by Discord Waifus and ts-connect.",
    oneOf: [
      { $ref: "#/$defs/AdministrativeAuditRecordV1" },
      { $ref: "#/$defs/ApprovalReceiptV1" },
      { $ref: "#/$defs/DashboardManifestV1" },
      { $ref: "#/$defs/EventCursorV1" },
      { $ref: "#/$defs/GetResetStatusCommand" },
      { $ref: "#/$defs/IdentityResetReceiptV1" },
      { $ref: "#/$defs/OperationAcceptedV1" },
      { $ref: "#/$defs/OperationStatusV1" },
      { $ref: "#/$defs/PairConfirmationV1" },
      { $ref: "#/$defs/PairControlRecordV1" },
      { $ref: "#/$defs/ResetIdentityCommand" },
      { $ref: "#/$defs/StreamSnapshotRequiredV1" }
    ],
    $defs: definitions
  };
}

function fixtureBytes(size: number, value: number): string {
  return Buffer.alloc(size, value).toString("base64url");
}

function approvalReceiptFixture(kind: "local" | "remote"): ContractJsonObject {
  return {
    version: 1,
    receiptId: fixtureBytes(32, 0x61),
    issuedAt: "1786270830",
    expiresAt: "1786270950",
    invitationId: fixtureBytes(16, 0x62),
    invitationGeneration: "1",
    pendingPairId: fixtureBytes(16, 0x63),
    hostIdentityBundleCbor: Buffer.from([0xa1, 0x01, 0x01]).toString("base64url"),
    hostIdentityBundleHash: fixtureBytes(32, 0x64),
    remoteIdentityBundleCbor: Buffer.from([0xa1, 0x01, 0x02]).toString("base64url"),
    remoteIdentityBundleHash: fixtureBytes(32, 0x65),
    noisePattern: "Noise_XXpsk0_25519_ChaChaPoly_SHA256",
    protocol: { major: 1, minor: 0 },
    transcriptHash: fixtureBytes(32, 0x66),
    channelBinding: fixtureBytes(32, 0x67),
    sasIndices: [1, 23, 456, 789, 1_023],
    sasFingerprint: "a1b2c3d4e5f6",
    hostTrustEpoch: "1",
    remoteTrustEpoch: "2",
    hostKeySequence: 1,
    remoteKeySequence: 1,
    approvingPrincipal: kind === "local"
      ? { kind: "local", stableId: "local" }
      : {
          kind: "remote_device",
          stableId: "remote:approver-device",
          peerFingerprint: fixtureBytes(16, 0x68),
          trustEpoch: "7"
        },
    browserBinding: kind === "local"
      ? {
          kind: "local",
          hostServerLaunchId: fixtureBytes(32, 0x69),
          browserSessionId: fixtureBytes(32, 0x6a)
        }
      : {
          kind: "remote",
          gatewayLaunchId: fixtureBytes(32, 0x6b),
          browserSessionId: fixtureBytes(32, 0x6c)
        },
    confirmationRequestNonce: fixtureBytes(16, 0x6d),
    confirmationMethod: "POST",
    confirmationTarget: "/api/remote-access/pairing-requests/request-1/approve",
    nonce: fixtureBytes(32, 0x6e),
    action: "approve_pair"
  };
}

function identityResetReceiptFixture(stage: "prepared" | "complete"): ContractJsonObject {
  return {
    version: 1,
    resetTombstone: "9007199254740992",
    resetId: fixtureBytes(16, 0x73),
    oldInstallationPublicKey: fixtureBytes(32, 0x74),
    newInstallationPublicKey: fixtureBytes(32, 0x75),
    oldFingerprint: fixtureBytes(16, 0x72),
    newFingerprint: fixtureBytes(16, 0x76),
    clearedActivationCount: "1",
    clearedPairCount: "2",
    clearedHostRoleSecretCount: "3",
    clearedRemoteRoleSecretCount: "4",
    stage,
    ...(stage === "complete" ? { completedAt: "1786270950" } : {})
  };
}

function dashboardManifestFixture(): ContractJsonObject {
  const payload: ContractJsonObject = {
    schemaVersion: 1,
    discordWaifusVersion: "1.5.203",
    apiVersion: { major: 1, minor: 0 },
    transportVersion: { major: 1, minor: 0 },
    minimumHelperVersion: "0.1.0",
    minimumRemoteGatewayVersion: "1.5.203",
    requiredCapabilities: [
      "waifus.browser-context.v1",
      "waifus.dashboard.manifest.v1",
      "waifus.http.v1",
      "waifus.principal.v1",
      "waifus.sse.cursor.v1",
      "waifus.stream.cancel.v1"
    ],
    assets: [
      {
        path: "assets/index-a1.js",
        byteSize: "23",
        sha256: "1".repeat(64),
        contentType: "text/javascript; charset=utf-8"
      },
      {
        path: "index.html",
        byteSize: "64",
        sha256: "2".repeat(64),
        contentType: "text/html; charset=utf-8"
      }
    ]
  };
  const buildId = createHash("sha256")
    .update(serializeCanonicalContractJson(payload))
    .digest("hex");
  return { ...payload, buildId };
}

export function createRemoteAccessFixtureSet(): ReadonlyMap<string, ContractJson> {
  const fixtures = new Map<string, ContractJson>();
  fixtures.set(
    "fixtures/valid/dashboard-manifest.json",
    dashboardManifestFixture()
  );
  fixtures.set(
    "fixtures/valid/approval-receipt-local.json",
    approvalReceiptFixture("local")
  );
  fixtures.set(
    "fixtures/valid/approval-receipt-remote.json",
    approvalReceiptFixture("remote")
  );
  fixtures.set(
    "fixtures/valid/identity-reset-receipt-prepared.json",
    identityResetReceiptFixture("prepared")
  );
  fixtures.set(
    "fixtures/valid/identity-reset-receipt-complete.json",
    identityResetReceiptFixture("complete")
  );

  const mixedBrowser = cloneFixture(approvalReceiptFixture("local"));
  (mixedBrowser.browserBinding as ContractJsonObject).gatewayLaunchId = fixtureBytes(32, 0x70);
  fixtures.set("fixtures/invalid/approval-receipt-mixed-browser.json", mixedBrowser);

  const wrongLocalSource = cloneFixture(approvalReceiptFixture("local"));
  wrongLocalSource.browserBinding = cloneFixture(
    approvalReceiptFixture("remote").browserBinding as ContractJsonObject
  );
  fixtures.set("fixtures/invalid/approval-receipt-local-with-remote-browser.json", wrongLocalSource);

  const wrongRemoteSource = cloneFixture(approvalReceiptFixture("remote"));
  wrongRemoteSource.browserBinding = cloneFixture(
    approvalReceiptFixture("local").browserBinding as ContractJsonObject
  );
  fixtures.set("fixtures/invalid/approval-receipt-remote-with-local-browser.json", wrongRemoteSource);

  const overlongExpiry = cloneFixture(approvalReceiptFixture("local"));
  overlongExpiry.expiresAt = "1786270951";
  fixtures.set("fixtures/invalid/approval-receipt-overlong-expiry.json", overlongExpiry);

  const missingComparison = cloneFixture(approvalReceiptFixture("remote"));
  missingComparison.sasIndices = [1, 2, 3, 4];
  fixtures.set("fixtures/invalid/approval-receipt-missing-comparison.json", missingComparison);

  const selfPair = cloneFixture(approvalReceiptFixture("local"));
  selfPair.remoteIdentityBundleCbor = selfPair.hostIdentityBundleCbor;
  selfPair.remoteIdentityBundleHash = selfPair.hostIdentityBundleHash;
  fixtures.set("fixtures/invalid/approval-receipt-self-pair.json", selfPair);

  const missingCompletion = cloneFixture(identityResetReceiptFixture("complete"));
  delete missingCompletion.completedAt;
  fixtures.set("fixtures/invalid/identity-reset-receipt-missing-completion.json", missingCompletion);

  const earlyCompletion = cloneFixture(identityResetReceiptFixture("prepared"));
  earlyCompletion.completedAt = "1786270950";
  fixtures.set("fixtures/invalid/identity-reset-receipt-early-completion.json", earlyCompletion);

  const reusedIdentity = cloneFixture(identityResetReceiptFixture("complete"));
  reusedIdentity.newInstallationPublicKey = reusedIdentity.oldInstallationPublicKey;
  reusedIdentity.newFingerprint = reusedIdentity.oldFingerprint;
  fixtures.set("fixtures/invalid/identity-reset-receipt-reused-identity.json", reusedIdentity);

  const dashboardTraversal = cloneFixture(dashboardManifestFixture());
  (dashboardTraversal.assets as ContractJsonObject[])[0].path = "../index.html";
  fixtures.set("fixtures/invalid/dashboard-manifest-traversal.json", dashboardTraversal);

  const dashboardUnsorted = cloneFixture(dashboardManifestFixture());
  const unsortedAssets = dashboardUnsorted.assets as ContractJson[];
  dashboardUnsorted.assets = [...unsortedAssets].reverse();
  fixtures.set("fixtures/invalid/dashboard-manifest-unsorted.json", dashboardUnsorted);

  const dashboardOversized = cloneFixture(dashboardManifestFixture());
  (dashboardOversized.assets as ContractJsonObject[])[0].byteSize = (
    DASHBOARD_ASSET_MAX_BYTES + 1
  ).toString(10);
  fixtures.set("fixtures/invalid/dashboard-manifest-oversized.json", dashboardOversized);

  const dashboardSelfIncluded = cloneFixture(dashboardManifestFixture());
  (dashboardSelfIncluded.assets as ContractJsonObject[])[0].path = "waifus-dashboard-manifest.json";
  fixtures.set("fixtures/invalid/dashboard-manifest-self-included.json", dashboardSelfIncluded);

  const operationId = fixtureBytes(32, 0x21);
  const statusUrl = `/api/admin/operations/${operationId}`;
  const operationAccepted: ContractJsonObject = {
    operationId,
    status: "accepted",
    statusUrl
  };
  const operationPrepared: ContractJsonObject = {
    version: 1,
    operationId,
    status: "prepared",
    statusUrl,
    createdAt: "100",
    updatedAt: "101",
    expiresAt: "2592100"
  };
  const operationCompleted: ContractJsonObject = {
    ...operationPrepared,
    status: "completed",
    updatedAt: "200",
    completedAt: "200",
    expiresAt: "86600",
    outcome: "succeeded"
  };
  const operationReconciled: ContractJsonObject = {
    ...operationCompleted,
    status: "reconciled",
    outcome: "failed",
    errorCode: "helper_unavailable"
  };
  const operationUnknown: ContractJsonObject = {
    ...operationPrepared,
    status: "outcome_unknown",
    updatedAt: "200",
    determinedAt: "200",
    expiresAt: "2592200",
    errorCode: "outcome_unknown"
  };
  const localAudit: ContractJsonObject = {
    version: 1,
    eventId: fixtureBytes(16, 0x31),
    timestamp: "1786270830",
    actor: { kind: "local", stableId: "local" },
    origin: "local",
    action: "remote.device.rename",
    resource: { type: "remote_device", identifier: "remote-device-01" },
    requestId: fixtureBytes(16, 0x32),
    idempotencyKeyHash: fixtureBytes(32, 0x33),
    operationId,
    beforeRevision: "7",
    afterRevision: "8",
    outcome: "completed"
  };
  const remoteAudit: ContractJsonObject = {
    ...localAudit,
    eventId: fixtureBytes(16, 0x34),
    actor: {
      kind: "remote_device",
      stableId: "remote:remote-device-01",
      deviceId: "remote-device-01",
      trustEpoch: "9"
    },
    origin: "remote",
    delegation: {
      conversationId: "conversation-1",
      toolCallId: "tool-1",
      pendingActionId: "action-1"
    },
    outcome: "accepted"
  };
  const eventCursor = `v1:${fixtureBytes(16, 0x41)}:9007199254740992`;
  const snapshotRequired: ContractJsonObject = {
    version: 1,
    type: "snapshot_required",
    reason: "epoch_mismatch",
    streamEpoch: fixtureBytes(16, 0x41),
    latestSequence: "9007199254740992"
  };

  fixtures.set("fixtures/valid/operation-accepted.json", operationAccepted);
  fixtures.set("fixtures/valid/operation-status-prepared.json", operationPrepared);
  fixtures.set("fixtures/valid/operation-status-completed.json", operationCompleted);
  fixtures.set("fixtures/valid/operation-status-reconciled.json", operationReconciled);
  fixtures.set("fixtures/valid/operation-status-outcome-unknown.json", operationUnknown);
  fixtures.set("fixtures/valid/admin-audit-local.json", localAudit);
  fixtures.set("fixtures/valid/admin-audit-remote-assistant.json", remoteAudit);
  fixtures.set("fixtures/valid/event-cursor.json", eventCursor);
  fixtures.set("fixtures/valid/snapshot-required.json", snapshotRequired);

  const mismatchedStatusUrl = cloneFixture(operationAccepted);
  mismatchedStatusUrl.statusUrl = `/api/admin/operations/${fixtureBytes(32, 0x22)}`;
  fixtures.set("fixtures/invalid/operation-accepted-status-url.json", mismatchedStatusUrl);

  const secretResult = cloneFixture(operationCompleted);
  secretResult.result = { activationCredential: "must-never-appear" };
  fixtures.set("fixtures/invalid/operation-status-secret-result.json", secretResult);

  const excessiveRetention = cloneFixture(operationCompleted);
  excessiveRetention.expiresAt = "86601";
  fixtures.set("fixtures/invalid/operation-status-retention.json", excessiveRetention);

  const auditBody = cloneFixture(localAudit);
  auditBody.requestBody = { token: "must-never-appear" };
  fixtures.set("fixtures/invalid/admin-audit-request-body.json", auditBody);

  const auditOrigin = cloneFixture(remoteAudit);
  auditOrigin.origin = "local";
  fixtures.set("fixtures/invalid/admin-audit-origin.json", auditOrigin);

  fixtures.set(
    "fixtures/invalid/event-cursor-leading-zero.json",
    `v1:${fixtureBytes(16, 0x41)}:01`
  );
  fixtures.set(
    "fixtures/invalid/event-cursor-overflow.json",
    `v1:${fixtureBytes(16, 0x41)}:18446744073709551616`
  );

  const invalidSnapshot = cloneFixture(snapshotRequired);
  invalidSnapshot.reason = "server_error";
  fixtures.set("fixtures/invalid/snapshot-required-reason.json", invalidSnapshot);

  return fixtures;
}
