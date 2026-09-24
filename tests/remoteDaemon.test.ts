import { access, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/cli/commands.js";
import { parseCliArgs } from "../src/cli/parser.js";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { startRemoteGatewayDaemon, type RunningRemoteGatewayDaemon } from "../src/remote/daemon.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";
import { remoteRolePaths } from "../src/remote/paths.js";
import { RememberedHostStore, type RememberedHostRecordV1 } from "../src/remote/rememberedHosts.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const daemons: RunningRemoteGatewayDaemon[] = [];

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function host(value: number, displayName = `Host ${value}`): RememberedHostRecordV1 {
  const installationPublicKey = Buffer.alloc(32, value).toString("base64url");
  return {
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(installationPublicKey, "base64url")),
    helperPairId: Buffer.alloc(16, value).toString("base64url"),
    displayName,
    platform: { os: "darwin", arch: "arm64" },
    installationPublicKey,
    installationFingerprint: Buffer.alloc(16, value).toString("base64url"),
    trustEpoch: "1",
    revision: "1",
    pairedAt: "1786270800",
    lastSeenAt: null,
    lastDirectAt: null,
    connectionState: "offline",
    lastErrorCode: null
  };
}

function fakeSupervisor(activationState: "active" | "activation_required" = "active") {
  const listeners = new Set<() => void>();
  let currentActivationState = activationState;
  let directState: "inactive" | "direct" = "inactive";
  const startRuntime = vi.fn(async () => {
    directState = "direct";
    return {};
  });
  const close = vi.fn(async () => undefined);
  return {
    supervisor: {
      start: vi.fn(async () => undefined),
      close,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => ({
        state: "ready",
        helperVersion: "0.1.0",
        releaseSequence: "1",
        protocol: { major: 1, minor: 0 },
        capabilities: ["waifus.http.v1"],
        target: { os: "darwin", arch: "arm64" },
        runtimeStatus: {
          activationState: currentActivationState,
          controlState: "connected",
          directState,
          lastDirectAt: null,
          lastErrorCode: null
        },
        lastErrorCode: null
      }),
      startRuntime,
      stopRuntime: vi.fn(async () => { directState = "inactive"; }),
      requestSignedSelfRevocation: vi.fn(async () => false),
      forgetRememberedHost: vi.fn(async () => undefined),
      registerGatewayLaunch: vi.fn(async () => undefined),
      request: vi.fn(async () => { throw new Error("not needed"); })
    },
    startRuntime,
    close,
    setActivationState: (next: "active" | "activation_required") => {
      currentActivationState = next;
      for (const listener of listeners) listener();
    }
  };
}

async function root(): Promise<string> {
  const dataRoot = await makeTempRoot("waifus-remote-daemon-");
  roots.push(dataRoot);
  await ensureRemoteOnlyLayout(dataRoot);
  return dataRoot;
}

