import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeState } from "../src/backend/runtime.js";
import {
  RemoteAccessActorUnauthorizedError,
  RemoteAccessService,
  type HelperSupervisorController
} from "../src/backend/remoteAccess/remoteAccessService.js";
import { RemoteAccessStateStore } from "../src/backend/remoteAccess/stateStore.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import type {
  HelperRuntimeStatus,
  HelperSupervisorSnapshot
} from "../src/remote/helperTypes.js";
import type { RemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function runtimeStatus(overrides: Partial<HelperRuntimeStatus> = {}): HelperRuntimeStatus {
  return {
    activationState: "active",
    controlState: "connected",
    directState: "inactive",
    lastDirectAt: null,
    lastErrorCode: null,
    ...overrides
  };
}

function supervisorSnapshot(
  overrides: Partial<HelperSupervisorSnapshot> = {}
): HelperSupervisorSnapshot {
  return {
    state: "ready",
    helperVersion: "0.1.0",
    releaseSequence: "42" as never,
    forkCommit: "0123456789abcdef0123456789abcdef01234567",
    target: { os: "darwin", arch: "arm64" },
    protocol: { major: 1, minor: 0 },
    capabilities: [
      "waifus.browser-context.v1",
      "waifus.dashboard.manifest.v1",
      "waifus.http.v1",
      "waifus.principal.v1",
      "waifus.sse.cursor.v1",
      "waifus.stream.cancel.v1"
    ],
    runtimeStatus: runtimeStatus(),
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false,
    ...overrides
  };
}

class FakeSupervisor implements HelperSupervisorController {
  startCalls = 0;
  reconnectCalls = 0;
  startRuntimeCalls = 0;
  reconnectRuntimeCalls = 0;
  stopRuntimeCalls = 0;
  attachedBridge: unknown;
  closeCalls = 0;
  startError: Error | undefined;
  reconcileError: Error | undefined;
  managementCalls: Array<{ command: string; input: unknown[] }> = [];
  devices: Array<{
    version: 1;
    deviceId: string;
    displayName: string;
    platform: { os: "darwin"; arch: "arm64" };
    installationFingerprint: string;
    trustEpoch: string;
    revision: string;
    pairedAt: string;
    lastSeenAt: string;
    connectionState: "direct";
  }> = [];
  #snapshot: HelperSupervisorSnapshot;
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();

  constructor(snapshot = supervisorSnapshot()) {
    this.#snapshot = snapshot;
  }

  snapshot(): HelperSupervisorSnapshot {
    return this.#snapshot;
  }

  identityStatus() {
    return null;
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  attachRequestBridge(bridge: unknown): void {
    this.attachedBridge = bridge;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    this.emit(this.#snapshot);
  }

  async stop(): Promise<void> {}

  async reconnect(): Promise<void> {
    this.reconnectCalls += 1;
  }

  async startRuntime(): Promise<HelperRuntimeStatus> {
    this.startRuntimeCalls += 1;
    return this.#snapshot.runtimeStatus;
  }

  async runtimeStatus(): Promise<HelperRuntimeStatus> {
    return this.#snapshot.runtimeStatus;
  }

  async reconnectRuntime(): Promise<HelperRuntimeStatus> {
    this.reconnectRuntimeCalls += 1;
    return this.#snapshot.runtimeStatus;
  }

  async stopRuntime(): Promise<HelperRuntimeStatus> {
    this.stopRuntimeCalls += 1;
    return this.#snapshot.runtimeStatus;
  }

  async registerGatewayLaunch(): Promise<void> {}

  async beginActivation(): Promise<never> {
    throw new Error("Activation is not configured in this lifecycle test.");
  }

  async pollActivation(): Promise<never> {
    throw new Error("Activation is not configured in this lifecycle test.");
  }

  async cancelActivation(): Promise<never> {
    throw new Error("Activation is not configured in this lifecycle test.");
  }

  async createInvitation(...input: unknown[]) {
    this.managementCalls.push({ command: "invitation_create", input });
    return {
      invitationId: Buffer.alloc(16, 0x41).toString("base64url"),
      fullToken: `WF1.${Buffer.alloc(192).toString("base64url")}`,
      shortCode: "01AB-CDEF",
      expiresAt: "1786271130"
    };
  }

  async cancelInvitation(...input: unknown[]): Promise<void> {
    this.managementCalls.push({ command: "invitation_cancel", input });
  }

  async listPairingRequests(...input: unknown[]) {
    this.managementCalls.push({ command: "pairing_requests_list", input });
    return { version: 1 as const, requests: [] };
  }

  async approvePairingRequest(...input: unknown[]): Promise<void> {
    this.managementCalls.push({ command: "pairing_request_approve", input });
  }

  async rejectPairingRequest(...input: unknown[]): Promise<void> {
    this.managementCalls.push({ command: "pairing_request_reject", input });
  }

  async listDevices(...input: unknown[]) {
    this.managementCalls.push({ command: "trusted_devices_list", input });
    return { version: 1 as const, devices: this.devices };
  }

  async renameDevice(deviceId: string, input: { displayName: string }, ...rest: unknown[]) {
    this.managementCalls.push({ command: "trusted_device_rename", input: [deviceId, input, ...rest] });
    return {
      version: 1 as const,
      deviceId,
      displayName: input.displayName,
      platform: { os: "darwin" as const, arch: "arm64" as const },
      installationFingerprint: Buffer.alloc(16, 0x42).toString("base64url"),
      trustEpoch: "7",
      revision: "2",
      pairedAt: "1786000000",
      lastSeenAt: "1786270800",
      connectionState: "direct" as const
    };
  }

  async revokeDevice(...input: unknown[]): Promise<void> {
    this.managementCalls.push({ command: "trusted_device_revoke", input });
    const [deviceId] = input;
    this.devices = this.devices.filter((device) => device.deviceId !== deviceId);
  }

  async reconcileDeviceRevocation(...input: unknown[]): Promise<void> {
    this.managementCalls.push({ command: "trusted_device_revoke_reconcile", input });
    if (this.reconcileError) throw this.reconcileError;
    const [{ deviceId }] = input as [{ deviceId: string }];
    this.devices = this.devices.filter((device) => device.deviceId !== deviceId);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  emit(snapshot: HelperSupervisorSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }
}

async function makeRoot(): Promise<string> {
  const root = await makeTempRoot("waifus-remote-service-");
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function enableRemoteAccess(
  root: string,
  options: { activated?: boolean; deviceId?: string; trustEpoch?: string } = {}
): Promise<void> {
  const paths = remoteStatePaths(root);
  const config = JSON.parse(await readFile(paths.hostConfig, "utf8")) as Record<string, unknown>;
  await writeJson(paths.hostConfig, {
    ...config,
    revision: "1",
    enabled: true,
    updatedAt: "1"
  });
  if (options.activated !== false) {
    const installation = JSON.parse(
      await readFile(paths.installation, "utf8")
    ) as Record<string, unknown>;
    await writeJson(paths.installation, {
      ...installation,
      activationReference: `waifus.activation.v1.${String(installation.installationId)}`
    });
  }
  if (options.deviceId) {
    const trustEpoch = options.trustEpoch ?? "7";
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: trustEpoch,
      resetTombstone: "0",
      pairs: [{
        deviceId: options.deviceId,
        pairId: Buffer.alloc(16, 0x51).toString("base64url"),
        trustEpoch
      }]
    });
  }
}

function makeRuntime(root: string) {
  return createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
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
}

function service(
  root: string,
  supervisor: FakeSupervisor,
  options: { effectiveHost?: string; dashboardSource?: "bundled" | "custom" } = {}
): RemoteAccessService {
  return new RemoteAccessService({
    dataRoot: root,
    runtime: makeRuntime(root),
    effectiveHost: options.effectiveHost ?? "127.0.0.1",
    dashboard: {
      path: path.join(root, "dashboard"),
      source: options.dashboardSource ?? "bundled",
      buildId: "a".repeat(64)
    },
    supervisor,
    resolveHost: async (host) => host === "localhost" ? ["127.0.0.1", "::1"] : [host]
  });
}

function principal(deviceId: string, trustEpoch: string): RemoteRequestPrincipal {
  return {
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: Buffer.alloc(16, 0x61).toString("base64url") as never,
    transportSessionId: Buffer.alloc(16, 0x62).toString("base64url") as never,
    trustEpoch: trustEpoch as never
  };
}

describe("host remote-access lifecycle service", () => {
  it("keeps a disabled installation inactive without launching the helper", async () => {
    const root = await makeRoot();
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);
    await remote.start();

    expect(supervisor.startCalls).toBe(0);
    expect(remote.getRuntimeSummary()).toEqual({
      version: 1,
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      trustedDeviceCount: 0,
      lastDirectAt: null,
      lastErrorCode: null
    });
    await remote.close();
    expect(supervisor.closeCalls).toBe(1);
  });

  it("starts an activated enabled installation and mirrors sanitized helper state", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    const supervisor = new FakeSupervisor(supervisorSnapshot({
      runtimeStatus: runtimeStatus({ directState: "direct", lastDirectAt: "100" as never })
    }));
    const remote = service(root, supervisor);
    await remote.start();

    expect(supervisor.startCalls).toBe(1);
    expect(supervisor.startRuntimeCalls).toBe(1);
    expect(remote.getRuntimeSummary()).toMatchObject({
      enabled: true,
      helperState: "ready",
      activationState: "active",
      controlState: "connected",
      directState: "direct",
      trustedDeviceCount: 1,
      lastDirectAt: "100",
      lastErrorCode: null
    });
    expect(await remote.isAuthorized(principal("travel-mac", "7"))).toBe(true);
    expect(await remote.isAuthorized(principal("travel-mac", "6"))).toBe(false);
  });

  it("attaches the request bridge before startup and reconnects only the direct runtime", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);
    const bridge = { close: () => undefined } as never;

    remote.attachRequestBridge(bridge);
    expect(supervisor.attachedBridge).toBe(bridge);
    await remote.start();
    await remote.reconnect();

    expect(supervisor.startCalls).toBe(1);
    expect(supervisor.startRuntimeCalls).toBe(1);
    expect(supervisor.reconnectRuntimeCalls).toBe(1);
    expect(supervisor.reconnectCalls).toBe(0);
  });

  it("fails remote startup on non-loopback bind or an active custom dashboard", async () => {
    const firstRoot = await makeRoot();
    await enableRemoteAccess(firstRoot);
    const firstSupervisor = new FakeSupervisor();
    const exposed = service(firstRoot, firstSupervisor, { effectiveHost: "0.0.0.0" });
    await exposed.start();
    expect(firstSupervisor.startCalls).toBe(0);
    expect(exposed.getRuntimeSummary()).toMatchObject({
      enabled: true,
      helperState: "failed",
      lastErrorCode: "bind_not_loopback"
    });

    const secondRoot = await makeRoot();
    await enableRemoteAccess(secondRoot);
    const secondSupervisor = new FakeSupervisor();
    const custom = service(secondRoot, secondSupervisor, { dashboardSource: "custom" });
    await custom.start();
    expect(secondSupervisor.startCalls).toBe(0);
    expect(custom.getRuntimeSummary()).toMatchObject({
      helperState: "failed",
      lastErrorCode: "custom_dashboard_unsupported"
    });
  });

  it("preserves a direct path when coordination is temporarily unavailable", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeSupervisor(supervisorSnapshot({
      runtimeStatus: runtimeStatus({ directState: "direct", lastDirectAt: "100" as never })
    }));
    const remote = service(root, supervisor);
    const events: string[] = [];
    remote.subscribe((summary) => events.push(
      `${summary.controlState}:${summary.directState}:${summary.lastErrorCode ?? "none"}`
    ));
    await remote.start();

    supervisor.emit(supervisorSnapshot({
      runtimeStatus: runtimeStatus({
        controlState: "unavailable",
        directState: "direct",
        lastDirectAt: "100" as never,
        lastErrorCode: "coordination_unavailable"
      }),
      lastErrorCode: "coordination_unavailable"
    }));

    expect(remote.getRuntimeSummary()).toMatchObject({
      controlState: "unavailable",
      directState: "direct",
      lastDirectAt: "100",
      lastErrorCode: "coordination_unavailable"
    });
    expect(events).toContain("unavailable:direct:coordination_unavailable");
  });

  it("delegates strict pairing and trusted-device management to the authenticated helper", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);
    await remote.start();
    const actor = {
      kind: "local" as const,
      stableId: "local" as const,
      hostServerLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x32).toString("base64url")
    };
    const requestActor = { kind: "local" as const, stableId: "local" as const };

    await expect(remote.createInvitation(
      actor,
      Buffer.alloc(32, 0x33).toString("base64url")
    )).resolves.toMatchObject({ shortCode: "01AB-CDEF" });
    await expect(remote.listPairingRequests(requestActor))
      .resolves.toEqual({ version: 1, requests: [] });
    await expect(remote.cancelInvitation(
      Buffer.alloc(16, 0x41).toString("base64url"),
      actor
    )).resolves.toBeUndefined();
    const pairingRequestId = Buffer.alloc(16, 0x45).toString("base64url");
    const approval = {
      invitationGeneration: "1",
      remoteIdentityBundleHash: Buffer.alloc(32, 0x24).toString("base64url"),
      transcriptHash: Buffer.alloc(32, 0x25).toString("base64url"),
      channelBinding: Buffer.alloc(32, 0x26).toString("base64url"),
      sasIndices: [1, 23, 456, 789, 1023] as [number, number, number, number, number],
      sasFingerprint: "a1b2c3d4e5f6"
    };
    await expect(remote.approvePairingRequest(pairingRequestId, approval, actor))
      .resolves.toBeUndefined();
    await expect(remote.rejectPairingRequest(pairingRequestId, requestActor))
      .resolves.toBeUndefined();
    await expect(remote.listDevices()).resolves.toEqual({ version: 1, devices: [] });
    await expect(remote.renameDevice(
      "travel-mac",
      { revision: "1", displayName: "Travel Laptop" },
      requestActor
    )).resolves.toMatchObject({ displayName: "Travel Laptop", revision: "2" });
    supervisor.devices = [{
      version: 1,
      deviceId: "travel-mac",
      displayName: "Travel Laptop",
      platform: { os: "darwin", arch: "arm64" },
      installationFingerprint: Buffer.alloc(16, 0x42).toString("base64url"),
      trustEpoch: "7",
      revision: "2",
      pairedAt: "1786000000",
      lastSeenAt: "1786270800",
      connectionState: "direct"
    }];
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    const revocation = await remote.revokeDevice("travel-mac", { revision: "2" }, actor);
    expect(supervisor.managementCalls.at(-1)?.command).toBe("trusted_devices_list");
    await remote.finishDeviceRevocation(revocation);

    expect(supervisor.managementCalls.map((call) => call.command)).toEqual([
      "invitation_create",
      "pairing_requests_list",
      "invitation_cancel",
      "pairing_request_approve",
      "pairing_request_reject",
      "trusted_devices_list",
      "trusted_device_rename",
      "trusted_devices_list",
      "trusted_device_revoke_reconcile"
    ]);
  });

  it("denies locally before publishing one invalidation and asking the helper to converge", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    const supervisor = new FakeSupervisor();
    supervisor.devices = [{
      version: 1,
      deviceId: "travel-mac",
      displayName: "Travel Laptop",
      platform: { os: "darwin", arch: "arm64" },
      installationFingerprint: Buffer.alloc(16, 0x42).toString("base64url"),
      trustEpoch: "7",
      revision: "2",
      pairedAt: "1786000000",
      lastSeenAt: "1786270800",
      connectionState: "direct"
    }];
    const remote = service(root, supervisor);
    await remote.start();
    const invalidations: unknown[] = [];
    remote.subscribeInvalidations((event) => invalidations.push(event));
    const actor = {
      kind: "local" as const,
      stableId: "local" as const,
      hostServerLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x32).toString("base64url")
    };

    const revocation = await remote.revokeDevice("travel-mac", { revision: "2" }, actor);

    expect(await remote.isAuthorized(principal("travel-mac", "7"))).toBe(false);
    expect(supervisor.managementCalls.map((call) => call.command)).toEqual([
      "trusted_devices_list"
    ]);
    expect(invalidations).toEqual([]);

    await remote.finishDeviceRevocation(revocation);
    await remote.finishDeviceRevocation(revocation);

    expect(invalidations).toEqual([{
      version: 1,
      kind: "device_trust_revoked",
      stableId: "remote:travel-mac",
      deviceId: "travel-mac",
      trustEpoch: "7",
      denyEpoch: "8"
    }]);
    expect(supervisor.managementCalls.map((call) => call.command)).toEqual([
      "trusted_devices_list",
      "trusted_device_revoke_reconcile"
    ]);
  });

  it("resumes helper revocation from the durable local cutoff after restart", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    await new RemoteAccessStateStore(root).denyDevice("travel-mac", "7", 100n);
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);

    await remote.start();

    expect(await remote.isAuthorized(principal("travel-mac", "7"))).toBe(false);
    expect(supervisor.managementCalls).toContainEqual({
      command: "trusted_device_revoke_reconcile",
      input: [{
        deviceId: "travel-mac",
        pairId: Buffer.alloc(16, 0x51).toString("base64url"),
        deniedTrustEpoch: "7",
        denyEpoch: "8"
      }]
    });
  });

  it("stays ready after one coalesced recovery failure and retries on the next ready snapshot", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    await new RemoteAccessStateStore(root).denyDevice("travel-mac", "7", 100n);
    const supervisor = new FakeSupervisor();
    supervisor.reconcileError = new Error("helper temporarily unavailable");
    const remote = service(root, supervisor);

    await remote.start();

    expect(remote.getRuntimeSummary()).toMatchObject({
      enabled: true,
      helperState: "ready",
      controlState: "connected"
    });
    expect(await remote.isAuthorized(principal("travel-mac", "7"))).toBe(false);
    expect(supervisor.managementCalls.filter(
      (call) => call.command === "trusted_device_revoke_reconcile"
    )).toHaveLength(1);

    supervisor.reconcileError = undefined;
    supervisor.emit(supervisorSnapshot());
    await expect.poll(() => supervisor.managementCalls.filter(
      (call) => call.command === "trusted_device_revoke_reconcile"
    ).length).toBe(2);
  });

  it("rechecks a remote administrative actor against current trust before helper delegation", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root, { deviceId: "travel-mac", trustEpoch: "7" });
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);
    await remote.start();
    const actor = {
      kind: "remote_device" as const,
      stableId: "remote:travel-mac" as const,
      deviceId: "travel-mac",
      trustEpoch: "7",
      gatewayLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x32).toString("base64url")
    };
    const paths = remoteStatePaths(root);
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "8",
      resetTombstone: "0",
      pairs: []
    });

    await expect(remote.createInvitation(
      actor,
      Buffer.alloc(32, 0x33).toString("base64url")
    )).rejects.toBeInstanceOf(RemoteAccessActorUnauthorizedError);
    expect(supervisor.managementCalls).toEqual([]);
  });

  it("keeps trust authorization isolated by data root and rechecks revocation", async () => {
    const firstRoot = await makeRoot();
    const secondRoot = await makeRoot();
    await enableRemoteAccess(firstRoot, { deviceId: "first-mac", trustEpoch: "7" });
    await enableRemoteAccess(secondRoot, { deviceId: "second-mac", trustEpoch: "9" });
    const first = service(firstRoot, new FakeSupervisor());
    const second = service(secondRoot, new FakeSupervisor());
    await Promise.all([first.start(), second.start()]);

    expect(await first.isAuthorized(principal("first-mac", "7"))).toBe(true);
    expect(await first.isAuthorized(principal("second-mac", "9"))).toBe(false);
    expect(await second.isAuthorized(principal("second-mac", "9"))).toBe(true);

    const firstPaths = remoteStatePaths(firstRoot);
    await writeJson(firstPaths.trustIndex, {
      version: 1,
      trustEpochHighWater: "8",
      resetTombstone: "0",
      pairs: []
    });
    expect(await first.isAuthorized(principal("first-mac", "7"))).toBe(false);
  });

  it("fails closed without taking down the service when state needs repair", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    await writeFile(paths.hostConfig, "{not-json\n", { mode: 0o600 });
    const supervisor = new FakeSupervisor();
    const remote = service(root, supervisor);

    await expect(remote.start()).resolves.toBeUndefined();
    expect(supervisor.startCalls).toBe(0);
    expect(remote.getRuntimeSummary()).toEqual({
      version: 1,
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      trustedDeviceCount: 0,
      lastDirectAt: null,
      lastErrorCode: "repair_required"
    });
    expect(await remote.isAuthorized(principal("travel-mac", "7"))).toBe(false);
  });

  it("degrades remote access when the supervisor itself rejects startup", async () => {
    const root = await makeRoot();
    await enableRemoteAccess(root);
    const supervisor = new FakeSupervisor();
    supervisor.startError = Object.assign(new Error("helper launch failed"), {
      code: "helper_missing"
    });
    const remote = service(root, supervisor);

    await expect(remote.start()).resolves.toBeUndefined();
    expect(remote.getRuntimeSummary()).toMatchObject({
      enabled: true,
      helperState: "failed",
      controlState: "unavailable",
      directState: "direct_unavailable",
      lastErrorCode: "helper_missing"
    });
  });
});
