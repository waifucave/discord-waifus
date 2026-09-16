import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import {
  RemoteLocalApi,
  type RemoteGatewayLocalBackend
} from "../src/remote/gateway/localApi.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";
import { RemoteOriginStore } from "../src/remote/gateway/originStore.js";
import {
  startRemoteGateway,
  type RunningRemoteGateway
} from "../src/remote/gateway/server.js";
import {
  RememberedHostStore,
  type RememberedHostRecordV1
} from "../src/remote/rememberedHosts.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";
import { isAllowedActivationUrl } from "../src/frontend/remote-shell/api.js";

const roots: string[] = [];
const gateways: RunningRemoteGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");

function deterministicRandom(start = 1): (size: number) => Uint8Array {
  let value = start;
  return (size) => Buffer.alloc(size, value++);
}

function rawRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: options.port,
      path: options.path,
      method: options.method ?? "GET",
      headers: {
        ...(body === undefined ? {} : {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body))
        }),
        ...options.headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.once("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

class FakeLocalBackend implements RemoteGatewayLocalBackend {
  beginActivationCalls = 0;
  cancelActivationCalls = 0;
  beginPairCalls = 0;
  pollPairCalls = 0;
  cancelPairCalls = 0;
  consumeCompletedPairCalls = 0;
  lastPairInput: unknown;
  signedRevocation = false;
  readonly hostActions: string[] = [];
  pairStatus: "verification_required" | "awaiting_host_approval" | "completed" = "verification_required";
  completedPairHost = record(0x75);
  pollPairError = false;
  pollActivationError = false;

  snapshot() {
    return {
      gatewayVersion: "1.5.203",
      helperVersion: "0.1.0",
      helperReleaseSequence: "42",
      protocol: { major: 1, minor: 0 },
      capabilities: [
        "waifus.browser-context.v1",
        "waifus.http.v1",
        "waifus.sse.cursor.v1"
      ],
      activationState: "activation_required" as const,
      helperState: "ready" as const,
      controlState: "connected" as const,
      directState: "inactive" as const,
      lastErrorCode: null
    };
  }

  async beginActivation(operationId: string) {
    this.beginActivationCalls += 1;
    return {
      operationId: operationId as never,
      verificationUrl: `https://pair.waifucave.com/activate#${bytes32(0x70)}` as never,
      expiresAt: "1786271400" as never
    };
  }

  async pollActivation(operationId: string) {
    if (this.pollActivationError) throw new Error("private helper detail");
    return {
      operationId: operationId as never,
      expiresAt: "1786271400" as never,
      state: "pending" as const
    };
  }

  async cancelActivation(operationId: string) {
    this.cancelActivationCalls += 1;
    return { operationId: operationId as never, cancelled: true as const };
  }

  async beginPair(_operationId: string, input: Parameters<RemoteGatewayLocalBackend["beginPair"]>[1]) {
    this.beginPairCalls += 1;
    this.lastPairInput = structuredClone(input);
    return { expiresAt: "1786271100" };
  }

  async pollPair(operationId: string) {
    this.pollPairCalls += 1;
    if (this.pollPairError) throw new Error("private helper detail");
    const common = {
      pairOperationId: operationId as never,
      statusUrl: `/_waifus_remote/v1/pair/${operationId}` as never,
      expiresAt: "1786271100" as never
    };
    if (this.pairStatus === "awaiting_host_approval") {
      return { ...common, state: "awaiting_host_approval" as const };
    }
    if (this.pairStatus === "completed") {
      return { ...common, state: "completed" as const };
    }
    return {
      ...common,
      state: "verification_required" as const,
      entryFlow: "full_token" as const,
      sasWords: ["acid", "acorn", "acre", "afar", "affix"] as never,
      sasFingerprint: "0123456789ab",
      claimedHostDisplayName: "Studio Host",
      claimedHostPlatform: { os: "darwin" as const, arch: "arm64" as const },
      claimedHostInstallationFingerprint: bytes16(0x71) as never
    };
  }

  async cancelPair(): Promise<void> {
    this.cancelPairCalls += 1;
  }

  async consumeCompletedPair(): Promise<RememberedHostRecordV1> {
    this.consumeCompletedPairCalls += 1;
    return this.completedPairHost;
  }

  async connectRememberedHost(host: RememberedHostRecordV1): Promise<void> {
    this.hostActions.push(`connect:${host.hostId}`);
  }

  async disconnectRememberedHost(host: RememberedHostRecordV1): Promise<void> {
    this.hostActions.push(`disconnect:${host.hostId}`);
  }

  async requestSignedSelfRevocation(host: RememberedHostRecordV1): Promise<boolean> {
    this.hostActions.push(`revoke:${host.hostId}`);
    return this.signedRevocation;
  }

  async forgetRememberedHost(host: RememberedHostRecordV1): Promise<void> {
    this.hostActions.push(`forget:${host.hostId}`);
  }
}

type ShellHarness = {
  root: string;
  gateway: RunningRemoteGateway;
  api: RemoteLocalApi;
  backend: FakeLocalBackend;
  hosts: RememberedHostStore;
  origins: RemoteOriginStore;
  cookie: string;
  csrf: string;
  request: (path: string, options?: {
    method?: string;
    body?: unknown;
    csrf?: string | false;
  }) => ReturnType<typeof rawRequest>;
};

async function shellHarness(options: {
  root?: string;
  api?: RemoteLocalApi;
  backend?: FakeLocalBackend;
  hostnameCharacter?: string;
  shellRoot?: string;
} = {}): Promise<ShellHarness> {
  const root = options.root ?? await makeTempRoot("waifus-local-api-");
  if (!options.root) {
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
  }
  const backend = options.backend ?? new FakeLocalBackend();
  const hosts = new RememberedHostStore(root);
  const origins = new RemoteOriginStore(root, { randomBytes: deterministicRandom(0x40) });
  const api = options.api ?? new RemoteLocalApi({
    backend,
    rememberedHosts: hosts,
    origins,
    now: () => 1_786_270_800_000,
    randomBytes: deterministicRandom(0x20),
    shellRoot: options.shellRoot
  });
  const hostname = `waifus-${(options.hostnameCharacter ?? "a").repeat(52)}.localhost`;
  const gateway = await startRemoteGateway({
    hostname,
    port: 0,
    surface: "shell",
    randomBytes: deterministicRandom(0x50),
    now: () => 1_786_270_800_000,
    handleAuthenticatedRequest: api.handle
  });
  gateways.push(gateway);
  const authority = `${hostname}:${gateway.port}`;
  const bootstrap = await rawRequest({
    port: gateway.port,
    path: new URL(gateway.bootstrapUrl).pathname,
    headers: { host: authority, "sec-fetch-site": "none" }
  });
  expect(bootstrap.statusCode).toBe(303);
  const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
  const request = async (path: string, requestOptions: {
    method?: string;
    body?: unknown;
    csrf?: string | false;
  } = {}) => rawRequest({
    port: gateway.port,
    path,
    method: requestOptions.method,
    body: requestOptions.body,
    headers: {
      host: authority,
      origin: gateway.origin,
      "sec-fetch-site": "same-origin",
      cookie,
      ...(
        requestOptions.csrf === false
          ? {}
          : requestOptions.csrf
            ? { "x-waifus-csrf": requestOptions.csrf }
            : {}
      )
    }
  });
  const context = await request("/_waifus_remote/v1/bootstrap");
  expect(context.statusCode).toBe(200);
  return {
    root,
    gateway,
    api,
    backend,
    hosts,
    origins,
    cookie,
    csrf: String(context.headers["x-waifus-csrf"]),
    request
  };
}

function record(value: number, overrides: Partial<RememberedHostRecordV1> = {}): RememberedHostRecordV1 {
  const installationPublicKey = Buffer.alloc(32, value).toString("base64url") as never;
  return {
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(installationPublicKey, "base64url")) as never,
    displayName: `Host ${value}`,
    platform: { os: "darwin", arch: "arm64" },
    installationFingerprint: Buffer.alloc(16, value).toString("base64url") as never,
    trustEpoch: "1" as never,
    revision: "1" as never,
    pairedAt: "1786270800" as never,
    lastSeenAt: null,
    lastDirectAt: null,
    connectionState: "offline",
    lastErrorCode: null,
    helperPairId: Buffer.alloc(16, value + 32).toString("base64url") as never,
    installationPublicKey,
    ...overrides
  };
}

