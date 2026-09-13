import { createHash, createHmac, randomBytes as cryptoRandomBytes } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  MAX_REMEMBERED_HOSTS
} from "../../shared/schemas/remoteLifecycle.js";
import { PositiveUint64DecimalSchema } from "../../shared/schemas/remoteAccess.js";
import {
  Base64Url32BytesSchema,
  UINT64_MAX,
  Uint64DecimalSchema
} from "../../shared/schemas/remoteProtocol.js";
import { atomicWriteJson, recoverAtomicWriteTemps } from "../../storage/atomic.js";
import { ResourceLockManager } from "../../storage/locks.js";
import { remoteStatePaths } from "../paths.js";

const HOST_ID_DOMAIN = Buffer.from("waifus/host-id/v1", "ascii");
const ORIGIN_DOMAIN = Buffer.from("waifus/origin/v1", "ascii");
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const originStateLocks = new ResourceLockManager();

const RemoteOriginHostV1Schema = z.object({
  pinnedHostId: Base64Url32BytesSchema,
  hostTrustEpoch: PositiveUint64DecimalSchema,
  localOriginEpoch: PositiveUint64DecimalSchema,
  port: z.number().int().min(1).max(65_535)
}).strict();

export const RemoteOriginStateV1Schema = z.object({
  version: z.literal(1),
  localOriginSeed: Base64Url32BytesSchema,
  originEpochHighWater: Uint64DecimalSchema,
  preferredPort: z.number().int().min(1).max(65_535).nullable(),
  hosts: z.array(RemoteOriginHostV1Schema).max(MAX_REMEMBERED_HOSTS)
}).strict().superRefine((value, context) => {
  const highWater = BigInt(value.originEpochHighWater);
  const hostIds = new Set<string>();
  const originEpochs = new Set<string>();
  let previousHostId: string | undefined;
  for (const [index, host] of value.hosts.entries()) {
    if (hostIds.has(host.pinnedHostId)) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "pinnedHostId"],
        message: "Remote origin host IDs must be unique."
      });
    }
    hostIds.add(host.pinnedHostId);
    if (originEpochs.has(host.localOriginEpoch)) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "localOriginEpoch"],
        message: "Remote origin epochs must be unique."
      });
    }
    originEpochs.add(host.localOriginEpoch);
    if (BigInt(host.localOriginEpoch) > highWater) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "localOriginEpoch"],
        message: "Remote origin epoch exceeds the global high-water mark."
      });
    }
    if (value.preferredPort === null || host.port !== value.preferredPort) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "port"],
        message: "Remote origin binding must use the current preferred port."
      });
    }
    if (
      previousHostId !== undefined
      && Buffer.compare(decode32(previousHostId), decode32(host.pinnedHostId)) >= 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "pinnedHostId"],
        message: "Remote origin host bindings must be bytewise sorted."
      });
    }
    previousHostId = host.pinnedHostId;
  }
});

export type RemoteOriginStateV1 = z.infer<typeof RemoteOriginStateV1Schema>;

export type RemoteOriginBinding = Readonly<{
  pinnedHostId: string;
  hostTrustEpoch: string;
  localOriginEpoch: string;
  hostname: string;
  port: number;
  origin: string;
}>;

export type RemoteOriginStoreErrorCode =
  | "origin_binding_conflict"
  | "origin_epoch_exhausted"
  | "origin_host_limit"
  | "origin_port_uninitialized"
  | "origin_state_invalid"
  | "origin_state_untrusted"
  | "preferred_port_conflict";

export class RemoteOriginStoreError extends Error {
  constructor(
    readonly code: RemoteOriginStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RemoteOriginStoreError";
  }
}

export type RemoteOriginStoreOptions = {
  readonly randomBytes?: (size: number) => Uint8Array;
};

function fail(code: RemoteOriginStoreErrorCode, message: string): never {
  throw new RemoteOriginStoreError(code, message);
}

function decode32(value: string): Buffer {
  return Buffer.from(Base64Url32BytesSchema.parse(value), "base64url");
}

function encodeBase32(bytes: Uint8Array): string {
  let accumulator = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return encoded;
}

function epochBytes(value: string): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(BigInt(PositiveUint64DecimalSchema.parse(value)));
  return bytes;
}

function validate32Bytes(value: Uint8Array, label: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.byteLength !== 32) throw new TypeError(`${label} must contain exactly 32 bytes.`);
  return bytes;
}

