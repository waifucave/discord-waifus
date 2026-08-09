import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActivationStartResultSchema,
  ActivationStatusSchema,
  ApprovePairingInputV1Schema,
  AssistantSafePairingRequestSummaryV1Schema,
  ClientContextV1Schema,
  CreateInvitationInputV1Schema,
  PairInvitationV1Schema,
  PairOperationEventSchema,
  PairOperationStatusSchema,
  PairStartInputSchema,
  PairStartResultSchema,
  PendingPairingRequestListV1Schema,
  PendingPairingRequestV1Schema,
  RemoteAccessDiagnosticsV1Schema,
  RemoteAccessStatusV1Schema,
  RenameTrustedDeviceInputV1Schema,
  TrustedDeviceListV1Schema,
  UpdateRemoteAccessInputV1Schema
} from "../src/shared/schemas/remoteLifecycle.js";
import {
  createRemoteAccessFixtureSet,
  createRemoteAccessJsonSchema
} from "../src/shared/schemas/remoteAccessContract.js";
import {
  serializeCanonicalContractJson,
  serializeRemoteContractJson
} from "../src/shared/schemas/remoteProtocolContract.js";

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");
const hash = (value: string) => value.repeat(64);

const platform = { os: "darwin", arch: "arm64" } as const;

function remoteAccessStatus() {
  return {
    version: 1,
    config: {
      revision: "7",
      enabled: true,
      displayName: "Studio Host",
      updatedAt: "1786270830"
    },
    identity: {
      deviceId: "host-device-01",
      installationFingerprint: bytes16(0x11)
    },
    appVersion: "1.5.203",
    dashboardBuildId: hash("1"),
    helperVersion: "0.1.0",
    helperReleaseSequence: "42",
    protocol: { major: 1, minor: 0 },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.http.v1",
      "waifus.sse.cursor.v1"
    ],
    helperState: "ready",
    activationState: "active",
    controlState: "connected",
    directState: "direct",
    lastDirectAt: "1786270800",
    lastErrorCode: null
  };
}

function pendingPairingRequest() {
  return {
    version: 1,
    requestId: bytes16(0x21),
    invitationId: bytes16(0x22),
    invitationGeneration: "1",
    entryFlow: "short_code",
    claimedDisplayName: "Travel Mac",
    claimedPlatform: platform,
    claimedInstallationFingerprint: bytes16(0x23),
    remoteIdentityBundleHash: bytes32(0x24),
    expiresAt: "1786271100",
    protocol: { major: 1, minor: 0 },
    transcriptHash: bytes32(0x25),
    channelBinding: bytes32(0x26),
    sasIndices: [1, 23, 456, 789, 1023],
    sasWords: ["amber", "birch", "cabin", "delta", "ember"],
    sasFingerprint: "a1b2c3d4e5f6"
  };
}

describe("remote access status and config DTOs", () => {
  it("accepts the strict redacted lifecycle surface", () => {
    expect(RemoteAccessStatusV1Schema.parse(remoteAccessStatus())).toEqual(remoteAccessStatus());
    expect(UpdateRemoteAccessInputV1Schema.parse({
      revision: "7",
      displayName: "Studio Host 2"
    })).toEqual({ revision: "7", displayName: "Studio Host 2" });
    expect(UpdateRemoteAccessInputV1Schema.safeParse({ revision: "7" }).success).toBe(false);
  });

  it("rejects secret, endpoint, private-path, and arbitrary-control fields", () => {
    for (const forbidden of [
      { activationCredential: "secret" },
      { endpoint: "192.0.2.1:1234" },
      { helperSocketPath: "/private/helper.sock" },
      { controlUrl: "https://example.invalid" }
    ]) {
      expect(RemoteAccessStatusV1Schema.safeParse({
        ...remoteAccessStatus(),
        ...forbidden
      }).success).toBe(false);
    }
    expect(UpdateRemoteAccessInputV1Schema.safeParse({
      revision: "7",
      enabled: true,
      frontendStaticDir: "/tmp/dashboard"
    }).success).toBe(false);
  });

  it("requires disabled status to report inactive helper/control/direct state", () => {
    expect(RemoteAccessStatusV1Schema.safeParse({
      ...remoteAccessStatus(),
      config: { ...remoteAccessStatus().config, enabled: false },
      helperState: "disabled",
      controlState: "inactive",
      directState: "inactive",
      helperVersion: null,
      helperReleaseSequence: null
    }).success).toBe(true);
    expect(RemoteAccessStatusV1Schema.safeParse({
      ...remoteAccessStatus(),
      config: { ...remoteAccessStatus().config, enabled: false }
    }).success).toBe(false);
  });
});

