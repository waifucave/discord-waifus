export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown,
    /** Machine-readable error code surfaced as the response `error` field. */
    readonly code: string = "ApiError"
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiErrorResponse = {
  error: string;
  message: string;
  details?: unknown;
};

export function apiErrorResponse(error: ApiError): ApiErrorResponse {
  return {
    error: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details })
  };
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, message, details, "BadRequest");
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message, undefined, "NotFound");
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, message, details, "Conflict");
}

export function preconditionRequired(message: string): ApiError {
  return new ApiError(428, message, undefined, "PreconditionRequired");
}

export function activationRequired(message = "Remote access must be activated before it can be enabled."): ApiError {
  return new ApiError(428, message, undefined, "ActivationRequired");
}

/**
 * A memory write lost an optimistic-concurrency race (per-record `recordRevision`, or the legacy
 * store-wide `revision`). Answered as 409 `{ error: "Conflict", latest: { revision }, record }`.
 */
export class MemoryRecordConflictError extends ApiError {
  readonly latest: { schemaVersion: number; revision: number; updatedAt: string };
  readonly record: unknown;

  constructor(store: { schemaVersion: number; revision: number; updatedAt: string }, record: unknown) {
    super(409, "Memory has changed since it was read.", undefined, "Conflict");
    this.name = "MemoryRecordConflictError";
    this.latest = { schemaVersion: store.schemaVersion, revision: store.revision, updatedAt: store.updatedAt };
    this.record = record;
  }
}
