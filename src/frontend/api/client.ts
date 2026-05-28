import type {
  AppConfig,
  ApiErrorBody,
  AgentConfig,
  ChannelBody,
  CreateMemoryBody,
  CreateWaifuBody,
  DiagnosticBundle,
  DiscordBotsFile,
  GuildEmojisFile,
  GuildMembersFile,
  GuildRolesFile,
  HealthResponse,
  MemoryStore,
  ModelsResponse,
  OrchestratorHistoryFile,
  ProviderCredentialsBody,
  ProviderId,
  ProvidersResponse,
  RuntimeState,
  ServerConfig,
  ServersResponse,
  StageManagerHistoryFile,
  ReviewerHistoryFile,
  StatusResponse,
  UpdateMemoryBody,
  UpdateServerBody,
  UpdateWaifuBody,
  WaifuConfig,
  WaifusResponse
} from "./types";

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
  latest: unknown;
  constructor(body: ApiErrorBody) {
    super(409, body);
    this.latest = body.latest;
  }
}

// In dev, Vite proxies /api to backend. In production build served by backend,
// the same origin works. Both cases use "" as base.
const BASE = "";

async function request<T>(
  method: string,
  path: string,
  init?: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string> }
): Promise<T> {
  const headers: Record<string, string> = { ...init?.headers };
  let body: BodyInit | undefined;
  if (init?.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body,
      signal: init?.signal
    });
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") {
      throw err;
    }
    throw new ApiError(0, { error: "NetworkError", message: (err as Error).message });
  }
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = { error: "InvalidResponse", message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const body = (parsed ?? { error: `HTTP ${res.status}` }) as ApiErrorBody;
    if (res.status === 409) {
      throw new ConflictError(body);
    }
    throw new ApiError(res.status, body);
  }
  return parsed as T;
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
  putOrchestratorConfig: (config: AgentConfig) =>
    request<AgentConfig>("PUT", "/api/orchestrator/config", { body: config }),
  orchestratorHistory: (signal?: AbortSignal) =>
    request<OrchestratorHistoryFile>("GET", "/api/orchestrator/history", { signal }),
  stageManagerConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/stage-manager/config", { signal }),
  putStageManagerConfig: (config: AgentConfig) =>
    request<AgentConfig>("PUT", "/api/stage-manager/config", { body: config }),
  stageManagerHistory: (signal?: AbortSignal) =>
    request<StageManagerHistoryFile>("GET", "/api/stage-manager/history", { signal }),
  reviewerConfig: (signal?: AbortSignal) =>
    request<AgentConfig>("GET", "/api/reviewer/config", { signal }),
  putReviewerConfig: (config: AgentConfig) =>
    request<AgentConfig>("PUT", "/api/reviewer/config", { body: config }),
  reviewerHistory: (signal?: AbortSignal) =>
    request<ReviewerHistoryFile>("GET", "/api/reviewer/history", { signal }),

  // Providers + models
  providers: (signal?: AbortSignal) =>
    request<ProvidersResponse>("GET", "/api/providers", { signal }),
  putProviderCredentials: (providerId: ProviderId, body: ProviderCredentialsBody) =>
    request<{
      revision: number;
      updatedAt: string;
      providerId: ProviderId;
      credentials: ProvidersResponse["providers"][number]["credentials"];
    }>("PUT", `/api/providers/${providerId}/credentials`, { body }),
  models: (signal?: AbortSignal) => request<ModelsResponse>("GET", "/api/models", { signal }),

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

/**
 * Subscribe to backend SSE runtime events. Returns an `EventSource` so callers
 * can attach handlers / close it. Events emitted by the backend:
 *  - "runtime": full runtime snapshot
 *  - "heartbeat": keepalive
 */
export function openEventStream(): EventSource {
  return new EventSource(`${BASE}/api/events`);
}