describe("remote gateway daemon", () => {
  it("starts an owner-only shell, publishes sanitized state, and closes only its own process state", async () => {
    const dataRoot = await root();
    const fake = fakeSupervisor();
    const daemon = await startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: fake.supervisor as never
    });
    daemons.push(daemon);
    const paths = remoteRolePaths(dataRoot, "remote");
    expect(daemon.runtime).toMatchObject({
      pid: process.pid,
      dataRoot,
      helperState: "ready",
      selectionState: "no_hosts",
      selectedHostId: null,
      directState: "inactive"
    });
    expect(daemon.bootstrapUrl).toMatch(/^http:\/\/waifus-[a-z2-7]{52}\.localhost:[0-9]+\/_waifus_remote\/bootstrap\//u);
    expect(JSON.parse(await readFile(paths.runtimePid, "utf8"))).toEqual(daemon.runtime);
    expect(JSON.parse(await readFile(paths.runtimeState, "utf8"))).toEqual(daemon.runtime);
    await daemon.close();
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(access(paths.runtimePid)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(paths.startupHandoff)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await access(paths.runtimeState).then(() => true)).toBe(true);
  });

  it("auto-connects exactly one remembered host without persisting an explicit selection", async () => {
    const dataRoot = await root();
    const remembered = new RememberedHostStore(dataRoot);
    const target = host(0x31);
    await remembered.upsert(target);
    const fake = fakeSupervisor();
    const daemon = await startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: fake.supervisor as never
    });
    daemons.push(daemon);
    expect(fake.startRuntime).toHaveBeenCalledWith(target.helperPairId);
    expect(daemon.runtime).toMatchObject({
      selectionState: "automatic_single",
      selectedHostId: target.hostId,
      directState: "direct"
    });
    expect((await remembered.getState()).explicitSelectedHostId).toBeNull();
  });

  it("resolves an explicit host by unambiguous name and refreshes host-selection status", async () => {
    const dataRoot = await root();
    const remembered = new RememberedHostStore(dataRoot);
    const first = host(0x41, "First");
    const second = host(0x42, "Second");
    await remembered.upsert(first);
    await remembered.upsert(second);
    const fake = fakeSupervisor();
    const daemon = await startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: fake.supervisor as never,
      host: "Second"
    });
    daemons.push(daemon);
    expect(fake.startRuntime).toHaveBeenCalledWith(second.helperPairId);
    expect(daemon.runtime).toMatchObject({
      selectionState: "explicit",
      selectedHostId: second.hostId
    });
    expect((await remembered.getState()).explicitSelectedHostId).toBe(second.hostId);
    await remembered.remove(second.hostId, "1");
    const refreshed = await daemon.refreshState();
    expect(refreshed).toMatchObject({
      selectionState: "automatic_single",
      selectedHostId: first.hostId,
      rememberedHostCount: 1
    });
    expect(JSON.parse(await readFile(remoteRolePaths(dataRoot, "remote").runtimeState, "utf8")))
      .toEqual(refreshed);
  });

  it("rejects ambiguous host names without advertising a daemon", async () => {
    const dataRoot = await root();
    const remembered = new RememberedHostStore(dataRoot);
    await remembered.upsert(host(0x51, "Same"));
    await remembered.upsert(host(0x52, "Same"));
    const fake = fakeSupervisor();
    await expect(startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: fake.supervisor as never,
      host: "Same"
    })).rejects.toThrow(/ambiguous/u);
    expect(fake.close).toHaveBeenCalledTimes(1);
    await expect(access(remoteRolePaths(dataRoot, "remote").runtimePid))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the activation shell available before the helper can connect", async () => {
    const dataRoot = await root();
    const remembered = new RememberedHostStore(dataRoot);
    const target = host(0x61);
    await remembered.upsert(target);
    const fake = fakeSupervisor("activation_required");
    const daemon = await startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: fake.supervisor as never
    });
    daemons.push(daemon);
    expect(fake.startRuntime).not.toHaveBeenCalled();
    expect(daemon.runtime).toMatchObject({
      activationState: "activation_required",
      selectionState: "automatic_single",
      directState: "inactive"
    });
    fake.setActivationState("active");
    const refreshed = await daemon.refreshState();
    expect(fake.startRuntime).toHaveBeenCalledWith(target.helperPairId);
    expect(refreshed).toMatchObject({ activationState: "active", directState: "direct" });
  });

  it("does not let a second remote daemon take the same data root", async () => {
    const dataRoot = await root();
    const firstFake = fakeSupervisor();
    const first = await startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: firstFake.supervisor as never
    });
    daemons.push(first);
    const secondFake = fakeSupervisor();
    await expect(startRemoteGatewayDaemon({
      dataRoot,
      appVersion: "1.5.203",
      deviceDisplayName: "Remote device",
      supervisor: secondFake.supervisor as never
    })).rejects.toThrow(/already running/u);
    expect(secondFake.supervisor.start).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(remoteRolePaths(dataRoot, "remote").runtimePid, "utf8")))
      .toEqual(first.runtime);
  });

  it("runs the real gateway lifecycle behind the foreground CLI contract", async () => {
    const dataRoot = await root();
    const fake = fakeSupervisor();
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const code = await runCommand(parseCliArgs([
        "remote",
        "--foreground",
        "--no-open",
        "--data-root",
        dataRoot
      ]), {
        remotePreflight: async () => undefined,
        remoteForegroundStarter: async (input) => {
          const daemon = await startRemoteGatewayDaemon({
            ...input,
            appVersion: "1.5.203",
            deviceDisplayName: "Remote device",
            supervisor: fake.supervisor as never
          });
          daemons.push(daemon);
          return daemon;
        },
        remoteHoldOpen: async () => undefined
      });
      expect(code).toBe(0);
      expect(printed).toHaveBeenCalledWith(expect.stringContaining("waifus remote gateway running"));
      expect(JSON.parse(await readFile(remoteRolePaths(dataRoot, "remote").runtimePid, "utf8")))
        .toMatchObject({ pid: process.pid, kind: "remote_gateway" });
    } finally {
      printed.mockRestore();
    }
  });
});
