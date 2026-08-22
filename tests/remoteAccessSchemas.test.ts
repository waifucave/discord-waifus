import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApprovalReceiptV1Schema,
  DashboardManifestSchema,
  GetResetStatusCommandSchema,
  HELPER_PACKAGE_TARGETS,
  HelperManifestSchema,
  IdentityResetReceiptV1Schema,
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessTrustIndexV1Schema,
  ResetIdentityCommandSchema,
  type HelperManifestInput
} from "../src/shared/schemas/remoteAccess.js";
import {
  createHelperManifestFixtureSet,
  createHelperManifestJsonSchema,
  createRemoteAccessFixtureSet,
  createRemoteAccessJsonSchema
} from "../src/shared/schemas/remoteAccessContract.js";
import {
  serializeCanonicalContractJson,
  serializeRemoteContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";

const hash = (character: string) => character.repeat(64);
const commit = (character: string) => character.repeat(40);

function helperManifest(packageName = "@waifucave/ts-connect-linux-x64"): HelperManifestInput {
  const packageTarget = HELPER_PACKAGE_TARGETS.find((entry) => entry.packageName === packageName);
  if (!packageTarget) {
    throw new Error(`Unknown test package ${packageName}`);
  }
  return {
    schemaVersion: 1,
    helperVersion: "0.1.0",
    releaseSequence: "1",
    releasedAt: "2026-08-09T10:20:30Z",
    packageName: packageTarget.packageName,
    target: packageTarget.target,
    binary: {
      relativePath: packageTarget.target.os === "win32"
        ? "bin/ts-connect.exe"
        : "bin/ts-connect",
      byteSize: "9007199254740992",
      sha256: hash("1")
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
    sourceCommit: commit("2"),
    contractCommit: commit("3"),
    forkCommit: commit("4"),
    workerTrustRingSha256: hash("5"),
    tailscale: {
      tag: "v1.102.2",
      commit: "eb67e5dcbe145d63e1128b9b4b630f8a82da101f"
    },
    goVersion: "go1.26.5",
    directOnlyBuildTag: "waifus_direct_only",
    ossNoticeSha256: hash("6"),
    releaseKeyIds: ["waifucave-ts-connect-release-2026-01"]
  };
}

describe("HelperManifestSchema", () => {
  it("accepts every locked V1 package/target pairing", () => {
    for (const packageTarget of HELPER_PACKAGE_TARGETS) {
      expect(HelperManifestSchema.parse(helperManifest(packageTarget.packageName))).toMatchObject({
        packageName: packageTarget.packageName,
        target: packageTarget.target
      });
    }
  });

  it("rejects target/package/binary substitutions and unknown fields", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      packageName: "@waifucave/ts-connect-darwin-arm64"
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      binary: { ...manifest.binary, relativePath: "../../ts-connect" }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, activationCredential: "secret" }).success).toBe(false);
  });

  it("keeps every uint64 JSON value canonical and lossless", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      releaseSequence: "18446744073709551615",
      binary: { ...manifest.binary, byteSize: "18446744073709551615" }
    }).success).toBe(true);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: 1 }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: "01" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, releaseSequence: "0" }).success).toBe(false);
  });

  it("requires whole-second UTC release time and an ordered app compatibility range", () => {
    const manifest = helperManifest();
    for (const releasedAt of [
      "2026-08-09T10:20:30.000Z",
      "2026-08-09T10:20:30+00:00",
      "2026-02-30T10:20:30Z"
    ]) {
      expect(HelperManifestSchema.safeParse({ ...manifest, releasedAt }).success).toBe(false);
    }
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      maximumDiscordWaifusVersionExclusive: manifest.minimumDiscordWaifusVersion
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      minimumDiscordWaifusVersion: "2.0.0",
      maximumDiscordWaifusVersionExclusive: "1.9.0"
    }).success).toBe(false);
  });

  it("requires ordered protocol ranges and sorted unique public identifiers", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      protocols: {
        ...manifest.protocols,
        ipc: { major: 1, minimumMinor: 2, maximumMinor: 1 }
      }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      capabilities: ["waifus.stream.cancel.v1", "waifus.http.v1"]
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      releaseKeyIds: ["z-key", "a-key"]
    }).success).toBe(false);
  });

  it("pins the fork baseline, Go toolchain, direct-only tag, and trust-ring hash", () => {
    const manifest = helperManifest();
    expect(HelperManifestSchema.safeParse({ ...manifest, goVersion: "go1.26.4" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, directOnlyBuildTag: "default" }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({
      ...manifest,
      tailscale: { ...manifest.tailscale, tag: "v1.102.1" }
    }).success).toBe(false);
    expect(HelperManifestSchema.safeParse({ ...manifest, workerTrustRingSha256: hash("G") }).success).toBe(false);
  });
});

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

