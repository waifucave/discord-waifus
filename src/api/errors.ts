export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, message, details);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string, details?: unknown): ApiError {
  return new ApiError(409, message, details);
}

export function preconditionRequired(message: string): ApiError {
  return new ApiError(428, message);
}
