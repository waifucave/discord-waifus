import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Page, Request as PlaywrightRequest } from "@playwright/test";
import { createApiServer } from "../../../src/api/server.js";
import { DashboardBuild } from "../../../src/backend/remoteAccess/dashboardBuild.js";
import {
  RemoteAccessService,
  type ConfirmedAdminActor,
  type HelperSupervisorController,
  type RemoteAccessRequestActor
} from "../../../src/backend/remoteAccess/remoteAccessService.js";
import { RemoteRequestBridge } from "../../../src/backend/remoteAccess/requestBridge.js";
import { createRuntimeState } from "../../../src/backend/runtime.js";
import { ensureDataLayout, ensureRemoteOnlyLayout } from "../../../src/config/layout.js";
import type { ModelPipeline } from "../../../src/providers/types.js";
import { DashboardCache } from "../../../src/remote/dashboardCache.js";
import type { DashboardRemoteClient } from "../../../src/remote/dashboardDownloader.js";
import { writeDashboardManifest } from "../../../src/remote/dashboardManifest.js";
import { startRemoteDashboardFrameShell } from "../../../src/remote/gateway/frameShell.js";
import { RemoteLocalApi } from "../../../src/remote/gateway/localApi.js";
import { RemoteOriginStore, derivePinnedHostId } from "../../../src/remote/gateway/originStore.js";
import { startRemoteGatewayRuntime } from "../../../src/remote/gateway/runtime.js";
import { RemoteSelectedHostGateway } from "../../../src/remote/gateway/selectedHost.js";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "../../../src/remote/gateway/server.js";
import type {
  PairOperationStatus,
  PairStartInput
} from "../../../src/shared/schemas/remoteLifecycle.js";
import type {
  RequestPrincipalWire,
  RemoteBrowserContextV1
} from "../../../src/shared/schemas/remoteProtocol.js";
import type { HelperRemoteRequest } from "../../../src/remote/helperTypes.js";
import {
  RememberedHostStore,
  type RememberedHostRecordV1
} from "../../../src/remote/rememberedHosts.js";
import { remoteStatePaths } from "../../../src/remote/paths.js";
import { mapSasIndicesToWordsV1 } from "../../../src/shared/sasWordlist.js";
import { StorageService } from "../../../src/storage/storageService.js";
import type {
  HelperActivationCancel,
  HelperActivationPoll,
  HelperActivationStart,
  HelperIdentityStatus,
  HelperRuntimeStatus,
  HelperSupervisorSnapshot
} from "../../../src/remote/helperTypes.js";
import {
  PairInvitationV1Schema,
  PendingPairingRequestListV1Schema,
  PendingPairingRequestV1Schema,
  TrustedDeviceListV1Schema,
  TrustedDeviceSummaryV1Schema,
  type ApprovePairingInputV1,
  type PairInvitationV1,
  type PendingPairingRequestV1,
  type RenameTrustedDeviceInputV1,
  type TrustedDeviceSummaryV1
} from "../../../src/shared/schemas/remoteLifecycle.js";
import { makeTempRoot } from "../../testUtils.js";
// This test-only transport exercises the authenticated parent/helper boundary without a real
// ts-connect binary. Its byte codec and proofs are covered by the protocol suites.
// @ts-expect-error JavaScript test fixture intentionally has no declaration file.
import { FakeTsConnect } from "../../fixtures/fakeTsConnect.mjs";

const APP_VERSION = "1.5.203";
const HELPER_VERSION = "0.1.0";
const REMOTE_DEVICE_ID = "e2e-remote";
const REMOTE_DEVICE_TRUST_EPOCH = "9";
const CAPABILITIES = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;

const bytes16 = (value: number): string => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number): string => Buffer.alloc(32, value).toString("base64url");
const seconds = (): string => BigInt(Math.floor(Date.now() / 1_000)).toString();

export type HarnessHost = Readonly<{
  key: "a" | "b";
  record: RememberedHostRecordV1;
  buildId: string;
  version: string;
}>;

export type ProxyLedgerEntry = Readonly<{
  hostId: string;
  method: string;
  canonicalTarget: string;
  headers: readonly (readonly [string, string])[];
  browserContext: RemoteBrowserContextV1;
}>;

export type RemoteHarnessLedger = {
  readonly attemptedEgress: Array<Readonly<{
    kind: "browser" | "fake_helper";
    destination: string;
    canonicalTarget: string;
  }>>;
  readonly proxyRequests: ProxyLedgerEntry[];
  readonly eventCursors: string[];
  readonly cancellations: Array<Readonly<{ hostId: string; canonicalTarget: string }>>;
  readonly gatewayLaunches: Array<Readonly<{
    hostId: string;
    gatewayLaunchId: string;
    expiresAt: string;
  }>>;
  readonly dashboardBindings: Array<Readonly<{
    hostId: string;
    origin: string;
    hostname: string;
    port: number;
    localOriginEpoch: string;
  }>>;
  readonly pairSubmissions: Array<Readonly<{ kind: PairStartInput["kind"]; characterCount: number }>>;
  readonly remoteManagement: Array<Readonly<{
    hostId: string;
    action: string;
    actorKind?: "local" | "remote_device";
    targetId?: string;
  }>>;
};

