import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConnectRememberedHostResultV1Schema,
  DisconnectRememberedHostResultV1Schema,
  ForgetRememberedHostInputV1Schema,
  ForgetRememberedHostResultV1Schema,
  GatewayBootstrapV1Schema,
  GatewayLocalEventV1Schema,
  RememberedHostActionInputV1Schema,
  RememberedHostListV1Schema,
  RememberedHostSummaryV1Schema
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
const platform = { os: "darwin", arch: "arm64" } as const;

function rememberedHost(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    hostId: bytes32(0x81),
    displayName: "Studio Host",
    platform,
    installationFingerprint: bytes16(0x82),
    trustEpoch: "7",
    revision: "3",
    pairedAt: "1786270000",
    lastSeenAt: "1786270800",
    lastDirectAt: "1786270800",
    connectionState: "direct",
    lastErrorCode: null,
    ...overrides
  };
}

describe("gateway bootstrap DTO", () => {
  const bootstrap = {
    version: 1,
    gatewayVersion: "1.5.203",
    helperVersion: "0.1.0",
    helperReleaseSequence: "42",
    protocol: { major: 1, minor: 0 },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.http.v1",
      "waifus.sse.cursor.v1"
    ],
    session: {
      idleExpiresAt: "1786272600",
      absoluteExpiresAt: "1786299600"
    },
    activationState: "active",
    helperState: "ready",
    controlState: "connected",
    directState: "direct",
    rememberedHostCount: 1,
    selectionState: "automatic_single",
    selectedHostId: bytes32(0x81),
    lastErrorCode: null
  };

  it("accepts a redacted credentialed-shell bootstrap", () => {
    expect(GatewayBootstrapV1Schema.parse(bootstrap)).toEqual(bootstrap);
  });

  it("rejects browser-session identity, CSRF, paths, endpoints, and pair material", () => {
    for (const forbidden of [
      { gatewayLaunchId: bytes32(0x83) },
      { browserSessionId: bytes32(0x84) },
      { csrfToken: bytes32(0x85) },
      { dataRoot: "/private/waifus" },
      { helperSocketPath: "/private/helper.sock" },
      { endpoint: "192.0.2.1:1234" },
      { pairId: bytes16(0x86) }
    ]) {
      expect(GatewayBootstrapV1Schema.safeParse({
        ...bootstrap,
        ...forbidden
      }).success).toBe(false);
    }
  });

  it("binds selection state to host count and selected host", () => {
    expect(GatewayBootstrapV1Schema.safeParse({
      ...bootstrap,
      rememberedHostCount: 0,
      selectionState: "no_hosts",
      selectedHostId: null,
      directState: "inactive"
    }).success).toBe(true);
    expect(GatewayBootstrapV1Schema.safeParse({
      ...bootstrap,
      rememberedHostCount: 2,
      selectionState: "selection_required",
      selectedHostId: null,
      directState: "inactive"
    }).success).toBe(true);
    expect(GatewayBootstrapV1Schema.safeParse({
      ...bootstrap,
      rememberedHostCount: 2,
      selectionState: "automatic_single"
    }).success).toBe(false);
    expect(GatewayBootstrapV1Schema.safeParse({
      ...bootstrap,
      selectionState: "selection_required"
    }).success).toBe(false);
    expect(GatewayBootstrapV1Schema.safeParse({
      ...bootstrap,
      session: {
        idleExpiresAt: "1786300000",
        absoluteExpiresAt: "1786299600"
      }
    }).success).toBe(false);
  });
});

describe("remembered-host DTOs", () => {
  it("accepts bounded redacted summaries and a unique host list", () => {
    const host = rememberedHost();
    expect(RememberedHostSummaryV1Schema.parse(host)).toEqual(host);
    expect(RememberedHostListV1Schema.parse({ version: 1, hosts: [host] })).toEqual({
      version: 1,
      hosts: [host]
    });
    expect(RememberedHostListV1Schema.safeParse({
      version: 1,
      hosts: [host, host]
    }).success).toBe(false);
  });

  it("rejects trust internals, origins, candidates, and arbitrary destinations", () => {
    const host = rememberedHost();
    for (const forbidden of [
      { pairId: bytes16(0x87) },
      { identityBundle: "secret" },
      { originEpoch: "4" },
      { localOrigin: `http://waifus-${"a".repeat(52)}.localhost:43123` },
      { endpoints: ["192.0.2.1:1234"] },
      { destination: "100.64.0.1" }
    ]) {
      expect(RememberedHostSummaryV1Schema.safeParse({
        ...host,
        ...forbidden
      }).success).toBe(false);
    }
    expect(RememberedHostActionInputV1Schema.parse({})).toEqual({});
    expect(RememberedHostActionInputV1Schema.safeParse({
      destination: "100.64.0.1"
    }).success).toBe(false);
  });
});

