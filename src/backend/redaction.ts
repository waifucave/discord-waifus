const DISCORD_TOKEN_PATTERN = /[MN][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6,7}\.[A-Za-z\d_-]{27,40}/g;
const API_KEY_PATTERN = /\b(?:sk|xai|zai|hf)[-_][A-Za-z0-9._-]{16,}\b/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PAIR_TOKEN_PATTERN = /\bWF1\.[A-Za-z0-9_-]{32,}\b/g;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const IP_ENDPOINT_PATTERN = /(?<![/:])(?:\b(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]):\d{1,5}\b/gi;
const INTERNAL_CAPABILITY_PATTERN = /(internal[-_\s]?capability\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi;
const INVITATION_SECRET_PATTERN = /(invitation[-_\s]?secret\s*[:=]\s*)[A-Za-z0-9._~+/=-]{8,}/gi;
const HELPER_SOCKET_PATTERN = /(helper(?:Socket| IPC)(?:Path)?\s*[:=]\s*)[^\s;,]+/gi;
const LOOPBACK_URL_PATTERN = /\b(?:https?|wss?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/[^\s"'<>]*)?/gi;
const HELPER_IPC_PATH_PATTERN = /(?:\/(?:private\/)?tmp|\/var\/run|\/run)\/[A-Za-z0-9._/-]*(?:waifus|ts-connect)[A-Za-z0-9._/-]*/gi;
const WINDOWS_PIPE_PATTERN = /\\\\\.\\pipe\\[^\s"'<>]+/gi;

const EXACT_SECRET_KEYS = new Set([
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "setcookie",
  "password",
  "privatekey",
  "pairroot",
  "pairsecret",
  "activationcredential",
  "internalcapability",
  "helpercapability",
  "parentcapability",
  "endpoint",
  "endpoints",
  "endpointcandidate",
  "endpointcandidates",
  "rawendpoints",
  "socketpath",
  "helpersocketpath",
  "ciphertext",
  "nonce"
]);

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return EXACT_SECRET_KEYS.has(normalized)
    || normalized.endsWith("apikey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("password")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("proof")
    || normalized.endsWith("signature")
    || normalized.endsWith("mac");
}

type RedactionOptions = {
  readonly remoteHostDetails: boolean;
  readonly knownHostPaths: readonly string[];
};

export function redactSecrets<T>(value: T): T {
  return redactValue(value, { remoteHostDetails: false, knownHostPaths: [] }) as T;
}

export function redactRemoteHostDetails<T>(
  value: T,
  knownHostPaths: readonly string[] = []
): T {
  return redactValue(value, { remoteHostDetails: true, knownHostPaths }) as T;
}

function redactString(value: string, options: RedactionOptions): string {
  let redacted = value
    .replace(PRIVATE_KEY_PATTERN, "[REDACTED]")
    .replace(DISCORD_TOKEN_PATTERN, "[REDACTED]")
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(PAIR_TOKEN_PATTERN, "[REDACTED]")
    .replace(IP_ENDPOINT_PATTERN, "[REDACTED_ENDPOINT]")
    .replace(INTERNAL_CAPABILITY_PATTERN, "$1[REDACTED]")
    .replace(INVITATION_SECRET_PATTERN, "$1[REDACTED]")
    .replace(HELPER_SOCKET_PATTERN, "$1[REDACTED_PATH]");
  if (!options.remoteHostDetails) return redacted;
  for (const hostPath of options.knownHostPaths) {
    if (hostPath) redacted = redacted.split(hostPath).join("[REDACTED_PATH]");
  }
  return redacted
    .replace(LOOPBACK_URL_PATTERN, "[REDACTED_LOCAL_URL]")
    .replace(HELPER_IPC_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(WINDOWS_PIPE_PATTERN, "[REDACTED_PATH]");
}

function redactValue(value: unknown, options: RedactionOptions): unknown {
  if (typeof value === "string") {
    return redactString(value, options);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isSecretKey(key) && entry !== undefined
          ? "[REDACTED]"
          : redactValue(entry, options)
      ])
    );
  }
  return value;
}
