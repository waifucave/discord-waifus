import type {
  ActivationStart,
  ApiErrorBody,
  GatewayBootstrap,
  PairStartInput,
  PairStatus,
  RememberedHost
} from "./types";

const ROOT = "/_waifus_remote/v1";
const CSRF_HEADER = "x-waifus-csrf";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const PAIR_STATUS_PATTERN = /^\/_waifus_remote\/v1\/pair\/[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
let csrfToken: string | undefined;

export class RemoteShellApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody
  ) {
    super(typeof body.error === "string" ? body.error : `HTTP ${status}`);
    this.name = "RemoteShellApiError";
  }
}

async function decode<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? JSON.parse(text) as T : undefined as T;
  if (!response.ok) throw new RemoteShellApiError(response.status, body as ApiErrorBody);
  return body;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (method !== "GET" && method !== "HEAD" && !csrfToken) await shellApi.bootstrap();
  const response = await fetch(`${ROOT}${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(method === "GET" || method === "HEAD" || !csrfToken
        ? {}
        : { [CSRF_HEADER]: csrfToken })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return decode<T>(response);
}

export function isAllowedActivationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.origin === "https://pair.waifucave.com"
      || url.origin === "https://pair-staging.waifucave.com")
    && url.pathname === "/activate"
    && url.search === ""
    && url.username === ""
    && url.password === ""
    && TOKEN_PATTERN.test(url.hash.slice(1))
    && url.href === value
  );
}

export function openActivationUrl(value: string): void {
  if (!isAllowedActivationUrl(value)) throw new Error("Activation URL was not trusted.");
  const opened = window.open(value, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
}

export const shellApi = {
  async bootstrap(): Promise<GatewayBootstrap> {
    const response = await fetch(`${ROOT}/bootstrap`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    });
    const token = response.headers.get(CSRF_HEADER) ?? "";
    if (!TOKEN_PATTERN.test(token)) {
      throw new RemoteShellApiError(0, { error: "InvalidSession" });
    }
    const body = await decode<GatewayBootstrap>(response);
    csrfToken = token;
    return body;
  },
  hosts: () => request<{ version: 1; hosts: RememberedHost[] }>("GET", "/hosts"),
  beginActivation: () => request<ActivationStart>("POST", "/activation", {}),
  activationStatus: (operationId: string) => request<Record<string, unknown>>(
    "GET",
    `/activation/${encodeURIComponent(operationId)}`
  ),
  cancelActivation: (operationId: string) => request<void>(
    "DELETE",
    `/activation/${encodeURIComponent(operationId)}`
  ),
  beginPair: (input: PairStartInput) => request<PairStatus>("POST", "/pair", input),
  pairStatus: (statusUrl: string) => {
    if (!PAIR_STATUS_PATTERN.test(statusUrl)) {
      throw new Error("Pair status path was not trusted.");
    }
    return request<PairStatus>("GET", statusUrl.slice(ROOT.length));
  },
  cancelPair: (statusUrl: string) => {
    if (!PAIR_STATUS_PATTERN.test(statusUrl)) {
      throw new Error("Pair status path was not trusted.");
    }
    return request<void>("DELETE", statusUrl.slice(ROOT.length));
  },
  connect: (hostId: string) => request<Record<string, unknown>>(
    "POST",
    `/hosts/${encodeURIComponent(hostId)}/connect`,
    {}
  ),
  disconnect: (hostId: string) => request<Record<string, unknown>>(
    "POST",
    `/hosts/${encodeURIComponent(hostId)}/disconnect`,
    {}
  ),
  forgetReachable: (host: RememberedHost) => request<Record<string, unknown>>(
    "DELETE",
    `/hosts/${encodeURIComponent(host.hostId)}`,
    { revision: host.revision, mode: "reachable_first" }
  ),
  forgetLocal: (host: RememberedHost) => request<Record<string, unknown>>(
    "DELETE",
    `/hosts/${encodeURIComponent(host.hostId)}`,
    {
      revision: host.revision,
      mode: "local_only_confirmed",
      warningCode: "host_unreachable_remote_trust_may_remain"
    }
  )
};