type MutableConnectionState = "direct" | "reconnecting" | "direct_unavailable";
type PairOutcome = Extract<PairOperationStatus["state"], "completed" | "failed" | "expired">;

type HostRuntime = {
  readonly public: HarnessHost;
  readonly dataRoot: string;
  readonly app: FastifyInstance;
  readonly remoteAccess: RemoteAccessService;
  readonly bridge: RemoteRequestBridge;
  readonly helper: InstanceType<typeof FakeTsConnect>;
  readonly client: DashboardRemoteClient;
  readonly updateDashboard: (version: string) => Promise<Readonly<{
    buildId: string;
    version: string;
  }>>;
};

export type RemoteHarnessOptions = Readonly<{
  rememberedHosts?: "none" | "one" | "two";
  fullDashboard?: boolean;
  initialConnection?: MutableConnectionState;
  assistantPipeline?: ModelPipeline;
}>;

export type RemoteHarness = Readonly<{
  dataRoot: string;
  shell: RunningRemoteGateway;
  hosts: Readonly<{ a: HarnessHost; b: HarnessHost }>;
  ledger: RemoteHarnessLedger;
  openShell: (page: Page) => Promise<void>;
  guardBrowserEgress: (page: Page) => Promise<void>;
  setConnection: (hostId: string, state: MutableConnectionState) => Promise<void>;
  setPairOutcome: (state: PairOutcome, errorCode?: string) => void;
  forgetAndRepair: (hostId: string) => Promise<void>;
  forcePreferredPortCollision: () => Promise<number>;
  updateHostBuild: (hostId: string, version: string) => Promise<Readonly<{
    buildId: string;
    version: string;
  }>>;
  hostLocalGet: (hostId: string, canonicalTarget: string) => Promise<Readonly<{
    statusCode: number;
    body: string;
  }>>;
  revokeRemoteAuthorization: (hostId: string) => Promise<void>;
  close: () => Promise<void>;
}>;

function hostRecord(key: "a" | "b"): RememberedHostRecordV1 {
  const value = key === "a" ? 0x41 : 0x42;
  const installationPublicKey = bytes32(value);
  return {
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(installationPublicKey, "base64url")),
    displayName: key === "a" ? "Studio Host" : "Travel Host",
    platform: key === "a"
      ? { os: "darwin", arch: "arm64" }
      : { os: "linux", arch: "x64" },
    installationFingerprint: bytes16(value + 2),
    trustEpoch: key === "a" ? "7" : "11",
    revision: key === "a" ? "3" : "5",
    pairedAt: "1786270000",
    lastSeenAt: "1786270800",
    lastDirectAt: "1786270800",
    connectionState: "direct",
    lastErrorCode: null,
    helperPairId: bytes16(value + 4),
    installationPublicKey
  } as RememberedHostRecordV1;
}

function requestPrincipal(browserContext: RemoteBrowserContextV1): RequestPrincipalWire {
  return {
    kind: "remote_device",
    stableId: `remote:${REMOTE_DEVICE_ID}`,
    deviceId: REMOTE_DEVICE_ID,
    peerFingerprint: bytes16(0x71),
    transportSessionId: bytes16(0x72),
    trustEpoch: REMOTE_DEVICE_TRUST_EPOCH,
    browserContext
  } as RequestPrincipalWire;
}

function browserDestination(request: PlaywrightRequest): string {
  const url = new URL(request.url());
  return url.host;
}

async function createDashboardBundle(
  root: string,
  key: "a" | "b",
  version: string,
  fullDashboard: boolean,
  variant = "initial"
): Promise<{ bundleDirectory: string; build: DashboardBuild; buildId: string }> {
  const packageRoot = path.join(root, `host-${key}-package-${variant}`);
  const bundleDirectory = path.join(packageRoot, "dist-frontend");
  await mkdir(packageRoot, { recursive: true });
  if (fullDashboard) {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      ".."
    );
    await cp(path.join(repositoryRoot, "dist-frontend"), bundleDirectory, { recursive: true });
    const indexPath = path.join(bundleDirectory, "index.html");
    const index = await readFile(indexPath, "utf8");
    await writeFile(
      indexPath,
      index.replace(
        "</head>",
        `<meta name="waifus-e2e-host" content="${key}"><meta name="waifus-e2e-version" content="${version}"></head>`
      )
    );
  } else {
    await mkdir(path.join(bundleDirectory, "assets"), { recursive: true });
    await writeFile(
      path.join(bundleDirectory, "index.html"),
      `<!doctype html><html><head><meta charset="utf-8"><title>Host ${key.toUpperCase()}</title></head><body><main data-testid="host-build">Host ${key.toUpperCase()} · ${version}</main><script type="module" src="/assets/app.js"></script></body></html>`
    );
    await writeFile(
      path.join(bundleDirectory, "assets", "app.js"),
      `globalThis.__WAIFUS_E2E_HOST__=${JSON.stringify(key)};`
    );
  }
  const manifest = await writeDashboardManifest({
    bundleDirectory,
    discordWaifusVersion: version,
    minimumHelperVersion: HELPER_VERSION,
    minimumRemoteGatewayVersion: APP_VERSION,
    requiredCapabilities: CAPABILITIES
  });
  const build = await DashboardBuild.load({
    bundleDirectory,
    expectedBuildId: manifest.buildId
  });
  return { bundleDirectory, build, buildId: manifest.buildId };
}

