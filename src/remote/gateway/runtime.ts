import { randomBytes as cryptoRandomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RemoteBrowserContextV1 } from "../../shared/schemas/remoteProtocol.js";
import {
  RemoteOriginStore,
  type RemoteOriginBinding
} from "./originStore.js";
import {
  startRemoteGateway,
  type RemoteGatewaySurface,
  type RemoteGatewayHandlerSecurity,
  type RunningRemoteGateway
} from "./server.js";
import type { RemoteBrowserSessionStoreOptions } from "./session.js";

const DYNAMIC_PORT_START = 49_152;
const DYNAMIC_PORT_COUNT = 16_384;

export type StartRemoteGatewayRuntimeOptions = RemoteBrowserSessionStoreOptions & {
  readonly dataRoot: string;
  readonly pinnedHostId: string;
  readonly hostTrustEpoch: string;
  readonly surface?: RemoteGatewaySurface;
  readonly frameAncestorOrigin?: string | (() => string | undefined);
  readonly bootstrapRedirectPath?: string;
  readonly registerGatewayLaunch: (gatewayLaunchId: string, expiresAt: string) => Promise<void>;
  readonly handleAuthenticatedRequest?: (
    request: FastifyRequest,
    reply: FastifyReply,
    browserContext: RemoteBrowserContextV1,
    security: RemoteGatewayHandlerSecurity
  ) => unknown | Promise<unknown>;
};

export type RunningRemoteGatewayRuntime = RunningRemoteGateway & Readonly<{
  originBinding: RemoteOriginBinding;
}>;

function isAddressInUse(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate instanceof Error; depth += 1) {
    if ((candidate as NodeJS.ErrnoException).code === "EADDRINUSE") return true;
    candidate = (candidate as Error & { cause?: unknown }).cause;
  }
  return false;
}

function initialPort(randomBytes: (size: number) => Uint8Array): number {
  const bytes = Buffer.from(randomBytes(2));
  if (bytes.byteLength !== 2) {
    throw new TypeError("Remote gateway port random source must return exactly 2 bytes.");
  }
  return DYNAMIC_PORT_START + (bytes.readUInt16BE(0) % DYNAMIC_PORT_COUNT);
}

export async function startRemoteGatewayRuntime(
  options: StartRemoteGatewayRuntimeOptions
): Promise<RunningRemoteGatewayRuntime> {
  const random = options.randomBytes ?? cryptoRandomBytes;
  const origins = new RemoteOriginStore(options.dataRoot, { randomBytes: random });
  let state = await origins.getState();
  if (state.preferredPort === null) {
    await origins.initializePreferredPort(initialPort(random));
    state = await origins.getState();
  }
  if (state.preferredPort === null) throw new Error("Remote gateway preferred port was not persisted.");
  let binding = await origins.allocateOrReuse(options.pinnedHostId, options.hostTrustEpoch);
  const common = {
    surface: options.surface,
    frameAncestorOrigin: options.frameAncestorOrigin,
    bootstrapRedirectPath: options.bootstrapRedirectPath,
    now: options.now,
    randomBytes: options.randomBytes,
    maxSessions: options.maxSessions,
    maxBootstrapTokens: options.maxBootstrapTokens,
    beforeExpose: async (launch: Readonly<{
      gatewayLaunchId: string;
      expiresAt: string;
    }>) => options.registerGatewayLaunch(launch.gatewayLaunchId, launch.expiresAt),
    handleAuthenticatedRequest: options.handleAuthenticatedRequest
  };

  let gateway: RunningRemoteGateway;
  try {
    gateway = await startRemoteGateway({
      ...common,
      hostname: binding.hostname,
      port: binding.port
    });
  } catch (error) {
    if (!isAddressInUse(error)) throw error;
    const expectedOriginEpoch = binding.localOriginEpoch;
    gateway = await startRemoteGateway({
      ...common,
      port: 0,
      resolveHostnameAfterBind: async (replacementPort) => {
        binding = await origins.rotateForPortFailover(
          options.pinnedHostId,
          expectedOriginEpoch,
          replacementPort
        );
        return binding.hostname;
      }
    });
  }

  return Object.freeze({
    ...gateway,
    originBinding: binding
  });
}
