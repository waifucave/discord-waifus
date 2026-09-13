import { lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Logger } from "../src/backend/logger.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { ProtectedHelperProcessFactory } from "../src/remote/helperClient.js";
import { HelperSupervisor } from "../src/remote/helperSupervisor.js";
import type {
  HelperLaunchRequest,
  HelperPackageResolver,
  HelperProcessFactory
} from "../src/remote/helperTypes.js";
import { remoteRolePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const fixture = fileURLToPath(new URL("./fixtures/fakeSupervisedHelper.mjs", import.meta.url));
const requiredCapabilities = [
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

class FixtureProcessFactory implements HelperProcessFactory {
  readonly launches: Array<{
    role: "host" | "remote";
    endpoint: string;
    capability: Buffer;
    endpointMode?: number;
  }> = [];
  readonly #delegate = new ProtectedHelperProcessFactory();

  async launch(request: HelperLaunchRequest) {
    const record = {
      role: request.role,
      endpoint: request.parentEndpoint,
      capability: Buffer.from(request.parentCapability)
    };
    this.launches.push(record);
    const launch = await this.#delegate.launch({
      ...request,
      argv: [fixture, ...request.argv],
      environment: { FAKE_HELPER_RUNTIME: "1" }
    });
    record.endpointMode = (await lstat(request.parentEndpoint)).mode & 0o777;
    return launch;
  }
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

function supervisor(
  role: "host" | "remote",
  dataRoot: string,
  processFactory: HelperProcessFactory
): HelperSupervisor {
  const packageResolver: HelperPackageResolver = {
    resolve: async () => ({
      binaryPath: process.execPath,
      helperVersion: "0.1.0",
      releaseSequence: "42" as never,
      forkCommit: "0123456789abcdef0123456789abcdef01234567",
      target: { os: "darwin", arch: "arm64" },
      capabilities: [...requiredCapabilities],
      ipcProtocol: {
        minimum: { major: 1, minor: 0 },
        maximum: { major: 1, minor: 0 }
      }
    })
  };
  return new HelperSupervisor({
    role,
    dataRoot,
    appVersion: "1.5.203",
    buildId: "dashboard-build",
    controlProfile: 1,
    runtimePurpose: "normal",
    packageResolver,
    processFactory,
    logger,
    jitter: () => 0
  });
}

const unixIt = process.platform === "win32" ? it.skip : it;

describe("remote-role helper reuse", () => {
  unixIt("runs host and remote supervisors independently on one data root", async () => {
    const root = await makeTempRoot("waifus-helper-coexist-");
    roots.push(root);
    await ensureDataLayout(root);
    const factory = new FixtureProcessFactory();
    const host = supervisor("host", root, factory);
    const remote = supervisor("remote", root, factory);
    const pairId = Buffer.alloc(16, 0x71).toString("base64url");

    try {
      await Promise.all([host.start(), remote.start()]);
      await Promise.all([host.startRuntime(), remote.startRuntime(pairId)]);

      expect(factory.launches).toHaveLength(2);
      const hostLaunch = factory.launches.find((entry) => entry.role === "host")!;
      const remoteLaunch = factory.launches.find((entry) => entry.role === "remote")!;
      expect(hostLaunch.endpoint).toBe(remoteRolePaths(root, "host").parentEndpoint);
      expect(remoteLaunch.endpoint).toBe(remoteRolePaths(root, "remote").parentEndpoint);
      expect(hostLaunch.endpoint).not.toBe(remoteLaunch.endpoint);
      expect(hostLaunch.capability.equals(remoteLaunch.capability)).toBe(false);
      expect(hostLaunch.capability.equals(Buffer.alloc(32))).toBe(false);
      expect(remoteLaunch.capability.equals(Buffer.alloc(32))).toBe(false);
      expect(hostLaunch.endpointMode).toBe(0o600);
      expect(remoteLaunch.endpointMode).toBe(0o600);

      await host.stop();
      expect(host.snapshot().state).toBe("disabled");
      expect(remote.snapshot().state).toBe("ready");
      await expect(remote.runtimeStatus()).resolves.toMatchObject({
        controlState: "connected",
        directState: "reconnecting"
      });

      await host.start();
      await host.startRuntime();
      expect(host.snapshot().state).toBe("ready");
      await remote.stop();
      expect(remote.snapshot().state).toBe("disabled");
      await expect(host.runtimeStatus()).resolves.toMatchObject({
        controlState: "connected",
        directState: "reconnecting"
      });
    } finally {
      await Promise.all([host.close(), remote.close()]);
    }
  });
});
