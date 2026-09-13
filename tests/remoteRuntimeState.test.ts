import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { RuntimeStateSchema } from "../src/backend/runtime.js";
import {
  RemoteDaemonStateSchema,
  createRemoteDaemonState
} from "../src/shared/schemas/remoteRuntime.js";
import { remoteRolePaths, remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const hostId = Buffer.alloc(32, 0x61).toString("base64url");
const isolatedHostname = `waifus-${"a".repeat(52)}.localhost`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("role-separated remote paths", () => {
  it("keeps host and remote persistent, runtime, endpoint, lock, and log paths disjoint", async () => {
    const root = await makeTempRoot("waifus-remote-paths-");
    roots.push(root);
    const host = remoteRolePaths(root, "host");
    const remote = remoteRolePaths(root, "remote");
    expect(remoteStatePaths(root).remoteOriginState).toBe(
      path.join(root, "app", "remote-gateway", "origins-v1.json")
    );

    expect(host).toMatchObject({
      role: "host",
      stateRoot: path.join(root, "app", "remote-access"),
      helperRoleState: path.join(root, "app", "remote-access", "helper-role-v1.json"),
      helperRoleLock: path.join(root, "app", "remote-access", ".helper.lock"),
      runtimeRoot: path.join(root, "app", "tmp", "remote-host"),
      runtimePid: path.join(root, "app", "tmp", "remote-host", "pid.json"),
      runtimeState: path.join(root, "app", "tmp", "remote-host", "runtime.json"),
      runtimeLock: path.join(root, "app", "tmp", "remote-host", "daemon.lock"),
      parentEndpoint: path.join(root, "app", "tmp", "remote-host", "p"),
      log: path.join(root, "app", "logs", "remote-host.log")
    });
    expect(remote).toMatchObject({
      role: "remote",
      stateRoot: path.join(root, "app", "remote-gateway"),
      helperRoleState: path.join(root, "app", "remote-gateway", "helper-role-v1.json"),
      helperRoleLock: path.join(root, "app", "remote-gateway", ".helper.lock"),
      runtimeRoot: path.join(root, "app", "tmp", "remote-gateway"),
      runtimePid: path.join(root, "app", "tmp", "remote-gateway", "pid.json"),
      runtimeState: path.join(root, "app", "tmp", "remote-gateway", "runtime.json"),
      runtimeLock: path.join(root, "app", "tmp", "remote-gateway", "daemon.lock"),
      parentEndpoint: path.join(root, "app", "tmp", "remote-gateway", "p"),
      log: path.join(root, "app", "logs", "remote-gateway.log")
    });

    const hostOwned = new Set(Object.values(host).filter((value) => typeof value === "string"));
    const remoteOwned = Object.values(remote).filter((value) => typeof value === "string");
    expect(remoteOwned.filter((value) => hostOwned.has(value))).toEqual([]);
    expect(Object.values(remoteStatePaths(root))).not.toContain(path.join(root, "app", "remote"));
  });
});

describe("remote-only data layout", () => {
  it("creates shared identity and remote runtime roots without Discord user state", async () => {
    const root = await makeTempRoot("waifus-remote-layout-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const shared = remoteStatePaths(root);
    const remote = remoteRolePaths(root, "remote");

    for (const directory of [
      shared.hostStateRoot,
      shared.trustRoot,
      shared.operationsRoot,
      shared.auditRoot,
      shared.remoteGatewayStateRoot,
      shared.dashboardCacheRoot,
      remote.runtimeRoot,
      path.dirname(remote.log)
    ]) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    await expect(access(path.join(root, "user"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(root, "config.toml"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(remoteRolePaths(root, "host").runtimeRoot))
      .rejects.toMatchObject({ code: "ENOENT" });

    expect(JSON.parse(await readFile(shared.installation, "utf8"))).toMatchObject({
      version: 1,
      activationReference: null
    });
    expect(JSON.parse(await readFile(shared.trustIndex, "utf8"))).toEqual({
      version: 1,
      trustEpochHighWater: "0",
      resetTombstone: "0",
      pairs: []
    });
  });
});

describe("remote daemon runtime state", () => {
  function validState() {
    return createRemoteDaemonState({
      pid: 4242,
      startedAt: "2026-09-13T06:00:00.000Z",
      packageVersion: "1.5.203",
      port: 43123,
      dataRoot: "/tmp/waifus-remote",
      mode: "remote",
      connectionShellOrigin: `http://${isolatedHostname}:43123`,
      helperVersion: "0.1.0",
      helperReleaseSequence: "42",
      protocol: { major: 1, minor: 0 },
      capabilities: ["waifus.http.v1"],
      helperState: "ready",
      activationState: "active",
      controlState: "connected",
      directState: "reconnecting",
      rememberedHostCount: 1,
      selectionState: "automatic_single",
      selectedHostId: hostId,
      lastDirectAt: null,
      lastErrorCode: null
    });
  }

  it("accepts only sanitized process, helper, and selected-host state", () => {
    const state = validState();
    expect(RemoteDaemonStateSchema.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      kind: "remote_gateway",
      port: 43123,
      selectedHostId: hostId
    });
    for (const forbidden of [
      { gatewayLaunchId: Buffer.alloc(32, 0x62).toString("base64url") },
      { browserSessionId: Buffer.alloc(32, 0x63).toString("base64url") },
      { csrfToken: Buffer.alloc(32, 0x64).toString("base64url") },
      { helperSocketPath: "/tmp/private.sock" },
      { endpoints: ["192.0.2.1:1234"] }
    ]) {
      expect(RemoteDaemonStateSchema.safeParse({ ...state, ...forbidden }).success).toBe(false);
    }
  });

  it("binds the origin port and selected-host state consistently", () => {
    const state = validState();
    expect(() => RemoteDaemonStateSchema.safeParse({
      ...state,
      connectionShellOrigin: "not-an-origin"
    })).not.toThrow();
    expect(RemoteDaemonStateSchema.safeParse({
      ...state,
      connectionShellOrigin: "not-an-origin"
    }).success).toBe(false);
    expect(RemoteDaemonStateSchema.safeParse({
      ...state,
      connectionShellOrigin: `http://${isolatedHostname}:43124`
    }).success).toBe(false);
    expect(RemoteDaemonStateSchema.safeParse({
      ...state,
      rememberedHostCount: 0,
      selectionState: "no_hosts",
      selectedHostId: null,
      directState: "inactive"
    }).success).toBe(true);
    expect(RemoteDaemonStateSchema.safeParse({
      ...state,
      selectedHostId: null
    }).success).toBe(false);
  });

  it("coexists with a host runtime schema without folding either role into the other", () => {
    const now = "2026-09-13T06:00:00.000Z";
    expect(RuntimeStateSchema.safeParse({
      schemaVersion: 2,
      pid: 4241,
      startedAt: now,
      updatedAt: now,
      packageVersion: "1.5.203",
      port: 3888,
      dataRoot: "/tmp/waifus-remote",
      mode: "start",
      paused: false,
      discord: {
        connected: false,
        orchestratorConnected: false,
        waifuBotCount: 0,
        warnings: []
      },
      queues: { active: 0, configuredGuilds: 0 }
    }).success).toBe(true);
    expect(RemoteDaemonStateSchema.safeParse(validState()).success).toBe(true);
  });
});
