import { chmod, lstat, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ProtectedHelperProcessFactory } from "../src/remote/helperClient.js";
import type { HelperLaunchRequest } from "../src/remote/helperTypes.js";
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
