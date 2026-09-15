import { lstat, readFile } from "node:fs/promises";
import {
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessLocalDenyIndexV1Schema,
  RemoteAccessTrustIndexV1Schema,
  type RemoteAccessLocalDenyEntryV1
} from "../../shared/schemas/remoteAccess.js";
import {
  RemoteAccessConfigV1Schema,
  UpdateRemoteAccessInputV1Schema,
  type RemoteAccessConfigV1,
  type UpdateRemoteAccessInputV1
} from "../../shared/schemas/remoteLifecycle.js";
import { remoteStatePaths } from "../../remote/paths.js";
import { atomicWriteJson } from "../../storage/atomic.js";

export type RemoteAccessPersistedState = {
  readonly config: ReturnType<typeof RemoteAccessConfigV1Schema.parse>;
  readonly installation: ReturnType<typeof RemoteAccessInstallationStateV1Schema.parse>;
  readonly trustIndex: ReturnType<typeof RemoteAccessTrustIndexV1Schema.parse>;
  readonly localDenyIndex: ReturnType<typeof RemoteAccessLocalDenyIndexV1Schema.parse>;
};

export type RemoteAccessDeviceDenialResult = Readonly<{
  created: boolean;
  denial: RemoteAccessLocalDenyEntryV1;
}>;

export class RemoteAccessTrustConflictError extends Error {
  constructor() {
    super("The trusted device changed before its local denial could be persisted.");
    this.name = "RemoteAccessTrustConflictError";
  }
}

export class RemoteAccessRevisionConflictError extends Error {
  constructor(readonly latest: RemoteAccessConfigV1) {
    super("Remote-access configuration changed since it was read.");
    this.name = "RemoteAccessRevisionConflictError";
  }
}

async function readOwnedJson(filePath: string): Promise<unknown> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Remote access state is not an owned regular file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Remote access state is not owned by the current user.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("Remote access state permissions are too broad.");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

export class RemoteAccessStateStore {
  readonly #paths: ReturnType<typeof remoteStatePaths>;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(dataRoot: string) {
    this.#paths = remoteStatePaths(dataRoot);
  }

  async load(): Promise<RemoteAccessPersistedState> {
    const [config, installation, trustIndex, localDenyIndex] = await Promise.all([
      readOwnedJson(this.#paths.hostConfig),
      readOwnedJson(this.#paths.installation),
      readOwnedJson(this.#paths.trustIndex),
      readOwnedJson(this.#paths.localDenyIndex)
    ]);
    return Object.freeze({
      config: Object.freeze(RemoteAccessConfigV1Schema.parse(config)),
      installation: Object.freeze(RemoteAccessInstallationStateV1Schema.parse(installation)),
      trustIndex: Object.freeze(RemoteAccessTrustIndexV1Schema.parse(trustIndex)),
      localDenyIndex: Object.freeze(RemoteAccessLocalDenyIndexV1Schema.parse(localDenyIndex))
    });
  }

  async isAuthorized(deviceId: string, trustEpoch: string): Promise<boolean> {
    try {
      const state = await this.load();
      if (!state.config.enabled) return false;
      const pair = state.trustIndex.pairs.find((candidate) => candidate.deviceId === deviceId);
      if (pair?.trustEpoch !== trustEpoch) return false;
      const denial = state.localDenyIndex.devices.find(
        (candidate) => candidate.deviceId === deviceId
      );
      return !denial || (
        pair.pairId !== denial.pairId
        && BigInt(trustEpoch) > BigInt(denial.denyEpoch)
      );
    } catch {
      return false;
    }
  }

  async denyDevice(
    deviceId: string,
    deniedTrustEpoch: string,
    nowSeconds: bigint
  ): Promise<RemoteAccessDeviceDenialResult> {
    let release!: () => void;
    const prior = this.#mutationTail;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const current = await this.load();
      const existing = current.localDenyIndex.devices.find(
        (candidate) => candidate.deviceId === deviceId
      );
      if (existing?.deniedTrustEpoch === deniedTrustEpoch) {
        return Object.freeze({ created: false, denial: Object.freeze(existing) });
      }
      const pair = current.trustIndex.pairs.find(
        (candidate) => candidate.deviceId === deviceId
      );
      if (!pair || pair.trustEpoch !== deniedTrustEpoch) {
        throw new RemoteAccessTrustConflictError();
      }
      const highWater = [
        BigInt(current.trustIndex.trustEpochHighWater),
        BigInt(current.localDenyIndex.trustEpochHighWater)
      ].reduce((highest, value) => value > highest ? value : highest, 0n);
      if (highWater === 18_446_744_073_709_551_615n) {
        throw new RemoteAccessTrustConflictError();
      }
      const denial = RemoteAccessLocalDenyIndexV1Schema.shape.devices.element.parse({
        deviceId,
        pairId: pair.pairId,
        deniedTrustEpoch,
        denyEpoch: (highWater + 1n).toString(),
        revokedAt: nowSeconds.toString()
      });
      const devices = current.localDenyIndex.devices
        .filter((candidate) => candidate.deviceId !== deviceId)
        .concat(denial)
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
      const next = RemoteAccessLocalDenyIndexV1Schema.parse({
        version: 1,
        trustEpochHighWater: denial.denyEpoch,
        devices
      });
      await atomicWriteJson(this.#paths.localDenyIndex, next, { mode: 0o600 });
      return Object.freeze({ created: true, denial: Object.freeze(denial) });
    } finally {
      release();
    }
  }

  async updateConfig(
    inputValue: UpdateRemoteAccessInputV1,
    nowSeconds: bigint
  ): Promise<RemoteAccessPersistedState> {
    const input = UpdateRemoteAccessInputV1Schema.parse(inputValue);
    let release!: () => void;
    const prior = this.#mutationTail;
    this.#mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const current = await this.load();
      if (current.config.revision !== input.revision) {
        throw new RemoteAccessRevisionConflictError(current.config);
      }
      const nextConfig = RemoteAccessConfigV1Schema.parse({
        ...current.config,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        revision: (BigInt(current.config.revision) + 1n).toString(),
        updatedAt: nowSeconds.toString()
      });
      await atomicWriteJson(this.#paths.hostConfig, nextConfig, { mode: 0o600 });
      return Object.freeze({
        ...current,
        config: Object.freeze(nextConfig)
      });
    } finally {
      release();
    }
  }
}
