import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerInternalDispatchReceiver } from "../src/api/internalDispatch.js";
import { RemoteRequestBridge } from "../src/backend/remoteAccess/requestBridge.js";
import { ProtectedHelperProcessFactory } from "../src/remote/helperClient.js";
import type { HelperLaunchRequest } from "../src/remote/helperTypes.js";
import { deriveInstallationFingerprint } from "../src/shared/remotePairing.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/fakeSupervisedHelper.mjs", import.meta.url));
const REQUIRED_CAPABILITIES = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function launchRequest(
  environment: Record<string, string> = {}
): Promise<HelperLaunchRequest> {
  const root = await makeTempRoot("waifus-helper-client-");
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  return {
    role: "host",
    dataRoot: root,
    binaryPath: process.execPath,
    argv: [fixture, "supervised", "--parent-endpoint", path.join(runtimeRoot, "p")],
    environment,
    parentEndpoint: path.join(runtimeRoot, "p"),
    parentCapability: Buffer.alloc(32, 0x31),
    parentHello: {
      protocol: { major: 1, minor: 0 },
      component: "discord_waifus",
      componentVersion: "1.5.203",
      buildId: "dashboard-build",
      nonce: Buffer.alloc(32, 0x41).toString("base64url") as never,
      capabilities: { required: [...REQUIRED_CAPABILITIES], optional: [] },
      controlProfile: 1,
      runtimePurpose: "normal"
    }
  };
}

