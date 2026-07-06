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
