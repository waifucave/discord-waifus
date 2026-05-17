import { readFile } from "node:fs/promises";
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
    await recoverAtomicWriteTemps(filePath);
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
      const current = await this.readJson(options.relativePath, options.schema, options.fallback);
      if (
        options.expectedRevision !== undefined &&
        current.revision !== options.expectedRevision
      ) {
        throw new StorageConflictError("Record has changed since it was read.", current);
      }

      const transformed = await options.transform(structuredClone(current));
      const next = options.schema.parse(
        bumpRevision({
          ...transformed,
          schemaVersion: CURRENT_SCHEMA_VERSION
        })
      );
      await atomicWriteJson(resolveDataPath(this.dataRoot, options.relativePath), next);
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
