import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, RevisionedRecord, bumpRevision } from "../shared/schemas/common.js";
import { resolveDataPath } from "../config/paths.js";
import { atomicWriteJson, recoverAtomicWriteTemps } from "./atomic.js";
import { StorageConflictError, StorageValidationError } from "./errors.js";
import { ResourceLockManager } from "./locks.js";

export type UpdateRevisionedJsonOptions<T extends RevisionedRecord> = {
  resourceKey: string;
  relativePath: string;
  schema: z.ZodType<T>;
  fallback: T;
  expectedRevision?: number;
  transform: (current: T) => Promise<T> | T;
};

/** Two records with the same content apart from `revision` and `updatedAt` (serialized bytes). */
function sameContent(a: RevisionedRecord, b: RevisionedRecord): boolean {
  const { revision: _a1, updatedAt: _a2, ...left } = a;
  const { revision: _b1, updatedAt: _b2, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

// Crash leftovers can only predate this process (our own temps are never removed and a live
// writer's temps must not be), so scanning a file's directory once per process is enough.
// Scanning on every read cost a readdir per read on hot paths (sessions, memories).
const tempRecovery = new Map<string, Promise<void>>();

function recoverTempsOnce(filePath: string): Promise<void> {
  let pending = tempRecovery.get(filePath);
  if (!pending) {
    pending = recoverAtomicWriteTemps(filePath).then(
      () => undefined,
      (error: unknown) => {
        tempRecovery.delete(filePath);
        throw error;
      }
    );
    tempRecovery.set(filePath, pending);
  }
  return pending;
}

export class StorageService {
  readonly locks: ResourceLockManager;

  constructor(
    readonly dataRoot: string,
    options: {
      locks?: ResourceLockManager;
      lockWaitWarnThresholdMs?: number;
      onLockWait?: (resourceKey: string, waitMs: number) => void;
    } = {}
  ) {
    this.locks =
      options.locks ??
      new ResourceLockManager(options.lockWaitWarnThresholdMs ?? 250, options.onLockWait);
  }

  async readJson<T>(
    relativePath: string,
    schema: z.ZodType<T>,
    fallback?: T
  ): Promise<T> {
    const filePath = resolveDataPath(this.dataRoot, relativePath);
    await recoverTempsOnce(filePath);
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return schema.parse(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) {
        return schema.parse(structuredClone(fallback));
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new StorageValidationError(`Invalid JSON record at ${relativePath}`, { cause: error });
      }
      throw error;
    }
  }

  async writeJson<T>(
    resourceKey: string,
    relativePath: string,
    schema: z.ZodType<T>,
    value: T
  ): Promise<T> {
    return this.locks.withLock(resourceKey, async () => {
      const parsed = schema.parse(value);
      await atomicWriteJson(resolveDataPath(this.dataRoot, relativePath), parsed);
      return parsed;
    });
  }

  async updateRevisionedJson<T extends RevisionedRecord>(
    options: UpdateRevisionedJsonOptions<T>
  ): Promise<T> {
    return this.locks.withLock(options.resourceKey, async () => {
      const filePath = resolveDataPath(this.dataRoot, options.relativePath);
      const existed = await stat(filePath).then(() => true, () => false);
      const current = await this.readJson(options.relativePath, options.schema, options.fallback);
      if (
        options.expectedRevision !== undefined &&
        current.revision !== options.expectedRevision
      ) {
        throw new StorageConflictError("Record has changed since it was read.", current);
      }

      const transformed = await options.transform(structuredClone(current));
      // A write that changes nothing on an existing file is skipped: no new revision, no disk write
      // (a scheduler tick or a message that only re-reads a file never rewrites it).
      if (existed && sameContent(options.schema.parse({ ...transformed, schemaVersion: CURRENT_SCHEMA_VERSION }), current)) return current;
      const next = options.schema.parse(
        bumpRevision({
          ...transformed,
          schemaVersion: CURRENT_SCHEMA_VERSION
        })
      );
      await atomicWriteJson(filePath, next);
      return next;
    });
  }

  async withLocks<T>(resourceKeys: string[], task: () => Promise<T> | T): Promise<T> {
    return this.locks.withLocks(resourceKeys, task);
  }

  dataPath(...segments: string[]): string {
    return path.join(this.dataRoot, ...segments);
  }
}