function approvalReceipt(browserKind: "local" | "remote" = "local") {
  return {
    version: 1,
    receiptId: bytes32(0x61),
    issuedAt: "1786270830",
    expiresAt: "1786270950",
    invitationId: bytes16(0x62),
    invitationGeneration: "1",
    pendingPairId: bytes16(0x63),
    hostIdentityBundleCbor: Buffer.from([0xa1, 0x01, 0x01]).toString("base64url"),
    hostIdentityBundleHash: bytes32(0x64),
    remoteIdentityBundleCbor: Buffer.from([0xa1, 0x01, 0x02]).toString("base64url"),
    remoteIdentityBundleHash: bytes32(0x65),
    noisePattern: "Noise_XXpsk0_25519_ChaChaPoly_SHA256",
    protocol: { major: 1, minor: 0 },
    transcriptHash: bytes32(0x66),
    channelBinding: bytes32(0x67),
    sasIndices: [1, 23, 456, 789, 1023],
    sasFingerprint: "a1b2c3d4e5f6",
    hostTrustEpoch: "1",
    remoteTrustEpoch: "2",
    hostKeySequence: 1,
    remoteKeySequence: 1,
    approvingPrincipal: browserKind === "local"
      ? { kind: "local", stableId: "local" }
      : {
          kind: "remote_device",
          stableId: "remote:approver-device",
          peerFingerprint: bytes16(0x68),
          trustEpoch: "7"
        },
    browserBinding: browserKind === "local"
      ? {
          kind: "local",
          hostServerLaunchId: bytes32(0x69),
          browserSessionId: bytes32(0x6a)
        }
      : {
          kind: "remote",
          gatewayLaunchId: bytes32(0x6b),
          browserSessionId: bytes32(0x6c)
        },
    confirmationRequestNonce: bytes16(0x6d),
    confirmationMethod: "POST",
    confirmationTarget: "/api/remote-access/pairing-requests/request-1/approve",
    nonce: bytes32(0x6e),
    action: "approve_pair"
  };
}

