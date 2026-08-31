import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { RemoteAccessService } from "../src/backend/remoteAccess/remoteAccessService.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import type {
  HelperActivationCancel,
  HelperActivationPoll,
  HelperActivationStart,
  HelperIdentityStatus,
  HelperSupervisorSnapshot
} from "../src/remote/helperTypes.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const services: RemoteAccessService[] = [];
const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function browserHeaders() {
  return {
    host: "127.0.0.1:3888",
    origin: "http://127.0.0.1:3888",
    "sec-fetch-site": "same-origin"
  };
}

function readySnapshot(): HelperSupervisorSnapshot {
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
    runtimeStatus: {
      activationState: "active",
      controlState: "connected",
      directState: "inactive",
      lastDirectAt: null,
      lastErrorCode: null
    },
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  };
}

class ManagementSupervisor {
  startCalls = 0;
  stopCalls = 0;
  reconnectCalls = 0;
  closeCalls = 0;
  startError: Error | undefined;
  stopGate: Promise<void> | undefined;
  #snapshot: HelperSupervisorSnapshot = {
    ...readySnapshot(),
    state: "disabled",
    helperVersion: null,
    releaseSequence: null,
    forkCommit: null,
    target: null,
    protocol: null,
    capabilities: [],
    runtimeStatus: {
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      lastDirectAt: null,
      lastErrorCode: null
    }
  };
  #identity: HelperIdentityStatus | null = null;
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();

  snapshot(): HelperSupervisorSnapshot {
    return this.#snapshot;
  }

  identityStatus(): HelperIdentityStatus | null {
    return this.#identity ? structuredClone(this.#identity) : null;
  }

  subscribe(listener: (snapshot: HelperSupervisorSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#snapshot.state === "ready") return;
    this.startCalls += 1;
    if (this.startError) throw this.startError;
    this.#identity = {
      activationState: "active",
      deviceId: "host-device-01",
      installationFingerprint: bytes16(0x71) as never,
      secretStorage: "keychain"
    };
    this.#snapshot = readySnapshot();
    for (const listener of this.#listeners) listener(this.#snapshot);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    await this.stopGate;
    this.#snapshot = {
      ...this.#snapshot,
      state: "disabled",
      runtimeStatus: {
        ...this.#snapshot.runtimeStatus,
        controlState: "inactive",
        directState: "inactive"
      }
    };
  }

  async reconnect(): Promise<void> {
    this.reconnectCalls += 1;
  }

  async beginActivation(): Promise<HelperActivationStart> {
    throw new Error("Activation is not part of this management API test.");
  }

  async pollActivation(): Promise<HelperActivationPoll> {
    throw new Error("Activation is not part of this management API test.");
  }

  async cancelActivation(): Promise<HelperActivationCancel> {
    throw new Error("Activation is not part of this management API test.");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("request timed out")), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function makeHarness(options: {
  effectiveHost?: string;
  dashboardSource?: "bundled" | "custom";
} = {}) {
  const root = await makeTempRoot("waifus-remote-access-api-");
  roots.push(root);
  await ensureDataLayout(root);
  const paths = remoteStatePaths(root);
  const installation = JSON.parse(await readFile(paths.installation, "utf8")) as {
    installationId: string;
    [key: string]: unknown;
  };
  await writeFile(paths.installation, JSON.stringify({
    ...installation,
    activationReference: `waifus.activation.v1.${installation.installationId}`
  }, null, 2) + "\n", { mode: 0o600 });

  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date(1_786_270_800_000).toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const supervisor = new ManagementSupervisor();
  const remoteAccess = new RemoteAccessService({
    dataRoot: root,
    runtime,
    effectiveHost: options.effectiveHost ?? "127.0.0.1",
    dashboard: {
      path: path.join(root, "dashboard"),
      source: options.dashboardSource ?? "bundled",
      buildId: "a".repeat(64)
    },
    supervisor,
    now: () => 1_786_270_800
  });
  services.push(remoteAccess);
  await remoteAccess.start();
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    browserSecurity: { listenerHost: "127.0.0.1", port: 3888, mode: "test" },
    remoteTrust: { isAuthorized: () => true },
    remoteAccess
  });
  apps.push(app);
  const sessionResponse = await app.inject({
    method: "GET",
    url: "/api/client-context",
    headers: browserHeaders()
  });
  return {
    app,
    paths,
    supervisor,
    browser: {
      cookie: String(sessionResponse.headers["set-cookie"]),
      csrf: String(sessionResponse.headers["x-waifus-csrf"])
    }
  };
}

function remotePrincipal() {
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: "remote:travel-mac",
    deviceId: "travel-mac",
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(0x32),
    trustEpoch: "3"
  });
}