async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readEventually(filePath: string): Promise<string> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      const value = await readFile(filePath, "utf8");
      JSON.parse(value);
      return value;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT"
        && !(error instanceof SyntaxError)
      ) {
        throw error;
      }
      if (performance.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

const unixIt = process.platform === "win32" ? it.skip : it;

describe("protected helper process client", () => {
  unixIt("authenticates the exact canonical transcript over a current-user Unix socket", async () => {
    const request = await launchRequest({ FAKE_HELPER_AUTH_DELAY_MS: "100" });
    const factory = new ProtectedHelperProcessFactory();
    const launch = await factory.launch(request);

    const directory = await lstat(path.dirname(request.parentEndpoint));
    const socket = await lstat(request.parentEndpoint);
    expect(directory.mode & 0o777).toBe(0o700);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o600);

    const client = await launch.authenticated;
    expect(client.hello).toMatchObject({
      component: "ts_connect",
      componentVersion: "0.1.0",
      controlProfile: 1,
      runtimePurpose: "normal"
    });
    expect(client.negotiatedProtocol).toEqual({ major: 1, minor: 0 });
    expect(client.negotiatedCapabilities).toEqual(REQUIRED_CAPABILITIES);
    expect(request.parentCapability.equals(Buffer.alloc(32))).toBe(true);

    await client.close();
    await launch.requestDrain();
    await launch.closeParentChannel();
    await expect(launch.exited).resolves.toMatchObject({ code: 0 });
  });

  unixIt("rejects a wrong helper proof", async () => {
    const request = await launchRequest({ FAKE_HELPER_WRONG_PROOF: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    let outcome = "pending";
    const authentication = launch.authenticated.then(
      () => "authenticated",
      () => "rejected"
    );
    void authentication.then((value) => {
      outcome = value;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(outcome).toBe("pending");
    await launch.forceTerminate();
    await launch.exited;
    await expect(authentication).resolves.toBe("rejected");
    await launch.closeParentChannel();
  });

  unixIt("does not let an unauthenticated socket-race loser consume the launch capability", async () => {
    const request = await launchRequest({ FAKE_HELPER_CONNECT_DELAY_MS: "150" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const attacker = net.connect(request.parentEndpoint);
    await new Promise<void>((resolve, reject) => {
      attacker.once("connect", resolve);
      attacker.once("error", reject);
    });
    attacker.write(Buffer.alloc(24, 0x00));
    await new Promise((resolve) => setTimeout(resolve, 50));
    attacker.destroy();

    const client = await launch.authenticated;
    expect(client.hello.component).toBe("ts_connect");
    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("uses the inherited capability pipe as the parent-liveness signal", async () => {
    const request = await launchRequest();
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    await launch.authenticated;

    await launch.closeParentChannel();
    await expect(launch.exited).resolves.toMatchObject({ code: 70 });
  });

  const realHelperIt = process.platform !== "win32" && process.env.WAIFUS_TS_CONNECT_TEST_BINARY
    ? it
    : it.skip;
  realHelperIt("authenticates the real ts-connect supervised binary", async () => {
    const baseRequest = await launchRequest();
    const request: HelperLaunchRequest = {
      ...baseRequest,
      binaryPath: process.env.WAIFUS_TS_CONNECT_TEST_BINARY!,
      argv: ["supervised", "--parent-endpoint", baseRequest.parentEndpoint],
      environment: {}
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);

    const client = await within(launch.authenticated, 2_000, "real helper authentication");
    expect(client.hello).toMatchObject({
      component: "ts_connect",
      componentVersion: "0.1.0-dev",
      controlProfile: 1,
      runtimePurpose: "normal"
    });
    await client.close();
    await launch.requestDrain();
    await expect(within(launch.exited, 2_000, "real helper shutdown")).resolves.toMatchObject({
      code: 70
    });
    await launch.closeParentChannel();
  });

  unixIt("keeps activation commands authenticated and exposes only sanitized operation state", async () => {
    const request = await launchRequest({
      FAKE_HELPER_ACTIVATION: "1",
      FAKE_HELPER_ACTIVATION_POLL_STATE: "completed"
    });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const operationId = Buffer.alloc(32, 0x61).toString("base64url");

    await expect(client.identityStatus()).resolves.toEqual({
      activationState: "activation_required",
      deviceId: "host-device-01",
      installationFingerprint: Buffer.alloc(16, 0x73).toString("base64url"),
      secretStorage: "keychain"
    });

    const started = await client.beginActivation(operationId);
    expect(started).toEqual({
      operationId,
      verificationUrl: `https://pair.waifucave.com/activate#${Buffer.alloc(32, 0x55).toString("base64url")}`,
      expiresAt: "1786271400"
    });
    expect(started.verificationUrl).not.toContain(operationId);

    await expect(client.pollActivation(operationId)).resolves.toEqual({
      operationId,
      state: "completed",
      expiresAt: "1786271400"
    });
    await expect(client.cancelActivation(operationId)).resolves.toEqual({
      operationId,
      cancelled: true
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("owns the supervised direct runtime through strict correlated commands", async () => {
    const request = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;

    await expect(client.identityStatus()).resolves.toMatchObject({ activationState: "active" });
    await expect(client.startRuntime()).resolves.toEqual({
      activationState: "active",
      controlState: "connected",
      directState: "reconnecting",
      lastDirectAt: null,
      lastErrorCode: null
    });
    await expect(client.startRuntime(Buffer.alloc(16, 0x61).toString("base64url")))
      .rejects.toMatchObject({ code: "helper_incompatible" });
    await expect(client.runtimeStatus()).resolves.toMatchObject({
      controlState: "connected",
      directState: "reconnecting"
    });
    await expect(client.reconnectRuntime()).resolves.toMatchObject({
      controlState: "connected"
    });
    await expect(client.stopRuntime()).resolves.toMatchObject({
      controlState: "inactive",
      directState: "inactive"
    });
    expect(client.currentStatus()).toMatchObject({
      controlState: "inactive",
      directState: "inactive"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("uses strict correlated helper commands for host pairing and trusted-device management", async () => {
    const request = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const invitationId = Buffer.alloc(16, 0x41).toString("base64url");
    const requestId = Buffer.alloc(16, 0x45).toString("base64url");
    const actor = {
      kind: "local" as const,
      stableId: "local" as const,
      hostServerLaunchId: Buffer.alloc(32, 0x31).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x32).toString("base64url")
    };
    const requestActor = { kind: "local" as const, stableId: "local" as const };
    const approval = {
      invitationGeneration: "1",
      remoteIdentityBundleHash: Buffer.alloc(32, 0x24).toString("base64url"),
      transcriptHash: Buffer.alloc(32, 0x25).toString("base64url"),
      channelBinding: Buffer.alloc(32, 0x26).toString("base64url"),
      sasIndices: [1, 23, 456, 789, 1023] as [number, number, number, number, number],
      sasFingerprint: "a1b2c3d4e5f6"
    };
    const approvalRequestBinding = {
      confirmationRequestNonce: Buffer.alloc(16, 0x27).toString("base64url"),
      confirmationMethod: "POST" as const,
      confirmationTarget: `/api/remote-access/pairing-requests/${requestId}/approve`
    };

    await expect(client.createInvitation(
      actor,
      Buffer.alloc(32, 0x33).toString("base64url"),
      {
        displayName: "Studio Host",
        platform: { os: "darwin", arch: "arm64" }
      }
    )).resolves.toMatchObject({ invitationId, shortCode: "01AB-CDEF" });
    await expect(client.cancelInvitation(invitationId, actor)).resolves.toBeUndefined();
    await expect(client.listPairingRequests(requestActor))
      .resolves.toEqual({ version: 1, requests: [] });
    await expect(client.approvePairingRequest(requestId, approval, actor, approvalRequestBinding))
      .resolves.toBeUndefined();
    await expect(client.rejectPairingRequest(requestId, requestActor))
      .resolves.toBeUndefined();
    await expect(client.listDevices()).resolves.toEqual({ version: 1, devices: [] });
    await expect(client.renameDevice(
      "travel-mac",
      { revision: "1", displayName: "Travel Laptop" },
      requestActor
    )).resolves.toMatchObject({
      deviceId: "travel-mac",
      displayName: "Travel Laptop",
      revision: "2"
    });
    await expect(client.revokeDevice("travel-mac", actor)).resolves.toBeUndefined();
    await expect(client.reconcileDeviceRevocation({
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x46).toString("base64url"),
      deniedTrustEpoch: "7",
      denyEpoch: "8"
    })).resolves.toBeUndefined();

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("uses strict correlated helper commands for the remote pairing lifecycle", async () => {
    const baseRequest = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const request: HelperLaunchRequest = { ...baseRequest, role: "remote" };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const operationId = Buffer.alloc(32, 0x47).toString("base64url");

    await expect(client.beginPair(operationId, {
      kind: "short_code",
      code: "0123-4567"
    }, {
      displayName: "Travel Mac",
      platform: { os: "darwin", arch: "arm64" }
    })).resolves.toEqual({ operationId, expiresAt: "1786271130" });
    await expect(client.pollPair(operationId)).resolves.toEqual({
      operationId,
      state: "verification_required",
      expiresAt: "1786271130",
      entryFlow: "short_code",
      sasWords: ["acid", "acorn", "acre", "afar", "affix"],
      sasFingerprint: "0123456789ab",
      claimedHostDisplayName: "Studio Host",
      claimedHostPlatform: { os: "darwin", arch: "arm64" },
      claimedHostInstallationFingerprint: Buffer.alloc(16, 0x48).toString("base64url")
    });
    await expect(client.consumeCompletedPair(operationId)).resolves.toEqual({
      operationId,
      pairId: Buffer.alloc(16, 0x49).toString("base64url"),
      hostDisplayName: "Studio Host",
      hostPlatform: { os: "darwin", arch: "arm64" },
      hostInstallationPublicKey: Buffer.alloc(32, 0x4a).toString("base64url"),
      hostInstallationFingerprint: deriveInstallationFingerprint(Buffer.alloc(32, 0x4a))
        .toString("base64url"),
      hostTrustEpoch: "7",
      pairedAt: "1786271000"
    });
    await expect(client.cancelPair(operationId)).resolves.toEqual({
      operationId,
      cancelled: true
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("validates and returns the complete host identity-reset receipt", async () => {
    const request = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const oldFingerprint = Buffer.alloc(16, 0x74).toString("base64url");

    await expect(client.resetIdentity({
      resetTombstone: "19",
      expectedOldFingerprint: oldFingerprint
    })).resolves.toEqual({
      version: 1,
      resetTombstone: "19",
      resetId: Buffer.alloc(16, 0x71).toString("base64url"),
      oldInstallationPublicKey: Buffer.alloc(32, 0x72).toString("base64url"),
      newInstallationPublicKey: Buffer.alloc(32, 0x73).toString("base64url"),
      oldFingerprint,
      newFingerprint: Buffer.alloc(16, 0x75).toString("base64url"),
      clearedActivationCount: "1",
      clearedPairCount: "2",
      clearedHostRoleSecretCount: "3",
      clearedRemoteRoleSecretCount: "4",
      stage: "complete",
      completedAt: "1786270950"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("queries one exact identity-reset tombstone for crash recovery", async () => {
    const request = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;

    await expect(client.getResetStatus({ resetTombstone: "19" })).resolves.toMatchObject({
      version: 1,
      resetTombstone: "19",
      oldFingerprint: Buffer.alloc(16, 0x74).toString("base64url"),
      newFingerprint: Buffer.alloc(16, 0x75).toString("base64url"),
      stage: "complete",
      completedAt: "1786270950"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("preserves the typed sibling-daemon reset failure without helper detail", async () => {
    const request = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_RESET_SIBLING: "1"
    });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;

    await expect(client.resetIdentity({
      resetTombstone: "19",
      expectedOldFingerprint: Buffer.alloc(16, 0x74).toString("base64url")
    })).rejects.toMatchObject({
      code: "sibling_daemon_running",
      message: "Helper rejected the identity reset command."
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("requires one canonical host selection for a remote runtime", async () => {
    const baseRequest = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const request: HelperLaunchRequest = { ...baseRequest, role: "remote" };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const pairId = Buffer.alloc(16, 0x62).toString("base64url");
    const gatewayLaunchId = Buffer.alloc(32, 0x63).toString("base64url");

    await client.identityStatus();
    await expect(client.startRuntime()).rejects.toMatchObject({ code: "helper_incompatible" });
    await expect(client.startRuntime(pairId)).resolves.toMatchObject({
      controlState: "connected",
      directState: "reconnecting"
    });
    await expect(client.registerGatewayLaunch(gatewayLaunchId, "1786271400"))
      .resolves.toBeUndefined();
    await expect(client.listDevices()).rejects.toMatchObject({
      code: "helper_incompatible"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("correlates remote remembered-host revocation and forget to the exact helper pair", async () => {
    const baseRequest = await launchRequest({ FAKE_HELPER_RUNTIME: "1" });
    const launch = await new ProtectedHelperProcessFactory().launch({ ...baseRequest, role: "remote" });
    const client = await launch.authenticated;
    const pairId = Buffer.alloc(16, 0x64).toString("base64url");

    await expect(client.requestSignedSelfRevocation(pairId)).resolves.toBe(true);
    await expect(client.forgetRememberedHost(pairId)).resolves.toBeUndefined();
    await expect(client.forgetRememberedHost("not-a-pair-id")).rejects.toThrow();

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("rejects a helper that substitutes the pair on a forget result", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_SWAP_REMEMBERED_PAIR: "1"
    });
    const launch = await new ProtectedHelperProcessFactory().launch({ ...baseRequest, role: "remote" });
    const client = await launch.authenticated;
    const pairId = Buffer.alloc(16, 0x64).toString("base64url");

    await expect(client.forgetRememberedHost(pairId)).rejects.toMatchObject({
      code: "helper_incompatible"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("does not let a remote-role client attach the host Fastify bridge", async () => {
    const baseRequest = await launchRequest();
    const request: HelperLaunchRequest = { ...baseRequest, role: "remote" };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const app = fastify({ logger: false });
    registerInternalDispatchReceiver(app);
    const bridge = new RemoteRequestBridge(app);

    expect(() => client.attachRequestBridge(bridge)).toThrowError(
      "Only a host-role helper client may attach the Fastify request bridge."
    );

    await client.close();
    bridge.close();
    await app.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("opens a Node-created odd remote request stream and returns its streamed response", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-request-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/remote-access/dashboard-manifest?source=remote";
    const browserContext = {
      version: 1 as const,
      gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
      requestNonce: Buffer.alloc(16, 0x65).toString("base64url"),
      method: "GET" as const,
      canonicalTarget,
      csrfValidated: true as const
    };

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    await client.registerGatewayLaunch(browserContext.gatewayLaunchId, "1786271400");
    const response = await client.request({
      method: "GET",
      canonicalTarget,
      headers: [["accept", "application/json"]],
      browserContext
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));

    expect(response).toMatchObject({
      statusCode: 206,
      statusMessage: "Partial Content",
      headers: [["content-type", "application/json"], ["x-helper-probe", "yes"]]
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe('{"ok":true}');
    expect(JSON.parse(await readEventually(resultPath))).toEqual({
      streamId: "1",
      requestStart: {
        version: 1,
        method: "GET",
        canonicalTarget,
        headers: [["accept", "application/json"]],
        browserContext
      },
      body: "",
      cancelled: false,
      requestEnded: true
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("rejects a remote request whose encoded header block exceeds 16 KiB", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1"
    });
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: path.join(baseRequest.dataRoot, "oversized-request-headers.json")
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/header-limit";

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    try {
      await expect(client.request({
        method: "GET",
        canonicalTarget,
        headers: [
          ["x-first", "a".repeat(8_192)],
          ["x-second", "b".repeat(8_192)]
        ],
        browserContext: {
          version: 1,
          gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
          browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
          requestNonce: Buffer.alloc(16, 0x6b).toString("base64url"),
          method: "GET",
          canonicalTarget,
          csrfValidated: true
        }
      })).rejects.toThrow("Encoded HTTP headers exceed 16 KiB.");
    } finally {
      await client.close();
      await launch.closeParentChannel();
      await launch.forceTerminate();
      await launch.exited;
    }
  });

  unixIt("rejects a 129th remote request without sending an untracked stream", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_STREAM_LIMIT: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-stream-limit-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const gatewayLaunchId = Buffer.alloc(32, 0x63).toString("base64url");
    const browserSessionId = Buffer.alloc(32, 0x64).toString("base64url");
    const openRequest = (index: number) => {
      const canonicalTarget = `/api/stream-limit/${index}`;
      return client.request({
        method: "GET",
        canonicalTarget,
        headers: [],
        browserContext: {
          version: 1,
          gatewayLaunchId,
          browserSessionId,
          requestNonce: Buffer.alloc(16, index + 1).toString("base64url"),
          method: "GET",
          canonicalTarget,
          csrfValidated: true
        }
      });
    };
    const active: Promise<unknown>[] = [];

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    try {
      for (let index = 0; index < 128; index += 1) {
        const pending = openRequest(index);
        void pending.catch(() => undefined);
        active.push(pending);
      }
      await expect(within(
        openRequest(128),
        500,
        "local stream-limit rejection"
      )).rejects.toMatchObject({
        name: "HelperStreamError",
        code: "stream_limit"
      });
      expect(JSON.parse(await readEventually(resultPath))).toEqual({
        started: 128,
        overflowSent: false
      });
      await expect(client.runtimeStatus()).resolves.toMatchObject({
        controlState: "connected"
      });
    } finally {
      await client.close();
      await Promise.allSettled(active);
      await launch.closeParentChannel();
      await launch.forceTerminate();
      await launch.exited;
    }
  });

  unixIt("contains an aborted remote request and keeps the authenticated connection usable", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_WAIT_FOR_CANCEL: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-cancel-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/events";
    const controller = new AbortController();

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    const pending = client.request({
      method: "GET",
      canonicalTarget,
      headers: [["accept", "text/event-stream"]],
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
        requestNonce: Buffer.alloc(16, 0x67).toString("base64url"),
        method: "GET",
        canonicalTarget,
        csrfValidated: true
      },
      signal: controller.signal
    });
    controller.abort(new Error("browser disconnected"));

    await expect(pending).rejects.toMatchObject({
      name: "HelperStreamError",
      code: "cancelled"
    });
    await expect(client.runtimeStatus()).resolves.toMatchObject({
      controlState: "connected"
    });
    expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
      streamId: "1",
      cancelled: true,
      requestEnded: false
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("surfaces direct-only response failure without failing over or dropping control", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_RESPONSE_ERROR: "direct_unavailable"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-direct-unavailable-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/status";

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    await expect(client.request({
      method: "GET",
      canonicalTarget,
      headers: [],
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
        requestNonce: Buffer.alloc(16, 0x6d).toString("base64url"),
        method: "GET",
        canonicalTarget,
        csrfValidated: true
      }
    })).rejects.toMatchObject({
      name: "HelperStreamError",
      code: "direct_unavailable",
      message: "direct connection unavailable"
    });
    expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
      streamId: "1",
      requestEnded: true
    });
    await expect(client.runtimeStatus()).resolves.toMatchObject({
      controlState: "connected"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("streams an upload beyond initial credit and resumes from helper window updates", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_RESULT_BODY_MODE: "digest"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-upload-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/import";
    const browserContext = {
      version: 1 as const,
      gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
      browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
      requestNonce: Buffer.alloc(16, 0x66).toString("base64url"),
      method: "POST" as const,
      canonicalTarget,
      csrfValidated: true as const
    };
    const upload = Buffer.alloc(1_114_113, 0x61);

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    const response = await client.request({
      method: "POST",
      canonicalTarget,
      headers: [["content-type", "application/octet-stream"]],
      browserContext,
      body: Readable.from([upload])
    });
    for await (const _chunk of response.body) {
      // Drain the fake response so the logical stream reaches its terminal state.
    }

    expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
      streamId: "1",
      bodyBytes: 1_114_113,
      bodySha256: "139063b571c84d332f99cf5e07281b1aea967fb89236a10ca8c2cd1c216ee7b2"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("cancels only the remote stream when its response consumer disconnects", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_STREAM_UNTIL_CANCEL: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-response-cancel-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/download";

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    try {
      const response = await within(client.request({
        method: "GET",
        canonicalTarget,
        headers: [["accept", "application/octet-stream"]],
        browserContext: {
          version: 1,
          gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
          browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
          requestNonce: Buffer.alloc(16, 0x68).toString("base64url"),
          method: "GET",
          canonicalTarget,
          csrfValidated: true
        }
      }), 2_000, "remote streaming response");
      response.body.destroy();

      expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
        streamId: "1",
        responseCancelled: true
      });
      await expect(client.runtimeStatus()).resolves.toMatchObject({
        controlState: "connected"
      });
    } finally {
      await client.close();
      await launch.closeParentChannel();
      await launch.forceTerminate();
      await launch.exited;
    }
  });

  unixIt("contains a malformed remote response without answering as the responder", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_PROTOCOL_ERROR: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-protocol-error-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/malformed";

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    await expect(client.request({
      method: "GET",
      canonicalTarget,
      headers: [],
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
        requestNonce: Buffer.alloc(16, 0x69).toString("base64url"),
        method: "GET",
        canonicalTarget,
        csrfValidated: true
      }
    })).rejects.toThrow("Helper stream protocol failed.");
    expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
      streamId: "1",
      requestEnded: true
    });
    await expect(client.runtimeStatus()).resolves.toMatchObject({
      controlState: "connected"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("fails closed when remote response headers exceed the 16 KiB contract", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_OVERSIZED_RESPONSE_HEADERS: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "oversized-response-headers.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/header-limit";

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    await expect(client.request({
      method: "GET",
      canonicalTarget,
      headers: [],
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
        requestNonce: Buffer.alloc(16, 0x6c).toString("base64url"),
        method: "GET",
        canonicalTarget,
        csrfValidated: true
      }
    })).rejects.toMatchObject({
      code: "helper_incompatible"
    });
    await expect(client.runtimeStatus()).rejects.toMatchObject({
      code: "helper_unavailable"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.forceTerminate();
    await launch.exited;
  });

  unixIt("keeps an early successful response when the helper closes an active upload", async () => {
    const baseRequest = await launchRequest({
      FAKE_HELPER_RUNTIME: "1",
      FAKE_HELPER_REMOTE_REQUEST: "1",
      FAKE_HELPER_REMOTE_EARLY_RESPONSE: "1"
    });
    const resultPath = path.join(baseRequest.dataRoot, "remote-early-response-result.json");
    const request: HelperLaunchRequest = {
      ...baseRequest,
      role: "remote",
      environment: {
        ...baseRequest.environment,
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const canonicalTarget = "/api/import";
    const upload = new Readable({ read() {} });
    upload.on("error", () => {});

    await client.identityStatus();
    await client.startRuntime(Buffer.alloc(16, 0x62).toString("base64url"));
    upload.push(Buffer.alloc(65_536, 0x61));
    const response = await client.request({
      method: "POST",
      canonicalTarget,
      headers: [["content-type", "application/octet-stream"]],
      browserContext: {
        version: 1,
        gatewayLaunchId: Buffer.alloc(32, 0x63).toString("base64url"),
        browserSessionId: Buffer.alloc(32, 0x64).toString("base64url"),
        requestNonce: Buffer.alloc(16, 0x6a).toString("base64url"),
        method: "POST",
        canonicalTarget,
        csrfValidated: true
      },
      body: upload
    });
    const responseChunks: Buffer[] = [];
    for await (const chunk of response.body) responseChunks.push(Buffer.from(chunk));

    expect(response.statusCode).toBe(413);
    expect(Buffer.concat(responseChunks)).toHaveLength(0);
    expect(upload.destroyed).toBe(true);
    expect(JSON.parse(await readEventually(resultPath))).toMatchObject({
      streamId: "1",
      bodyBytes: 65_536,
      requestEnded: true
    });
    await expect(client.runtimeStatus()).resolves.toMatchObject({
      controlState: "connected"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("multiplexes a helper-created HTTP stream beside connection commands", async () => {
    const baseRequest = await launchRequest();
    const resultPath = path.join(baseRequest.dataRoot, "probe-result.json");
    const request = {
      ...baseRequest,
      environment: {
        FAKE_HELPER_RUNTIME: "1",
        FAKE_HELPER_REQUEST: "1",
        FAKE_HELPER_DELAY_REQUEST_END_UNTIL_RESPONSE: "1",
        FAKE_HELPER_RESULT_PATH: resultPath
      }
    };
    const app = fastify({ logger: false });
    registerInternalDispatchReceiver(app);
    app.get("/probe", async (incoming, reply) => {
      reply.code(207).header("x-host-safe", "yes");
      return { query: incoming.query, header: incoming.headers["x-probe"] };
    });
    const bridge = new RemoteRequestBridge(app);
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    client.attachRequestBridge(bridge);

    await client.identityStatus();
    await client.startRuntime();
    await client.runtimeStatus();
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    expect(result.responseStart).toMatchObject({
      version: 1,
      statusCode: 207,
      headers: expect.arrayContaining([["x-host-safe", "yes"]])
    });
    expect(JSON.parse(result.body)).toEqual({
      query: { source: "helper" },
      header: "present"
    });

    await client.close();
    bridge.close();
    await app.close();
    await launch.closeParentChannel();
    await launch.exited;
  });

  unixIt("rejects an activation result that is not correlated to its request", async () => {
    const request = await launchRequest({
      FAKE_HELPER_ACTIVATION: "1",
      FAKE_HELPER_ACTIVATION_MISMATCH: "1"
    });
    const launch = await new ProtectedHelperProcessFactory().launch(request);
    const client = await launch.authenticated;
    const operationId = Buffer.alloc(32, 0x61).toString("base64url");

    await expect(client.beginActivation(operationId)).rejects.toMatchObject({
      code: "helper_incompatible"
    });

    await client.close();
    await launch.closeParentChannel();
    await launch.exited;
  });
});