function helperRuntimeStatus(): HelperRuntimeStatus {
  return {
    activationState: "active",
    controlState: "connected",
    directState: "direct",
    lastDirectAt: seconds() as never,
    lastErrorCode: null
  };
}

function helperSnapshot(key: "a" | "b"): HelperSupervisorSnapshot {
  return {
    state: "ready",
    helperVersion: HELPER_VERSION,
    releaseSequence: "1" as never,
    forkCommit: key === "a"
      ? "1111111111111111111111111111111111111111"
      : "2222222222222222222222222222222222222222",
    target: key === "a"
      ? { os: "darwin", arch: "arm64" }
      : { os: "linux", arch: "x64" },
    protocol: { major: 1, minor: 0 },
    capabilities: [...CAPABILITIES],
    runtimeStatus: helperRuntimeStatus(),
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  };
}

class HostManagementSupervisor implements HelperSupervisorController {
  readonly #hostId: string;
  readonly #key: "a" | "b";
  readonly #ledger: RemoteHarnessLedger;
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();
  #snapshot: HelperSupervisorSnapshot;
  #requests: PendingPairingRequestV1[];
  #devices: TrustedDeviceSummaryV1[];
  #invitation: PairInvitationV1 | undefined;

  constructor(key: "a" | "b", hostId: string, ledger: RemoteHarnessLedger) {
    this.#hostId = hostId;
    this.#key = key;
    this.#ledger = ledger;
    this.#snapshot = helperSnapshot(key);
    const sasIndices = [1, 23, 456, 789, 1_023] as const;
    this.#requests = [PendingPairingRequestV1Schema.parse({
      version: 1,
      requestId: bytes16(key === "a" ? 0x51 : 0x61),
      invitationId: bytes16(key === "a" ? 0x52 : 0x62),
      invitationGeneration: "4",
      entryFlow: "short_code",
      claimedDisplayName: key === "a" ? "New Travel Laptop" : "New Studio Laptop",
      claimedPlatform: { os: "linux", arch: "x64" },
      claimedInstallationFingerprint: bytes16(0x53),
      remoteIdentityBundleHash: bytes32(0x54),
      expiresAt: (BigInt(seconds()) + 300n).toString(),
      protocol: { major: 1, minor: 0 },
      transcriptHash: bytes32(0x55),
      channelBinding: bytes32(0x56),
      sasIndices,
      sasWords: mapSasIndicesToWordsV1(sasIndices),
      sasFingerprint: "a1b2c3d4e5f6"
    })];
    this.#devices = [TrustedDeviceSummaryV1Schema.parse({
      version: 1,
      deviceId: "tablet-01",
      displayName: key === "a" ? "Living Room Tablet" : "Office Tablet",
      platform: { os: "linux", arch: "x64" },
      installationFingerprint: bytes16(0x57),
      trustEpoch: "3",
      revision: "1",
      pairedAt: (BigInt(seconds()) - 900n).toString(),
      lastSeenAt: (BigInt(seconds()) - 5n).toString(),
      connectionState: "direct"
    })];
  }

  snapshot(): HelperSupervisorSnapshot {
    return this.#snapshot;
  }

  identityStatus(): HelperIdentityStatus {
    return {
      activationState: "active",
      deviceId: `host-e2e-${this.#key}`,
      installationFingerprint: bytes16(this.#key === "a" ? 0x58 : 0x68) as never,
      secretStorage: "keychain"
    };
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  attachRequestBridge(_bridge: RemoteRequestBridge): void {}

  async start(): Promise<void> {
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  async stop(): Promise<void> {}

  async reconnect(): Promise<void> {}

  async startRuntime(): Promise<HelperRuntimeStatus> {
    return this.#snapshot.runtimeStatus;
  }

  async runtimeStatus(): Promise<HelperRuntimeStatus> {
    return this.#snapshot.runtimeStatus;
  }

  async reconnectRuntime(): Promise<HelperRuntimeStatus> {
    this.#record("reconnect");
    return this.#snapshot.runtimeStatus;
  }

  async stopRuntime(): Promise<HelperRuntimeStatus> {
    return this.#snapshot.runtimeStatus;
  }

  async registerGatewayLaunch(): Promise<void> {}

  async beginActivation(_operationId: string): Promise<HelperActivationStart> {
    throw new Error("Host browser fixtures are already activated.");
  }

  async pollActivation(_operationId: string): Promise<HelperActivationPoll> {
    throw new Error("Host browser fixtures are already activated.");
  }

  async cancelActivation(_operationId: string): Promise<HelperActivationCancel> {
    throw new Error("Host browser fixtures are already activated.");
  }

  async createInvitation(actor: ConfirmedAdminActor, _idempotencyKey: string): Promise<PairInvitationV1> {
    this.#record("invitation_create", actor.kind);
    this.#invitation ??= PairInvitationV1Schema.parse({
      invitationId: bytes16(this.#key === "a" ? 0x71 : 0x72),
      fullToken: `WF1.${Buffer.alloc(192, this.#key === "a" ? 0x31 : 0x32).toString("base64url")}`,
      shortCode: this.#key === "a" ? "01AB-CDEF" : "02AB-CDEF",
      expiresAt: (BigInt(seconds()) + 300n).toString()
    });
    return this.#invitation;
  }

  async cancelInvitation(invitationId: string, actor: ConfirmedAdminActor): Promise<void> {
    this.#record("invitation_cancel", actor.kind, invitationId);
    if (this.#invitation?.invitationId === invitationId) this.#invitation = undefined;
  }

  async listPairingRequests(actor: RemoteAccessRequestActor) {
    this.#record("pairing_requests_list", actor.kind);
    return PendingPairingRequestListV1Schema.parse({ version: 1, requests: this.#requests });
  }

  async approvePairingRequest(
    requestId: string,
    _input: ApprovePairingInputV1,
    actor: ConfirmedAdminActor
  ): Promise<void> {
    this.#record("pairing_request_approve", actor.kind, requestId);
    const request = this.#requests.find((candidate) => candidate.requestId === requestId);
    this.#requests = this.#requests.filter((candidate) => candidate.requestId !== requestId);
    if (request) {
      this.#devices.push(TrustedDeviceSummaryV1Schema.parse({
        version: 1,
        deviceId: "new-travel-laptop",
        displayName: request.claimedDisplayName,
        platform: request.claimedPlatform,
        installationFingerprint: request.claimedInstallationFingerprint,
        trustEpoch: "12",
        revision: "1",
        pairedAt: seconds(),
        lastSeenAt: seconds(),
        connectionState: "direct"
      }));
    }
  }

  async rejectPairingRequest(requestId: string, actor: RemoteAccessRequestActor): Promise<void> {
    this.#record("pairing_request_reject", actor.kind, requestId);
    this.#requests = this.#requests.filter((candidate) => candidate.requestId !== requestId);
  }

  async listDevices() {
    this.#record("trusted_devices_list");
    return TrustedDeviceListV1Schema.parse({ version: 1, devices: this.#devices });
  }

  async renameDevice(
    deviceId: string,
    input: RenameTrustedDeviceInputV1,
    actor: RemoteAccessRequestActor
  ): Promise<TrustedDeviceSummaryV1> {
    this.#record("trusted_device_rename", actor.kind, deviceId);
    const index = this.#devices.findIndex((device) => device.deviceId === deviceId);
    if (index < 0) throw new Error("Unknown deterministic trusted device.");
    const current = this.#devices[index]!;
    const updated = TrustedDeviceSummaryV1Schema.parse({
      ...current,
      displayName: input.displayName,
      revision: (BigInt(current.revision) + 1n).toString()
    });
    this.#devices[index] = updated;
    return updated;
  }

  async revokeDevice(deviceId: string, actor: ConfirmedAdminActor): Promise<void> {
    this.#record("trusted_device_revoke", actor.kind, deviceId);
    this.#devices = this.#devices.filter((device) => device.deviceId !== deviceId);
  }

  async close(): Promise<void> {}

  #record(
    action: string,
    actorKind?: "local" | "remote_device",
    targetId?: string
  ): void {
    this.#ledger.remoteManagement.push({
      hostId: this.#hostId,
      action,
      ...(actorKind ? { actorKind } : {}),
      ...(targetId ? { targetId } : {})
    });
  }
}

