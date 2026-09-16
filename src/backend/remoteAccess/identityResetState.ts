import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { z } from "zod";
import {
  IdentityResetReceiptV1Schema,
  PositiveUint64DecimalSchema,
  RemoteAccessInstallationStateV1Schema,
  RemoteAccessLocalDenyIndexV1Schema,
  RemoteAccessTrustIndexV1Schema,
  type IdentityResetReceiptV1,
  type RemoteAccessTrustIndexPairV1
} from "../../shared/schemas/remoteAccess.js";
import { RemoteAccessConfigV1Schema } from "../../shared/schemas/remoteLifecycle.js";
import {
  Base64Url16BytesSchema,
  UINT64_MAX,
  Uint64DecimalSchema
} from "../../shared/schemas/remoteProtocol.js";
import { RemoteDaemonStateSchema } from "../../shared/schemas/remoteRuntime.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { ResourceLockManager } from "../../storage/locks.js";
import { processIsAlive } from "../../cli/processState.js";
import { remoteRolePaths, remoteStatePaths } from "../../remote/paths.js";

const identityResetLocks = new ResourceLockManager();
const DEFAULT_HOST_DISPLAY_NAME = "Discord Waifus Host";

export const IdentityResetTombstoneV1Schema = z.object({
  version: z.literal(1),
  resetTombstone: PositiveUint64DecimalSchema,
  expectedOldFingerprint: Base64Url16BytesSchema,
  stage: z.enum(["reset_pending", "helper_complete", "complete"]),
  requestedAt: Uint64DecimalSchema,
  updatedAt: Uint64DecimalSchema,
  receipt: IdentityResetReceiptV1Schema.nullable()
}).strict().superRefine((value, context) => {
  if (BigInt(value.updatedAt) < BigInt(value.requestedAt)) {
    context.addIssue({
      code: "custom",
      path: ["updatedAt"],
      message: "Identity reset update time cannot precede its request time."
    });
  }
  if (value.stage === "reset_pending" && value.receipt !== null) {
    context.addIssue({
      code: "custom",
      path: ["receipt"],
      message: "A pending Node reset cannot contain a helper receipt."
    });
  }
  if (value.stage !== "reset_pending" && (
    value.receipt === null
    || value.receipt.stage !== "complete"
    || value.receipt.resetTombstone !== value.resetTombstone
    || value.receipt.oldFingerprint !== value.expectedOldFingerprint
  )) {
    context.addIssue({
      code: "custom",
      path: ["receipt"],
      message: "A completed helper reset requires its exact immutable receipt."
    });
  }
});

export type IdentityResetTombstoneV1 = z.infer<typeof IdentityResetTombstoneV1Schema>;

export type PreparedIdentityReset = Readonly<{
  resetTombstone: string;
  expectedOldFingerprint: string;
  pairs: readonly RemoteAccessTrustIndexPairV1[];
}>;

export class IdentityResetSiblingDaemonRunningError extends Error {
  constructor() {
    super("A remote gateway for this data root is still running.");
    this.name = "IdentityResetSiblingDaemonRunningError";
  }
}

export class IdentityResetStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityResetStateError";
  }
}

export type IdentityResetStateOptions = {
  processIsAlive?: (pid: number) => boolean;
};