describe("ApprovalReceiptV1Schema", () => {
  it("accepts exact local and trusted-remote browser bindings", () => {
    expect(ApprovalReceiptV1Schema.safeParse(approvalReceipt("local")).success).toBe(true);
    expect(ApprovalReceiptV1Schema.safeParse(approvalReceipt("remote")).success).toBe(true);
  });

  it("rejects mixed browser bindings, overlong expiry, and comparison substitutions", () => {
    const receipt = approvalReceipt("local");
    expect(ApprovalReceiptV1Schema.safeParse({
      ...receipt,
      browserBinding: {
        ...receipt.browserBinding,
        gatewayLaunchId: bytes32(0x70)
      }
    }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({ ...receipt, expiresAt: "1786270951" }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({ ...receipt, sasIndices: [1, 2, 3, 4] }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({ ...receipt, sasFingerprint: "A1B2C3D4E5F6" }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({
      ...receipt,
      browserBinding: {
        kind: "remote",
        gatewayLaunchId: Buffer.alloc(32, 0x71).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x72).toString("base64url")
      }
    }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({ ...receipt, confirmationMethod: "post" }).success).toBe(false);
    expect(ApprovalReceiptV1Schema.safeParse({ ...receipt, action: "approve_device" }).success).toBe(false);
  });

  it("requires assistant provenance to augment rather than replace browser proof", () => {
    const receipt = approvalReceipt("remote");
    expect(ApprovalReceiptV1Schema.safeParse({
      ...receipt,
      assistantProvenance: {
        conversationId: "conversation-1",
        toolCallId: "tool-1",
        pendingActionId: "action-1",
        confirmedActionPayloadHash: bytes32(0x71)
      }
    }).success).toBe(true);
    expect(ApprovalReceiptV1Schema.safeParse({
      ...receipt,
      assistantProvenance: {
        conversationId: "conversation-1"
      }
    }).success).toBe(false);
    const { browserBinding: _browserBinding, ...withoutBrowser } = receipt;
    expect(ApprovalReceiptV1Schema.safeParse(withoutBrowser).success).toBe(false);
  });
});

describe("persistent nonsecret remote state schemas", () => {
  it("accepts only a derived opaque vault label and never private-key fields", () => {
    const installationId = bytes16(0x70);
    const state = {
      version: 1,
      installationId,
      vaultLabel: `waifus.installation.v1.${installationId}`,
      activationReference: "vault:activation:reference",
      createdAt: "9007199254740993"
    };
    expect(RemoteAccessInstallationStateV1Schema.parse(state)).toEqual(state);
    expect(RemoteAccessInstallationStateV1Schema.safeParse({
      ...state,
      vaultLabel: "waifus.installation.v1.someone-else"
    }).success).toBe(false);
    expect(RemoteAccessInstallationStateV1Schema.safeParse({
      ...state,
      privateKey: bytes32(0x71)
    }).success).toBe(false);
  });

  it("requires unique pairs and a monotonic trust-epoch high-water", () => {
    const state = {
      version: 1,
      trustEpochHighWater: "9007199254740993",
      resetTombstone: "4",
      pairs: [{
        deviceId: "travel-mac",
        pairId: bytes16(0x72),
        trustEpoch: "9007199254740993"
      }]
    };
    expect(RemoteAccessTrustIndexV1Schema.parse(state)).toEqual(state);
    expect(RemoteAccessTrustIndexV1Schema.safeParse({
      ...state,
      trustEpochHighWater: "9007199254740992"
    }).success).toBe(false);
    expect(RemoteAccessTrustIndexV1Schema.safeParse({
      ...state,
      pairs: [...state.pairs, { ...state.pairs[0], pairId: bytes16(0x73) }]
    }).success).toBe(false);
  });
});

describe("identity reset wire schemas", () => {
  const command = {
    resetTombstone: "9007199254740992",
    expectedOldFingerprint: bytes16(0x72)
  };
  const receiptBase = {
    version: 1,
    resetTombstone: command.resetTombstone,
    resetId: bytes16(0x73),
    oldInstallationPublicKey: bytes32(0x74),
    newInstallationPublicKey: bytes32(0x75),
    oldFingerprint: command.expectedOldFingerprint,
    newFingerprint: bytes16(0x76),
    clearedActivationCount: "1",
    clearedPairCount: "2",
    clearedHostRoleSecretCount: "3",
    clearedRemoteRoleSecretCount: "4"
  };

  it("accepts only strict reset and status commands", () => {
    expect(ResetIdentityCommandSchema.parse(command)).toEqual(command);
    expect(GetResetStatusCommandSchema.parse({ resetTombstone: command.resetTombstone })).toEqual({
      resetTombstone: command.resetTombstone
    });
    expect(ResetIdentityCommandSchema.safeParse({ ...command, resetTombstone: 1 }).success).toBe(false);
    expect(ResetIdentityCommandSchema.safeParse({ ...command, dataRoot: "/tmp/other" }).success).toBe(false);
  });

  it("locks impossible reset receipt stage/completion combinations", () => {
    expect(IdentityResetReceiptV1Schema.safeParse({
      ...receiptBase,
      stage: "prepared"
    }).success).toBe(true);
    expect(IdentityResetReceiptV1Schema.safeParse({
      ...receiptBase,
      stage: "complete",
      completedAt: "1786270950"
    }).success).toBe(true);
    expect(IdentityResetReceiptV1Schema.safeParse({
      ...receiptBase,
      stage: "complete"
    }).success).toBe(false);
    expect(IdentityResetReceiptV1Schema.safeParse({
      ...receiptBase,
      stage: "prepared",
      completedAt: "1786270950"
    }).success).toBe(false);
  });
});

describe("checked-in helper manifest contract", () => {
  it("matches the generated schema and every generated fixture byte-for-byte", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    const schemaBytes = await readFile(path.join(contractRoot, "helper-manifest.schema.json"), "utf8");
    expect(schemaBytes).toBe(serializeRemoteContractJson(createHelperManifestJsonSchema()));

    for (const [relativePath, value] of createHelperManifestFixtureSet()) {
      const actual = await readFile(path.join(contractRoot, relativePath), "utf8");
      expect(actual).toBe(serializeCanonicalContractJson(value));
      const expectedValid = relativePath.includes("/valid/");
      expect(HelperManifestSchema.safeParse(value).success, relativePath).toBe(expectedValid);
    }
  });

  it("publishes bounded hashes, paths, ranges, and compatibility fields", () => {
    const schema = createHelperManifestJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.HelperManifest).toMatchObject({
      type: "object",
      additionalProperties: false
    });
    expect(schema.$defs.HelperManifest).toHaveProperty("allOf");
    expect(schema.$defs.PositiveUint64Decimal).toHaveProperty("not", { const: "0" });
    expect(schema.$defs.CanonicalReleasedAt).toHaveProperty(
      "format",
      "waifus-rfc3339-whole-second"
    );
  });
});

describe("checked-in remote-access wire contract", () => {
  it("matches the generated schema and strict valid/invalid fixtures", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    const schemaBytes = await readFile(path.join(contractRoot, "remote-access.schema.json"), "utf8");
    expect(schemaBytes).toBe(serializeRemoteContractJson(createRemoteAccessJsonSchema()));
    for (const [relativePath, value] of createRemoteAccessFixtureSet()) {
      const actual = await readFile(path.join(contractRoot, relativePath), "utf8");
      expect(actual).toBe(serializeCanonicalContractJson(value));
      const expectedValid = relativePath.includes("/valid/");
      const schema = relativePath.includes("approval-receipt")
        ? ApprovalReceiptV1Schema
        : relativePath.includes("dashboard-manifest")
          ? DashboardManifestSchema
          : relativePath.includes("identity-reset-receipt")
            ? IdentityResetReceiptV1Schema
            : undefined;
      if (schema) {
        expect(schema.safeParse(value).success, relativePath).toBe(expectedValid);
      }
    }
  });

  it("publishes bounded, derived dashboard-manifest invariants", () => {
    const schema = createRemoteAccessJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.DashboardAssetV1).toMatchObject({
      additionalProperties: false,
      "x-waifus-content-type-derived-from": "path",
      "x-waifus-maximum-byte-size": 16_777_216,
      "x-waifus-normalized-relative-path-field": "path"
    });
    expect(schema.$defs.DashboardManifestV1).toMatchObject({
      additionalProperties: false,
      "x-waifus-assets-ascii-sorted-unique": true,
      "x-waifus-maximum-raw-bytes": 4_194_304,
      "x-waifus-required-asset": "index.html"
    });
    expect(schema.$defs.DashboardManifestV1).toHaveProperty(
      "x-waifus-build-id.input",
      "RFC 8785 canonical manifest object with buildId omitted"
    );
  });
});