async function enableHostRemoteAccess(
  dataRoot: string,
  displayName: string
): Promise<void> {
  const paths = remoteStatePaths(dataRoot);
  const [config, installation, trustIndex] = await Promise.all([
    readFile(paths.hostConfig, "utf8").then(JSON.parse),
    readFile(paths.installation, "utf8").then(JSON.parse),
    readFile(paths.trustIndex, "utf8").then(JSON.parse)
  ]) as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
  await Promise.all([
    writeFile(paths.hostConfig, JSON.stringify({
      ...config,
      revision: "1",
      enabled: true,
      displayName,
      updatedAt: seconds()
    }, null, 2) + "\n", { mode: 0o600 }),
    writeFile(paths.installation, JSON.stringify({
      ...installation,
      activationReference: `waifus.activation.v1.${String(installation.installationId)}`
    }, null, 2) + "\n", { mode: 0o600 }),
    writeFile(paths.trustIndex, JSON.stringify({
      ...trustIndex,
      trustEpochHighWater: REMOTE_DEVICE_TRUST_EPOCH,
      pairs: [{
        deviceId: REMOTE_DEVICE_ID,
        pairId: bytes16(0x73),
        trustEpoch: REMOTE_DEVICE_TRUST_EPOCH
      }]
    }, null, 2) + "\n", { mode: 0o600 })
  ]);
}