describe("remembered-host actions and offline forget", () => {
  const hostId = bytes32(0x81);

  it("pins strict connect and disconnect results", () => {
    expect(ConnectRememberedHostResultV1Schema.safeParse({
      hostId,
      action: "connect",
      state: "connecting",
      acceptedAt: "1786270830"
    }).success).toBe(true);
    expect(DisconnectRememberedHostResultV1Schema.safeParse({
      hostId,
      action: "disconnect",
      state: "offline",
      completedAt: "1786270831"
    }).success).toBe(true);
    expect(ConnectRememberedHostResultV1Schema.safeParse({
      hostId,
      action: "connect",
      state: "connecting",
      acceptedAt: "1786270830",
      destination: "100.64.0.1"
    }).success).toBe(false);
  });

  it("requires the exact warning acknowledgement before local-only forget", () => {
    expect(ForgetRememberedHostInputV1Schema.safeParse({
      revision: "3",
      mode: "reachable_first"
    }).success).toBe(true);
    expect(ForgetRememberedHostInputV1Schema.safeParse({
      revision: "3",
      mode: "local_only_confirmed",
      warningCode: "host_unreachable_remote_trust_may_remain"
    }).success).toBe(true);
    expect(ForgetRememberedHostInputV1Schema.safeParse({
      revision: "3",
      mode: "local_only_confirmed"
    }).success).toBe(false);

    expect(ForgetRememberedHostResultV1Schema.safeParse({
      hostId,
      state: "local_only_confirmation_required",
      revision: "3",
      warningCode: "host_unreachable_remote_trust_may_remain",
      requiredMode: "local_only_confirmed"
    }).success).toBe(true);
    expect(ForgetRememberedHostResultV1Schema.safeParse({
      hostId,
      state: "forgotten",
      revocation: "signed_self_revocation",
      forgottenAt: "1786270832"
    }).success).toBe(true);
    expect(ForgetRememberedHostResultV1Schema.safeParse({
      hostId,
      state: "forgotten",
      revocation: "local_only",
      warningCode: "host_unreachable_remote_trust_may_remain",
      forgottenAt: "1786270832"
    }).success).toBe(true);
    expect(ForgetRememberedHostResultV1Schema.safeParse({
      hostId,
      state: "forgotten",
      revocation: "local_only",
      forgottenAt: "1786270832"
    }).success).toBe(false);
  });
});

describe("gateway-local events", () => {
  it("allows only opaque lifecycle transitions", () => {
    const pairEvent = {
      version: 1,
      type: "pair_operation_state_changed",
      pairOperationId: bytes32(0x88),
      state: "verification_required",
      at: "1786270830"
    };
    expect(GatewayLocalEventV1Schema.parse(pairEvent)).toEqual(pairEvent);
    expect(GatewayLocalEventV1Schema.safeParse({
      ...pairEvent,
      sasWords: ["amber", "birch", "cabin", "delta", "ember"]
    }).success).toBe(false);
    expect(GatewayLocalEventV1Schema.safeParse({
      version: 1,
      type: "host_connection_changed",
      hostId: bytes32(0x81),
      state: "reconnecting",
      at: "1786270830"
    }).success).toBe(true);
    expect(GatewayLocalEventV1Schema.safeParse({
      version: 1,
      type: "remembered_hosts_changed",
      at: "1786270830"
    }).success).toBe(true);
  });
});

function gatewayFixtureSchema(relativePath: string) {
  if (relativePath.includes("gateway-bootstrap")) return GatewayBootstrapV1Schema;
  if (relativePath.includes("remembered-host-list")) return RememberedHostListV1Schema;
  if (relativePath.includes("remembered-host-summary")) return RememberedHostSummaryV1Schema;
  if (relativePath.includes("remembered-host-action-input")) return RememberedHostActionInputV1Schema;
  if (relativePath.includes("remembered-host-connect-result")) return ConnectRememberedHostResultV1Schema;
  if (relativePath.includes("remembered-host-disconnect-result")) return DisconnectRememberedHostResultV1Schema;
  if (relativePath.includes("remembered-host-forget-input")) return ForgetRememberedHostInputV1Schema;
  if (relativePath.includes("remembered-host-forget-result")) return ForgetRememberedHostResultV1Schema;
  if (relativePath.includes("gateway-local-event")) return GatewayLocalEventV1Schema;
  return undefined;
}

describe("checked-in gateway-local contract", () => {
  it("matches generated bytes and all gateway-local fixtures", async () => {
    const contractRoot = path.join(process.cwd(), "contracts", "remote", "v1");
    expect(await readFile(path.join(contractRoot, "remote-access.schema.json"), "utf8")).toBe(
      serializeRemoteContractJson(createRemoteAccessJsonSchema())
    );
    for (const [relativePath, value] of createRemoteAccessFixtureSet()) {
      const schema = gatewayFixtureSchema(relativePath);
      if (!schema) continue;
      expect(await readFile(path.join(contractRoot, relativePath), "utf8")).toBe(
        serializeCanonicalContractJson(value)
      );
      expect(schema.safeParse(value).success, relativePath).toBe(relativePath.includes("/valid/"));
    }
  });

  it("publishes redaction, selection, and forget-order invariants", () => {
    const schema = createRemoteAccessJsonSchema() as {
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$defs.GatewayBootstrapV1).toMatchObject({
      "x-waifus-cache-control": "no-store",
      "x-waifus-csrf-delivery": "X-Waifus-CSRF response header only",
      "x-waifus-session-timeouts-seconds": {
        idle: 1_800,
        absolute: 28_800
      },
      "x-waifus-redacted": true
    });
    expect(schema.$defs.RememberedHostListV1).toHaveProperty(
      "x-waifus-partition-scope",
      "canonical data root"
    );
    expect(schema.$defs.ForgetRememberedHostResultV1).toHaveProperty(
      "x-waifus-forget-order",
      "signed self-revocation before reachable deletion; explicit warning before local-only deletion"
    );
    expect(schema.$defs.GatewayLocalEventV1).toHaveProperty(
      "x-waifus-forbidden-fields",
      ["sasWords", "sasFingerprint", "identity", "endpoint", "token", "code"]
    );
    expect(schema.$defs.GatewayLocalEventV1).toHaveProperty(
      "x-waifus-cache-control",
      "no-store"
    );
  });
});