describe("host remote-access management API", () => {
  it("returns redacted status and diagnostics locally and to a trusted remote", async () => {
    const harness = await makeHarness();
    const local = await harness.app.inject({
      method: "GET",
      url: "/api/remote-access",
      headers: browserHeaders()
    });
    expect(local.statusCode).toBe(200);
    expect(local.json()).toMatchObject({
      version: 1,
      config: { revision: "0", enabled: false },
      identity: {
        deviceId: "host-device-01",
        installationFingerprint: bytes16(0x71)
      },
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helperVersion: "0.1.0",
      helperReleaseSequence: "42",
      helperState: "disabled",
      activationState: "active"
    });
    expect(harness.supervisor.startCalls).toBe(1);
    expect(harness.supervisor.stopCalls).toBe(1);

    const remote = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "GET",
      url: "/api/remote-access/diagnostics"
    });
    expect(remote.statusCode).toBe(200);
    expect(remote.json()).toMatchObject({
      version: 1,
      helper: { state: "disabled", secretStorage: "keychain" },
      stun: "unknown",
      udp: "unknown",
      portMapping: "unknown",
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    });
    expect(remote.body).not.toMatch(/endpoint|candidate|privateKey|certificate/iu);
    expect(harness.supervisor.startCalls).toBe(1);
  });

  it("adds only the sanitized remote section to the ordinary diagnostics bundle", async () => {
    const harness = await makeHarness();
    const response = await harness.app.inject({
      method: "GET",
      url: "/api/diagnostics/bundle",
      headers: browserHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().remoteAccess).toMatchObject({
      version: 1,
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    });
    expect(JSON.stringify(response.json().remoteAccess)).not.toMatch(
      /endpoint|candidate|socketPath|pairId|fullToken|certificate|privateKey/iu
    );
  });

  it("keeps the ordinary diagnostics bundle available when the helper cannot start", async () => {
    const harness = await makeHarness();
    harness.supervisor.startError = new Error("signed helper package is unavailable");

    const response = await harness.app.inject({
      method: "GET",
      url: "/api/diagnostics/bundle",
      headers: browserHeaders()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().remoteAccess).toMatchObject({
      version: 1,
      helper: {
        state: "disabled",
        version: null,
        releaseSequence: null,
        forkCommit: null,
        target: null,
        protocol: null,
        capabilities: [],
        secretStorage: null
      },
      lastErrorCode: "helper_unavailable"
    });
    expect(response.body).not.toContain("signed helper package is unavailable");
  });

  it("returns config for display-only writes and operation acknowledgements for lifecycle writes", async () => {
    const harness = await makeHarness();
    const headers = {
      ...browserHeaders(),
      cookie: harness.browser.cookie,
      "x-waifus-csrf": harness.browser.csrf
    };
    const renamed = await harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers,
      payload: { revision: "0", displayName: "Studio Host" }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      revision: "1",
      enabled: false,
      displayName: "Studio Host"
    });

    const enabled = await harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers,
      payload: { revision: "1", enabled: true }
    });
    expect(enabled.statusCode).toBe(202);
    expect(enabled.json()).toMatchObject({
      status: "accepted",
      statusUrl: expect.stringMatching(/^\/api\/admin\/operations\/[A-Za-z0-9_-]{43}$/u)
    });
    expect(JSON.parse(await readFile(harness.paths.hostConfig, "utf8"))).toMatchObject({
      revision: "2",
      enabled: true,
      displayName: "Studio Host"
    });

    const reconnect = await harness.app.inject({
      method: "POST",
      url: "/api/remote-access/reconnect",
      headers
    });
    expect(reconnect.statusCode).toBe(202);
    expect(reconnect.json()).toMatchObject({ status: "accepted" });
    expect(harness.supervisor.reconnectCalls).toBe(1);
  });

  it("flushes a disable acknowledgement before draining the helper connection", async () => {
    const harness = await makeHarness();
    const headers = {
      ...browserHeaders(),
      cookie: harness.browser.cookie,
      "x-waifus-csrf": harness.browser.csrf
    };
    expect((await harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers,
      payload: { revision: "0", enabled: true }
    })).statusCode).toBe(202);

    let releaseStop!: () => void;
    harness.supervisor.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const disabled = await within(harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers,
      payload: { revision: "1", enabled: false }
    }), 250);

    expect(disabled.statusCode).toBe(202);
    expect(disabled.json()).toMatchObject({ status: "accepted" });
    expect(harness.supervisor.stopCalls).toBe(1);
    releaseStop();
  });

  it("allows a trusted remote full-admin principal to update display settings", async () => {
    const harness = await makeHarness();
    const response = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "PUT",
      url: "/api/remote-access",
      headers: { "idempotency-key": bytes32(0x45) },
      payload: { revision: "0", displayName: "Remote Rename" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      revision: "1",
      displayName: "Remote Rename"
    });
  });

  it.each([
    {
      name: "non-loopback bind",
      options: { effectiveHost: "0.0.0.0" },
      error: "BindNotLoopback"
    },
    {
      name: "custom dashboard",
      options: { dashboardSource: "custom" as const },
      error: "CustomDashboardUnsupported"
    }
  ])("rejects enable before persistence for $name", async ({ options, error }) => {
    const harness = await makeHarness(options);
    const response = await harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers: {
        ...browserHeaders(),
        cookie: harness.browser.cookie,
        "x-waifus-csrf": harness.browser.csrf
      },
      payload: { revision: "0", enabled: true }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error });
    expect(JSON.parse(await readFile(harness.paths.hostConfig, "utf8"))).toMatchObject({
      revision: "0",
      enabled: false
    });
    expect(harness.supervisor.startCalls).toBe(0);
  });
});
