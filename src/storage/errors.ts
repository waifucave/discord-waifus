export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class StorageConflictError<T = unknown> extends StorageError {
  readonly statusCode = 409;

  constructor(
    message: string,
    readonly latest: T
  ) {
    super(message);
    this.name = "StorageConflictError";
  }
}

export class StorageValidationError extends StorageError {
  readonly statusCode = 500;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageValidationError";
  }
}