export function derivePinnedHostId(installationPublicKey: Uint8Array): string {
  const publicKey = validate32Bytes(installationPublicKey, "Installation public key");
  return createHash("sha256").update(HOST_ID_DOMAIN).update(publicKey).digest("base64url");
}

export function deriveRemoteOriginHostname(
  localOriginSeed: Uint8Array,
  pinnedHostId: string,
  localOriginEpoch: string
): string {
  const seed = validate32Bytes(localOriginSeed, "Local origin seed");
  const digest = createHmac("sha256", seed)
    .update(ORIGIN_DOMAIN)
    .update(Buffer.from([0]))
    .update(decode32(pinnedHostId))
    .update(epochBytes(localOriginEpoch))
    .digest();
  const label = encodeBase32(digest);
  if (label.length !== 52) throw new Error("Remote origin digest did not encode to 52 characters.");
  return `waifus-${label}.localhost`;
}

function cloneState(state: RemoteOriginStateV1): RemoteOriginStateV1 {
  return RemoteOriginStateV1Schema.parse(structuredClone(state));
}

function sortHosts(hosts: RemoteOriginStateV1["hosts"]): RemoteOriginStateV1["hosts"] {
  return [...hosts].sort((left, right) => (
    Buffer.compare(decode32(left.pinnedHostId), decode32(right.pinnedHostId))
  ));
}