describe("activation DTOs", () => {
  const activationOperationId = bytes32(0x31);
  const activationId = bytes32(0x32);

  it("accepts exact production and staging fragment-only verification URLs", () => {
    for (const verificationUrl of [
      `https://pair.waifucave.com/activate#${activationId}`,
      `https://pair-staging.waifucave.com/activate#${activationId}`
    ]) {
      expect(ActivationStartResultSchema.safeParse({
        activationOperationId,
        verificationUrl,
        expiresAt: "1786271430"
      }).success).toBe(true);
    }
  });

  it("rejects queries, foreign origins, missing fragments, and exposed Worker state", () => {
    for (const verificationUrl of [
      `https://pair.waifucave.com/activate?id=${activationId}`,
      `https://pair.waifucave.com/activate#${activationId}?leak=1`,
      "https://pair.waifucave.com/activate",
      `https://evil.example/activate#${activationId}`,
      `http://pair.waifucave.com/activate#${activationId}`
    ]) {
      expect(ActivationStartResultSchema.safeParse({
        activationOperationId,
        verificationUrl,
        expiresAt: "1786271430"
      }).success).toBe(false);
    }
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "pending",
      expiresAt: "1786271430",
      workerActivationId: activationId
    }).success).toBe(false);
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "completed",
      expiresAt: "1786271430",
      completedAt: "1786271000",
      certificate: "must-never-appear"
    }).success).toBe(false);
  });

  it("freezes pending, completed, expired, and sanitized failed states", () => {
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "pending",
      expiresAt: "1786271430"
    }).success).toBe(true);
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "completed",
      expiresAt: "1786271430",
      completedAt: "1786271000"
    }).success).toBe(true);
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "expired",
      expiresAt: "1786271430"
    }).success).toBe(true);
    expect(ActivationStatusSchema.safeParse({
      activationOperationId,
      state: "failed",
      expiresAt: "1786271430",
      errorCode: "activation_unavailable"
    }).success).toBe(true);
  });
});

describe("invitation and pairing-request DTOs", () => {
  const invitation = {
    invitationId: bytes16(0x41),
    fullToken: `WF1.${"A".repeat(256)}`,
    shortCode: "01AB-CDEF",
    expiresAt: "1786271130"
  };

  it("keeps invitation entry secrets only in the strict creator response", () => {
    expect(CreateInvitationInputV1Schema.parse({})).toEqual({});
    expect(PairInvitationV1Schema.parse(invitation)).toEqual(invitation);
    expect(PairInvitationV1Schema.safeParse({
      ...invitation,
      invitationUrl: `https://pair.waifucave.com/?token=${invitation.fullToken}`
    }).success).toBe(false);
    expect(PairInvitationV1Schema.safeParse({
      ...invitation,
      helperSecret: "must-never-appear"
    }).success).toBe(false);
  });

  it("pins the complete attended comparison without identity bundles or secrets", () => {
    const request = pendingPairingRequest();
    expect(PendingPairingRequestV1Schema.parse(request)).toEqual(request);
    expect(PendingPairingRequestV1Schema.safeParse({
      ...request,
      remoteIdentityBundle: "must-stay-helper-owned"
    }).success).toBe(false);
    expect(PendingPairingRequestV1Schema.safeParse({
      ...request,
      sasWords: ["amber", "birch", "cabin", "delta"]
    }).success).toBe(false);
  });

  it("locks exact comparison fields in approval and a four-field assistant projection", () => {
    const request = pendingPairingRequest();
    const approval = {
      invitationGeneration: request.invitationGeneration,
      remoteIdentityBundleHash: request.remoteIdentityBundleHash,
      transcriptHash: request.transcriptHash,
      channelBinding: request.channelBinding,
      sasIndices: request.sasIndices,
      sasFingerprint: request.sasFingerprint
    };
    expect(ApprovePairingInputV1Schema.safeParse(approval).success).toBe(true);
    expect(ApprovePairingInputV1Schema.safeParse({
      ...approval,
      sasWords: request.sasWords
    }).success).toBe(false);

    const assistantSafe = {
      requestId: request.requestId,
      claimedDisplayName: request.claimedDisplayName,
      claimedPlatform: request.claimedPlatform,
      expiresAt: request.expiresAt
    };
    expect(AssistantSafePairingRequestSummaryV1Schema.parse(assistantSafe)).toEqual(assistantSafe);
    for (const forbidden of ["sasWords", "sasFingerprint", "transcriptHash", "invitationGeneration"] as const) {
      expect(AssistantSafePairingRequestSummaryV1Schema.safeParse({
        ...assistantSafe,
        [forbidden]: request[forbidden]
      }).success).toBe(false);
    }
  });
});

