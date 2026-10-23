import net from "node:net";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import { startBackend, type RunningBackend } from "../src/backend/server.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { RemoteComponentCompatibilityError } from "../src/remote/componentCompatibility.js";
import { HelperSupervisorError } from "../src/remote/helperTypes.js";
import {
  createHostHelperSupervisor,
  UnavailableHelperSupervisor
} from "../src/backend/remoteAccess/hostHelperSupervisor.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const compatibility = vi.hoisted(() => ({ fail: false }));

vi.mock("../src/remote/componentCompatibility.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/remote/componentCompatibility.js")>();
  return {
    ...original,
    loadRemoteCompatibilityV1: vi.fn(async (...args: Parameters<typeof original.loadRemoteCompatibilityV1>) => {
      if (compatibility.fail) {
        throw new original.RemoteComponentCompatibilityError(
          "Remote compatibility metadata does not match the running app version."
        );
      }
      return original.loadRemoteCompatibilityV1(...args);
    })
  };
});

let roots: string[] = [];
let backends: RunningBackend[] = [];

afterEach(async () => {
  compatibility.fail = false;
  await Promise.all(backends.splice(0).map((backend) => backend.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("remote access never blocks host boot", () => {
  it("boots with disabled remote access when the compatibility table is unusable", async () => {
    compatibility.fail = true;
    const root = await initializedRemoteRoot();
    const backend = await startDecoupledBackend(root);

    expect((await fetch(`${backend.url}/api/health`)).status).toBe(200);
    expect(backend.runtime.remoteAccess).toEqual({
      version: 1,
      enabled: false,
      helperState: "disabled",
      activationState: "activation_required",
      controlState: "inactive",
      directState: "inactive",
      trustedDeviceCount: 0,
      lastDirectAt: null,
      lastErrorCode: "helper_incompatible"
    });
  });

  it("keeps the host online but fails remote closed when it is enabled at boot", async () => {
    compatibility.fail = true;
    const root = await initializedRemoteRoot();
    await activateRemoteAccess(root, { enabled: true });
    const backend = await startDecoupledBackend(root);

    expect((await fetch(`${backend.url}/api/health`)).status).toBe(200);
    expect(backend.runtime.remoteAccess).toMatchObject({
      enabled: true,
      helperState: "failed",
      controlState: "unavailable",
      directState: "direct_unavailable",
      lastErrorCode: "helper_incompatible"
    });
    expect(await backend.remoteAccess.isAuthorized({
      deviceId: "remote-device-01",
      trustEpoch: "1"
    } as never)).toBe(false);
  });

  it("surfaces the unavailable reason when remote access is enabled later", async () => {
    compatibility.fail = true;
    const root = await initializedRemoteRoot();
    await activateRemoteAccess(root, { enabled: false });
    const backend = await startDecoupledBackend(root);

    const config = await backend.remoteAccess.updateConfig({ revision: "1", enabled: true });
    expect(config.enabled).toBe(true);
    expect(backend.runtime.remoteAccess).toMatchObject({
      enabled: true,
      helperState: "failed",
      lastErrorCode: "helper_incompatible"
    });
    const diagnostics = await backend.remoteAccess.diagnostics();
    expect(diagnostics.lastErrorCode).toBe("helper_incompatible");
  });
});

describe("host helper supervisor factory", () => {
  it("returns an unavailable supervisor on unsupported platforms without loading the helper", async () => {
    const root = await initializedRemoteRoot();
    const logger = quietLogger();
    const supervisor = await createHostHelperSupervisor({
      role: "host",
      dataRoot: root,
      appVersion: "2.111.2",
      buildId: "a".repeat(64),
      logger,
      platform: "darwin",
      arch: "x64"
    });

    expect(supervisor).toBeInstanceOf(UnavailableHelperSupervisor);
    expect(supervisor.unavailableReason?.()).toBe("unsupported_platform");
    expect(logger.warn).toHaveBeenCalledWith(
      "Remote access helper unavailable",
      { role: "host", code: "unsupported_platform" }
    );
  });

  it("maps compatibility failures to helper_incompatible", async () => {
    compatibility.fail = true;
    const root = await initializedRemoteRoot();
    const supervisor = await createHostHelperSupervisor({
      role: "host",
      dataRoot: root,
      appVersion: "2.111.2",
      buildId: "a".repeat(64),
      logger: quietLogger(),
      platform: "darwin",
      arch: "arm64"
    });

    expect(supervisor.unavailableReason?.()).toBe("helper_incompatible");
  });

  it("fails every helper operation closed with the recorded reason", async () => {
    const supervisor = new UnavailableHelperSupervisor("helper_incompatible");
    const snapshot = supervisor.snapshot();
    expect(snapshot).toMatchObject({
      state: "disabled",
      lastErrorCode: "helper_incompatible",
      restartScheduled: false,
      consecutiveFailures: 0
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(supervisor.identityStatus()).toBeNull();
    for (const operation of [
      () => supervisor.start(),
      () => supervisor.reconnect(),
      () => supervisor.startRuntime(),
      () => supervisor.runtimeStatus(),
      () => supervisor.reconnectRuntime(),
      () => supervisor.stopRuntime(),
      () => supervisor.registerGatewayLaunch("launch", "1"),
      () => supervisor.beginActivation("operation"),
      () => supervisor.pollActivation("operation"),
      () => supervisor.cancelActivation("operation")
    ]) {
      const error = await operation().then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(HelperSupervisorError);
      expect((error as HelperSupervisorError).code).toBe("helper_incompatible");
    }
    await expect(supervisor.stop()).resolves.toBeUndefined();
    await expect(supervisor.close()).resolves.toBeUndefined();
  });

  it("never treats a compatibility error as anything but a closed enum code", () => {
    const error = new RemoteComponentCompatibilityError("/private/path must not leak");
    expect(UnavailableHelperSupervisor.reasonFor(error)).toBe("helper_incompatible");
    expect(UnavailableHelperSupervisor.reasonFor(
      new HelperSupervisorError("unsupported_platform", "x")
    )).toBe("unsupported_platform");
    expect(UnavailableHelperSupervisor.reasonFor(new Error("other"))).toBe("helper_unavailable");
  });
});

async function initializedRemoteRoot(): Promise<string> {
  const root = await makeTempRoot("waifus-remote-decoupling-");
  roots.push(root);
  await ensureDataLayout(root);
  return root;
}

async function activateRemoteAccess(root: string, options: { enabled: boolean }): Promise<void> {
  const paths = remoteStatePaths(root);
  const config = JSON.parse(await readFile(paths.hostConfig, "utf8")) as Record<string, unknown>;
  await writeFile(paths.hostConfig, JSON.stringify({
    ...config,
    revision: "1",
    enabled: options.enabled,
    updatedAt: "1"
  }, null, 2) + "\n", { mode: 0o600 });
  const installation = JSON.parse(
    await readFile(paths.installation, "utf8")
  ) as Record<string, unknown>;
  await writeFile(paths.installation, JSON.stringify({
    ...installation,
    activationReference: `waifus.activation.v1.${String(installation.installationId)}`
  }, null, 2) + "\n", { mode: 0o600 });
}

async function startDecoupledBackend(root: string): Promise<RunningBackend> {
  const backend = await startBackend({
    dataRoot: root,
    host: "127.0.0.1",
    port: await freePort(),
    mode: "test",
    logger: quietLogger(),
    remoteAccess: {
      dashboard: {
        path: path.resolve("dist-frontend"),
        source: "bundled",
        buildId: "a".repeat(64)
      }
    }
  });
  backends.push(backend);
  return backend;
}

function quietLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || !address) {
        server.close(() => reject(new Error("Could not allocate test port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
