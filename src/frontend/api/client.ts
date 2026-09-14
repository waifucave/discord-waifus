import type {
  AssistantStoredMessage,
  AppConfig,
  ActivationStartResult,
  ActivationStatus,
  ApprovePairingInput,
  ApiErrorBody,
  AgentConfig,
  ChannelBody,
  ClientContext,
  CreateMemoryBody,
  CreateWaifuBody,
  DiagnosticBundle,
  DiscordBotsFile,
  GuildEmojisFile,
  GuildMembersFile,
  GuildRolesFile,
  HealthResponse,
  MemoryStore,
  OrchestratorHistoryFile,
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
  StageManagerHistoryFile,
  ReviewerHistoryFile,
  StatusResponse,
  TrustedDevice,
  TrustedDeviceList,
  UpdateAgentConfigBody,
  UpdateMemoryBody,
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

export class ConflictError extends ApiError {
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

function operationStatusUrl(status: number, parsed: unknown): string | undefined {
  if (status !== 202) return undefined;
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
  health: (signal?: AbortSignal) => request<HealthResponse>("GET", "/api/health", { signal }),
  status: (signal?: AbortSignal) => request<StatusResponse>("GET", "/api/status", { signal }),
  runtime: (signal?: AbortSignal) => request<RuntimeState>("GET", "/api/runtime", { signal }),
  pause: () => request<RuntimeState>("POST", "/api/runtime/pause"),
  resume: () => request<RuntimeState>("POST", "/api/runtime/resume"),
  reload: () => request<{ accepted: boolean; message: string }>("POST", "/api/runtime/reload"),
  triggerOrchestrator: (target?: { guildId: string; channelId: string }) =>
    request<{ accepted: boolean; message: string; history?: OrchestratorHistoryFile }>(
      "POST",
      "/api/runtime/trigger/orchestrator",
      target ? { body: target } : undefined
    ),
  triggerStageManager: (target?: { guildId: string; channelId: string }) =>
    request<{ accepted: boolean; message: string; history?: StageManagerHistoryFile }>(
      "POST",
      "/api/runtime/trigger/stage-manager",
      target ? { body: target } : undefined
    ),
  diagnosticsBundle: (signal?: AbortSignal) =>
    request<DiagnosticBundle>("GET", "/api/diagnostics/bundle", { signal }),

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
  revokeRemoteAccessDevice: (deviceId: string) =>
    request<OperationAccepted>(
      "DELETE",
      `/api/remote-access/devices/${encodeURIComponent(deviceId)}`
    ),
  reconnectRemoteAccess: () =>
    request<OperationAccepted>("POST", "/api/remote-access/reconnect"),
  remoteAccessDiagnostics: (signal?: AbortSignal) =>
    request<RemoteAccessDiagnostics>("GET", "/api/remote-access/diagnostics", { signal }),

  // Config
  getConfig: (signal?: AbortSignal) => request<AppConfig>("GET", "/api/config", { signal }),
  putConfig: (config: AppConfig) => request<AppConfig>("PUT", "/api/config", { body: config }),
  clearOcrCache: () =>
    request<{ accepted: boolean; message: string }>("POST", "/api/cache/ocr/clear"),
  discordBots: (signal?: AbortSignal) =>
    request<DiscordBotsFile>("GET", "/api/discord-bots", { signal }),
  putDiscordBots: (bots: DiscordBotsFile) =>
    request<DiscordBotsFile>("PUT", "/api/discord-bots", { body: bots }),
  orchestratorConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/orchestrator/config", { signal }),
  putOrchestratorConfig: (config: UpdateAgentConfigBody) =>
    request<AgentConfig>("PUT", "/api/orchestrator/config", { body: config }),
  orchestratorHistory: (signal?: AbortSignal) =>
    request<OrchestratorHistoryFile>("GET", "/api/orchestrator/history", { signal }),
  stageManagerConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/stage-manager/config", { signal }),
  putStageManagerConfig: (config: UpdateAgentConfigBody) =>
    request<AgentConfig>("PUT", "/api/stage-manager/config", { body: config }),
  stageManagerHistory: (signal?: AbortSignal) =>
    request<StageManagerHistoryFile>("GET", "/api/stage-manager/history", { signal }),
  reviewerConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/reviewer/config", { signal }),
  putReviewerConfig: (config: UpdateAgentConfigBody) =>
    request<AgentConfig>("PUT", "/api/reviewer/config", { body: config }),
  reviewerHistory: (signal?: AbortSignal) =>
    request<ReviewerHistoryFile>("GET", "/api/reviewer/history", { signal }),
  assistantConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/assistant/config", { signal }),
  putAssistantConfig: (config: UpdateAgentConfigBody) =>
    request<AgentConfig>("PUT", "/api/assistant/config", { body: config }),
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

  // Waifus
  waifus: (signal?: AbortSignal) => request<WaifusResponse>("GET", "/api/waifus", { signal }),
  waifu: (id: string, signal?: AbortSignal) =>
    request<WaifuConfig>("GET", `/api/waifus/${encodeURIComponent(id)}`, { signal }),
  createWaifu: (body: CreateWaifuBody) =>
    request<WaifuConfig>("POST", "/api/waifus", { body }),
  updateWaifu: (id: string, body: UpdateWaifuBody) =>
    request<WaifuConfig>("PUT", `/api/waifus/${encodeURIComponent(id)}`, { body }),
  regeneratePersonaDigest: (id: string) =>
    request<WaifuConfig>("POST", `/api/waifus/${encodeURIComponent(id)}/digest`),
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
  members: (guildId: string, signal?: AbortSignal) =>
    request<GuildMembersFile>("GET", `/api/servers/${encodeURIComponent(guildId)}/members`, {
      signal
    }),
  refreshMembers: (guildId: string) =>
    request<{ accepted: boolean; guildId: string; message: string }>(
      "POST",
      `/api/servers/${encodeURIComponent(guildId)}/members/refresh`
    ),
  emojis: (guildId: string, signal?: AbortSignal) =>
    request<GuildEmojisFile>("GET", `/api/servers/${encodeURIComponent(guildId)}/emojis`, {
      signal
    }),
  refreshEmojis: (guildId: string) =>
    request<{ accepted: boolean; guildId: string; message: string }>(
      "POST",
      `/api/servers/${encodeURIComponent(guildId)}/emojis/refresh`
    ),
  roles: (guildId: string, signal?: AbortSignal) =>
    request<GuildRolesFile>("GET", `/api/servers/${encodeURIComponent(guildId)}/roles`, {
      signal
    }),
  refreshRoles: (guildId: string) =>
    request<{ accepted: boolean; guildId: string; message: string }>(
      "POST",
      `/api/servers/${encodeURIComponent(guildId)}/roles/refresh`
    ),
  updateChannel: (guildId: string, channelId: string, body: ChannelBody) =>
    request<ServerConfig>(
      "PUT",
      `/api/servers/${encodeURIComponent(guildId)}/channels/${encodeURIComponent(channelId)}`,
      { body }
    ),

  // Memories
  memories: (signal?: AbortSignal) => request<MemoryStore>("GET", "/api/memories", { signal }),
  createMemory: (body: CreateMemoryBody) =>
    request<MemoryStore>("POST", "/api/memories", { body }),
  updateMemory: (id: string, body: UpdateMemoryBody) =>
    request<MemoryStore>("PUT", `/api/memories/${encodeURIComponent(id)}`, { body }),
  deleteMemory: (id: string, revision: number) =>
    request<MemoryStore>("DELETE", `/api/memories/${encodeURIComponent(id)}`, {
      body: { revision }
    })
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
