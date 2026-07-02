import { useEffect, useMemo, useState } from "react";
import { Compass, PlayCircle, Save } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type {
  AgentConfig,
  DiscordBotConfig,
  DiscordBotsFile,
  OrchestratorHistoryFile,
  OrchestratorPromptSections,
  ServersResponse
} from "../api/types";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton } from "../components/Skeleton";
import { DiscordBotGuide } from "../components/DiscordBotGuide";
import { Pill } from "../components/Pill";
import { Toggle } from "../components/Toggle";
import { ModelParamsForm } from "../components/modelParams/ModelParamsForm";
import {
  buildModelGroupOptions,
  buildRouteOptions,
  defaultRoute,
  findRoute,
  groupModelRoutes,
  UNAVAILABLE_MODEL_VALUE
} from "../components/modelParams/logic";
import { violationsFromApiError, type SaveErrorViolation } from "../api/violations";

type LlmProviderSummary = Awaited<ReturnType<typeof llmProviders>>[number];

const SECTION_OPTIONS: Array<{ key: keyof OrchestratorPromptSections; label: string }> = [
  { key: "pausePlanning", label: "<pause_planning>" },
  { key: "messageStructure", label: "<chat_message_structure>" }
];

export function OrchestratorView() {
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.orchestratorConfig(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const history = useApi<OrchestratorHistoryFile>((s) => api.orchestratorHistory(s), []);
  const [providerId, setProviderId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [paramsValid, setParamsValid] = useState(true);
  const [promptSections, setPromptSections] = useState<OrchestratorPromptSections>({
    pausePlanning: true,
    messageStructure: true
  });
  const [contextWindow, setContextWindow] = useState<number>(20);
  const [directiveCooldown, setDirectiveCooldown] = useState<number>(3);
  const [botDisplayName, setBotDisplayName] = useState("Orchestrator");
  const [botApplicationId, setBotApplicationId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [errorViolations, setErrorViolations] = useState<SaveErrorViolation[] | undefined>(undefined);
  const [target, setTarget] = useState("");

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
    setParams(remoteConfig.data.params ?? {});
    setPromptSections(remoteConfig.data.promptSections);
    setContextWindow(remoteConfig.data.contextWindow ?? 20);
    setDirectiveCooldown(remoteConfig.data.directiveCooldown ?? 3);
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

  const routeGroups = useMemo(() => groupModelRoutes(llmModelsState.data ?? []), [llmModelsState.data]);
  const configuredProviderIds = useMemo(
    () => new Set((llmProvidersState.data ?? []).filter((p) => p.credentialConfigured).map((p) => p.id)),
    [llmProvidersState.data]
  );
  const resolvedRoute = useMemo(() => {
    if (!providerId || !modelId) return undefined;
    return findRoute(llmModelsState.data ?? [], providerId, modelId);
  }, [llmModelsState.data, providerId, modelId]);
  const modelGroupOptions = useMemo(
    () =>
      buildModelGroupOptions(
        routeGroups,
        providerId && modelId && !resolvedRoute ? { providerId, modelId } : undefined
      ),
    [routeGroups, providerId, modelId, resolvedRoute]
  );
  const modelGroupValue = !providerId || !modelId
    ? ""
    : resolvedRoute
      ? resolvedRoute.group.key
      : UNAVAILABLE_MODEL_VALUE;
  const routeOptions = resolvedRoute ? buildRouteOptions(resolvedRoute.group, configuredProviderIds) : [];

  const selectModelGroup = (value: string) => {
    if (value === "") {
      setProviderId("");
      setModelId("");
      return;
    }
    if (value === UNAVAILABLE_MODEL_VALUE) {
      return;
    }
    const group = routeGroups.find((g) => g.key === value);
    const route = group && defaultRoute(group, configuredProviderIds);
    if (!route) return;
    setProviderId(route.providerId);
    setModelId(route.modelId);
  };

  const selectRoute = (nextProviderId: string) => {
    const route = resolvedRoute?.group.routes.find((r) => r.providerId === nextProviderId);
    if (!route) return;
    setProviderId(route.providerId);
    setModelId(route.modelId);
  };

  const modelSelected = Boolean(providerId && modelId);
  const paramsBlocked = modelSelected && !paramsValid;

  const save = async () => {
    if (!remoteConfig.data) return;
    setSaving(true);
    setMessage(undefined);
    setErrorViolations(undefined);
    try {
      const saved = await api.putOrchestratorConfig({
        revision: remoteConfig.data.revision,
        enabled: true,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        contextWindow,
        directiveCooldown,
        promptSections,
        params
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
      setErrorViolations(violationsFromApiError(err));
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
          <button className="btn" onClick={save} disabled={!remoteConfig.data || saving || paramsBlocked}>
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
          <Notice tone="info">
            <div>{message}</div>
            {errorViolations && errorViolations.length > 0 && (
              <ul className="model-params-warnings">
                {errorViolations.map((v, i) => (
                  <li key={i}>
                    {v.param}: {v.code}
                    {v.rule ? ` (rule ${v.rule})` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Notice>
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
        {llmProvidersState.loading && <Skeleton height={40} />}
        {llmProvidersState.data && (
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label">Model</label>
              <select
                className="select"
                value={modelGroupValue}
                onChange={(e) => selectModelGroup(e.target.value)}
              >
                {modelGroupOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {resolvedRoute && resolvedRoute.group.routes.length > 1 && (
              <div className="field">
                <label className="field-label">Route</label>
                <select
                  className="select"
                  value={resolvedRoute.route.providerId}
                  onChange={(e) => selectRoute(e.target.value)}
                >
                  {routeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
      </section>

      <ModelParamsForm
        providerId={providerId || null}
        modelId={modelId || null}
        value={params}
        onChange={setParams}
        onValidity={setParamsValid}
      />

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Context &amp; directives</h3>
          <span className="section-description">
            How many messages of history the orchestrator reads, and how often it may attach a directive to a responder.
          </span>
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label">Context window (messages)</label>
            <input
              className="input"
              type="number"
              min={1}
              max={100}
              value={contextWindow}
              onChange={(e) =>
                e.target.value.trim() === ""
                  ? setContextWindow(contextWindow)
                  : setContextWindow(Math.max(1, Math.min(100, Number(e.target.value) || 20)))
              }
            />
            <span className="field-hint">Default 20</span>
          </div>
          <div className="field">
            <label className="field-label">Directive cooldown (decisions)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={20}
              value={directiveCooldown}
              onChange={(e) =>
                e.target.value.trim() === ""
                  ? setDirectiveCooldown(directiveCooldown)
                  : setDirectiveCooldown(Math.max(0, Math.min(20, Number(e.target.value) || 0)))
              }
            />
            <span className="field-hint">Default 3</span>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Prompt</h3>
          <span className="section-description">
            Toggle optional sections of the orchestrator system prompt. Identity, hard rules, task instructions, server info, and active waifus are always included.
          </span>
        </div>
        <div className="grid grid-2" style={{ marginTop: 12 }}>
          {SECTION_OPTIONS.map((option) => (
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
        <pre className="code-block">{`{
  "action": "reply" | "no_reply",
  "respondingWaifus": [
    { "waifuId": string, "delaySeconds": number (0..30, default 0),
      "directive": { "intent": "break_loop"|"change_topic"|"include_person"|"close_beat"|"interrupt"|"spotlight", "goal": string (<=100 chars) } | null }
  ],
  "retriggerAfterSeconds": number (100..28800) | null,
  "wakePlan": string | null,
  "reasoning": string
}
// action="reply"    -> respondingWaifus non-empty, retriggerAfterSeconds + wakePlan null
// action="no_reply" -> respondingWaifus empty, retriggerAfterSeconds + wakePlan set`}</pre>
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
              <span>Status</span>
              <span>Execution</span>
              <span>Retrigger</span>
              <span>Reasoning</span>
            </div>
            {history.data?.decisions.map((entry) => (
              <div className="tr" key={entry.id}>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                <span>{entry.action}</span>
                <span>{entry.status}</span>
                <span>{formatResponderExecution(entry)}</span>
                <span>
                  {entry.retriggerAfterSeconds ? `${entry.retriggerAfterSeconds}s` : "—"}
                  {entry.action === "no_reply" && entry.wakePlan && (
                    <span className="field-hint" style={{ display: "block" }}>
                      wake plan: {entry.wakePlan}
                    </span>
                  )}
                </span>
                <span>{entry.reasoning}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function formatResponderExecution(
  entry: OrchestratorHistoryFile["decisions"][number]
): string {
  if (entry.responderOutcomes.length === 0) {
    return entry.respondingWaifus
      .map((responder) => {
        const dir = responder.directive
          ? ` (${responder.directive.intent}${responder.directive.goal ? ": " + responder.directive.goal : ""})`
          : "";
        return `${responder.waifuId}${dir}`;
      })
      .join(" → ") || "—";
  }
  return entry.responderOutcomes
    .map((outcome) => {
      const source = outcome.source === "handoff"
        ? ` handoff from ${outcome.handoffFromWaifuId ?? "unknown"}`
        : outcome.handoffFromWaifuId
          ? ` moved next by ${outcome.handoffFromWaifuId}`
          : "";
      const reason = outcome.reason ? `: ${outcome.reason.replaceAll("_", " ")}` : "";
      const stripped = outcome.directiveStripped
        ? ` directive stripped (${outcome.directiveStripped.replaceAll("_", " ")})`
        : "";
      return `${outcome.waifuId} [${outcome.status.replaceAll("_", " ")}${source}${reason}${stripped}]`;
    })
    .join(" → ");
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