describe("trusted-device and diagnostics DTOs", () => {
  const device = {
    version: 1,
    deviceId: "remote-device-01",
    displayName: "Travel Mac",
    platform,
    installationFingerprint: bytes16(0x51),
    trustEpoch: "9",
    revision: "3",
    pairedAt: "1786000000",
    lastSeenAt: "1786270800",
    connectionState: "direct"
  };

  it("accepts revisioned device summaries and rename input", () => {
    expect(TrustedDeviceListV1Schema.safeParse({ version: 1, devices: [device] }).success).toBe(true);
    expect(RenameTrustedDeviceInputV1Schema.parse({
      revision: "3",
      displayName: "Travel Mac 2"
    })).toEqual({ revision: "3", displayName: "Travel Mac 2" });
    expect(TrustedDeviceListV1Schema.safeParse({
      version: 1,
      devices: [{ ...device, pairId: bytes16(0x52) }]
    }).success).toBe(false);
  });

  it("accepts only sanitized component/network state and prohibited counters", () => {
    const diagnostics = {
      version: 1,
      appVersion: "1.5.203",
      dashboardBuildId: hash("2"),
      helper: {
        state: "ready",
        version: "0.1.0",
        releaseSequence: "42",
        forkCommit: "3".repeat(40),
        target: platform,
        protocol: { major: 1, minor: 0 },
        capabilities: ["waifus.http.v1", "waifus.sse.cursor.v1"],
        secretStorage: "keychain"
      },
      controlState: "connected",
      stun: "available",
      udp: "available",
      portMapping: "available",
      directState: "direct",
      lastTransitionAt: "1786270800",
      lastDirectAt: "1786270800",
      lastErrorCode: null,
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    };
    expect(RemoteAccessDiagnosticsV1Schema.parse(diagnostics)).toEqual(diagnostics);
    for (const forbidden of [
      { endpoints: ["192.0.2.1:1234"] },
      { candidates: [{ address: "198.51.100.2" }] },
      { socketPath: "/private/helper.sock" },
      { pairId: bytes16(0x53) },
      { activationCredential: "secret" }
    ]) {
      expect(RemoteAccessDiagnosticsV1Schema.safeParse({
        ...diagnostics,
        ...forbidden
      }).success).toBe(false);
    }
  });
});

describe("client context DTO", () => {
  it("keeps host context exact and remote context limited to the selected host and shell origin", () => {
    expect(ClientContextV1Schema.parse({ mode: "host" })).toEqual({ mode: "host" });
    const remote = {
      mode: "remote",
      selectedHostId: bytes32(0x61),
      connectionState: "reconnecting",
      connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:43123`
    };
    expect(ClientContextV1Schema.parse(remote)).toEqual(remote);
    expect(ClientContextV1Schema.safeParse({ ...remote, csrfToken: bytes32(0x62) }).success).toBe(false);
    expect(ClientContextV1Schema.safeParse({
      ...remote,
      connectionShellOrigin: `http://${"a".repeat(52)}.waifus.localhost:43123`
    }).success).toBe(false);
    expect(ClientContextV1Schema.safeParse({
      ...remote,
      rememberedHosts: [bytes32(0x63)]
    }).success).toBe(false);
  });
});

describe("gateway-local pair-operation DTOs", () => {
  const pairOperationId = bytes32(0x71);
  const statusUrl = `/_waifus_remote/v1/pair/${pairOperationId}`;

  it("accepts only full-token or normalized short-code input", () => {
    expect(PairStartInputSchema.safeParse({
      kind: "full_token",
      token: `WF1.${"A".repeat(256)}`
    }).success).toBe(true);
    expect(PairStartInputSchema.safeParse({ kind: "short_code", code: "01AB-CDEF" }).success).toBe(true);
    expect(PairStartInputSchema.safeParse({
      kind: "short_code",
      code: "01AB-CDEF",
      destination: "100.64.0.1"
    }).success).toBe(false);
    expect(PairStartInputSchema.safeParse({ kind: "short_code", code: "01ab-cdef" }).success).toBe(false);
  });

  it("binds the start result and detail resource to the same opaque operation", () => {
    expect(PairStartResultSchema.safeParse({
      pairOperationId,
      statusUrl,
      state: "starting",
      expiresAt: "1786271130"
    }).success).toBe(true);
    expect(PairStartResultSchema.safeParse({
      pairOperationId,
      statusUrl: `/_waifus_remote/v1/pair/${bytes32(0x72)}`,
      state: "starting",
      expiresAt: "1786271130"
    }).success).toBe(false);
    expect(PairOperationStatusSchema.safeParse({
      pairOperationId,
      statusUrl,
      state: "verification_required",
      expiresAt: "1786271130",
      entryFlow: "short_code",
      sasWords: ["amber", "birch", "cabin", "delta", "ember"],
      sasFingerprint: "a1b2c3d4e5f6",
      claimedHostDisplayName: "Studio Host",
      claimedHostPlatform: platform,
      claimedHostInstallationFingerprint: bytes16(0x73)
    }).success).toBe(true);
  });

  it("keeps local events opaque and comparison-free", () => {
    const event = {
      pairOperationId,
      state: "verification_required",
      at: "1786270830"
    };
    expect(PairOperationEventSchema.parse(event)).toEqual(event);
    expect(PairOperationEventSchema.safeParse({
      ...event,
      sasWords: ["amber", "birch", "cabin", "delta", "ember"]
    }).success).toBe(false);
  });
});

