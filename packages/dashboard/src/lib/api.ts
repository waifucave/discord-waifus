import type {
  ChannelConfig,
  DebugResponse,
  InvalidWaifuRow,
  OrchestratorConfig,
  ProviderConfig,
  StageManagerConfig,
  StageManagerDiagnosticsRuntime,
  StageManagerDiagnosticsState,
  StageManagerRunSummary,
  StatusResponse,
  WaifuEditorPayload,
  WaifuEditorWritePayload
} from "./types";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export const api = {
  getStatus: () => request<StatusResponse>("/api/status"),
  getDebug: () => request<DebugResponse>("/api/debug"),
  getOrchestrator: () => request<{ orchestrator: OrchestratorConfig }>("/api/orchestrator"),
  updateOrchestrator: (patch: Partial<OrchestratorConfig>) =>
    request<{ orchestrator: OrchestratorConfig }>("/api/orchestrator", {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  getStageManager: () => request<{ stageManager: StageManagerConfig }>("/api/stage-manager"),
  updateStageManager: (patch: Partial<StageManagerConfig>) =>
    request<{ stageManager: StageManagerConfig }>("/api/stage-manager", {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  getStageManagerState: () =>
    request<{ state: StageManagerDiagnosticsState; runtime: StageManagerDiagnosticsRuntime }>(
      "/api/stage-manager/state"
    ),
  runStageManager: (guildId: string) =>
    request<{ result: StageManagerRunSummary }>("/api/stage-manager/run", {
      method: "POST",
      body: JSON.stringify({ guildId })
    }),
  getWaifus: () =>
    request<{ waifus: WaifuEditorPayload[]; invalidWaifus: InvalidWaifuRow[] }>("/api/waifus"),
  getWaifuTemplate: () => request<WaifuEditorPayload>("/api/waifus/template"),
  getWaifu: (id: string) => request<WaifuEditorPayload>(`/api/waifus/${id}`),
  createWaifu: (payload: WaifuEditorWritePayload) =>
    request<WaifuEditorPayload>("/api/waifus", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateWaifu: (id: string, payload: WaifuEditorWritePayload) =>
    request<WaifuEditorPayload>(`/api/waifus/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteWaifu: (id: string) => request<void>(`/api/waifus/${id}`, { method: "DELETE" }),
  startWaifu: (id: string) =>
    request<{ ok: boolean }>(`/api/waifus/${id}/start`, { method: "POST" }),
  stopWaifu: (id: string) => request<{ ok: boolean }>(`/api/waifus/${id}/stop`, { method: "POST" }),
  uploadWaifuAsset: async (id: string, kind: "avatar" | "banner", file: File) => {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch(`/api/waifus/${id}/${kind}`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<{ ok: boolean }>;
  },
  getProviders: () => request<{ providers: ProviderConfig[] }>("/api/providers"),
  createProvider: (provider: ProviderConfig) =>
    request<ProviderConfig>("/api/providers", {
      method: "POST",
      body: JSON.stringify(provider)
    }),
  updateProvider: (id: string, patch: Partial<ProviderConfig>) =>
    request<ProviderConfig>(`/api/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    request<{ ok: boolean; content?: string; error?: string; runtimeErrors?: string[] }>(
      `/api/providers/${id}/test`,
      {
        method: "POST"
      }
    ),
  fetchProviderModels: (id: string) =>
    request<{ models: string[]; discoveryAttempted?: boolean; runtimeErrors?: string[] }>(
      `/api/providers/${id}/models`
    ),
  getChannels: () => request<{ channels: ChannelConfig[] }>("/api/channels"),
  createChannel: (channel: ChannelConfig) =>
    request<ChannelConfig>("/api/channels", {
      method: "POST",
      body: JSON.stringify(channel)
    }),
  updateChannel: (id: string, patch: Partial<ChannelConfig>) =>
    request<ChannelConfig>(`/api/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch)
    }),
  deleteChannel: (id: string) => request<void>(`/api/channels/${id}`, { method: "DELETE" })
};
