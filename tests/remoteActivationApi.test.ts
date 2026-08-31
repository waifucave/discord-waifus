import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { createRemoteRequestPrincipal } from "../src/api/requestPrincipal.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { RemoteAccessService } from "../src/backend/remoteAccess/remoteAccessService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import type {
  HelperActivationPoll,
  HelperActivationStart,
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
    runtimeStatus: {
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      lastDirectAt: null,
      lastErrorCode: null
    },
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  };
}

class ActivationSupervisor {
  startCalls = 0;
  stopCalls = 0;
  closeCalls = 0;
  pollCalls = 0;
  cancelCalls = 0;
  localOperationId: string | undefined;
  pollResult: HelperActivationPoll;
  readonly workerActivationId = bytes32(0x55);
  readonly expiresAt: string;
  onCompleted: (() => Promise<void>) | undefined;
  #ready = false;
  #snapshot = helperSnapshot();
  readonly #listeners = new Set<(snapshot: HelperSupervisorSnapshot) => void>();

  constructor(expiresAt: string) {
    this.expiresAt = expiresAt;
    this.pollResult = {
      operationId: bytes32(0),
      state: "pending",
      expiresAt
    } as HelperActivationPoll;
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

  async start(): Promise<void> {
    if (this.#ready) return;
    this.#ready = true;
    this.startCalls += 1;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    this.#ready = false;
  }

  async reconnect(): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
  }

  async beginActivation(operationId: string): Promise<HelperActivationStart> {
    this.localOperationId = operationId;
    return {
      operationId: operationId as never,
      verificationUrl: `https://pair.waifucave.com/activate#${this.workerActivationId}`,
      expiresAt: this.expiresAt as never
    };
  }

  async pollActivation(operationId: string): Promise<HelperActivationPoll> {
    this.pollCalls += 1;
    if (this.pollResult.state === "completed") await this.onCompleted?.();
    return { ...this.pollResult, operationId: operationId as never } as HelperActivationPoll;
  }

  async cancelActivation(operationId: string) {
    this.cancelCalls += 1;
    return { operationId: operationId as never, cancelled: true as const };
  }
}

async function makeHarness() {
  const root = await makeTempRoot("waifus-activation-api-");
  roots.push(root);
  await ensureDataLayout(root);
  let now = 1_786_270_800;
  let randomCounter = 0x70;
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date(now * 1000).toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const supervisor = new ActivationSupervisor(String(now + 600));
  const remoteAccess = new RemoteAccessService({
    dataRoot: root,
    runtime,
    effectiveHost: "127.0.0.1",
    dashboard: { path: path.join(root, "dashboard"), source: "bundled", buildId: "a".repeat(64) },
    supervisor,
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, randomCounter++)
  });
  services.push(remoteAccess);
  await remoteAccess.start();
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    browserSecurity: {
      listenerHost: "127.0.0.1",
      port: 3888,
      mode: "test"
    },
    remoteTrust: { isAuthorized: () => true },
    remoteAccess
  });
  apps.push(app);
  const session = async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/client-context",
      headers: browserHeaders()
    });
    expect(response.statusCode).toBe(200);
    return {
      cookie: String(response.headers["set-cookie"]),
      csrf: String(response.headers["x-waifus-csrf"])
    };
  };
  const activateInstallation = async () => {
    const paths = remoteStatePaths(root);
    const installation = JSON.parse(await readFile(paths.installation, "utf8")) as {
      installationId: string;
      [key: string]: unknown;
    };
    await writeFile(paths.installation, JSON.stringify({
      ...installation,
      activationReference: `waifus.activation.v1.${installation.installationId}`
    }, null, 2) + "\n", { mode: 0o600 });
  };
  supervisor.onCompleted = activateInstallation;
  return {
    app,
    root,
    supervisor,
    session,
    setNow: (value: number) => { now = value; },
    activateInstallation
  };
}