export class RemoteOriginStore {
  readonly #stateRoot: string;
  readonly #statePath: string;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(dataRoot: string, options: RemoteOriginStoreOptions = {}) {
    const paths = remoteStatePaths(dataRoot);
    this.#stateRoot = paths.remoteGatewayStateRoot;
    this.#statePath = paths.remoteOriginState;
    this.#randomBytes = options.randomBytes ?? cryptoRandomBytes;
  }

  async getState(): Promise<RemoteOriginStateV1> {
    return originStateLocks.withLock(this.#statePath, async () => {
      const { state, exists } = await this.#readState();
      if (!exists) await this.#writeState(state);
      return cloneState(state);
    });
  }

  async initializePreferredPort(port: number): Promise<void> {
    const validatedPort = this.#validatePort(port);
    await originStateLocks.withLock(this.#statePath, async () => {
      const { state, exists } = await this.#readState();
      if (state.preferredPort !== null && state.preferredPort !== validatedPort) {
        return fail(
          "preferred_port_conflict",
          "Changing the preferred port requires an origin-rotation transaction."
        );
      }
      if (!exists || state.preferredPort === null) {
        await this.#writeState(RemoteOriginStateV1Schema.parse({
          ...state,
          preferredPort: validatedPort
        }));
      }
    });
  }

  async allocateOrReuse(
    pinnedHostIdValue: string,
    hostTrustEpochValue: string
  ): Promise<RemoteOriginBinding> {
    const pinnedHostId = Base64Url32BytesSchema.parse(pinnedHostIdValue);
    const hostTrustEpoch = PositiveUint64DecimalSchema.parse(hostTrustEpochValue);
    return originStateLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      if (state.preferredPort === null) {
        return fail("origin_port_uninitialized", "A preferred loopback port must be selected first.");
      }
      const existing = state.hosts.find((host) => host.pinnedHostId === pinnedHostId);
      if (
        existing
        && existing.hostTrustEpoch === hostTrustEpoch
        && existing.port === state.preferredPort
      ) {
        return this.#binding(state, existing);
      }
      if (!existing && state.hosts.length >= MAX_REMEMBERED_HOSTS) {
        return fail("origin_host_limit", "The remembered-host origin limit has been reached.");
      }
      const localOriginEpoch = this.#nextEpoch(state);
      const host = RemoteOriginHostV1Schema.parse({
        pinnedHostId,
        hostTrustEpoch,
        localOriginEpoch,
        port: state.preferredPort
      });
      const next = RemoteOriginStateV1Schema.parse({
        ...state,
        originEpochHighWater: localOriginEpoch,
        hosts: sortHosts([
          ...state.hosts.filter((candidate) => candidate.pinnedHostId !== pinnedHostId),
          host
        ])
      });
      await this.#writeState(next);
      return this.#binding(next, host);
    });
  }

  async rotateForPortFailover(
    pinnedHostIdValue: string,
    expectedOriginEpochValue: string,
    replacementPortValue: number
  ): Promise<RemoteOriginBinding> {
    const pinnedHostId = Base64Url32BytesSchema.parse(pinnedHostIdValue);
    const expectedOriginEpoch = PositiveUint64DecimalSchema.parse(expectedOriginEpochValue);
    const replacementPort = this.#validatePort(replacementPortValue);
    return originStateLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      const existing = state.hosts.find((host) => host.pinnedHostId === pinnedHostId);
      if (!existing || existing.localOriginEpoch !== expectedOriginEpoch) {
        return fail("origin_binding_conflict", "The selected host origin changed before rotation.");
      }
      if (state.preferredPort === replacementPort) {
        return fail("preferred_port_conflict", "Port failover requires a different loopback port.");
      }
      const localOriginEpoch = this.#nextEpoch(state);
      const host = RemoteOriginHostV1Schema.parse({
        ...existing,
        localOriginEpoch,
        port: replacementPort
      });
      const next = RemoteOriginStateV1Schema.parse({
        ...state,
        originEpochHighWater: localOriginEpoch,
        preferredPort: replacementPort,
        hosts: [host]
      });
      await this.#writeState(next);
      return this.#binding(next, host);
    });
  }

  async forget(pinnedHostIdValue: string, expectedOriginEpochValue: string): Promise<void> {
    const pinnedHostId = Base64Url32BytesSchema.parse(pinnedHostIdValue);
    const expectedOriginEpoch = PositiveUint64DecimalSchema.parse(expectedOriginEpochValue);
    await originStateLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      const existing = state.hosts.find((host) => host.pinnedHostId === pinnedHostId);
      if (!existing || existing.localOriginEpoch !== expectedOriginEpoch) {
        return fail("origin_binding_conflict", "The remembered host origin changed before forget.");
      }
      const highWater = this.#nextEpoch(state);
      await this.#writeState(RemoteOriginStateV1Schema.parse({
        ...state,
        originEpochHighWater: highWater,
        hosts: state.hosts.filter((host) => host.pinnedHostId !== pinnedHostId)
      }));
    });
  }

  #binding(
    state: RemoteOriginStateV1,
    host: RemoteOriginStateV1["hosts"][number]
  ): RemoteOriginBinding {
    if (state.preferredPort === null || host.port !== state.preferredPort) {
      return fail("origin_state_invalid", "Remote origin port state is inconsistent.");
    }
    const hostname = deriveRemoteOriginHostname(
      decode32(state.localOriginSeed),
      host.pinnedHostId,
      host.localOriginEpoch
    );
    return Object.freeze({
      ...host,
      hostname,
      origin: `http://${hostname}:${host.port}`
    });
  }

  #nextEpoch(state: RemoteOriginStateV1): string {
    const current = BigInt(state.originEpochHighWater);
    if (current >= UINT64_MAX) {
      return fail(
        "origin_epoch_exhausted",
        "The local origin epoch is exhausted; reset the installation identity to continue."
      );
    }
    return (current + 1n).toString();
  }

  #validatePort(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new TypeError("Preferred loopback port must be an integer from 1 through 65535.");
    }
    return value;
  }

  async #readState(): Promise<{ state: RemoteOriginStateV1; exists: boolean }> {
    await this.#ensureStateRoot();
    await recoverAtomicWriteTemps(this.#statePath);
    let metadata;
    try {
      metadata = await lstat(this.#statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const generated = validate32Bytes(this.#randomBytes(32), "Generated local origin seed");
        return {
          exists: false,
          state: RemoteOriginStateV1Schema.parse({
            version: 1,
            localOriginSeed: generated.toString("base64url"),
            originEpochHighWater: "0",
            preferredPort: null,
            hosts: []
          })
        };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return fail("origin_state_untrusted", "Remote origin state must be a regular file.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      return fail("origin_state_untrusted", "Remote origin state has the wrong owner.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return fail("origin_state_untrusted", "Remote origin state permissions are too broad.");
    }
    try {
      return {
        exists: true,
        state: RemoteOriginStateV1Schema.parse(JSON.parse(await readFile(this.#statePath, "utf8")))
      };
    } catch (error) {
      if (error instanceof RemoteOriginStoreError) throw error;
      return fail("origin_state_invalid", "Remote origin state is invalid.");
    }
  }

  async #ensureStateRoot(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#stateRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return fail("origin_state_untrusted", "Remote gateway state root must be a directory.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      return fail("origin_state_untrusted", "Remote gateway state root has the wrong owner.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return fail("origin_state_untrusted", "Remote gateway state root permissions are too broad.");
    }
  }

  async #writeState(state: RemoteOriginStateV1): Promise<void> {
    await atomicWriteJson(this.#statePath, RemoteOriginStateV1Schema.parse(state), { mode: 0o600 });
  }
}
