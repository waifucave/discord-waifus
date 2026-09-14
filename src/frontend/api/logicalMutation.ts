import { classifyMutationRetry, type RetryClass } from "./retryPolicy";

const OPERATION_STATUS_URL = /^\/api\/admin\/operations\/[A-Za-z0-9_-]{43}$/u;

export type LogicalMutationState = "pending" | "accepted" | "outcome_unknown";

export type LogicalMutationSnapshot = Readonly<{
  idempotencyKey: string;
  method: string;
  canonicalTarget: string;
  bodyHash: string;
  retryClass: RetryClass;
  state: LogicalMutationState;
  statusUrl: string | null;
}>;

export class LogicalMutationTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogicalMutationTransportError";
  }
}

export class LogicalMutationOutcomeUnknownError extends Error {
  readonly action: LogicalMutationSnapshot;

  constructor(action: LogicalMutationSnapshot, cause: unknown) {
    super(
      "The connection changed before this action's outcome was known. Refresh current state before explicitly trying again.",
      { cause }
    );
    this.name = "LogicalMutationOutcomeUnknownError";
    this.action = action;
  }
}

type RandomBytes = (size: number) => Uint8Array;

export type LogicalMutationRegistryOptions = {
  readonly randomBytes?: RandomBytes;
};

export type BeginLogicalMutation = {
  readonly method: string;
  readonly target: string;
  readonly body: unknown;
};

export type LogicalMutationAttempt = Readonly<{
  idempotencyKey: string;
  attempt: number;
}>;

export type LogicalMutationResponse<T> = Readonly<{
  value: T;
  statusUrl?: string;
}>;

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function canonicalTarget(target: string): string {
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new TypeError("Mutation target must be a same-origin path.");
  }
  const parsed = new URL(target, "http://waifus.invalid");
  if (parsed.origin !== "http://waifus.invalid" || parsed.hash !== "") {
    throw new TypeError("Mutation target must be a same-origin path without a fragment.");
  }
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

function canonicalJson(value: unknown, inArray = false): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Mutation body numbers must be finite.");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return inArray ? "null" : undefined;
  }
  if (typeof value === "bigint") throw new TypeError("Mutation bodies cannot contain bigint values.");
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, true) ?? "null").join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .flatMap((key) => {
        const serialized = canonicalJson((value as Record<string, unknown>)[key]);
        return serialized === undefined ? [] : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Mutation body contains an unsupported value.");
}

async function bodyHash(body: unknown): Promise<string> {
  const identity = body === undefined
    ? "none\0"
    : typeof body === "string"
      ? `text\0${body}`
      : body instanceof Uint8Array
        ? undefined
        : `json\0${canonicalJson(body)}`;
  const bytes = identity === undefined
    ? new Uint8Array([
        ...new TextEncoder().encode("bytes\0"),
        ...(body as Uint8Array)
      ])
    : new TextEncoder().encode(identity);
  return base64Url(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)));
}

export class LogicalMutationRegistry {
  readonly #randomBytes: RandomBytes;
  readonly #active = new Map<string, LogicalMutation>();

  constructor(options: LogicalMutationRegistryOptions = {}) {
    this.#randomBytes = options.randomBytes ?? defaultRandomBytes;
  }

  async begin(input: BeginLogicalMutation): Promise<LogicalMutation> {
    const method = input.method.toUpperCase();
    const target = canonicalTarget(input.target);
    const retryClass = classifyMutationRetry(method, target);
    const keyBytes = this.#randomBytes(32);
    if (keyBytes.byteLength !== 32) {
      throw new TypeError("Logical mutation idempotency keys require exactly 32 random bytes.");
    }
    const idempotencyKey = base64Url(keyBytes);
    if (this.#active.has(idempotencyKey)) {
      throw new TypeError("Logical mutation idempotency key was reused.");
    }
    const action = new LogicalMutation(
      this,
      Object.freeze({
        idempotencyKey,
        method,
        canonicalTarget: target,
        bodyHash: await bodyHash(input.body),
        retryClass,
        state: "pending",
        statusUrl: null
      })
    );
    this.#active.set(idempotencyKey, action);
    return action;
  }

  get(idempotencyKey: string): LogicalMutation | undefined {
    return this.#active.get(idempotencyKey);
  }

  finish(idempotencyKey: string, action: LogicalMutation): void {
    if (this.#active.get(idempotencyKey) === action) this.#active.delete(idempotencyKey);
  }
}

export class LogicalMutation {
  readonly #registry: LogicalMutationRegistry;
  #record: LogicalMutationSnapshot;

  constructor(registry: LogicalMutationRegistry, record: LogicalMutationSnapshot) {
    this.#registry = registry;
    this.#record = record;
  }

  snapshot(): LogicalMutationSnapshot {
    return this.#record;
  }

  async execute<T>(
    send: (attempt: LogicalMutationAttempt) => Promise<LogicalMutationResponse<T>>
  ): Promise<T> {
    if (this.#record.state !== "pending") {
      throw new TypeError("Logical mutation has already been sent.");
    }
    const maxAttempts = this.#record.retryClass === "non_replayable" ? 1 : 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await send(Object.freeze({
          idempotencyKey: this.#record.idempotencyKey,
          attempt
        }));
        if (response.statusUrl !== undefined) {
          if (!OPERATION_STATUS_URL.test(response.statusUrl)) {
            throw new TypeError("Mutation returned an invalid operation status URL.");
          }
          this.#record = Object.freeze({
            ...this.#record,
            state: "accepted",
            statusUrl: response.statusUrl
          });
        } else {
          this.#registry.finish(this.#record.idempotencyKey, this);
        }
        return response.value;
      } catch (error) {
        if (!(error instanceof LogicalMutationTransportError)) {
          this.#registry.finish(this.#record.idempotencyKey, this);
          throw error;
        }
        if (attempt < maxAttempts) continue;
        this.#record = Object.freeze({ ...this.#record, state: "outcome_unknown" });
        throw new LogicalMutationOutcomeUnknownError(this.#record, error);
      }
    }
    throw new TypeError("Logical mutation attempt loop is unreachable.");
  }
}