async function createHostRuntime(
  root: string,
  key: "a" | "b",
  record: RememberedHostRecordV1,
  fullDashboard: boolean,
  ledger: RemoteHarnessLedger,
  assistantPipeline?: ModelPipeline
): Promise<HostRuntime> {
  const version = key === "a" ? "1.5.250" : "1.6.0";
  const fixture = await createDashboardBundle(root, key, version, fullDashboard);
  let activeDashboardFixture = fixture;
  let dashboardUpdateSequence = 0;
  const dataRoot = path.join(root, `host-${key}-data`);
  await ensureDataLayout(dataRoot);
  await enableHostRemoteAccess(dataRoot, record.displayName);
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: version,
    port: 3888,
    dataRoot,
    mode: "test",
    paused: false,
    discord: {
      connected: false,
      orchestratorConnected: false,
      waifuBotCount: 0,
      warnings: []
    },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const supervisor = new HostManagementSupervisor(key, record.hostId, ledger);
  const remoteAccess = new RemoteAccessService({
    dataRoot,
    runtime,
    effectiveHost: "127.0.0.1",
    dashboard: {
      path: fixture.bundleDirectory,
      source: "bundled",
      buildId: fixture.buildId
    },
    supervisor,
    resolveHost: async (host) => host === "localhost" ? ["127.0.0.1", "::1"] : [host]
  });
  const app = await createApiServer({
    dataRoot,
    runtime,
    storage: new StorageService(dataRoot),
    dashboardBuild: fixture.build,
    remoteTrust: {
      isAuthorized: (principal) => remoteAccess.isAuthorized(principal)
    },
    remoteAccess,
    ...(assistantPipeline ? { assistant: { createPipeline: () => assistantPipeline } } : {}),
    browserSecurity: { listenerHost: "127.0.0.1", port: 3888, mode: "test" }
  });
  const bridge = new RemoteRequestBridge(app);
  remoteAccess.attachRequestBridge(bridge);
  if (assistantPipeline) {
    const credentials = await app.inject({
      method: "PUT",
      url: "/api/providers/deepseek/credentials",
      payload: { apiKey: "sk-e2e-placeholder" }
    });
    if (credentials.statusCode !== 200) {
      throw new Error(`Could not configure the deterministic assistant provider (${credentials.statusCode}).`);
    }
    const current = await app.inject({ method: "GET", url: "/api/assistant/config" });
    const configured = await app.inject({
      method: "PUT",
      url: "/api/assistant/config",
      payload: {
        revision: current.json<{ revision: number }>().revision,
        providerId: "deepseek",
        modelId: "deepseek-v4-pro"
      }
    });
    if (configured.statusCode !== 200) {
      throw new Error(`Could not configure the deterministic assistant model (${configured.statusCode}).`);
    }
  }
  await remoteAccess.start();
  const helper = new FakeTsConnect(bridge, `e2e-helper-${key}`);
  const client: DashboardRemoteClient = {
    hello: { componentVersion: HELPER_VERSION },
    negotiatedProtocol: { major: 1, minor: 0 },
    negotiatedCapabilities: [...CAPABILITIES],
    request: async (input: HelperRemoteRequest) => {
      ledger.attemptedEgress.push({
        kind: "fake_helper",
        destination: record.hostId,
        canonicalTarget: input.canonicalTarget
      });
      ledger.proxyRequests.push({
        hostId: record.hostId,
        method: input.method,
        canonicalTarget: input.canonicalTarget,
        headers: input.headers.map((header) => Object.freeze([...header] as const)),
        browserContext: structuredClone(input.browserContext)
      });
      const lastEventId = input.headers.find(([name]) => name === "last-event-id")?.[1];
      if (lastEventId) ledger.eventCursors.push(lastEventId);
      if (input.canonicalTarget === "/api/remote-access/dashboard-manifest") {
        const current = await activeDashboardFixture.build.readManifest();
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", "application/json; charset=utf-8"],
            ["content-length", String(current.bytes.byteLength)]
          ],
          body: Readable.from([current.bytes]),
          cancel: () => {
            ledger.cancellations.push({
              hostId: record.hostId,
              canonicalTarget: input.canonicalTarget
            });
          }
        };
      }
      const dashboardAssetPrefix = "/api/remote-access/dashboard-assets/";
      if (input.canonicalTarget.startsWith(dashboardAssetPrefix)) {
        const relative = input.canonicalTarget.slice(dashboardAssetPrefix.length);
        const separator = relative.indexOf("/");
        if (separator < 1) throw new Error("Malformed deterministic dashboard asset target.");
        const opened = await activeDashboardFixture.build.openAsset(
          relative.slice(0, separator),
          relative.slice(separator + 1),
          input.signal
        );
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", opened.asset.contentType],
            ["content-length", opened.asset.byteSize]
          ],
          body: opened.stream,
          cancel: (reason?: unknown) => {
            ledger.cancellations.push({
              hostId: record.hostId,
              canonicalTarget: input.canonicalTarget
            });
            opened.stream.destroy(reason instanceof Error ? reason : undefined);
          }
        };
      }
      if (input.canonicalTarget === "/api/e2e/download") {
        const chunks = Array.from({ length: 16 }, (_, index) => Buffer.alloc(16 * 1_024, index));
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", "application/octet-stream"],
            ["content-length", String(256 * 1_024)],
            ["content-disposition", 'attachment; filename="remote-e2e.bin"']
          ],
          body: Readable.from(chunks),
          cancel: () => {
            ledger.cancellations.push({
              hostId: record.hostId,
              canonicalTarget: input.canonicalTarget
            });
          }
        };
      }
      if (input.canonicalTarget === "/api/e2e/slow") {
        const body = new PassThrough();
        body.on("error", () => {});
        body.write(Buffer.from("stream-started"));
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [["content-type", "application/octet-stream"]],
          body,
          cancel: (reason?: unknown) => {
            ledger.cancellations.push({
              hostId: record.hostId,
              canonicalTarget: input.canonicalTarget
            });
            body.destroy(reason instanceof Error ? reason : new Error("Browser cancelled test stream."));
          }
        };
      }
      if (input.canonicalTarget === "/api/e2e/policy") {
        return {
          statusCode: 200,
          statusMessage: "OK",
          headers: [
            ["content-type", "application/json; charset=utf-8"],
            ["set-cookie", "host_session=forbidden; Path=/"],
            ["content-security-policy", "default-src *; sandbox allow-popups allow-top-navigation"],
            ["service-worker-allowed", "/"],
            ["access-control-allow-origin", "*"]
          ],
          body: Readable.from([Buffer.from(JSON.stringify({ host: key, ok: true }))]),
          cancel: () => {
            ledger.cancellations.push({
              hostId: record.hostId,
              canonicalTarget: input.canonicalTarget
            });
          }
        };
      }
      const response = await helper.request({
        version: 1,
        method: input.method,
        canonicalTarget: input.canonicalTarget,
        headers: input.headers,
        principal: requestPrincipal(input.browserContext)
      }, {
        ...(input.body ? { body: input.body } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
      const cancel = response.cancel;
      return Object.freeze({
        ...response,
        cancel: (reason?: unknown) => {
          ledger.cancellations.push({
            hostId: record.hostId,
            canonicalTarget: input.canonicalTarget
          });
          cancel(reason);
        }
      });
    }
  };
  return {
    public: Object.freeze({ key, record, buildId: fixture.buildId, version }),
    dataRoot,
    app,
    remoteAccess,
    bridge,
    helper,
    client,
    updateDashboard: async (nextVersion: string) => {
      dashboardUpdateSequence += 1;
      activeDashboardFixture = await createDashboardBundle(
        root,
        key,
        nextVersion,
        fullDashboard,
        `update-${dashboardUpdateSequence}`
      );
      return Object.freeze({
        buildId: activeDashboardFixture.buildId,
        version: nextVersion
      });
    }
  };
}

