import { lstat, mkdir, readFile } from "node:fs/promises";
import { z } from "zod";
import {
  MAX_REMEMBERED_HOSTS,
  RememberedHostSummaryV1Schema,
  TrustedDeviceConnectionStateSchema,
  type GatewaySelectionState,
  type RememberedHostListV1,
  type RememberedHostSummaryV1
} from "../shared/schemas/remoteLifecycle.js";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  Uint64DecimalSchema
} from "../shared/schemas/remoteProtocol.js";
import { atomicWriteJson, recoverAtomicWriteTemps } from "../storage/atomic.js";
import { ResourceLockManager } from "../storage/locks.js";
import { remoteStatePaths } from "./paths.js";
import { derivePinnedHostId } from "./gateway/originStore.js";

const rememberedHostLocks = new ResourceLockManager();

export const RememberedHostRecordV1Schema = RememberedHostSummaryV1Schema.extend({
  helperPairId: Base64Url16BytesSchema,
  installationPublicKey: Base64Url32BytesSchema
}).strict();

export type RememberedHostRecordV1 = z.infer<typeof RememberedHostRecordV1Schema>;

export const RememberedHostStateV1Schema = z.object({
  version: z.literal(1),
  explicitSelectedHostId: Base64Url32BytesSchema.nullable(),
  hosts: z.array(RememberedHostRecordV1Schema).max(MAX_REMEMBERED_HOSTS)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  const helperPairIds = new Set<string>();
  let previous: string | undefined;
  for (const [index, host] of value.hosts.entries()) {
    if (ids.has(host.hostId)) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "hostId"],
        message: "Remembered host IDs must be unique."
      });
    }
    ids.add(host.hostId);
    if (derivePinnedHostId(Buffer.from(host.installationPublicKey, "base64url")) !== host.hostId) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "hostId"],
        message: "Remembered host ID must derive from its pinned installation public key."
      });
    }
    if (helperPairIds.has(host.helperPairId)) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "helperPairId"],
        message: "Remembered helper pair IDs must be unique."
      });
    }
    helperPairIds.add(host.helperPairId);
    if (previous !== undefined && Buffer.compare(
      Buffer.from(previous, "base64url"),
      Buffer.from(host.hostId, "base64url")
    ) >= 0) {
      context.addIssue({
        code: "custom",
        path: ["hosts", index, "hostId"],
        message: "Remembered hosts must be bytewise sorted."
      });
    }
    previous = host.hostId;
  }
  if (
    value.explicitSelectedHostId !== null
    && !ids.has(value.explicitSelectedHostId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["explicitSelectedHostId"],
      message: "Explicit selection must refer to a remembered host."
    });
  }
});

export type RememberedHostStateV1 = z.infer<typeof RememberedHostStateV1Schema>;

export type RememberedHostSelection = Readonly<{
  selectionState: GatewaySelectionState;
  selectedHostId: string | null;
}>;

export type RememberedHostStoreErrorCode =
  | "host_conflict"
  | "host_limit"
  | "host_not_found"
  | "remembered_hosts_invalid"
  | "remembered_hosts_untrusted";

export class RememberedHostStoreError extends Error {
  constructor(
    readonly code: RememberedHostStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "RememberedHostStoreError";
  }
}

function fail(code: RememberedHostStoreErrorCode, message: string): never {
  throw new RememberedHostStoreError(code, message);
}

function sortedHosts(hosts: readonly RememberedHostRecordV1[]): RememberedHostRecordV1[] {
  return [...hosts].sort((left, right) => Buffer.compare(
    Buffer.from(left.hostId, "base64url"),
    Buffer.from(right.hostId, "base64url")
  ));
}

function publicSummary(record: RememberedHostRecordV1): RememberedHostSummaryV1 {
  const { helperPairId: _helperPairId, installationPublicKey: _installationPublicKey, ...summary } = record;
  return Object.freeze(RememberedHostSummaryV1Schema.parse(summary));
}

export class RememberedHostStore {
  readonly #stateRoot: string;
  readonly #statePath: string;

  constructor(dataRoot: string) {
    const paths = remoteStatePaths(dataRoot);
    this.#stateRoot = paths.remoteGatewayStateRoot;
    this.#statePath = paths.remoteRememberedHosts;
  }

