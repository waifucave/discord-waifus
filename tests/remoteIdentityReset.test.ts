import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdentityResetSiblingDaemonRunningError,
  IdentityResetStateError,
  IdentityResetState
} from "../src/backend/remoteAccess/identityResetState.js";
import { RemoteAccessStateStore } from "../src/backend/remoteAccess/stateStore.js";
import {
  RemoteAccessService,
  type HelperSupervisorController
} from "../src/backend/remoteAccess/remoteAccessService.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteRolePaths, remoteStatePaths } from "../src/remote/paths.js";
import { createRemoteDaemonState } from "../src/shared/schemas/remoteRuntime.js";
import type { IdentityResetReceiptV1 } from "../src/shared/schemas/remoteAccess.js";
import type {
  HelperIdentityStatus,
  HelperRuntimeStatus,
  HelperSupervisorSnapshot
} from "../src/remote/helperTypes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function makeRoot(): Promise<string> {
  const root = await makeTempRoot("waifus-identity-reset-");
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function completeReceipt(tombstone = "8"): IdentityResetReceiptV1 {
  return {
    version: 1,
    resetTombstone: tombstone,
    resetId: Buffer.alloc(16, 0x41).toString("base64url"),
    oldInstallationPublicKey: Buffer.alloc(32, 0x42).toString("base64url"),
    newInstallationPublicKey: Buffer.alloc(32, 0x43).toString("base64url"),
    oldFingerprint: Buffer.alloc(16, 0x44).toString("base64url"),
    newFingerprint: Buffer.alloc(16, 0x45).toString("base64url"),
    clearedActivationCount: "1",
    clearedPairCount: "2",
    clearedHostRoleSecretCount: "3",
    clearedRemoteRoleSecretCount: "4",
    stage: "complete",
    completedAt: "101"
  };
}

function incompleteReceipt(
  stage: "prepared" | "old_state_cleared" | "new_identity_committed" = "prepared",
  tombstone = "8"
): IdentityResetReceiptV1 {
  const receipt = completeReceipt(tombstone);
  return {
    version: receipt.version,
    resetTombstone: receipt.resetTombstone,
    resetId: receipt.resetId,
    oldInstallationPublicKey: receipt.oldInstallationPublicKey,
    newInstallationPublicKey: receipt.newInstallationPublicKey,
    oldFingerprint: receipt.oldFingerprint,
    newFingerprint: receipt.newFingerprint,
    clearedActivationCount: receipt.clearedActivationCount,
    clearedPairCount: receipt.clearedPairCount,
    clearedHostRoleSecretCount: receipt.clearedHostRoleSecretCount,
    clearedRemoteRoleSecretCount: receipt.clearedRemoteRoleSecretCount,
    stage
  };
}

function helperRuntimeStatus(): HelperRuntimeStatus {
  return {
    activationState: "active",
    controlState: "connected",
    directState: "direct",
    lastDirectAt: "99" as never,
    lastErrorCode: null
  };
}

function helperSnapshot(): HelperSupervisorSnapshot {
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
    runtimeStatus: helperRuntimeStatus(),
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  };
}

function replacementIdentity(): HelperIdentityStatus {
  return {
    activationState: "activation_required",
    deviceId: "replacement-host-device",
    installationFingerprint: Buffer.alloc(16, 0x45).toString("base64url"),
    secretStorage: "keychain"
  };
}

