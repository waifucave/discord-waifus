export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export type StorageConflictVersion = {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly updatedAt: string;
};

function storageConflictVersion(value: unknown): StorageConflictVersion {
  if (!value || typeof value !== "object") {
    throw new TypeError("Storage conflict record is missing revision metadata.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isInteger(candidate.schemaVersion)
    || Number(candidate.schemaVersion) < 0
    || !Number.isInteger(candidate.revision)
    || Number(candidate.revision) < 0
    || typeof candidate.updatedAt !== "string"
  ) {
    throw new TypeError("Storage conflict record has invalid revision metadata.");
  }
  return Object.freeze({
    schemaVersion: Number(candidate.schemaVersion),
    revision: Number(candidate.revision),
    updatedAt: candidate.updatedAt
  });
}

export class StorageConflictError<T = unknown> extends StorageError {
  readonly statusCode = 409;
  readonly latest: T;
  readonly latestVersion: StorageConflictVersion;

  constructor(
    message: string,
    latest: T
  ) {
    super(message);
    this.name = "StorageConflictError";
    this.latest = latest;
    this.latestVersion = storageConflictVersion(latest);
    // Callers may use the full current value to reconcile locally, but generic Error
    // serialization must not be able to expose the resource body by accident.
    Object.defineProperty(this, "latest", { enumerable: false });
  }
}

export class StorageValidationError extends StorageError {
  readonly statusCode = 500;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageValidationError";
  }
}