async function makeStore(prefix: string): Promise<{ root: string; store: RememberedHostStore }> {
  const root = await makeTempRoot(prefix);
  roots.push(root);
  await ensureRemoteOnlyLayout(root);
  return { root, store: new RememberedHostStore(root) };
}

describe("remembered host store", () => {
  it("is partitioned by data root and never exposes helper pair references or public keys", async () => {
    const first = await makeStore("waifus-remembered-first-");
    const second = await makeStore("waifus-remembered-second-");
    const host = record(0x31);
    await first.store.upsert(host);

    expect(await first.store.list()).toEqual({
      version: 1,
      hosts: [{
        version: 1,
        hostId: host.hostId,
        displayName: host.displayName,
        platform: host.platform,
        installationFingerprint: host.installationFingerprint,
        trustEpoch: host.trustEpoch,
        revision: host.revision,
        pairedAt: host.pairedAt,
        lastSeenAt: null,
        lastDirectAt: null,
        connectionState: "offline",
        lastErrorCode: null
      }]
    });
    expect(JSON.stringify(await first.store.list())).not.toContain(host.helperPairId);
    expect(JSON.stringify(await first.store.list())).not.toContain(host.installationPublicKey);
    expect(await second.store.list()).toEqual({ version: 1, hosts: [] });

    const statePath = remoteStatePaths(first.root).remoteRememberedHosts;
    if (process.platform !== "win32") {
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("auto-selects one host, requires a choice for many, and persists an explicit selection", async () => {
    const { root, store } = await makeStore("waifus-remembered-selection-");
    const first = record(0x41);
    const second = record(0x42);
    expect(await store.selection()).toEqual({ selectionState: "no_hosts", selectedHostId: null });
    await store.upsert(first);
    expect(await store.selection()).toEqual({
      selectionState: "automatic_single",
      selectedHostId: first.hostId
    });
    await store.upsert(second);
    expect(await store.selection()).toEqual({
      selectionState: "selection_required",
      selectedHostId: null
    });
    await store.select(second.hostId);
    expect(await new RememberedHostStore(root).selection()).toEqual({
      selectionState: "explicit",
      selectedHostId: second.hostId
    });
  });

  it("validates host identity, bytewise ordering, unique pair IDs, and optimistic removal", async () => {
    const { store } = await makeStore("waifus-remembered-integrity-");
    const first = record(0x51);
    await expect(store.upsert({ ...first, hostId: record(0x52).hostId })).rejects.toThrow();
    await store.upsert(first);
    await expect(store.remove(first.hostId, "2"))
      .rejects.toMatchObject({ code: "host_conflict" });
    expect(await store.record(first.hostId)).toEqual(first);
    await store.remove(first.hostId, "1");
    expect(await store.record(first.hostId)).toBeUndefined();
    expect(await store.selection()).toEqual({ selectionState: "no_hosts", selectedHostId: null });
  });

  it("updates only sanitized connection state while preserving trust revision", async () => {
    const { store } = await makeStore("waifus-remembered-status-");
    const host = record(0x61);
    await store.upsert(host);
    const updated = await store.updateConnection(
      host.hostId,
      "direct",
      "1786270900",
      null
    );
    expect(updated).toMatchObject({
      hostId: host.hostId,
      revision: "1",
      connectionState: "direct",
      lastDirectAt: "1786270900"
    });
  });

  it("rejects owner-broad persisted state", async () => {
    if (process.platform === "win32") return;
    const { root, store } = await makeStore("waifus-remembered-mode-");
    await store.getState();
    const statePath = remoteStatePaths(root).remoteRememberedHosts;
    await chmod(statePath, 0o644);
    await expect(new RememberedHostStore(root).getState())
      .rejects.toMatchObject({ code: "remembered_hosts_untrusted" });
    expect(await readFile(statePath, "utf8")).not.toContain("privateKey");
  });
});

describe("remote connection-shell local API", () => {
  it("serves only the installed shell index and declared hashed assets", async () => {
    const root = await makeTempRoot("waifus-local-shell-assets-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const shellRoot = path.join(root, "shell");
    await mkdir(path.join(shellRoot, "assets"), { recursive: true });
    await writeFile(
      path.join(shellRoot, "index.html"),
      '<!doctype html><script type="module" src="/assets/index-Ab12.js"></script>',
      "utf8"
    );
    await writeFile(path.join(shellRoot, "assets", "index-Ab12.js"), "export {};\n", "utf8");
    await writeFile(path.join(shellRoot, "secret.txt"), "must-not-serve\n", "utf8");
    const harness = await shellHarness({ root, shellRoot });

    const index = await harness.request("/");
    expect(index.statusCode).toBe(200);
    expect(index.headers["content-type"]).toContain("text/html");
    expect(index.headers["cache-control"]).toBe("no-store");
    expect(index.headers["content-security-policy"]).toContain("allow-popups");
    expect(index.body).toContain("/assets/index-Ab12.js");

    const asset = await harness.request("/assets/index-Ab12.js");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect((await harness.request("/secret.txt")).statusCode).toBe(404);
    expect((await harness.request("/assets/unknown.js")).statusCode).toBe(404);
  });

  it("accepts only the exact fragment-only activation origins", () => {
    const fragment = bytes32(0x70);
    expect(isAllowedActivationUrl(`https://pair.waifucave.com/activate#${fragment}`)).toBe(true);
    expect(isAllowedActivationUrl(`https://pair-staging.waifucave.com/activate#${fragment}`)).toBe(true);
    for (const value of [
      `https://evil.example/activate#${fragment}`,
      `https://pair.waifucave.com:444/activate#${fragment}`,
      `https://pair.waifucave.com/activate?token=x#${fragment}`,
      `https://user@pair.waifucave.com/activate#${fragment}`,
      `https://pair.waifucave.com/other#${fragment}`,
      `https://pair.waifucave.com/activate#${fragment}=`,
      "not-a-url"
    ]) {
      expect(isAllowedActivationUrl(value), value).toBe(false);
    }
  });

  it("delivers CSRF only in the credentialed bootstrap header and starts activation only on POST", async () => {
    const harness = await shellHarness();
    const bootstrap = await harness.request("/_waifus_remote/v1/bootstrap");
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.headers["cache-control"]).toBe("no-store");
    expect(Buffer.from(harness.csrf, "base64url")).toHaveLength(32);
    expect(harness.csrf).toHaveLength(43);
    expect(bootstrap.body).not.toContain(harness.csrf);
    expect(bootstrap.body).not.toContain(harness.gateway.gatewayLaunchId);
    expect(bootstrap.body).not.toContain("browserSessionId");
    expect(bootstrap.body).not.toContain("dataRoot");
    expect(JSON.parse(bootstrap.body)).toMatchObject({
      version: 1,
      activationState: "activation_required",
      rememberedHostCount: 0,
      selectionState: "no_hosts",
      selectedHostId: null
    });
    expect(harness.backend.beginActivationCalls).toBe(0);

    const missingCsrf = await harness.request("/_waifus_remote/v1/activation", {
      method: "POST",
      body: {},
      csrf: false
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(harness.backend.beginActivationCalls).toBe(0);

    const started = await harness.request("/_waifus_remote/v1/activation", {
      method: "POST",
      body: {},
      csrf: harness.csrf
    });
    expect(started.statusCode).toBe(201);
    expect(started.headers["cache-control"]).toBe("no-store");
    const result = JSON.parse(started.body);
    expect(Buffer.from(result.activationOperationId, "base64url")).toHaveLength(32);
    expect(result.verificationUrl).toBe(
      `https://pair.waifucave.com/activate#${bytes32(0x70)}`
    );
    expect(result.verificationUrl).not.toContain(result.activationOperationId);
    expect(harness.backend.beginActivationCalls).toBe(1);

    const status = await harness.request(
      `/_waifus_remote/v1/activation/${result.activationOperationId}`
    );
    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toEqual({
      activationOperationId: result.activationOperationId,
      state: "pending",
      expiresAt: "1786271400"
    });
  });

  it("keeps pair entry secrets out of results and state while binding details to one session", async () => {
    const harness = await shellHarness();
    const token = `WF1.${Buffer.alloc(32, 0x7a).toString("base64url")}`;
    const unknownField = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "full_token", token, destination: "100.64.0.1" }
    });
    expect(unknownField.statusCode).toBe(400);
    expect(harness.backend.beginPairCalls).toBe(0);

    const started = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "full_token", token }
    });
    expect(started.statusCode).toBe(202);
    const result = JSON.parse(started.body);
    expect(result).toMatchObject({
      statusUrl: `/_waifus_remote/v1/pair/${result.pairOperationId}`,
      state: "starting",
      expiresAt: "1786271100"
    });
    expect(started.body).not.toContain(token);
    expect(result.statusUrl).not.toContain(token);
    expect(harness.backend.lastPairInput).toEqual({ kind: "full_token", token });

    const duplicate = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "short_code", code: "0123-4567" }
    });
    expect(duplicate.statusCode).toBe(409);

    const verification = await harness.request(result.statusUrl);
    expect(verification.statusCode).toBe(200);
    expect(JSON.parse(verification.body)).toMatchObject({
      state: "verification_required",
      entryFlow: "full_token",
      sasWords: ["acid", "acorn", "acre", "afar", "affix"],
      sasFingerprint: "0123456789ab",
      claimedHostDisplayName: "Studio Host"
    });
    expect(verification.body).not.toContain(token);

    const authority = `${harness.gateway.hostname}:${harness.gateway.port}`;
    const secondBootstrap = await rawRequest({
      port: harness.gateway.port,
      path: new URL(harness.gateway.issueBootstrapUrl()).pathname,
      headers: { host: authority, "sec-fetch-site": "none" }
    });
    const secondCookie = String(secondBootstrap.headers["set-cookie"]).split(";", 1)[0];
    const secondContext = await rawRequest({
      port: harness.gateway.port,
      path: "/_waifus_remote/v1/bootstrap",
      headers: {
        host: authority,
        origin: harness.gateway.origin,
        "sec-fetch-site": "same-origin",
        cookie: secondCookie
      }
    });
    const secondCsrf = String(secondContext.headers["x-waifus-csrf"]);
    const secondRequest = (path: string, method = "GET") => rawRequest({
      port: harness.gateway.port,
      path,
      method,
      headers: {
        host: authority,
        origin: harness.gateway.origin,
        "sec-fetch-site": "same-origin",
        cookie: secondCookie,
        ...(method === "GET" ? {} : { "x-waifus-csrf": secondCsrf })
      }
    });
    const hidden = await secondRequest(result.statusUrl);
    expect(hidden.statusCode).toBe(404);
    const hiddenCancel = await secondRequest(result.statusUrl, "DELETE");
    expect(hiddenCancel.statusCode).toBe(404);

    harness.backend.pairStatus = "awaiting_host_approval";
    const redacted = await harness.request(result.statusUrl);
    expect(JSON.parse(redacted.body)).toEqual({
      pairOperationId: result.pairOperationId,
      statusUrl: result.statusUrl,
      state: "awaiting_host_approval",
      expiresAt: "1786271100"
    });
    expect(redacted.body).not.toContain("sasWords");
    expect(redacted.body).not.toContain("Studio Host");

    const cancelled = await harness.request(result.statusUrl, {
      method: "DELETE",
      csrf: harness.csrf
    });
    expect(cancelled.statusCode).toBe(204);
    expect(harness.backend.cancelPairCalls).toBe(1);
    expect((await harness.request(result.statusUrl)).statusCode).toBe(404);

    const stateFiles = [
      remoteStatePaths(harness.root).remoteRememberedHosts,
      remoteStatePaths(harness.root).remoteOriginState
    ];
    for (const stateFile of stateFiles) {
      expect(await readFile(stateFile, "utf8").catch(() => "")).not.toContain(token);
    }
  });

  it("persists a completed pair exactly once without exposing helper-only host material", async () => {
    const harness = await shellHarness();
    const token = `WF1.${Buffer.alloc(32, 0x7c).toString("base64url")}`;
    const started = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "full_token", token }
    });
    const operation = JSON.parse(started.body);
    harness.backend.pairStatus = "completed";

    const completed = await harness.request(operation.statusUrl);

    expect(completed.statusCode).toBe(200);
    expect(JSON.parse(completed.body)).toEqual({
      pairOperationId: operation.pairOperationId,
      statusUrl: operation.statusUrl,
      state: "completed",
      expiresAt: "1786271100"
    });
    expect(completed.body).not.toContain(harness.backend.completedPairHost.helperPairId);
    expect(completed.body).not.toContain(harness.backend.completedPairHost.installationPublicKey);
    expect(await harness.hosts.record(harness.backend.completedPairHost.hostId))
      .toEqual(harness.backend.completedPairHost);

    const listed = await harness.request("/_waifus_remote/v1/hosts");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain(harness.backend.completedPairHost.displayName);
    expect(listed.body).not.toContain(harness.backend.completedPairHost.helperPairId);
    expect(listed.body).not.toContain(harness.backend.completedPairHost.installationPublicKey);
    expect((await harness.request(operation.statusUrl)).statusCode).toBe(200);
    expect(harness.backend.consumeCompletedPairCalls).toBe(1);
  });

  it("turns helper loss into a terminal redacted failure and cancels live work on session close", async () => {
    const harness = await shellHarness();
    const token = `WF1.${Buffer.alloc(32, 0x7b).toString("base64url")}`;
    const pair = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "full_token", token }
    });
    const pairResult = JSON.parse(pair.body);
    expect((await harness.request(pairResult.statusUrl)).statusCode).toBe(200);
    harness.backend.pollPairError = true;
    const failed = await harness.request(pairResult.statusUrl);
    expect(JSON.parse(failed.body)).toEqual({
      pairOperationId: pairResult.pairOperationId,
      statusUrl: pairResult.statusUrl,
      state: "failed",
      expiresAt: "1786271100",
      errorCode: "helper_unavailable"
    });
    expect(failed.body).not.toContain("private helper detail");
    expect(failed.body).not.toContain("sasWords");
    const polls = harness.backend.pollPairCalls;
    expect(JSON.parse((await harness.request(pairResult.statusUrl)).body).state).toBe("failed");
    expect(harness.backend.pollPairCalls).toBe(polls);

    harness.backend.pollPairError = false;
    const second = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "short_code", code: "0123-4567" }
    });
    const activation = await harness.request("/_waifus_remote/v1/activation", {
      method: "POST",
      csrf: harness.csrf,
      body: {}
    });
    const sessionId = harness.cookie.slice(harness.cookie.indexOf("=") + 1);
    await harness.api.closeSession(harness.gateway.gatewayLaunchId, sessionId);
    expect(harness.backend.cancelPairCalls).toBe(1);
    expect(harness.backend.cancelActivationCalls).toBe(1);
    expect((await harness.request(JSON.parse(second.body).statusUrl)).statusCode).toBe(404);
    expect((await harness.request(
      `/_waifus_remote/v1/activation/${JSON.parse(activation.body).activationOperationId}`
    )).statusCode).toBe(404);
  });

  it("streams only opaque cursored transitions and never pair secrets or comparison details", async () => {
    const harness = await shellHarness();
    const authority = `${harness.gateway.hostname}:${harness.gateway.port}`;
    let streamText = "";
    let streamResponse!: import("node:http").IncomingMessage;
    let ready!: () => void;
    const connected = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const streamRequest = httpRequest({
      host: "127.0.0.1",
      port: harness.gateway.port,
      path: "/_waifus_remote/v1/events",
      headers: {
        host: authority,
        origin: harness.gateway.origin,
        "sec-fetch-site": "same-origin",
        cookie: harness.cookie
      }
    }, (response) => {
      streamResponse = response;
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      response.on("data", (chunk) => {
        streamText += Buffer.from(chunk).toString("utf8");
        if (streamText.includes(": connected")) ready();
      });
    });
    streamRequest.end();
    await connected;

    const token = `WF1.${Buffer.alloc(32, 0x7c).toString("base64url")}`;
    const started = await harness.request("/_waifus_remote/v1/pair", {
      method: "POST",
      csrf: harness.csrf,
      body: { kind: "full_token", token }
    });
    const operationId = JSON.parse(started.body).pairOperationId;
    const deadline = Date.now() + 1_000;
    while (!streamText.includes(operationId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(streamText).toContain(operationId);
    expect(streamText).toMatch(/id: v1:[A-Za-z0-9_-]{22}:1\n/u);
    expect(streamText).toContain('"state":"starting"');
    expect(streamText).not.toContain(token);
    expect(streamText).not.toContain("sasWords");
    expect(streamText).not.toContain("Studio Host");
    streamResponse.destroy();
    streamRequest.destroy();
  });

  it("selects hosts and requires signed revocation or the exact offline warning", async () => {
    const root = await makeTempRoot("waifus-local-host-actions-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const hosts = new RememberedHostStore(root);
    const first = record(0x71);
    const second = record(0x72);
    await hosts.upsert(first);
    await hosts.upsert(second);
    const harness = await shellHarness({ root });

    const listed = await harness.request("/_waifus_remote/v1/hosts");
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(first.helperPairId);
    expect(listed.body).not.toContain(first.installationPublicKey);
    expect(JSON.parse(listed.body).hosts).toHaveLength(2);

    const destination = await harness.request(
      `/_waifus_remote/v1/hosts/${first.hostId}/connect`,
      { method: "POST", csrf: harness.csrf, body: { destination: "100.64.0.1" } }
    );
    expect(destination.statusCode).toBe(400);
    const connected = await harness.request(
      `/_waifus_remote/v1/hosts/${first.hostId}/connect`,
      { method: "POST", csrf: harness.csrf, body: {} }
    );
    expect(connected.statusCode).toBe(202);
    expect(JSON.parse(connected.body)).toMatchObject({ hostId: first.hostId, state: "connecting" });
    expect(await hosts.selection()).toEqual({
      selectionState: "explicit",
      selectedHostId: first.hostId
    });

    const disconnected = await harness.request(
      `/_waifus_remote/v1/hosts/${first.hostId}/disconnect`,
      { method: "POST", csrf: harness.csrf, body: {} }
    );
    expect(disconnected.statusCode).toBe(200);
    expect(JSON.parse(disconnected.body)).toMatchObject({ hostId: first.hostId, state: "offline" });

    const warning = await harness.request(`/_waifus_remote/v1/hosts/${first.hostId}`, {
      method: "DELETE",
      csrf: harness.csrf,
      body: { revision: "1", mode: "reachable_first" }
    });
    expect(warning.statusCode).toBe(409);
    expect(JSON.parse(warning.body)).toEqual({
      hostId: first.hostId,
      state: "local_only_confirmation_required",
      revision: "1",
      warningCode: "host_unreachable_remote_trust_may_remain",
      requiredMode: "local_only_confirmed"
    });
    expect(await hosts.record(first.hostId)).toBeDefined();

    const missingWarning = await harness.request(`/_waifus_remote/v1/hosts/${first.hostId}`, {
      method: "DELETE",
      csrf: harness.csrf,
      body: { revision: "1", mode: "local_only_confirmed" }
    });
    expect(missingWarning.statusCode).toBe(400);
    const forgotten = await harness.request(`/_waifus_remote/v1/hosts/${first.hostId}`, {
      method: "DELETE",
      csrf: harness.csrf,
      body: {
        revision: "1",
        mode: "local_only_confirmed",
        warningCode: "host_unreachable_remote_trust_may_remain"
      }
    });
    expect(forgotten.statusCode).toBe(200);
    expect(JSON.parse(forgotten.body)).toMatchObject({
      state: "forgotten",
      revocation: "local_only"
    });
    expect(await hosts.record(first.hostId)).toBeUndefined();
    expect((await harness.origins.getState()).originEpochHighWater).toBe("1");

    harness.backend.signedRevocation = true;
    const signed = await harness.request(`/_waifus_remote/v1/hosts/${second.hostId}`, {
      method: "DELETE",
      csrf: harness.csrf,
      body: { revision: "1", mode: "reachable_first" }
    });
    expect(signed.statusCode).toBe(200);
    expect(JSON.parse(signed.body)).toMatchObject({
      state: "forgotten",
      revocation: "signed_self_revocation"
    });
    expect(harness.backend.hostActions.slice(-2)).toEqual([
      `revoke:${second.hostId}`,
      `forget:${second.hostId}`
    ]);
    expect(await hosts.record(second.hostId)).toBeUndefined();
    expect((await harness.origins.getState()).originEpochHighWater).toBe("2");
  });

  it("returns the same 404 for every local-control route on a downloaded-dashboard origin", async () => {
    let calls = 0;
    const hostname = `waifus-${"c".repeat(52)}.localhost`;
    const gateway = await startRemoteGateway({
      hostname,
      port: 0,
      surface: "dashboard",
      randomBytes: deterministicRandom(0x60),
      handleAuthenticatedRequest: async () => {
        calls += 1;
        return { leaked: true };
      }
    });
    gateways.push(gateway);
    const authority = `${hostname}:${gateway.port}`;
    const bootstrap = await rawRequest({
      port: gateway.port,
      path: new URL(gateway.bootstrapUrl).pathname,
      headers: { host: authority, "sec-fetch-site": "none" }
    });
    const cookie = String(bootstrap.headers["set-cookie"]).split(";", 1)[0];
    const operationId = bytes32(0x73);
    const hostId = bytes32(0x74);
    const routes = [
      ["GET", "/_waifus_remote/v1/bootstrap"],
      ["POST", "/_waifus_remote/v1/activation"],
      ["GET", `/_waifus_remote/v1/activation/${operationId}`],
      ["DELETE", `/_waifus_remote/v1/activation/${operationId}`],
      ["GET", "/_waifus_remote/v1/hosts"],
      ["POST", "/_waifus_remote/v1/pair"],
      ["GET", `/_waifus_remote/v1/pair/${operationId}`],
      ["DELETE", `/_waifus_remote/v1/pair/${operationId}`],
      ["POST", `/_waifus_remote/v1/hosts/${hostId}/connect`],
      ["POST", `/_waifus_remote/v1/hosts/${hostId}/disconnect`],
      ["DELETE", `/_waifus_remote/v1/hosts/${hostId}`],
      ["GET", "/_waifus_remote/v1/events"]
    ];
    const bodies: string[] = [];
    for (const [method, path] of routes) {
      const response = await rawRequest({
        port: gateway.port,
        path,
        method,
        headers: {
          host: authority,
          origin: gateway.origin,
          "sec-fetch-site": "same-origin",
          cookie
        }
      });
      expect(response.statusCode, `${method} ${path}`).toBe(404);
      bodies.push(response.body);
    }
    expect(new Set(bodies).size).toBe(1);
    expect(calls).toBe(0);
  });
});
