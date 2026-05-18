import { useEffect, useState } from "react";
import { Compass, PlayCircle, Save } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AgentConfig,
  DiscordBotConfig,
  DiscordBotsFile,
  ModelsResponse,
  OrchestratorHistoryFile,
  OrchestratorPromptSections,
  ProvidersResponse,
  ServersResponse
} from "../api/types";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton } from "../components/Skeleton";
import { DiscordBotGuide } from "../components/DiscordBotGuide";
import { Pill } from "../components/Pill";
import { Toggle } from "../components/Toggle";
import { ReasoningControls, hasReasoningControls } from "../components/ReasoningControls";
import type { ReasoningConfig } from "../api/types";

const PROMPT_SECTION_OPTIONS: Array<{ key: keyof OrchestratorPromptSections; label: string }> = [
  { key: "loopBreaking", label: "<loop_breaking>" },
  { key: "retriggerPacing", label: "<retrigger_pacing>" },
  { key: "messageStructure", label: "<message_structure>" },
  { key: "toolUse", label: "<tool_use>" }
];

export function OrchestratorView() {
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.orchestratorConfig(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const history = useApi<OrchestratorHistoryFile>((s) => api.orchestratorHistory(s), []);
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [reasoning, setReasoning] = useState<ReasoningConfig>({});
  const [promptSections, setPromptSections] = useState<OrchestratorPromptSections>({
    loopBreaking: true,
    retriggerPacing: true,
    messageStructure: true,
    toolUse: true
  });
  const [botDisplayName, setBotDisplayName] = useState("Orchestrator");
  const [botApplicationId, setBotApplicationId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
    setReasoning(remoteConfig.data.reasoning ?? {});
    setPromptSections(remoteConfig.data.promptSections);
  }, [remoteConfig.data]);

  useEffect(() => {
    if (!bots.data) return;
    setBotDisplayName(bots.data.orchestrator?.displayName ?? "Orchestrator");
    setBotApplicationId(bots.data.orchestrator?.applicationId ?? "");
    setBotToken("");
  }, [bots.data?.revision]);

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
      const saved = await api.putOrchestratorConfig({
        ...remoteConfig.data,
        providerId: providerId ? (providerId as AgentConfig["providerId"]) : undefined,
        modelId: modelId || undefined,
        enabled: true,
        reasoning,
        promptSections
      });
      remoteConfig.setData(saved);
      if (bots.data) {
        const base: DiscordBotConfig = bots.data.orchestrator ?? {
          id: "orchestrator",
          displayName: "Orchestrator",
          enabled: true
        };
        const savedBots = await api.putDiscordBots({
          ...bots.data,
          orchestrator: {
            ...base,
            id: "orchestrator",
            displayName: botDisplayName.trim() || "Orchestrator",
            applicationId: botApplicationId.trim() || undefined,
            token: botToken.trim() || undefined,
            enabled: true
          }
        });
        bots.setData(savedBots);
        setBotToken("");
      }
      setMessage("Orchestrator settings saved.");
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
      const res = await api.triggerOrchestrator(parseTarget(target));
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
          <h2 className="view-title">Orchestrator</h2>
          <p className="view-subtitle">
            Picks which waifus respond, when to trigger the stage manager or reviewer, and when to stay silent.
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
      {bots.error && <Notice tone="err">{bots.error.message}</Notice>}

      {message && (
        <div style={{ marginTop: 12 }}>
          <Notice tone="info">{message}</Notice>
        </div>
      )}

      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-header">
          <h3 className="section-title">Discord bot</h3>
          <span className="section-description">
            The orchestrator listens for Discord messages and decides which waifu should reply.
          </span>
        </div>
        {bots.loading && <Skeleton height={40} />}
        {bots.data && (
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label">Display name</label>
              <input
                className="input"
                value={botDisplayName}
                onChange={(e) => setBotDisplayName(e.target.value)}
                placeholder="Orchestrator"
              />
              <span className="field-hint">Friendly label shown in this UI.</span>
            </div>
            <div className="field">
              <label className="field-label">Application ID</label>
              <input
                className="input code"
                value={botApplicationId}
                onChange={(e) => setBotApplicationId(e.target.value)}
                placeholder="17-20 digit Discord application id"
              />
            </div>
            <div className="field">
              <label className="field-label">Bot token</label>
              <input
                className="input code"
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={
                  bots.data.orchestrator?.tokenConfigured
                    ? `Saved ${bots.data.orchestrator.tokenHint ?? ""} - leave blank to keep`
                    : "Paste bot token"
                }
              />
              <span className="field-hint">Token is write-only and redacted after save.</span>
            </div>
            <div className="field">
              <label className="field-label">Status</label>
              <div className="row">
                {bots.data.orchestrator?.tokenConfigured ? (
                  <Pill tone="ok" dot>token saved</Pill>
                ) : (
                  <Pill tone="warn" dot>missing token</Pill>
                )}
                {bots.data.orchestrator?.applicationId ? (
                  <Pill tone="ok" dot>app id saved</Pill>
                ) : (
                  <Pill tone="warn" dot>missing app id</Pill>
                )}
              </div>
            </div>
          </div>
        )}
        <DiscordBotGuide
          kind="orchestrator"
          applicationId={botApplicationId || bots.data?.orchestrator?.applicationId}
          botDisplayName={botDisplayName}
          collapsedByDefault={Boolean(bots.data?.orchestrator?.tokenConfigured)}
        />
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Model</h3>
          <span className="section-description">Filtered to providers with credentials configured.</span>
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
          <h3 className="section-title">Prompt sections</h3>
          <span className="section-description">
            Toggle optional sections of the orchestrator system prompt. Identity, hard rules, task instructions, server info, and active waifus are always included.
          </span>
        </div>
        <div className="grid grid-2">
          {PROMPT_SECTION_OPTIONS.map((option) => (
            <Toggle
              key={option.key}
              label={option.label}
              checked={promptSections[option.key]}
              onChange={(next) => setPromptSections((prev) => ({ ...prev, [option.key]: next }))}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Manual trigger target</h3>
          <span className="section-description">
            Selecting a channel runs the runtime pipeline; no target records a dry manual entry.
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
          <h3 className="section-title">Decision tool schema (read-only)</h3>
  <span className="section-description">Orchestrator must emit exactly one structured decision.</span>
        </div>
        <pre className="code-block">{`type OrchestratorDecision =
  | { action: "waifus"; selectedWaifus: { waifuId: string; sceneDirection?: string; replyToIndex?: number }[]; reasoning: string }
  | { action: "stage_manager"; retriggerAfterSeconds: number; reasoning: string }
  | { action: "reviewer"; reasoning: string }
  | { action: "no_reply"; retriggerAfterSeconds: number; reasoning: string };

// Use replyToIndex only for older messages; omit it for the latest message.`}</pre>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Decision history</h3>
          <span className="section-description">Recent decisions per server/channel.</span>
        </div>
        {(history.data?.decisions.length ?? 0) === 0 ? (
          <Empty title="No decisions yet" icon={<Compass className="icon-lg" />}>
            Trigger the orchestrator or let the runtime pipeline run to record decisions here.
          </Empty>
        ) : (
          <div className="table">
            <div className="tr head">
              <span>Time</span>
              <span>Action</span>
              <span>Waifus</span>
              <span>Reasoning</span>
            </div>
            {history.data?.decisions.map((entry) => (
              <div className="tr" key={entry.id}>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                <span>{entry.action}</span>
                <span>{entry.selectedWaifuIds.join(", ") || "—"}</span>
                <span>{entry.reasoning}</span>
              </div>
            ))}
          </div>
        )}
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