export async function createRemoteHarness(
  options: RemoteHarnessOptions = {}
): Promise<RemoteHarness> {
  const root = await makeTempRoot("waifus-browser-e2e-");
  const dataRoot = path.join(root, "remote-data");
  await ensureRemoteOnlyLayout(dataRoot);
  const rememberedHosts = new RememberedHostStore(dataRoot);
  const origins = new RemoteOriginStore(dataRoot);
  const ledger: RemoteHarnessLedger = {
    attemptedEgress: [],
    proxyRequests: [],
    eventCursors: [],
    cancellations: [],
    gatewayLaunches: [],
    dashboardBindings: [],
    pairSubmissions: [],
    remoteManagement: []
  };
  const records = { a: hostRecord("a"), b: hostRecord("b") };
  const [hostA, hostB] = await Promise.all([
    createHostRuntime(
      root,
      "a",
      records.a,
      options.fullDashboard ?? false,
      ledger,
      options.assistantPipeline
    ),
    createHostRuntime(
      root,
      "b",
      records.b,
      options.fullDashboard ?? false,
      ledger,
      options.assistantPipeline
    )
  ]);
  const hostRuntimes = new Map([
    [records.a.hostId, hostA],
    [records.b.hostId, hostB]
  ]);
  const remembered = options.rememberedHosts ?? "two";
  if (remembered === "one" || remembered === "two") await rememberedHosts.upsert(records.a);
  if (remembered === "two") await rememberedHosts.upsert({
    ...records.b,
    connectionState: "offline",
    lastDirectAt: null
  });

  const desiredConnections = new Map<string, MutableConnectionState>([
    [records.a.hostId, options.initialConnection ?? "direct"],
    [records.b.hostId, options.initialConnection ?? "direct"]
  ]);
  let pairOutcome: { state: PairOutcome; errorCode?: string } | undefined;
  const activationExpires = new Map<string, string>();
  const pairFlows = new Map<string, PairStartInput["kind"]>();
  const pairExpires = new Map<string, string>();
  const pairPolls = new Map<string, number>();
  let activeDashboard: {
    hostId: string;
    gateway: RunningRemoteGateway;
    frameShell: RunningRemoteGateway;
  } | undefined;
  const blockers: Server[] = [];
  let localApi: RemoteLocalApi;

  const selectedConnection = async (): Promise<MutableConnectionState | "inactive"> => {
    const selection = await rememberedHosts.selection();
    return selection.selectedHostId
      ? desiredConnections.get(selection.selectedHostId) ?? "direct_unavailable"
      : "inactive";
  };

  const backend = {
    snapshot: async () => ({
      gatewayVersion: APP_VERSION,
      helperVersion: HELPER_VERSION,
      helperReleaseSequence: "1",
      protocol: { major: 1, minor: 0 },
      capabilities: [...CAPABILITIES],
      activationState: "active" as const,
      helperState: "ready" as const,
      controlState: "connected" as const,
      directState: await selectedConnection(),
      lastErrorCode: null
    }),
    beginActivation: async (operationId: string) => {
      const expiresAt = (BigInt(seconds()) + 300n).toString();
      activationExpires.set(operationId, expiresAt);
      return {
        operationId,
        verificationUrl: `https://pair.waifucave.com/activate#${bytes32(0x61)}` as const,
        expiresAt
      };
    },
    pollActivation: async (operationId: string) => ({
      operationId,
      state: "completed" as const,
      expiresAt: activationExpires.get(operationId) ?? "0"
    }),
    cancelActivation: async (operationId: string) => {
      activationExpires.delete(operationId);
      return { operationId, cancelled: true as const };
    },
    beginPair: async (operationId: string, input: PairStartInput) => {
      const expiresAt = (BigInt(seconds()) + 300n).toString();
      pairFlows.set(operationId, input.kind);
      pairExpires.set(operationId, expiresAt);
      pairPolls.set(operationId, 0);
      ledger.pairSubmissions.push({
        kind: input.kind,
        characterCount: input.kind === "full_token" ? input.token.length : input.code.length
      });
      return { expiresAt };
    },
    pollPair: async (operationId: string): Promise<PairOperationStatus> => {
      const polls = (pairPolls.get(operationId) ?? 0) + 1;
      pairPolls.set(operationId, polls);
      const expiresAt = pairExpires.get(operationId) ?? "0";
      const statusUrl = `/_waifus_remote/v1/pair/${operationId}`;
      if (pairOutcome) {
        if (pairOutcome.state === "completed") {
          if (!await rememberedHosts.record(records.a.hostId)) await rememberedHosts.upsert(records.a);
          desiredConnections.set(records.a.hostId, "direct");
          return { pairOperationId: operationId, statusUrl, state: "completed", expiresAt } as PairOperationStatus;
        }
        if (pairOutcome.state === "expired") {
          return { pairOperationId: operationId, statusUrl, state: "expired", expiresAt } as PairOperationStatus;
        }
        return {
          pairOperationId: operationId,
          statusUrl,
          state: "failed",
          expiresAt,
          errorCode: pairOutcome.errorCode ?? "verification_mismatch"
        } as PairOperationStatus;
      }
      return {
        pairOperationId: operationId,
        statusUrl,
        state: "verification_required",
        expiresAt,
        entryFlow: pairFlows.get(operationId) ?? "full_token",
        sasWords: ["acorn", "angel", "jeep", "slip", "zoom"],
        sasFingerprint: "a1b2c3d4e5f6",
        claimedHostDisplayName: records.a.displayName,
        claimedHostPlatform: records.a.platform,
        claimedHostInstallationFingerprint: records.a.installationFingerprint
      } as PairOperationStatus;
    },
    cancelPair: async (operationId: string) => {
      pairFlows.delete(operationId);
      pairExpires.delete(operationId);
      pairPolls.delete(operationId);
    },
    connectRememberedHost: async (host: RememberedHostRecordV1) => {
      if (!desiredConnections.has(host.hostId)) desiredConnections.set(host.hostId, "direct");
    },
    disconnectRememberedHost: async (host: RememberedHostRecordV1) => {
      desiredConnections.set(host.hostId, "reconnecting");
    },
    requestSignedSelfRevocation: async () => true,
    forgetRememberedHost: async (host: RememberedHostRecordV1) => {
      desiredConnections.delete(host.hostId);
      if (activeDashboard?.hostId === host.hostId) {
        await activeDashboard.frameShell.close();
        await activeDashboard.gateway.close();
        activeDashboard = undefined;
      }
    }
  };

  const issueSelectedHostBootstrap = async (record: RememberedHostRecordV1): Promise<string> => {
    const host = hostRuntimes.get(record.hostId);
    if (!host) throw new Error("Selected host is not pinned in the deterministic harness.");
    if (activeDashboard?.hostId === record.hostId) {
      return activeDashboard.frameShell.issueBootstrapUrl();
    }
    if (activeDashboard) {
      await activeDashboard.frameShell.close();
      await activeDashboard.gateway.close();
    }
    let selected: RemoteSelectedHostGateway | undefined;
    let frameShellOrigin: string | undefined;
    const gateway = await startRemoteGatewayRuntime({
      dataRoot,
      pinnedHostId: record.hostId,
      hostTrustEpoch: record.trustEpoch,
      surface: "dashboard",
      frameAncestorOrigin: () => frameShellOrigin,
      registerGatewayLaunch: async (gatewayLaunchId, expiresAt) => {
        ledger.gatewayLaunches.push({ hostId: record.hostId, gatewayLaunchId, expiresAt });
      },
      handleAuthenticatedRequest: (...args) => {
        if (!selected) throw new Error("Selected-host gateway was not initialized.");
        return selected.handle(...args);
      }
    });
    let frameShell: RunningRemoteGateway;
    try {
      frameShell = await startRemoteDashboardFrameShell({ dashboard: gateway });
      frameShellOrigin = frameShell.origin;
    } catch (error) {
      await gateway.close();
      throw error;
    }
    selected = new RemoteSelectedHostGateway({
      cache: new DashboardCache({ dataRoot }),
      client: host.client,
      hostKey: { hostId: record.hostId, trustEpoch: record.trustEpoch },
      remoteGatewayVersion: APP_VERSION,
      connectionShellOrigin: shell.origin,
      localOrigin: gateway.origin,
      connectionState: () => desiredConnections.get(record.hostId) ?? "direct_unavailable"
    });
    ledger.dashboardBindings.push({
      hostId: record.hostId,
      origin: gateway.origin,
      hostname: gateway.hostname,
      port: gateway.port,
      localOriginEpoch: gateway.originBinding.localOriginEpoch
    });
    activeDashboard = { hostId: record.hostId, gateway, frameShell };
    return frameShell.bootstrapUrl;
  };

  let shell!: RunningRemoteGateway;
  shell = await startRemoteGateway({
    hostname: `waifus-${"z".repeat(52)}.localhost`,
    port: 0,
    surface: "shell",
    handleAuthenticatedRequest: (...args) => localApi.handle(...args)
  });
  localApi = new RemoteLocalApi({
    backend,
    rememberedHosts,
    origins,
    issueSelectedHostBootstrap
  });

  let closed = false;
  return Object.freeze({
    dataRoot,
    shell,
    hosts: Object.freeze({ a: hostA.public, b: hostB.public }),
    ledger,
    openShell: async (page: Page) => {
      await page.goto(shell.issueBootstrapUrl(), { waitUntil: "domcontentloaded" });
    },
    guardBrowserEgress: async (page: Page) => {
      await page.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.protocol === "http:" && url.hostname.endsWith(".localhost")) {
          await route.continue();
          return;
        }
        ledger.attemptedEgress.push({
          kind: "browser",
          destination: browserDestination(request),
          canonicalTarget: `${url.pathname}${url.search}`
        });
        await route.abort("blockedbyclient");
      });
    },
    setConnection: async (hostId: string, state: MutableConnectionState) => {
      desiredConnections.set(hostId, state);
      const host = await rememberedHosts.record(hostId);
      if (host) {
        await rememberedHosts.updateConnection(
          hostId,
          state,
          state === "direct" ? seconds() : host.lastDirectAt,
          state === "direct_unavailable" ? "direct_unavailable" : null
        );
      }
    },
    setPairOutcome: (state: PairOutcome, errorCode?: string) => {
      pairOutcome = { state, ...(errorCode ? { errorCode } : {}) };
    },
    forgetAndRepair: async (hostId: string) => {
      const current = await rememberedHosts.record(hostId);
      if (!current) throw new Error("Cannot re-pair an unknown harness host.");
      if (activeDashboard?.hostId === hostId) {
        await activeDashboard.frameShell.close();
        await activeDashboard.gateway.close();
        activeDashboard = undefined;
      }
      await origins.advanceForForget(hostId);
      await rememberedHosts.remove(hostId, current.revision);
      await rememberedHosts.upsert({
        ...current,
        revision: (BigInt(current.revision) + 1n).toString(),
        trustEpoch: (BigInt(current.trustEpoch) + 1n).toString(),
        connectionState: "direct",
        lastDirectAt: seconds(),
        lastSeenAt: seconds()
      });
      desiredConnections.set(hostId, "direct");
    },
    forcePreferredPortCollision: async () => {
      if (!activeDashboard) throw new Error("A dashboard must be open before forcing a port collision.");
      const port = activeDashboard.gateway.port;
      await activeDashboard.frameShell.close();
      await activeDashboard.gateway.close();
      activeDashboard = undefined;
      const blocker = createServer();
      await new Promise<void>((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(port, "127.0.0.1", resolve);
      });
      const address = blocker.address() as AddressInfo;
      if (address.port !== port) throw new Error("Preferred-port blocker bound the wrong port.");
      blockers.push(blocker);
      return port;
    },
    updateHostBuild: async (hostId: string, version: string) => {
      const host = hostRuntimes.get(hostId);
      if (!host) throw new Error("Cannot update an unknown deterministic host build.");
      const updated = await host.updateDashboard(version);
      if (activeDashboard?.hostId === hostId) {
        await activeDashboard.frameShell.close();
        await activeDashboard.gateway.close();
        activeDashboard = undefined;
      }
      return updated;
    },
    hostLocalGet: async (hostId: string, canonicalTarget: string) => {
      const host = hostRuntimes.get(hostId);
      if (!host) throw new Error("Cannot query an unknown deterministic host.");
      const response = await host.app.inject({ method: "GET", url: canonicalTarget });
      return Object.freeze({ statusCode: response.statusCode, body: response.body });
    },
    revokeRemoteAuthorization: async (hostId: string) => {
      const host = hostRuntimes.get(hostId);
      if (!host) throw new Error("Cannot revoke authorization on an unknown deterministic host.");
      const trustIndexPath = remoteStatePaths(host.dataRoot).trustIndex;
      const trustIndex = JSON.parse(await readFile(trustIndexPath, "utf8")) as {
        pairs?: Array<{ deviceId?: string }>;
      };
      await writeFile(trustIndexPath, JSON.stringify({
        ...trustIndex,
        pairs: (trustIndex.pairs ?? []).filter((pair) => pair.deviceId !== REMOTE_DEVICE_ID)
      }, null, 2) + "\n", { mode: 0o600 });
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await localApi.close();
      await activeDashboard?.frameShell.close();
      await activeDashboard?.gateway.close();
      await shell.close();
      await Promise.all(blockers.splice(0).map((blocker) => new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      })));
      hostA.helper.close();
      hostB.helper.close();
      hostA.bridge.close();
      hostB.bridge.close();
      await Promise.all([hostA.remoteAccess.close(), hostB.remoteAccess.close()]);
      await Promise.all([hostA.app.close(), hostB.app.close()]);
      await rm(root, { recursive: true, force: true });
    }
  });
}
