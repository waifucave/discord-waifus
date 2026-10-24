import type {
  AssistantActionConfirmation,
  AssistantActionDetail,
  AssistantStoredMessage,
  AppConfig,
  AutoUpdateStatus,
  ActivationStartResult,
  ActivationStatus,
  ApprovePairingInput,
  ApiErrorBody,
  AssistantConfig,
  ChannelBody,
  ClientContext,
  ForgetUserResult,
  ForgetJobsResponse,
  CreateWaifuBody,
  DetectorConfigResponse,
  DetectorHistoryEntry,
  DetectorModelsResponse,
  HelpTopic,
  LifeCompactResult,
  LifeLog,
  LifeResetResult,
  LifeStatus,
  LogsResponse,
  NeedsReviewResponse,
  OwnerNotices,
  SearchUsage,
  UpdateAppConfigBody,
  UsageGroupKey,
  UsageResponse,
  WakeResult,
  DiscordBotsFile,
  ModelsResponse,
  OperationAccepted,
  PairInvitation,
  PendingPairingRequestList,
  ProviderCredentialsBody,
  ProviderId,
  ProvidersResponse,
  RemoteAccessConfig,
  RemoteAccessDiagnostics,
  RemoteAccessStatus,
  RuntimeState,
  ServerConfig,
  ServersResponse,
  StatusResponse,
  TrustedDevice,
  TrustedDeviceList,
  UpdateAssistantConfigBody,
  UpdateServerBody,
  UpdateWaifuBody,
  WaifuConfig,
  WaifusResponse
} from "./types";
import { parseClientContext } from "../state/clientContext";
import {
  ResumableEventFeed,
  type ResumableEventFeedOptions
} from "./resumableEventFeed";
import {
  LogicalMutationRegistry,
  LogicalMutationTransportError,
  type LogicalMutationResponse
} from "./logicalMutation";

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody, message?: string) {
    super(message ?? body.message ?? body.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

class ConflictError extends ApiError {
  latest: ApiErrorBody["latest"];
  constructor(body: ApiErrorBody) {
    super(409, body);
    this.latest = body.latest;
  }
}

// In dev, Vite proxies /api to backend. In production build served by backend,
// the same origin works. Both cases use "" as base.
const BASE = "";
const CSRF_HEADER = "x-waifus-csrf";
const IDEMPOTENCY_HEADER = "idempotency-key";
const CLIENT_CONTEXT_PATH = "/api/client-context";
const CANONICAL_BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

let browserCsrfToken: string | undefined;
let browserClientContext: ClientContext | undefined;
let browserSessionPromise: Promise<ClientContext> | undefined;
const logicalMutations = new LogicalMutationRegistry();

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

async function establishBrowserSession(): Promise<ClientContext> {
  const response = await fetch(`${BASE}${CLIENT_CONTEXT_PATH}`, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new ApiError(response.status, {
      error: "BrowserSessionError",
      message: `Could not establish the local browser session (HTTP ${response.status}).`
    });
  }
  let contextValue: unknown;
  try {
    contextValue = await response.json();
  } catch {
    throw new ApiError(0, {
      error: "BrowserSessionError",
      message: "The local browser session returned invalid client context."
    });
  }
  let context: ClientContext;
  try {
    context = parseClientContext(contextValue);
  } catch {
    throw new ApiError(0, {
      error: "BrowserSessionError",
      message: "The local browser session returned invalid client context."
    });
  }
  const token = response.headers.get(CSRF_HEADER) ?? "";
  if (token.length !== 43 || !CANONICAL_BASE64URL_32.test(token)) {
    throw new ApiError(0, {
      error: "BrowserSessionError",
      message: "The local browser session returned an invalid CSRF token."
    });
  }
  browserCsrfToken = token;
  browserClientContext = context;
  return context;
}

async function ensureBrowserSession(): Promise<ClientContext | undefined> {
  if (!isBrowserRuntime()) return undefined;
  if (browserCsrfToken && browserClientContext) return browserClientContext;
  if (!browserSessionPromise) {
    const pending = establishBrowserSession();
    pending.catch(() => {
      if (browserSessionPromise === pending) browserSessionPromise = undefined;
    });
    browserSessionPromise = pending;
  }
  return browserSessionPromise;
}

export async function browserSecurityHeaders(
  method: string,
  initial: Record<string, string> = {}
): Promise<Record<string, string>> {
  const context = await ensureBrowserSession();
  return context && browserCsrfToken && method !== "GET" && method !== "HEAD"
    ? { ...initial, [CSRF_HEADER]: browserCsrfToken }
    : initial;
}

export async function loadClientContext(): Promise<ClientContext> {
  const context = await ensureBrowserSession();
  if (!context) {
    throw new ApiError(0, {
      error: "BrowserSessionError",
      message: "Client context is available only in a browser session."
    });
  }
  return context;
}

export function recoverBrowserSession(status: number, body: unknown): boolean {
  if (!isBrowserRuntime() || status !== 403 || !body || typeof body !== "object") return false;
  const code = (body as { error?: unknown }).error;
  if (code !== "BrowserSessionRequired" && code !== "CsrfInvalid") return false;
  browserCsrfToken = undefined;
  browserClientContext = undefined;
  browserSessionPromise = undefined;
  return true;
}

/** The mutation layer's in-progress answer (`{operationId, status: "accepted", statusUrl}`). */
function isOperationAccepted(parsed: unknown): boolean {
  return Boolean(parsed) && typeof parsed === "object" && typeof (parsed as { operationId?: unknown }).operationId === "string";
}

function operationStatusUrl(status: number, parsed: unknown): string | undefined {
  // A route may answer 202 with its own result (a forget with pending parts, a compaction still
  // running): that is a value, not an operation receipt.
  if (status !== 202 || !isOperationAccepted(parsed)) return undefined;
  if (
    !parsed
    || typeof parsed !== "object"
    || typeof (parsed as { statusUrl?: unknown }).statusUrl !== "string"
  ) {
    throw new ApiError(0, {
      error: "InvalidResponse",
      message: "An accepted mutation did not return an operation status URL."
    });
  }
  return (parsed as { statusUrl: string }).statusUrl;
}

async function sendRequest<T>(
  method: string,
  path: string,
  init: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } | undefined,
  idempotencyKey?: string
): Promise<LogicalMutationResponse<T>> {
  let headers: Record<string, string> = { ...init?.headers };
  if (idempotencyKey) headers[IDEMPOTENCY_HEADER] = idempotencyKey;
  let body: BodyInit | undefined;
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res: Response;
    try {
      headers = await browserSecurityHeaders(method, headers);
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body,
        signal: init?.signal,
        credentials: "same-origin"
      });
    } catch (err) {
      if ((err as DOMException)?.name === "AbortError") {
        throw err;
      }
      const message = err instanceof Error ? err.message : "The network request failed.";
      if (idempotencyKey) {
        throw new LogicalMutationTransportError(message, { cause: err });
      }
      throw new ApiError(0, { error: "NetworkError", message });
    }
    if (res.status === 204) {
      return { value: undefined as T };
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = { error: "InvalidResponse", message: text.slice(0, 200) };
    }
    if (attempt === 0 && recoverBrowserSession(res.status, parsed)) continue;
    if (!res.ok) {
      const errorBody = (parsed ?? { error: `HTTP ${res.status}` }) as ApiErrorBody;
      if (res.status === 409) {
        throw new ConflictError(errorBody);
      }
      throw new ApiError(res.status, errorBody);
    }
    const statusUrl = operationStatusUrl(res.status, parsed);
    return {
      value: parsed as T,
      ...(statusUrl ? { statusUrl } : {})
    };
  }
  throw new ApiError(0, { error: "BrowserSessionError", message: "Browser session recovery failed." });
}