async function readOwnedJson(filePath: string): Promise<unknown> {
  const metadata = await lstat(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new IdentityResetStateError("Identity reset state must be an owned regular file.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new IdentityResetStateError("Identity reset state has the wrong owner.");
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new IdentityResetStateError("Identity reset state permissions are too broad.");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalOwnedJson(filePath: string): Promise<unknown | undefined> {
  try {
    return await readOwnedJson(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function resetOwnedDirectory(directory: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (metadata) {
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new IdentityResetStateError("Identity reset target must be an owned directory.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new IdentityResetStateError("Identity reset target has the wrong owner.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new IdentityResetStateError("Identity reset target permissions are too broad.");
    }
    await rm(directory, { recursive: true, force: true });
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function removeOwnedFileIfPresent(filePath: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new IdentityResetStateError("Identity reset refused an unexpected state path.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new IdentityResetStateError("Identity reset state has the wrong owner.");
  }
  await rm(filePath, { force: true });
}

function preparedResult(
  tombstone: IdentityResetTombstoneV1,
  pairs: readonly RemoteAccessTrustIndexPairV1[]
): PreparedIdentityReset {
  return Object.freeze({
    resetTombstone: tombstone.resetTombstone,
    expectedOldFingerprint: tombstone.expectedOldFingerprint,
    pairs: Object.freeze(pairs.map((pair) => Object.freeze(structuredClone(pair))))
  });
}

export class IdentityResetState {
  readonly #paths: ReturnType<typeof remoteStatePaths>;
  readonly #remoteRolePaths: ReturnType<typeof remoteRolePaths>;
  readonly #processIsAlive: (pid: number) => boolean;

  constructor(dataRoot: string, options: IdentityResetStateOptions = {}) {
    this.#paths = remoteStatePaths(dataRoot);
    this.#remoteRolePaths = remoteRolePaths(dataRoot, "remote");
    this.#processIsAlive = options.processIsAlive ?? processIsAlive;
  }

  async assertNoLiveRemoteSibling(): Promise<void> {
    const value = await readOptionalOwnedJson(this.#remoteRolePaths.runtimePid);
    if (value === undefined) return;
    const runtime = RemoteDaemonStateSchema.parse(value);
    if (this.#processIsAlive(runtime.pid)) {
      throw new IdentityResetSiblingDaemonRunningError();
    }
  }

  async load(): Promise<IdentityResetTombstoneV1 | undefined> {
    const value = await readOptionalOwnedJson(this.#paths.resetTombstone);
    return value === undefined
      ? undefined
      : IdentityResetTombstoneV1Schema.parse(value);
  }

  async isPending(): Promise<boolean> {
    const state = await this.load();
    return state !== undefined && state.stage !== "complete";
  }

  async authorizeWhileIdle(check: () => Promise<boolean>): Promise<boolean> {
    return identityResetLocks.withLock(this.#paths.resetTombstone, async () => {
      if (await this.isPending()) return false;
      return check();
    });
  }

  async runWhileIdle<T>(operation: () => Promise<T>): Promise<T> {
    return identityResetLocks.withLock(this.#paths.resetTombstone, async () => {
      if (await this.isPending()) {
        throw new IdentityResetStateError("Identity reset is in progress.");
      }
      return operation();
    });
  }

  async prepare(expectedOldFingerprintValue: string, nowSeconds: bigint): Promise<PreparedIdentityReset> {
    const expectedOldFingerprint = Base64Url16BytesSchema.parse(expectedOldFingerprintValue);
    const now = Uint64DecimalSchema.parse(nowSeconds.toString());
    return identityResetLocks.withLock(this.#paths.resetTombstone, async () => {
      await this.assertNoLiveRemoteSibling();
      const [existing, configValue, trustValue, denyValue] = await Promise.all([
        this.load(),
        readOwnedJson(this.#paths.hostConfig),
        readOwnedJson(this.#paths.trustIndex),
        readOwnedJson(this.#paths.localDenyIndex)
      ]);
      const config = RemoteAccessConfigV1Schema.parse(configValue);
      const trust = RemoteAccessTrustIndexV1Schema.parse(trustValue);
      const deny = RemoteAccessLocalDenyIndexV1Schema.parse(denyValue);
      if (existing?.stage !== "complete") {
        if (existing && existing.expectedOldFingerprint !== expectedOldFingerprint) {
          throw new IdentityResetStateError("Another identity reset is already pending.");
        }
        if (existing) {
          await this.#ensurePreparedFiles(existing, config, trust, now);
          return preparedResult(existing, trust.pairs);
        }
      }

      const highWater = [
        BigInt(trust.trustEpochHighWater),
        BigInt(trust.resetTombstone),
        BigInt(deny.trustEpochHighWater),
        ...(existing ? [BigInt(existing.resetTombstone)] : [])
      ].reduce((highest, value) => value > highest ? value : highest, 0n);
      if (highWater >= UINT64_MAX) {
        throw new IdentityResetStateError("Identity reset tombstone space is exhausted.");
      }
      const tombstone = IdentityResetTombstoneV1Schema.parse({
        version: 1,
        resetTombstone: (highWater + 1n).toString(),
        expectedOldFingerprint,
        stage: "reset_pending",
        requestedAt: now,
        updatedAt: now,
        receipt: null
      });

      // The tombstone is the first mutation. Authorization consults it directly, so a crash before
      // the config/deny writes below still fails closed and resumes this exact transition.
      await atomicWriteJson(this.#paths.resetTombstone, tombstone, { mode: 0o600 });
      await this.#ensurePreparedFiles(tombstone, config, trust, now);
      return preparedResult(tombstone, trust.pairs);
    });
  }

  async markHelperComplete(receiptValue: IdentityResetReceiptV1, nowSeconds: bigint): Promise<void> {
    const receipt = IdentityResetReceiptV1Schema.parse(receiptValue);
    const now = Uint64DecimalSchema.parse(nowSeconds.toString());
    await identityResetLocks.withLock(this.#paths.resetTombstone, async () => {
      const current = await this.load();
      if (!current) throw new IdentityResetStateError("Identity reset tombstone is missing.");
      if (
        receipt.stage !== "complete"
        || receipt.resetTombstone !== current.resetTombstone
        || receipt.oldFingerprint !== current.expectedOldFingerprint
      ) {
        throw new IdentityResetStateError("Helper identity reset receipt does not match the pending reset.");
      }
      if (current.receipt && JSON.stringify(current.receipt) !== JSON.stringify(receipt)) {
        throw new IdentityResetStateError("Helper identity reset receipt changed after commitment.");
      }
      await atomicWriteJson(this.#paths.resetTombstone, IdentityResetTombstoneV1Schema.parse({
        ...current,
        stage: current.stage === "complete" ? "complete" : "helper_complete",
        updatedAt: now,
        receipt
      }), { mode: 0o600 });
    });
  }

  async finalize(nowSeconds: bigint): Promise<void> {
    const now = Uint64DecimalSchema.parse(nowSeconds.toString());
    await identityResetLocks.withLock(this.#paths.resetTombstone, async () => {
      const current = await this.load();
      if (!current) throw new IdentityResetStateError("Identity reset tombstone is missing.");
      if (current.stage === "complete") return;
      if (current.stage !== "helper_complete" || current.receipt?.stage !== "complete") {
        throw new IdentityResetStateError("Helper identity reset has not completed.");
      }
      const installation = RemoteAccessInstallationStateV1Schema.parse(
        await readOwnedJson(this.#paths.installation)
      );
      if (installation.activationReference !== null) {
        throw new IdentityResetStateError("Replacement installation must be unactivated.");
      }

      await Promise.all([
        removeOwnedFileIfPresent(this.#paths.remoteRememberedHosts),
        removeOwnedFileIfPresent(this.#paths.remoteOriginState)
      ]);

      await resetOwnedDirectory(this.#paths.dashboardCacheRoot);
      await resetOwnedDirectory(this.#paths.trustRoot);
      await Promise.all([
        atomicWriteJson(this.#paths.trustIndex, RemoteAccessTrustIndexV1Schema.parse({
          version: 1,
          trustEpochHighWater: current.resetTombstone,
          resetTombstone: current.resetTombstone,
          pairs: []
        }), { mode: 0o600 }),
        atomicWriteJson(this.#paths.localDenyIndex, RemoteAccessLocalDenyIndexV1Schema.parse({
          version: 1,
          trustEpochHighWater: current.resetTombstone,
          devices: []
        }), { mode: 0o600 })
      ]);

      const config = RemoteAccessConfigV1Schema.parse(await readOwnedJson(this.#paths.hostConfig));
      if (config.enabled || config.displayName !== DEFAULT_HOST_DISPLAY_NAME) {
        await atomicWriteJson(this.#paths.hostConfig, RemoteAccessConfigV1Schema.parse({
          ...config,
          revision: (BigInt(config.revision) + 1n).toString(),
          enabled: false,
          displayName: DEFAULT_HOST_DISPLAY_NAME,
          updatedAt: now
        }), { mode: 0o600 });
      }

      await atomicWriteJson(this.#paths.resetTombstone, IdentityResetTombstoneV1Schema.parse({
        ...current,
        stage: "complete",
        updatedAt: now
      }), { mode: 0o600 });
    });
  }

  async #ensurePreparedFiles(
    tombstone: IdentityResetTombstoneV1,
    configValue: unknown,
    trustValue: unknown,
    now: string
  ): Promise<void> {
    const config = RemoteAccessConfigV1Schema.parse(configValue);
    const trust = RemoteAccessTrustIndexV1Schema.parse(trustValue);
    if (config.enabled) {
      await atomicWriteJson(this.#paths.hostConfig, RemoteAccessConfigV1Schema.parse({
        ...config,
        revision: (BigInt(config.revision) + 1n).toString(),
        enabled: false,
        updatedAt: now
      }), { mode: 0o600 });
    }
    const devices = trust.pairs
      .map((pair) => ({
        deviceId: pair.deviceId,
        pairId: pair.pairId,
        deniedTrustEpoch: pair.trustEpoch,
        denyEpoch: tombstone.resetTombstone,
        revokedAt: now
      }))
      .sort((left, right) => left.deviceId.localeCompare(right.deviceId));
    await atomicWriteJson(this.#paths.localDenyIndex, RemoteAccessLocalDenyIndexV1Schema.parse({
      version: 1,
      trustEpochHighWater: tombstone.resetTombstone,
      devices
    }), { mode: 0o600 });
  }
}