  async getState(): Promise<RememberedHostStateV1> {
    return rememberedHostLocks.withLock(this.#statePath, async () => {
      const { state, exists } = await this.#readState();
      if (!exists) await this.#writeState(state);
      return RememberedHostStateV1Schema.parse(structuredClone(state));
    });
  }

  async list(): Promise<RememberedHostListV1> {
    const state = await this.getState();
    return Object.freeze({
      version: 1,
      hosts: Object.freeze(state.hosts.map(publicSummary))
    }) as RememberedHostListV1;
  }

  async selection(): Promise<RememberedHostSelection> {
    return this.#selection(await this.getState());
  }

  async record(hostIdValue: string): Promise<RememberedHostRecordV1 | undefined> {
    const hostId = Base64Url32BytesSchema.parse(hostIdValue);
    const state = await this.getState();
    const record = state.hosts.find((host) => host.hostId === hostId);
    return record ? Object.freeze(structuredClone(record)) : undefined;
  }

  async upsert(recordValue: unknown): Promise<RememberedHostRecordV1> {
    const record = RememberedHostRecordV1Schema.parse(recordValue);
    return rememberedHostLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      const exists = state.hosts.some((host) => host.hostId === record.hostId);
      if (!exists && state.hosts.length >= MAX_REMEMBERED_HOSTS) {
        return fail("host_limit", "The remembered-host limit has been reached.");
      }
      const next = RememberedHostStateV1Schema.parse({
        ...state,
        hosts: sortedHosts([
          ...state.hosts.filter((host) => host.hostId !== record.hostId),
          record
        ])
      });
      await this.#writeState(next);
      return Object.freeze(structuredClone(record));
    });
  }

  async select(hostIdValue: string): Promise<RememberedHostSelection> {
    const hostId = Base64Url32BytesSchema.parse(hostIdValue);
    return rememberedHostLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      if (!state.hosts.some((host) => host.hostId === hostId)) {
        return fail("host_not_found", "Remembered host does not exist.");
      }
      const next = RememberedHostStateV1Schema.parse({
        ...state,
        explicitSelectedHostId: hostId
      });
      await this.#writeState(next);
      return this.#selection(next);
    });
  }

  async updateConnection(
    hostIdValue: string,
    connectionStateValue: string,
    lastDirectAt: string | null,
    lastErrorCode: RememberedHostSummaryV1["lastErrorCode"]
  ): Promise<RememberedHostSummaryV1> {
    const hostId = Base64Url32BytesSchema.parse(hostIdValue);
    const connectionState = TrustedDeviceConnectionStateSchema.parse(connectionStateValue);
    return rememberedHostLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      const current = state.hosts.find((host) => host.hostId === hostId);
      if (!current) return fail("host_not_found", "Remembered host does not exist.");
      const updated = RememberedHostRecordV1Schema.parse({
        ...current,
        connectionState,
        lastDirectAt,
        lastErrorCode
      });
      const next = RememberedHostStateV1Schema.parse({
        ...state,
        hosts: sortedHosts(state.hosts.map((host) => host.hostId === hostId ? updated : host))
      });
      await this.#writeState(next);
      return publicSummary(updated);
    });
  }

  async remove(hostIdValue: string, expectedRevisionValue: string): Promise<RememberedHostRecordV1> {
    const hostId = Base64Url32BytesSchema.parse(hostIdValue);
    const expectedRevision = Uint64DecimalSchema.parse(expectedRevisionValue);
    return rememberedHostLocks.withLock(this.#statePath, async () => {
      const { state } = await this.#readState();
      const current = state.hosts.find((host) => host.hostId === hostId);
      if (!current) return fail("host_not_found", "Remembered host does not exist.");
      if (current.revision !== expectedRevision) {
        return fail("host_conflict", "Remembered host revision changed.");
      }
      const next = RememberedHostStateV1Schema.parse({
        ...state,
        explicitSelectedHostId: state.explicitSelectedHostId === hostId
          ? null
          : state.explicitSelectedHostId,
        hosts: state.hosts.filter((host) => host.hostId !== hostId)
      });
      await this.#writeState(next);
      return Object.freeze(structuredClone(current));
    });
  }

  #selection(state: RememberedHostStateV1): RememberedHostSelection {
    if (state.hosts.length === 0) {
      return Object.freeze({ selectionState: "no_hosts", selectedHostId: null });
    }
    if (state.hosts.length === 1 && state.explicitSelectedHostId === null) {
      return Object.freeze({
        selectionState: "automatic_single",
        selectedHostId: state.hosts[0].hostId
      });
    }
    if (state.explicitSelectedHostId !== null) {
      return Object.freeze({
        selectionState: "explicit",
        selectedHostId: state.explicitSelectedHostId
      });
    }
    return Object.freeze({ selectionState: "selection_required", selectedHostId: null });
  }

  async #readState(): Promise<{ state: RememberedHostStateV1; exists: boolean }> {
    await this.#ensureStateRoot();
    await recoverAtomicWriteTemps(this.#statePath);
    let metadata;
    try {
      metadata = await lstat(this.#statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          exists: false,
          state: { version: 1, explicitSelectedHostId: null, hosts: [] }
        };
      }
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return fail("remembered_hosts_untrusted", "Remembered-host state must be a regular file.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      return fail("remembered_hosts_untrusted", "Remembered-host state has the wrong owner.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return fail("remembered_hosts_untrusted", "Remembered-host state permissions are too broad.");
    }
    try {
      return {
        exists: true,
        state: RememberedHostStateV1Schema.parse(
          JSON.parse(await readFile(this.#statePath, "utf8"))
        )
      };
    } catch {
      return fail("remembered_hosts_invalid", "Remembered-host state is invalid.");
    }
  }

  async #ensureStateRoot(): Promise<void> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.#stateRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return fail("remembered_hosts_untrusted", "Remote gateway state root must be a directory.");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      return fail("remembered_hosts_untrusted", "Remote gateway state root has the wrong owner.");
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return fail("remembered_hosts_untrusted", "Remote gateway state root permissions are too broad.");
    }
  }

  async #writeState(state: RememberedHostStateV1): Promise<void> {
    await atomicWriteJson(this.#statePath, RememberedHostStateV1Schema.parse(state), { mode: 0o600 });
  }
}