async function beginActivation(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  session: Awaited<ReturnType<Awaited<ReturnType<typeof makeHarness>>["session"]>>
) {
  return harness.app.inject({
    method: "POST",
    url: "/api/remote-access/activation",
    headers: {
      ...browserHeaders(),
      cookie: session.cookie,
      "x-waifus-csrf": session.csrf
    }
  });
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

describe("anonymous remote activation API", () => {
  it("requires a bound local browser and isolates each operation to its creator session", async () => {
    const harness = await makeHarness();
    const first = await harness.session();
    const second = await harness.session();

    const nonBrowser = await harness.app.inject({
      method: "POST",
      url: "/api/remote-access/activation"
    });
    expect(nonBrowser.statusCode).toBe(403);
    const remote = await dispatchInternal(harness.app, remotePrincipal(), undefined, {
      method: "POST",
      url: "/api/remote-access/activation"
    });
    expect(remote.statusCode).toBe(403);

    const started = await beginActivation(harness, first);
    expect(started.statusCode).toBe(201);
    expect(started.headers["cache-control"]).toBe("no-store");
    const body = started.json();
    expect(Buffer.from(body.activationOperationId, "base64url")).toHaveLength(32);
    expect(body.activationOperationId).not.toBe(harness.supervisor.workerActivationId);
    expect(body.verificationUrl).toBe(
      `https://pair.waifucave.com/activate#${harness.supervisor.workerActivationId}`
    );
    expect(body.verificationUrl).not.toContain(body.activationOperationId);

    const hidden = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${body.activationOperationId}`,
      headers: { ...browserHeaders(), cookie: second.cookie }
    });
    expect(hidden.statusCode).toBe(404);
    const owner = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${body.activationOperationId}`,
      headers: { ...browserHeaders(), cookie: first.cookie }
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toEqual({
      activationOperationId: body.activationOperationId,
      state: "pending",
      expiresAt: "1786271400"
    });
  });

  it("expires, cancels, and caches terminal completion without another helper poll", async () => {
    const harness = await makeHarness();
    const browser = await harness.session();
    const expiredStart = await beginActivation(harness, browser);
    const expiredId = expiredStart.json().activationOperationId;
    harness.setNow(1_786_271_401);
    const expired = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${expiredId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(expired.json()).toMatchObject({ state: "expired", expiresAt: "1786271400" });
    expect(harness.supervisor.cancelCalls).toBe(1);

    harness.setNow(1_786_270_800);
    const completedStart = await beginActivation(harness, browser);
    const completedId = completedStart.json().activationOperationId;
    harness.supervisor.pollResult = {
      operationId: completedId,
      state: "completed",
      expiresAt: "1786271400"
    } as HelperActivationPoll;
    const completed = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${completedId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(completed.json()).toEqual({
      activationOperationId: completedId,
      state: "completed",
      expiresAt: "1786271400",
      completedAt: "1786270800"
    });
    const pollCalls = harness.supervisor.pollCalls;
    const repeated = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${completedId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(repeated.json()).toEqual(completed.json());
    expect(harness.supervisor.pollCalls).toBe(pollCalls);

    const cancelledStart = await beginActivation(harness, browser);
    const cancelledId = cancelledStart.json().activationOperationId;
    const cancelled = await harness.app.inject({
      method: "DELETE",
      url: `/api/remote-access/activation/${cancelledId}`,
      headers: {
        ...browserHeaders(),
        cookie: browser.cookie,
        "x-waifus-csrf": browser.csrf
      }
    });
    expect(cancelled.statusCode).toBe(204);
    const missing = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${cancelledId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(missing.statusCode).toBe(404);
  });

  it("returns sanitized helper failure state and never persists the Worker handle or certificate", async () => {
    const harness = await makeHarness();
    const browser = await harness.session();
    const started = await beginActivation(harness, browser);
    const id = started.json().activationOperationId;
    harness.supervisor.pollResult = {
      operationId: id,
      state: "failed",
      expiresAt: "1786271400",
      errorCode: "certificate_invalid"
    } as HelperActivationPoll;
    const failed = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${id}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(failed.json()).toEqual({
      activationOperationId: id,
      state: "failed",
      expiresAt: "1786271400",
      errorCode: "certificate_invalid"
    });

    const privateValues = [
      harness.supervisor.workerActivationId,
      "turnstile-test-token",
      "activation-certificate-test"
    ];
    const stateRoot = path.join(harness.root, "app", "remote-access");
    const files = [
      path.join(stateRoot, "operations", "ledger.json"),
      path.join(stateRoot, "audit", "ledger.json")
    ];
    for (const file of files) {
      const contents = await readFile(file, "utf8").catch(() => "");
      for (const value of privateValues) expect(contents).not.toContain(value);
    }
  });

  it("rejects helper completion unless helper-owned activation metadata was persisted", async () => {
    const harness = await makeHarness();
    const browser = await harness.session();
    const started = await beginActivation(harness, browser);
    const operationId = started.json().activationOperationId;
    harness.supervisor.onCompleted = undefined;
    harness.supervisor.pollResult = {
      operationId,
      state: "completed",
      expiresAt: "1786271400"
    } as HelperActivationPoll;

    const completed = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${operationId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(completed.json()).toMatchObject({
      state: "failed",
      errorCode: "certificate_invalid"
    });
    expect(harness.supervisor.stopCalls).toBe(1);
  });

  it("rejects first enable without activation and leaves revision and helper launch unchanged", async () => {
    const harness = await makeHarness();
    const browser = await harness.session();
    const update = () => harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers: {
        ...browserHeaders(),
        cookie: browser.cookie,
        "x-waifus-csrf": browser.csrf
      },
      payload: { revision: "0", enabled: true }
    });
    const blocked = await update();
    expect(blocked.statusCode).toBe(428);
    expect(blocked.json()).toMatchObject({ error: "ActivationRequired" });
    expect(harness.supervisor.startCalls).toBe(0);
    const before = JSON.parse(await readFile(remoteStatePaths(harness.root).hostConfig, "utf8"));
    expect(before).toMatchObject({ revision: "0", enabled: false });

    await harness.activateInstallation();
    const enabled = await update();
    expect(enabled.statusCode).toBe(202);
    expect(enabled.json()).toMatchObject({ status: "accepted" });
    const after = JSON.parse(await readFile(remoteStatePaths(harness.root).hostConfig, "utf8"));
    expect(after).toMatchObject({ revision: "1", enabled: true });
    expect(harness.supervisor.startCalls).toBe(1);
  });

  it("keeps the helper alive for a pending activation after disable, then stops it", async () => {
    const harness = await makeHarness();
    const browser = await harness.session();
    await harness.activateInstallation();
    const update = (revision: string, enabled: boolean) => harness.app.inject({
      method: "PUT",
      url: "/api/remote-access",
      headers: {
        ...browserHeaders(),
        cookie: browser.cookie,
        "x-waifus-csrf": browser.csrf
      },
      payload: { revision, enabled }
    });

    expect((await update("0", true)).statusCode).toBe(202);
    const started = await beginActivation(harness, browser);
    const operationId = started.json().activationOperationId;
    expect((await update("1", false)).statusCode).toBe(202);
    expect(harness.supervisor.stopCalls).toBe(0);

    harness.supervisor.pollResult = {
      operationId,
      state: "completed",
      expiresAt: "1786271400"
    } as HelperActivationPoll;
    const completed = await harness.app.inject({
      method: "GET",
      url: `/api/remote-access/activation/${operationId}`,
      headers: { ...browserHeaders(), cookie: browser.cookie }
    });
    expect(completed.json()).toMatchObject({ state: "completed" });
    expect(harness.supervisor.stopCalls).toBe(1);
  });
});
