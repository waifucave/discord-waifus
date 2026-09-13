import { randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";
import {
  Base64Url32BytesSchema,
  type Base64Url32Bytes
} from "../../shared/schemas/remoteProtocol.js";

export const REMOTE_SESSION_IDLE_MS = 30 * 60 * 1_000;
export const REMOTE_SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;
export const REMOTE_BOOTSTRAP_TOKEN_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 1_024;
const DEFAULT_MAX_BOOTSTRAP_TOKENS = 32;
const RANDOM_COLLISION_RETRIES = 8;

type MutableRemoteBrowserSession = {
  readonly gatewayLaunchId: Base64Url32Bytes;
  readonly sessionCookieName: string;
  readonly browserSessionId: Base64Url32Bytes;
  readonly csrfToken: Base64Url32Bytes;
  readonly createdAt: number;
  idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
};

export type RemoteBrowserSession = Readonly<MutableRemoteBrowserSession>;

export type RemoteBrowserSessionStoreOptions = {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly maxSessions?: number;
  readonly maxBootstrapTokens?: number;
};

export class RemoteBrowserSessionStoreError extends Error {
  constructor(
    readonly code: "bootstrap_capacity" | "random_collision" | "session_capacity",
    message: string
  ) {
    super(message);
    this.name = "RemoteBrowserSessionStoreError";
  }
}

function exactRandomBytes(
  random: (size: number) => Uint8Array,
  size: number,
  label: string
): Buffer {
  const bytes = Buffer.from(random(size));
  if (bytes.byteLength !== size) {
    throw new TypeError(`${label} random source must return exactly ${size} bytes.`);
  }
  return bytes;
}

function positiveCapacity(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return selected;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function snapshot(session: MutableRemoteBrowserSession): RemoteBrowserSession {
  return Object.freeze({ ...session });
}

export class RemoteBrowserSessionStore {
  readonly gatewayLaunchId: Base64Url32Bytes;
  readonly sessionCookieName: string;
  readonly #now: () => number;
  readonly #random: (size: number) => Uint8Array;
  readonly #maxSessions: number;
  readonly #maxBootstrapTokens: number;
  readonly #bootstrapTokens = new Map<string, number>();
  readonly #sessions = new Map<string, MutableRemoteBrowserSession>();
  #closed = false;

  constructor(options: RemoteBrowserSessionStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#random = options.randomBytes ?? cryptoRandomBytes;
    this.#maxSessions = positiveCapacity(options.maxSessions, DEFAULT_MAX_SESSIONS, "Session capacity");
    this.#maxBootstrapTokens = positiveCapacity(
      options.maxBootstrapTokens,
      DEFAULT_MAX_BOOTSTRAP_TOKENS,
      "Bootstrap-token capacity"
    );
    this.gatewayLaunchId = Base64Url32BytesSchema.parse(
      exactRandomBytes(this.#random, 32, "Gateway launch ID").toString("base64url")
    );
    this.sessionCookieName = `waifus_remote_session_${exactRandomBytes(
      this.#random,
      16,
      "Session cookie name"
    ).toString("hex")}`;
  }

  issueBootstrapToken(): Base64Url32Bytes {
    this.#requireOpen();
    this.#prune();
    if (this.#bootstrapTokens.size >= this.#maxBootstrapTokens) {
      throw new RemoteBrowserSessionStoreError(
        "bootstrap_capacity",
        "Remote browser bootstrap capacity is exhausted."
      );
    }
    const token = this.#uniqueToken(this.#bootstrapTokens, "Bootstrap token");
    this.#bootstrapTokens.set(token, this.#now() + REMOTE_BOOTSTRAP_TOKEN_MS);
    return token;
  }

  consumeBootstrapToken(tokenValue: string): RemoteBrowserSession | undefined {
    this.#requireOpen();
    const parsed = Base64Url32BytesSchema.safeParse(tokenValue);
    if (!parsed.success) return undefined;
    const expiresAt = this.#bootstrapTokens.get(parsed.data);
    this.#bootstrapTokens.delete(parsed.data);
    if (expiresAt === undefined || this.#now() >= expiresAt) return undefined;
    this.#prune();
    if (this.#sessions.size >= this.#maxSessions) {
      throw new RemoteBrowserSessionStoreError(
        "session_capacity",
        "Remote browser session capacity is exhausted."
      );
    }
    const createdAt = this.#now();
    const browserSessionId = this.#uniqueSessionSecret("Browser session ID");
    const csrfToken = this.#uniqueSessionSecret("CSRF token", browserSessionId);
    const session: MutableRemoteBrowserSession = {
      gatewayLaunchId: this.gatewayLaunchId,
      sessionCookieName: this.sessionCookieName,
      browserSessionId,
      csrfToken,
      createdAt,
      idleExpiresAt: createdAt + REMOTE_SESSION_IDLE_MS,
      absoluteExpiresAt: createdAt + REMOTE_SESSION_ABSOLUTE_MS
    };
    this.#sessions.set(browserSessionId, session);
    return snapshot(session);
  }

  sessionFromCookie(cookieHeader: string | undefined): RemoteBrowserSession | undefined {
    if (this.#closed || !cookieHeader) return undefined;
    const values: string[] = [];
    for (const part of cookieHeader.split(";")) {
      const separator = part.indexOf("=");
      if (separator === -1) continue;
      if (part.slice(0, separator).trim() === this.sessionCookieName) {
        values.push(part.slice(separator + 1).trim());
      }
    }
    if (values.length !== 1) return undefined;
    const parsed = Base64Url32BytesSchema.safeParse(values[0]);
    if (!parsed.success) return undefined;
    const session = this.#activeSession(parsed.data);
    return session ? snapshot(session) : undefined;
  }

  commitValidated(sessionValue: RemoteBrowserSession): RemoteBrowserSession | undefined {
    if (this.#closed) return undefined;
    const session = this.#activeSession(sessionValue.browserSessionId);
    if (
      !session
      || session.gatewayLaunchId !== sessionValue.gatewayLaunchId
      || session.sessionCookieName !== sessionValue.sessionCookieName
      || !safeTokenEqual(session.csrfToken, sessionValue.csrfToken)
    ) {
      return undefined;
    }
    session.idleExpiresAt = Math.min(
      this.#now() + REMOTE_SESSION_IDLE_MS,
      session.absoluteExpiresAt
    );
    return snapshot(session);
  }

  sessionCookieHeader(sessionValue: RemoteBrowserSession): string {
    const session = this.#activeSession(sessionValue.browserSessionId);
    if (!session || !safeTokenEqual(session.csrfToken, sessionValue.csrfToken)) {
      throw new TypeError("Remote browser session is missing or expired.");
    }
    const remainingSeconds = Math.max(
      1,
      Math.floor((Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - this.#now()) / 1_000)
    );
    return `${this.sessionCookieName}=${session.browserSessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${remainingSeconds}`;
  }

  sessionCookieHeaderIfActive(sessionValue: RemoteBrowserSession): string | undefined {
    try {
      return this.sessionCookieHeader(sessionValue);
    } catch {
      return undefined;
    }
  }

  invalidate(browserSessionId: string): void {
    this.#sessions.delete(browserSessionId);
  }

  close(): void {
    this.#closed = true;
    this.#bootstrapTokens.clear();
    this.#sessions.clear();
  }

  #activeSession(browserSessionId: string): MutableRemoteBrowserSession | undefined {
    const session = this.#sessions.get(browserSessionId);
    if (!session) return undefined;
    const now = this.#now();
    if (now >= session.idleExpiresAt || now >= session.absoluteExpiresAt) {
      this.#sessions.delete(browserSessionId);
      return undefined;
    }
    return session;
  }

  #prune(): void {
    const now = this.#now();
    for (const [token, expiresAt] of this.#bootstrapTokens) {
      if (now >= expiresAt) this.#bootstrapTokens.delete(token);
    }
    for (const id of this.#sessions.keys()) this.#activeSession(id);
  }

  #uniqueToken(
    occupied: ReadonlyMap<string, unknown>,
    label: string
  ): Base64Url32Bytes {
    for (let attempt = 0; attempt < RANDOM_COLLISION_RETRIES; attempt += 1) {
      const token = Base64Url32BytesSchema.parse(
        exactRandomBytes(this.#random, 32, label).toString("base64url")
      );
      if (!occupied.has(token)) return token;
    }
    throw new RemoteBrowserSessionStoreError(
      "random_collision",
      `${label} random source repeatedly collided.`
    );
  }

  #uniqueSessionSecret(label: string, other?: string): Base64Url32Bytes {
    for (let attempt = 0; attempt < RANDOM_COLLISION_RETRIES; attempt += 1) {
      const token = Base64Url32BytesSchema.parse(
        exactRandomBytes(this.#random, 32, label).toString("base64url")
      );
      if (
        token !== other
        && !this.#sessions.has(token)
        && [...this.#sessions.values()].every((session) => session.csrfToken !== token)
      ) {
        return token;
      }
    }
    throw new RemoteBrowserSessionStoreError(
      "random_collision",
      `${label} random source repeatedly collided.`
    );
  }

  #requireOpen(): void {
    if (this.#closed) throw new TypeError("Remote browser session store is closed.");
  }
}