function lifecycleFixtureSchema(relativePath: string) {
  if (relativePath.includes("remote-access-status")) return RemoteAccessStatusV1Schema;
  if (relativePath.includes("remote-access-update")) return UpdateRemoteAccessInputV1Schema;
  if (relativePath.includes("activation-start")) return ActivationStartResultSchema;
  if (relativePath.includes("activation-status")) return ActivationStatusSchema;
  if (relativePath.includes("create-invitation-input")) return CreateInvitationInputV1Schema;
  if (relativePath.includes("pair-invitation")) return PairInvitationV1Schema;
  if (relativePath.includes("pending-pairing-request-list")) return PendingPairingRequestListV1Schema;
  if (relativePath.includes("pending-pairing-request")) return PendingPairingRequestV1Schema;
  if (relativePath.includes("approve-pairing-input")) return ApprovePairingInputV1Schema;
  if (relativePath.includes("assistant-safe-pairing")) return AssistantSafePairingRequestSummaryV1Schema;
  if (relativePath.includes("trusted-device-list")) return TrustedDeviceListV1Schema;
  if (relativePath.includes("trusted-device-rename")) return RenameTrustedDeviceInputV1Schema;
  if (relativePath.includes("remote-access-diagnostics")) return RemoteAccessDiagnosticsV1Schema;
  if (relativePath.includes("client-context")) return ClientContextV1Schema;
  if (relativePath.includes("pair-start-input")) return PairStartInputSchema;
  if (relativePath.includes("pair-start-result")) return PairStartResultSchema;
  if (relativePath.includes("pair-operation-status")) return PairOperationStatusSchema;
  if (relativePath.includes("pair-operation-event")) return PairOperationEventSchema;
  return undefined;
}

describe("checked-in remote lifecycle contract", () => {
  it("matches generated bytes and all lifecycle fixtures", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    expect(await readFile(path.join(contractRoot, "remote-access.schema.json"), "utf8")).toBe(
      serializeRemoteContractJson(createRemoteAccessJsonSchema())
    );
    for (const [relativePath, value] of createRemoteAccessFixtureSet()) {
      const schema = lifecycleFixtureSchema(relativePath);
      if (!schema) continue;
      expect(await readFile(path.join(contractRoot, relativePath), "utf8")).toBe(
        serializeCanonicalContractJson(value)
      );
      expect(schema.safeParse(value).success, relativePath).toBe(relativePath.includes("/valid/"));
    }
  });

  it("publishes secret-lifetime, no-store, and projection invariants", () => {
    const schema = createRemoteAccessJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.PairInvitationV1).toMatchObject({
      "x-waifus-cache-control": "no-store",
      "x-waifus-secret-lifetime": "creator-bound until expiry or cancellation"
    });
    expect(schema.$defs.AssistantSafePairingRequestSummaryV1).toHaveProperty(
      "x-waifus-exact-fields",
      ["requestId", "claimedDisplayName", "claimedPlatform", "expiresAt"]
    );
    expect(schema.$defs.PairOperationStatus).toHaveProperty(
      "x-waifus-comparison-detail-scope",
      "same shell browser session only"
    );
    expect(schema.$defs.PairOperationEvent).toHaveProperty(
      "x-waifus-forbidden-fields",
      ["sasWords", "sasFingerprint", "identity", "transcript", "channelBinding"]
    );
    expect(schema.$defs.ClientContextV1).toHaveProperty(
      "x-waifus-csrf-delivery",
      "response header only"
    );
  });
});