function runtime(root: string) {
  return createRuntimeState({
    pid: process.pid,
    startedAt: "2026-08-06T00:00:00.000Z",
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

class ResetSupervisor {
  readonly resetIdentity = vi.fn(async () => completeReceipt());
  readonly getResetStatus = vi.fn(async () => completeReceipt());
  readonly stop = vi.fn(async () => undefined);
  readonly start = vi.fn(async () => undefined);
  readonly startRuntime = vi.fn(async () => helperRuntimeStatus());
  readonly cancelActivation = vi.fn(async () => ({
    operationId: Buffer.alloc(32, 0x11).toString("base64url") as never,
    cancelled: true as const
  }));
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();
  identity: HelperIdentityStatus | null = {
    activationState: "active",
    deviceId: "host-device-01",
    installationFingerprint: Buffer.alloc(16, 0x44).toString("base64url"),
    secretStorage: "keychain"
  };

  snapshot(): HelperSupervisorSnapshot {
    return helperSnapshot();
  }

  identityStatus(): HelperIdentityStatus | null {
    return this.identity;
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  attachRequestBridge(): void {}
  async reconnect(): Promise<void> {}
  async runtimeStatus(): Promise<HelperRuntimeStatus> { return helperRuntimeStatus(); }
  async reconnectRuntime(): Promise<HelperRuntimeStatus> { return helperRuntimeStatus(); }
  async stopRuntime(): Promise<HelperRuntimeStatus> { return helperRuntimeStatus(); }
  async registerGatewayLaunch(): Promise<void> {}
  async beginActivation(): Promise<never> { throw new Error("unused"); }
  async pollActivation(): Promise<never> { throw new Error("unused"); }
  async close(): Promise<void> {}
}

async function writeEnabledResetFixture(root: string): Promise<void> {
  const paths = remoteStatePaths(root);
  const installation = await readJson(paths.installation) as Record<string, unknown>;
  await writeJson(paths.installation, {
    ...installation,
    activationReference: `waifus.activation.v1.${String(installation.installationId)}`
  });
  await writeJson(paths.hostConfig, {
    revision: "1",
    enabled: true,
    displayName: "Reset host",
    updatedAt: "90"
  });
  await writeJson(paths.trustIndex, {
    version: 1,
    trustEpochHighWater: "7",
    resetTombstone: "0",
    pairs: [{
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x51).toString("base64url"),
      trustEpoch: "7"
    }]
  });
}

async function writeHelperResetResult(root: string): Promise<void> {
  const paths = remoteStatePaths(root);
  const installationId = Buffer.alloc(16, 0x61).toString("base64url");
  await writeJson(paths.installation, {
    version: 1,
    installationId,
    vaultLabel: `waifus.installation.v1.${installationId}`,
    activationReference: null,
    createdAt: "101"
  });
  await writeJson(paths.trustIndex, {
    version: 1,
    trustEpochHighWater: "8",
    resetTombstone: "8",
    pairs: []
  });
}

function resetService(
  root: string,
  supervisor: ResetSupervisor,
  identityReset = new IdentityResetState(root, { processIsAlive: () => false })
): RemoteAccessService {
  return new RemoteAccessService({
    dataRoot: root,
    runtime: runtime(root),
    effectiveHost: "127.0.0.1",
    dashboard: { path: path.join(root, "dashboard"), source: "bundled", buildId: "a".repeat(64) },
    supervisor: supervisor as unknown as HelperSupervisorController,
    identityResetState: identityReset,
    now: () => 100
  });
}

describe("data-root identity reset state", () => {
  it("rejects a live remote gateway before changing any reset sentinel", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    const remotePaths = remoteRolePaths(root, "remote");
    const before = {
      config: await readFile(paths.hostConfig, "utf8"),
      installation: await readFile(paths.installation, "utf8"),
      trust: await readFile(paths.trustIndex, "utf8"),
      deny: await readFile(paths.localDenyIndex, "utf8")
    };
    await writeJson(remotePaths.runtimePid, createRemoteDaemonState({
      pid: 4242,
      startedAt: "2026-08-06T00:00:00.000Z",
      packageVersion: "1.5.203",
      port: 3988,
      dataRoot: root,
      mode: "test",
      connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:3988`,
      helperVersion: null,
      helperReleaseSequence: null,
      protocol: { major: 1, minor: 0 },
      capabilities: [],
      helperState: "disabled",
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      rememberedHostCount: 0,
      selectionState: "no_hosts",
      selectedHostId: null,
      lastDirectAt: null,
      lastErrorCode: null
    }));
    const reset = new IdentityResetState(root, { processIsAlive: (pid) => pid === 4242 });

    await expect(reset.assertNoLiveRemoteSibling())
      .rejects.toBeInstanceOf(IdentityResetSiblingDaemonRunningError);
    await expect(readFile(paths.resetTombstone, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(paths.hostConfig, "utf8")).toBe(before.config);
    expect(await readFile(paths.installation, "utf8")).toBe(before.installation);
    expect(await readFile(paths.trustIndex, "utf8")).toBe(before.trust);
    expect(await readFile(paths.localDenyIndex, "utf8")).toBe(before.deny);
  });

  it("persists a fail-closed tombstone and clears only old Node-owned state after receipt", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    const remotePaths = remoteRolePaths(root, "remote");
    const oldFingerprint = Buffer.alloc(16, 0x44).toString("base64url");
    const firstPair = {
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x51).toString("base64url"),
      trustEpoch: "7"
    };
    const secondPair = {
      deviceId: "studio-pc",
      pairId: Buffer.alloc(16, 0x52).toString("base64url"),
      trustEpoch: "6"
    };
    await writeJson(paths.hostConfig, {
      revision: "4",
      enabled: true,
      displayName: "Old host name",
      updatedAt: "90"
    });
    const installation = await readJson(paths.installation) as Record<string, unknown>;
    await writeJson(paths.installation, {
      ...installation,
      activationReference: `waifus.activation.v1.${String(installation.installationId)}`
    });
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "7",
      resetTombstone: "3",
      pairs: [firstPair, secondPair]
    });
    await writeFile(path.join(paths.operationsRoot, "preserved"), "operation\n");
    await writeFile(path.join(paths.auditRoot, "preserved"), "audit\n");
    await writeJson(paths.remoteRememberedHosts, {
      version: 1,
      explicitSelectedHostId: null,
      hosts: []
    });
    await writeFile(paths.remoteOriginState, "old origin state\n", { mode: 0o600 });
    await writeFile(remotePaths.helperRoleState, "fresh helper role\n", { mode: 0o600 });
    await writeFile(path.join(paths.dashboardCacheRoot, "old.js"), "cached\n");

    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    const prepared = await reset.prepare(oldFingerprint, 100n);

    expect(prepared).toMatchObject({
      resetTombstone: "8",
      expectedOldFingerprint: oldFingerprint,
      pairs: [firstPair, secondPair]
    });
    expect(await readJson(paths.hostConfig)).toMatchObject({ enabled: false, revision: "5" });
    expect(await readJson(paths.trustIndex)).toMatchObject({
      trustEpochHighWater: "7",
      resetTombstone: "3",
      pairs: [firstPair, secondPair]
    });
    expect(await readJson(paths.localDenyIndex)).toEqual({
      version: 1,
      trustEpochHighWater: "8",
      devices: [secondPair, firstPair].map((pair) => ({
        deviceId: pair.deviceId,
        pairId: pair.pairId,
        deniedTrustEpoch: pair.trustEpoch,
        denyEpoch: "8",
        revokedAt: "100"
      }))
    });
    expect(await reset.load()).toMatchObject({
      stage: "reset_pending",
      resetTombstone: "8",
      receipt: null
    });

    const newInstallationId = Buffer.alloc(16, 0x61).toString("base64url");
    const newInstallation = {
      version: 1,
      installationId: newInstallationId,
      vaultLabel: `waifus.installation.v1.${newInstallationId}`,
      activationReference: null,
      createdAt: "101"
    };
    await writeJson(paths.installation, newInstallation);
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "8",
      resetTombstone: "8",
      pairs: []
    });
    const receipt = completeReceipt();
    await reset.markHelperComplete(receipt, 101n);
    // Simulate a crash after exact directory removal but before recreation/writes.
    await rm(paths.trustRoot, { recursive: true });
    await rm(paths.dashboardCacheRoot, { recursive: true });
    await reset.finalize(102n);

    expect(await readJson(paths.installation)).toEqual(newInstallation);
    expect(await readJson(paths.hostConfig)).toMatchObject({
      enabled: false,
      displayName: "Discord Waifus Host",
      updatedAt: "102"
    });
    expect(await readJson(paths.trustIndex)).toEqual({
      version: 1,
      trustEpochHighWater: "8",
      resetTombstone: "8",
      pairs: []
    });
    expect(await readJson(paths.localDenyIndex)).toEqual({
      version: 1,
      trustEpochHighWater: "8",
      devices: []
    });
    expect(await readFile(remotePaths.helperRoleState, "utf8")).toBe("fresh helper role\n");
    await expect(readFile(paths.remoteRememberedHosts, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.remoteOriginState, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(paths.dashboardCacheRoot, "old.js"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(paths.operationsRoot, "preserved"), "utf8"))
      .toBe("operation\n");
    expect(await readFile(path.join(paths.auditRoot, "preserved"), "utf8")).toBe("audit\n");
    expect(await reset.load()).toMatchObject({
      stage: "complete",
      resetTombstone: "8",
      receipt
    });
  });

  it("denies old trust from the first tombstone write across a preparation crash", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    const pair = {
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x71).toString("base64url"),
      trustEpoch: "7"
    };
    const enabledConfig = {
      revision: "1",
      enabled: true,
      displayName: "Host",
      updatedAt: "90"
    };
    await writeJson(paths.hostConfig, enabledConfig);
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "7",
      resetTombstone: "0",
      pairs: [pair]
    });
    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    await reset.prepare(Buffer.alloc(16, 0x72).toString("base64url"), 100n);

    // Recreate the exact crash window after the tombstone commit but before the two fail-closed
    // convenience mirrors. The tombstone itself must remain authoritative.
    await writeJson(paths.hostConfig, enabledConfig);
    await writeJson(paths.localDenyIndex, {
      version: 1,
      trustEpochHighWater: "0",
      devices: []
    });

    expect(await new RemoteAccessStateStore(root).isAuthorized("travel-mac", "7")).toBe(false);
  });

  it("serializes authorization with the first reset tombstone mutation", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    const pair = {
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x73).toString("base64url"),
      trustEpoch: "7"
    };
    await writeJson(paths.hostConfig, {
      revision: "1",
      enabled: true,
      displayName: "Host",
      updatedAt: "90"
    });
    await writeJson(paths.trustIndex, {
      version: 1,
      trustEpochHighWater: "7",
      resetTombstone: "0",
      pairs: [pair]
    });
    const store = new RemoteAccessStateStore(root);
    const authorizedSnapshot = await store.load();
    let releaseAuthorization!: () => void;
    const authorizationReleased = new Promise<void>((resolve) => {
      releaseAuthorization = resolve;
    });
    let authorizationEntered!: () => void;
    const enteredAuthorization = new Promise<void>((resolve) => {
      authorizationEntered = resolve;
    });
    vi.spyOn(store, "load").mockImplementationOnce(async () => {
      authorizationEntered();
      await authorizationReleased;
      return authorizedSnapshot;
    });

    const authorization = store.isAuthorized(pair.deviceId, pair.trustEpoch);
    await enteredAuthorization;
    let resetPrepared = false;
    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    const preparation = reset
      .prepare(Buffer.alloc(16, 0x74).toString("base64url"), 100n)
      .then(() => {
        resetPrepared = true;
      });
    const preparationState = await Promise.race([
      preparation.then(() => "prepared" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100))
    ]);

    expect(preparationState).toBe("blocked");
    expect(resetPrepared).toBe(false);
    releaseAuthorization();
    await expect(authorization).resolves.toBe(true);
    await preparation;
    await expect(store.isAuthorized(pair.deviceId, pair.trustEpoch)).resolves.toBe(false);
  });

  it("serializes configuration mutation with the first reset tombstone mutation", async () => {
    const root = await makeRoot();
    const paths = remoteStatePaths(root);
    await writeJson(paths.hostConfig, {
      revision: "1",
      enabled: true,
      displayName: "Host",
      updatedAt: "90"
    });
    const store = new RemoteAccessStateStore(root);
    const current = await store.load();
    let releaseMutation!: () => void;
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    let mutationEntered!: () => void;
    const enteredMutation = new Promise<void>((resolve) => {
      mutationEntered = resolve;
    });
    vi.spyOn(store, "load").mockImplementationOnce(async () => {
      mutationEntered();
      await mutationReleased;
      return current;
    });

    const mutation = store.updateConfig({
      revision: "1",
      displayName: "Renamed before reset"
    }, 99n);
    await enteredMutation;
    let resetPrepared = false;
    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    const preparation = reset
      .prepare(Buffer.alloc(16, 0x75).toString("base64url"), 100n)
      .then(() => {
        resetPrepared = true;
      });
    const preparationState = await Promise.race([
      preparation.then(() => "prepared" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100))
    ]);

    expect(preparationState).toBe("blocked");
    expect(resetPrepared).toBe(false);
    releaseMutation();
    await expect(mutation).resolves.toMatchObject({
      config: { enabled: true, displayName: "Renamed before reset" }
    });
    await preparation;
    await expect(store.load()).resolves.toMatchObject({
      config: { revision: "3", enabled: false, displayName: "Renamed before reset" }
    });
  });

  it("rotates through the helper, invalidates every old actor, and finishes disabled", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const supervisor = new ResetSupervisor();
    supervisor.resetIdentity.mockImplementationOnce(async () => {
      await writeHelperResetResult(root);
      supervisor.identity = replacementIdentity();
      return completeReceipt();
    });
    const service = resetService(root, supervisor);
    const invalidations: unknown[] = [];
    const cancelDevice = vi.fn();
    service.subscribeInvalidations((event) => invalidations.push(event));
    service.attachRequestBridge({ cancelDevice, close: vi.fn() } as never);
    await service.start();

    await expect(service.resetIdentity()).resolves.toEqual(completeReceipt());

    expect(supervisor.resetIdentity).toHaveBeenCalledWith({
      resetTombstone: "8",
      expectedOldFingerprint: Buffer.alloc(16, 0x44).toString("base64url")
    });
    expect(invalidations).toEqual([expect.objectContaining({
      kind: "device_trust_revoked",
      deviceId: "travel-mac",
      trustEpoch: "7",
      denyEpoch: "8"
    })]);
    expect(cancelDevice).toHaveBeenCalledWith("travel-mac", expect.any(Error));
    expect(service.getRuntimeSummary()).toMatchObject({
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required",
      trustedDeviceCount: 0
    });
    expect(await new IdentityResetState(root).load()).toMatchObject({ stage: "complete" });
    await service.close();
  });

  it("publishes each reset invalidation only once when the exact reset is retried", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const supervisor = new ResetSupervisor();
    supervisor.resetIdentity
      .mockRejectedValueOnce(new Error("simulated helper interruption"))
      .mockImplementationOnce(async () => {
        await writeHelperResetResult(root);
        supervisor.identity = replacementIdentity();
        return completeReceipt();
      });
    const service = resetService(root, supervisor);
    const invalidations: unknown[] = [];
    const cancelDevice = vi.fn();
    service.subscribeInvalidations((event) => invalidations.push(event));
    service.attachRequestBridge({ cancelDevice, close: vi.fn() } as never);
    await service.start();

    await expect(service.resetIdentity()).rejects.toThrow("simulated helper interruption");
    await expect(service.resetIdentity()).resolves.toEqual(completeReceipt());

    expect(invalidations).toEqual([expect.objectContaining({
      kind: "device_trust_revoked",
      deviceId: "travel-mac",
      denyEpoch: "8"
    })]);
    expect(cancelDevice).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("keeps a helper available when resetting an already-disabled host", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const paths = remoteStatePaths(root);
    await writeJson(paths.hostConfig, {
      revision: "2",
      enabled: false,
      displayName: "Reset host",
      updatedAt: "91"
    });
    const supervisor = new ResetSupervisor();
    supervisor.identity = null;
    let running = false;
    let replacementCommitted = false;
    supervisor.start.mockImplementation(async () => {
      running = true;
      supervisor.identity = replacementCommitted
        ? replacementIdentity()
        : {
            activationState: "active",
            deviceId: "host-device-01",
            installationFingerprint: Buffer.alloc(16, 0x44).toString("base64url"),
            secretStorage: "keychain"
          };
    });
    supervisor.stop.mockImplementation(async () => {
      running = false;
      supervisor.identity = null;
    });
    supervisor.resetIdentity.mockImplementationOnce(async () => {
      expect(running).toBe(true);
      await writeHelperResetResult(root);
      replacementCommitted = true;
      running = false;
      supervisor.identity = null;
      return completeReceipt();
    });
    const service = resetService(root, supervisor);
    await service.start();

    await expect(service.resetIdentity()).resolves.toEqual(completeReceipt());

    expect(supervisor.start).toHaveBeenCalledTimes(3);
    expect(supervisor.resetIdentity).toHaveBeenCalledTimes(1);
    expect(await new IdentityResetState(root).load()).toMatchObject({ stage: "complete" });
    await service.close();
  });

  it("keeps reset pending when the fresh helper identity disagrees with its receipt", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const supervisor = new ResetSupervisor();
    supervisor.resetIdentity.mockImplementationOnce(async () => {
      await writeHelperResetResult(root);
      supervisor.identity = {
        activationState: "activation_required",
        deviceId: "replacement-host-device",
        installationFingerprint: Buffer.alloc(16, 0x46).toString("base64url"),
        secretStorage: "keychain"
      };
      return completeReceipt();
    });
    const service = resetService(root, supervisor);
    await service.start();

    await expect(service.resetIdentity()).rejects.toBeInstanceOf(IdentityResetStateError);

    expect(supervisor.start).toHaveBeenCalledTimes(3);
    expect(supervisor.stop).toHaveBeenCalled();
    expect(await new IdentityResetState(root).load()).toMatchObject({
      stage: "reset_pending",
      receipt: null
    });
    await service.close();
  });

  it("recovers an uncertain reset by querying the same tombstone before normal startup", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    await reset.prepare(Buffer.alloc(16, 0x44).toString("base64url"), 100n);
    await writeHelperResetResult(root);
    const supervisor = new ResetSupervisor();
    supervisor.identity = replacementIdentity();
    const service = resetService(root, supervisor, reset);

    await service.start();

    expect(supervisor.getResetStatus).toHaveBeenCalledWith({ resetTombstone: "8" });
    expect(supervisor.resetIdentity).not.toHaveBeenCalled();
    expect(supervisor.startRuntime).not.toHaveBeenCalled();
    expect(await reset.load()).toMatchObject({ stage: "complete", resetTombstone: "8" });
    expect(service.getRuntimeSummary()).toMatchObject({
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required"
    });
    await service.close();
  });

  it("resumes the exact helper reset when recovery finds an incomplete journal", async () => {
    const root = await makeRoot();
    await writeEnabledResetFixture(root);
    const reset = new IdentityResetState(root, { processIsAlive: () => false });
    await reset.prepare(Buffer.alloc(16, 0x44).toString("base64url"), 100n);
    const supervisor = new ResetSupervisor();
    supervisor.getResetStatus.mockResolvedValueOnce(incompleteReceipt());
    supervisor.resetIdentity.mockImplementationOnce(async () => {
      await writeHelperResetResult(root);
      supervisor.identity = replacementIdentity();
      return completeReceipt();
    });
    const service = resetService(root, supervisor, reset);

    await service.start();

    expect(supervisor.getResetStatus).toHaveBeenCalledWith({ resetTombstone: "8" });
    expect(supervisor.resetIdentity).toHaveBeenCalledWith({
      resetTombstone: "8",
      expectedOldFingerprint: Buffer.alloc(16, 0x44).toString("base64url")
    });
    expect(supervisor.startRuntime).not.toHaveBeenCalled();
    expect(await reset.load()).toMatchObject({
      stage: "complete",
      resetTombstone: "8",
      receipt: { stage: "complete", resetId: completeReceipt().resetId }
    });
    expect(service.getRuntimeSummary()).toMatchObject({
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required"
    });
    await service.close();
  });
});
