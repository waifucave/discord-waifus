import { useEffect, useState } from "react";
import { Layers, PlayCircle, Save } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AgentConfig,
  ModelsResponse,
  ProvidersResponse,
  ServersResponse,
  StageManagerHistoryFile
} from "../api/types";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton } from "../components/Skeleton";
import { Toggle } from "../components/Toggle";
import { ReasoningControls, hasReasoningControls } from "../components/ReasoningControls";
import type { ReasoningConfig } from "../api/types";

export function StageManagerView() {
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.stageManagerConfig(s), []);
  const history = useApi<StageManagerHistoryFile>((s) => api.stageManagerHistory(s), []);
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [enabled, setEnabled] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningConfig>({});
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
    setEnabled(remoteConfig.data.enabled);
    setReasoning(remoteConfig.data.reasoning ?? {});
  }, [remoteConfig.data]);

  useEffect(() => {
    if (target || !servers.data) return;
    const first = firstRuntimeTarget(servers.data);
    if (first) setTarget(first.value);
  }, [servers.data, target]);

  const save = async () => {
    if (!remoteConfig.data) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.putStageManagerConfig({
        ...remoteConfig.data,
        providerId: providerId ? (providerId as AgentConfig["providerId"]) : undefined,
        modelId: modelId || undefined,
        enabled,
        reasoning
      });
      remoteConfig.setData(saved);
      setMessage("Stage-manager config saved.");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const trigger = async () => {
    setPending(true);
    setMessage(undefined);
    try {
      const res = await api.triggerStageManager(parseTarget(target));
      setMessage(res.message);
      if (res.history) history.setData(res.history);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const filteredModels = providerId
    ? models.data?.models.filter((m) => m.providerId === providerId)
    : models.data?.models;
  const selectedModel = models.data?.models.find(
    (m) => m.modelId === modelId && (!providerId || m.providerId === providerId)
  );

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Stage manager</h2>
          <p className="view-subtitle">
            Background reviewer of long-window context that edits waifu memories without blocking
            replies.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={save} disabled={!remoteConfig.data || saving}>
            <Save className="icon" />
            {saving ? "Saving…" : "Save config"}
          </button>
          <button className="btn primary" onClick={trigger} disabled={pending}>
            <PlayCircle className="icon" />
            {pending ? "Triggering…" : "Trigger now"}
          </button>
        </div>
      </div>

      {remoteConfig.error && <Notice tone="err">{remoteConfig.error.message}</Notice>}

      {message && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="info">{message}</Notice>
        </div>
      )}

      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-header">
          <h3 className="section-title">Model</h3>
          <span className="section-description">Defaults to a long-context model when available.</span>
        </div>
        {providers.loading && <Skeleton height={40} />}
        {providers.data && (
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label">Provider</label>
              <select
                className="select"
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setModelId("");
                }}
              >
                <option value="">— Any —</option>
                {providers.data.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.credentials.configured}>
                    {p.displayName} {p.credentials.configured ? "" : "(no key)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Model</label>
              <select
                className="select"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              >
                <option value="">— Select —</option>
                {(filteredModels ?? []).map((m) => (
                  <option key={`${m.providerId}/${m.modelId}`} value={m.modelId}>
                    {m.displayName} ({m.modelId})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Runtime status</label>
              <Toggle
                checked={enabled}
                onChange={setEnabled}
                label={enabled ? "Enabled" : "Disabled"}
              />
              <span className="field-hint">
                Disabled stage-manager configs skip memory review.
              </span>
            </div>
            <ReasoningControls
              model={selectedModel}
              value={reasoning}
              onChange={setReasoning}
            />
          </div>
        )}
        {selectedModel && !hasReasoningControls(selectedModel) && (
          <span className="field-hint">
            Selected model does not expose reasoning controls.
          </span>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Manual trigger target</h3>
          <span className="section-description">
            Selecting a channel runs the background memory reviewer for that channel.
          </span>
        </div>
        <div className="field">
          <label className="field-label">Server / channel</label>
          <select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">No target</option>
            {runtimeTargetOptions(servers.data).map((option) => (
              <option key={option.value} value={option.value} disabled={!option.enabled}>
                {option.label}{option.enabled ? "" : " (disabled)"}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Pipeline</h3>
        </div>
        <pre className="code-block">{`Pass 1 — Observer: extract atomic durable observations from chat.
  record_observations(observations[{ waifuId, content, importance, kind }])

Pass 2 — Librarian: reconcile observations with existing memories.
  add_memory(waifuId, content, importance)
  update_memory(memoryIndex, fields)
  archive_memory(memoryIndex)
  merge_memories(sourceMemoryIndices[], mergedContent)
  no_change(reason)`}</pre>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Memory edit history</h3>
        </div>
        {(history.data?.edits.length ?? 0) === 0 ? (
          <Empty title="No edits yet" icon={<Layers className="icon-lg" />}>
            Trigger the stage manager or let the runtime pipeline run to record memory tool calls.
          </Empty>
        ) : (
          <div className="table">
            <div className="tr head">
              <span>Time</span>
              <span>Tool</span>
              <span>Obs</span>
              <span>Memory IDs</span>
              <span>Summary</span>
            </div>
            {history.data?.edits.map((entry) => (
              <div className="tr" key={entry.id}>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                <span>{entry.tool}</span>
                <span>{entry.observationCount ?? "—"}</span>
                <span>{entry.affectedMemoryIds.join(", ") || "—"}</span>
                <span>{entry.summary}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Background status</h3>
        </div>
        <div className="kv">
          <span className="k">Last run</span>
          <span className="v">{history.data?.edits[0]?.createdAt ? new Date(history.data.edits[0].createdAt).toLocaleString() : "—"}</span>
          <span className="k">Active per channel</span>
          <span className="v">0</span>
          <span className="k">Pending</span>
          <span className="v">0</span>
        </div>
      </section>
    </>
  );
}

function runtimeTargetOptions(servers: ServersResponse | undefined): Array<{
  value: string;
  label: string;
  enabled: boolean;
}> {
  return (servers?.servers ?? []).flatMap((server) =>
    Object.values(server.channels ?? {}).map((channel) => ({
      value: `${server.guildId}:${channel.channelId}`,
      label: `${server.name || server.guildId} / ${channel.name || `#${channel.channelId}`}`,
      enabled: (channel.enabledWaifuIds?.length ?? 0) > 0
    }))
  );
}

function firstRuntimeTarget(servers: ServersResponse): { value: string } | undefined {
  return runtimeTargetOptions(servers).find((option) => option.enabled);
}

function parseTarget(value: string): { guildId: string; channelId: string } | undefined {
  const idx = value.indexOf(":");
  if (!value || idx <= 0) return undefined;
  return {
    guildId: value.slice(0, idx),
    channelId: value.slice(idx + 1)
  };
}