async function request<T>(
  method: string,
  path: string,
  init?: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
): Promise<T> {
  if (method === "GET" || method === "HEAD") {
    return (await sendRequest<T>(method, path, init)).value;
  }
  const action = await logicalMutations.begin({
    method,
    target: path,
    body: init?.body
  });
  return action.execute(({ idempotencyKey }) =>
    sendRequest<T>(method, path, init, idempotencyKey)
  );
}

export const api = {
  // Runtime
  status: (signal?: AbortSignal) => request<StatusResponse>("GET", "/api/status", { signal }),
  runtime: (signal?: AbortSignal) => request<RuntimeState>("GET", "/api/runtime", { signal }),
  pause: () => request<RuntimeState>("POST", "/api/runtime/pause"),
  resume: () => request<RuntimeState>("POST", "/api/runtime/resume"),
  reload: () => request<{ accepted: boolean; message: string }>("POST", "/api/runtime/reload"),
  /** Dismisses the persisted model notices of one scope (`waifu:<id>`, `assistant`). */
  dismissModelWarnings: (scope: string) =>
    request<{ scope: string; dismissed: number }>("DELETE", `/api/runtime/model-warnings/${encodeURIComponent(scope)}`),

  // Remote access
  remoteAccessStatus: (signal?: AbortSignal) =>
    request<RemoteAccessStatus>("GET", "/api/remote-access", { signal }),
  beginRemoteAccessActivation: () =>
    request<ActivationStartResult>("POST", "/api/remote-access/activation"),
  remoteAccessActivation: (activationOperationId: string, signal?: AbortSignal) =>
    request<ActivationStatus>(
      "GET",
      `/api/remote-access/activation/${encodeURIComponent(activationOperationId)}`,
      { signal }
    ),
  cancelRemoteAccessActivation: (activationOperationId: string) =>
    request<void>(
      "DELETE",
      `/api/remote-access/activation/${encodeURIComponent(activationOperationId)}`
    ),
  updateRemoteAccess: (body: {
    revision: string;
    enabled?: boolean;
    displayName?: string;
  }) => request<RemoteAccessConfig | OperationAccepted>("PUT", "/api/remote-access", { body }),
  createRemoteAccessInvitation: () =>
    request<PairInvitation>("POST", "/api/remote-access/invitations", { body: {} }),
  cancelRemoteAccessInvitation: (invitationId: string) =>
    request<OperationAccepted>(
      "DELETE",
      `/api/remote-access/invitations/${encodeURIComponent(invitationId)}`
    ),
  remoteAccessPairingRequests: (signal?: AbortSignal) =>
    request<PendingPairingRequestList>("GET", "/api/remote-access/pairing-requests", { signal }),
  approveRemoteAccessPairing: (requestId: string, body: ApprovePairingInput) =>
    request<OperationAccepted>(
      "POST",
      `/api/remote-access/pairing-requests/${encodeURIComponent(requestId)}/approve`,
      { body }
    ),
  rejectRemoteAccessPairing: (requestId: string) =>
    request<OperationAccepted>(
      "POST",
      `/api/remote-access/pairing-requests/${encodeURIComponent(requestId)}/reject`
    ),
  remoteAccessDevices: (signal?: AbortSignal) =>
    request<TrustedDeviceList>("GET", "/api/remote-access/devices", { signal }),
  renameRemoteAccessDevice: (deviceId: string, body: { revision: string; displayName: string }) =>
    request<TrustedDevice>(
      "PUT",
      `/api/remote-access/devices/${encodeURIComponent(deviceId)}`,
      { body }
    ),
  revokeRemoteAccessDevice: (deviceId: string, revision: string) =>
    request<OperationAccepted>(
      "DELETE",
      `/api/remote-access/devices/${encodeURIComponent(deviceId)}`,
      { body: { revision } }
    ),
  reconnectRemoteAccess: () =>
    request<OperationAccepted>("POST", "/api/remote-access/reconnect"),
  resetRemoteAccess: (confirmation: string) =>
    request<OperationAccepted>("POST", "/api/remote-access/reset", {
      body: { confirmation }
    }),
  remoteAccessDiagnostics: (signal?: AbortSignal) =>
    request<RemoteAccessDiagnostics>("GET", "/api/remote-access/diagnostics", { signal }),

  // Config
  getConfig: (signal?: AbortSignal) => request<AppConfig>("GET", "/api/config", { signal }),
  updates: (signal?: AbortSignal) => request<AutoUpdateStatus>("GET", "/api/updates", { signal }),
  putUpdateSettings: (updates: AppConfig["updates"]) => request<AppConfig>("PUT", "/api/config", { body: { updates } }),
  /** A partial patch: send only the keys that changed (omitted keys keep their values). */
  putConfig: (patch: UpdateAppConfigBody) => request<AppConfig>("PUT", "/api/config", { body: patch }),
  logs: (limit: number, signal?: AbortSignal) => request<LogsResponse>("GET", `/api/logs?limit=${Math.min(Math.max(1, limit), 500)}`, { signal }),
  /** Registry help for a group, a part of one or a key (`app.life`), as JSON. */
  help: (topic: string, signal?: AbortSignal) => request<HelpTopic>("GET", `/api/help/${encodeURIComponent(topic)}`, { signal }),
  clearOcrCache: () =>
    request<{ accepted: boolean; message: string }>("POST", "/api/cache/ocr/clear"),
  discordBots: (signal?: AbortSignal) =>
    request<DiscordBotsFile>("GET", "/api/discord-bots", { signal }),
  putDiscordBots: (bots: DiscordBotsFile) =>
    request<DiscordBotsFile>("PUT", "/api/discord-bots", { body: bots }),
  // Models (Living cast §9.2): the curated list every model picker offers.
  models: (signal?: AbortSignal) => request<ModelsResponse>("GET", "/api/models", { signal }),
  assistantConfig: (signal?: AbortSignal) =>
    request<AssistantConfig>("GET", "/api/assistant/config", { signal }),
  putAssistantConfig: (config: UpdateAssistantConfigBody) =>
    request<AssistantConfig>("PUT", "/api/assistant/config", { body: config }),
  createAssistantConversation: () =>
    request<{ conversationId: string }>("POST", "/api/assistant/conversations"),
  assistantConversation: (id: string, signal?: AbortSignal) =>
    request<{ id: string; busy: boolean; messages: AssistantStoredMessage[] }>(
      "GET",
      `/api/assistant/conversations/${encodeURIComponent(id)}`,
      { signal }
    ),
  sendAssistantMessage: (id: string, content: string) =>
    request<{ reply: string }>("POST", `/api/assistant/conversations/${encodeURIComponent(id)}/messages`, {
      body: { content }
    }),
  assistantAction: (actionId: string, signal?: AbortSignal) =>
    request<AssistantActionDetail>(
      "GET",
      `/api/assistant/actions/${encodeURIComponent(actionId)}`,
      { signal }
    ),
  confirmAssistantAction: (actionId: string) =>
    request<AssistantActionConfirmation>(
      "POST",
      `/api/assistant/actions/${encodeURIComponent(actionId)}/confirm`
    ),
  cancelAssistantAction: (actionId: string) =>
    request<void>("DELETE", `/api/assistant/actions/${encodeURIComponent(actionId)}`),

  // Providers
  providers: (signal?: AbortSignal) =>
    request<ProvidersResponse>("GET", "/api/providers", { signal }),
  putProviderCredentials: (providerId: ProviderId, body: ProviderCredentialsBody) =>
    request<{
      revision: number;
      updatedAt: string;
      providerId: ProviderId;
      credentials: ProvidersResponse["providers"][number]["credentials"];
    }>("PUT", `/api/providers/${providerId}/credentials`, { body }),
  deleteProviderCredentials: (providerId: ProviderId) =>
    request<{ revision: number; providerId: ProviderId }>("DELETE", `/api/providers/${encodeURIComponent(providerId)}/credentials`),

  // Waifus
  waifus: (signal?: AbortSignal) => request<WaifusResponse>("GET", "/api/waifus", { signal }),
  waifu: (id: string, signal?: AbortSignal) =>
    request<WaifuConfig>("GET", `/api/waifus/${encodeURIComponent(id)}`, { signal }),
  createWaifu: (body: CreateWaifuBody) =>
    request<WaifuConfig>("POST", "/api/waifus", { body }),
  updateWaifu: (id: string, body: UpdateWaifuBody) =>
    request<WaifuConfig>("PUT", `/api/waifus/${encodeURIComponent(id)}`, { body }),
  deleteWaifu: (id: string, revision: number) =>
    request<void>("DELETE", `/api/waifus/${encodeURIComponent(id)}`, {
      body: { revision }
    }),

  // Servers
  servers: (signal?: AbortSignal) => request<ServersResponse>("GET", "/api/servers", { signal }),
  server: (guildId: string, signal?: AbortSignal) =>
    request<ServerConfig>("GET", `/api/servers/${encodeURIComponent(guildId)}`, { signal }),
  updateServer: (guildId: string, body: UpdateServerBody) =>
    request<ServerConfig>("PUT", `/api/servers/${encodeURIComponent(guildId)}`, { body }),
  updateChannel: (guildId: string, channelId: string, body: ChannelBody) =>
    request<ServerConfig>(
      "PUT",
      `/api/servers/${encodeURIComponent(guildId)}/channels/${encodeURIComponent(channelId)}`,
      { body }
    ),

  // People (Living cast §14.1)
  forgetUser: (discordUserId: string, dryRun = false) =>
    request<ForgetUserResult>("POST", `/api/people/${encodeURIComponent(discordUserId)}/forget`, { body: { confirm: true, dryRun } }),
  forgetJobs: (signal?: AbortSignal) => request<ForgetJobsResponse>("GET", "/api/people/forget-jobs", { signal }),
  ownerNotices: (signal?: AbortSignal) => request<OwnerNotices>("GET", "/api/owner-notices", { signal }),

  // Lives (Living cast §14.1). `includePrivate` reveals DM content and works only on the host itself.
  life: (waifuId: string, includePrivate: boolean, signal?: AbortSignal) =>
    request<LifeStatus>("GET", `/api/waifus/${encodeURIComponent(waifuId)}/life${includePrivate ? "?includePrivate=1" : ""}`, { signal }),
  lifeLog: (waifuId: string, query: { epoch?: number; before?: number; limit?: number; includePrivate?: boolean }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.epoch !== undefined) params.set("epoch", String(query.epoch));
    if (query.before !== undefined) params.set("before", String(query.before));
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.includePrivate) params.set("includePrivate", "1");
    const qs = params.toString();
    return request<LifeLog>("GET", `/api/waifus/${encodeURIComponent(waifuId)}/life/log${qs ? `?${qs}` : ""}`, { signal });
  },
  wake: (waifuId: string, note?: string) =>
    request<WakeResult>("POST", `/api/waifus/${encodeURIComponent(waifuId)}/wake`, { body: note ? { note } : {} }),
  compactLife: (waifuId: string) => request<LifeCompactResult>("POST", `/api/waifus/${encodeURIComponent(waifuId)}/life/compact`),
  resetLife: (waifuId: string) => request<LifeResetResult>("POST", `/api/waifus/${encodeURIComponent(waifuId)}/life/reset`, { body: { confirm: true } }),
  needsReview: (waifuId: string, signal?: AbortSignal) =>
    request<NeedsReviewResponse>("GET", `/api/waifus/${encodeURIComponent(waifuId)}/life/needs-review`, { signal }),
  dismissNeedsReview: (waifuId: string, itemId: string) =>
    request<void>("DELETE", `/api/waifus/${encodeURIComponent(waifuId)}/life/needs-review/${encodeURIComponent(itemId)}`),

  // Usage, search, detector
  usage: (query: { from?: string; to?: string; groupBy?: UsageGroupKey[]; waifuId?: string; tz?: string }, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (query.from) params.set("from", query.from);
    if (query.to) params.set("to", query.to);
    if (query.groupBy?.length) params.set("groupBy", query.groupBy.join(","));
    if (query.waifuId) params.set("waifuId", query.waifuId);
    if (query.tz) params.set("tz", query.tz);
    const qs = params.toString();
    return request<UsageResponse>("GET", `/api/usage${qs ? `?${qs}` : ""}`, { signal });
  },
  searchUsage: (signal?: AbortSignal) => request<SearchUsage>("GET", "/api/search/usage", { signal }),
  detectorConfig: (signal?: AbortSignal) => request<DetectorConfigResponse>("GET", "/api/detector/config", { signal }),
  putDetectorConfig: (target: string) => request<DetectorConfigResponse>("PUT", "/api/detector/config", { body: { target } }),
  detectorModels: (signal?: AbortSignal) => request<DetectorModelsResponse>("GET", "/api/detector/models", { signal }),
  detectorHistory: (guildId: string, signal?: AbortSignal) =>
    request<{ guildId: string; entries: DetectorHistoryEntry[] }>("GET", `/api/detector/history?guildId=${encodeURIComponent(guildId)}`, { signal })
};

export type EventFeedOptions = Omit<
  ResumableEventFeedOptions,
  "url" | "prepareHeaders" | "onResponseError"
>;

/** Open the global epoch-aware feed after establishing the same-origin browser session. */
export function openEventStream(options: EventFeedOptions): ResumableEventFeed {
  return openResumableEventStream("/api/events", options);
}

export function openAssistantEventStream(
  conversationId: string,
  options: EventFeedOptions
): ResumableEventFeed {
  return openResumableEventStream(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/stream`,
    options
  );
}

function openResumableEventStream(
  path: string,
  options: EventFeedOptions
): ResumableEventFeed {
  const feed = new ResumableEventFeed({
    ...options,
    url: `${BASE}${path}`,
    prepareHeaders: () => browserSecurityHeaders("GET"),
    onResponseError: async (response) => {
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        body = undefined;
      }
      return recoverBrowserSession(response.status, body);
    }
  });
  feed.start();
  return feed;
}
