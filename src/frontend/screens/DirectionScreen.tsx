import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type { AgentConfig, OrchestratorHistoryFile, UpdateAgentConfigBody } from "../api/types";
import type { ViewId } from "../nav";
import { Disclosure, FootRow, HeadRow, TabCells } from "./scaffold";
import { ModelParamsForm } from "../components/modelParams/ModelParamsForm";
import { Notice } from "../components/Notice";
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

type AgentTab = "orchestrator" | "stage-manager" | "reviewer" | "assistant";

const AGENT_API: Record<
  AgentTab,
  { get: (s?: AbortSignal) => Promise<AgentConfig>; put: (b: UpdateAgentConfigBody) => Promise<AgentConfig>; blurb: string; promptLabel?: string }
> = {
  orchestrator: {
    get: (s) => api.orchestratorConfig(s),
    put: (b) => api.putOrchestratorConfig(b),
    blurb: "The director — reads the room and decides who speaks, when to stay silent, and when to steer."
  },
  "stage-manager": {
    get: (s) => api.stageManagerConfig(s),
    put: (b) => api.putStageManagerConfig(b),
    blurb: "Watches conversations, records observations as memories, generates persona digests, and dreams at night."
  },
  reviewer: {
    get: (s) => api.reviewerConfig(s),
    put: (b) => api.putReviewerConfig(b),
    blurb: "Optional post-send check via /review in Discord — flags and removes leaked reasoning or prompt text.",
    promptLabel: "Detection policy"
  },
  assistant: {
    get: (s) => api.assistantConfig(s),
    put: (b) => api.putAssistantConfig(b),
    blurb: "Norma — the dashboard helper. She reads and changes app configuration through the same API this UI uses."
  }
};

export function DirectionScreen({
  tab,
  onNavigate,
  onTab
}: {
  tab: string | undefined;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onTab: (tab: string) => void;
}) {
  const active = (tab ?? "orchestrator") as AgentTab;
  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("home")} title="Direction" sub={AGENT_API[active].blurb} />
      <TabCells view="direction" active={active} onTab={onTab} />
      <AgentForm key={active} agent={active} />
      <FootRow />
    </div>
  );
}

function AgentForm({ agent }: { agent: AgentTab }) {
  const def = AGENT_API[agent];
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const remote = useApi<AgentConfig>((s) => def.get(s), [agent]);
  const orchestratorConfig = useApi<AgentConfig>((s) => api.orchestratorConfig(s), []);
  const history = useApi<OrchestratorHistoryFile | undefined>(
    async (s) => (agent === "orchestrator" ? api.orchestratorHistory(s) : undefined),
    [agent]
  );

  const [draft, setDraft] = useState<Partial<AgentConfig>>({});
  const [paramsValid, setParamsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [violations, setViolations] = useState<SaveErrorViolation[] | undefined>(undefined);

  useEffect(() => {
    if (remote.data) setDraft(remote.data);
  }, [remote.data]);

  const routeGroups = useMemo(() => groupModelRoutes(llmModelsState.data ?? []), [llmModelsState.data]);
  const configuredProviderIds = useMemo(
    () => new Set((llmProvidersState.data ?? []).filter((p) => p.credentialConfigured).map((p) => p.id)),
    [llmProvidersState.data]
  );
  const resolvedRoute = useMemo(() => {
    if (!draft.providerId || !draft.modelId) return undefined;
    return findRoute(llmModelsState.data ?? [], draft.providerId, draft.modelId);
  }, [llmModelsState.data, draft.providerId, draft.modelId]);
  const modelGroupOptions = useMemo(
    () =>
      buildModelGroupOptions(
        routeGroups,
        draft.providerId && draft.modelId && !resolvedRoute ? { providerId: draft.providerId, modelId: draft.modelId } : undefined
      ),
    [routeGroups, draft.providerId, draft.modelId, resolvedRoute]
  );
  const modelGroupValue = !draft.providerId || !draft.modelId ? "" : resolvedRoute ? resolvedRoute.group.key : UNAVAILABLE_MODEL_VALUE;
  const routeOptions = resolvedRoute ? buildRouteOptions(resolvedRoute.group, configuredProviderIds) : [];
  const set = (patch: Partial<AgentConfig>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    if (!remote.data) return;
    setSaving(true);
    setMessage(undefined);
    setViolations(undefined);
    try {
      const saved = await def.put({
        revision: remote.data.revision,
        enabled: draft.enabled,
        providerId: draft.providerId ?? null,
        modelId: draft.modelId ?? null,
        params: draft.params,
        prompt: draft.prompt,
        contextWindow: draft.contextWindow,
        ...(agent === "orchestrator" ? { directiveCooldown: draft.directiveCooldown } : {})
      });
      remote.setData(saved);
      setMessage("Saved.");
    } catch (err) {
      setMessage((err as Error).message);
      setViolations(violationsFromApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const fallbackModel = orchestratorConfig.data?.modelId;

  return (
    <div className="content">
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone={violations?.length ? "err" : "ok"}>
            <div>{message}</div>
            {violations && violations.length > 0 && (
              <ul className="model-params-warnings">
                {violations.map((v, i) => (
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

      <div className="cell slabel" style={{ flex: "none" }}>
        <span className="t-micro" style={{ color: "var(--ink)" }}>Model</span>
        <span className="t-micro">
            {agent === "assistant" && !draft.modelId
              ? fallbackModel
                ? `unset — borrowing the orchestrator's ${fallbackModel}`
                : "unset, and the orchestrator has none either"
              : agent === "stage-manager"
                ? "forced tool calls — reasoning params buy nothing here"
                : ""}
        </span>
      </div>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr 160px 160px" }}>
          <div className="fcell">
            <label className="field-label">Model</label>
            <select
              className="select"
              value={modelGroupValue}
              onChange={(e) => {
                const value = e.target.value;
                if (!value) return set({ providerId: undefined, modelId: undefined });
                if (value === UNAVAILABLE_MODEL_VALUE) return;
                const group = routeGroups.find((g) => g.key === value);
                const route = group && defaultRoute(group, configuredProviderIds);
                if (route) set({ providerId: route.providerId as AgentConfig["providerId"], modelId: route.modelId });
              }}
            >
              {modelGroupOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {resolvedRoute && resolvedRoute.group.routes.length > 1 ? (
            <div className="fcell">
              <label className="field-label">Route</label>
              <select
                className="select"
                value={resolvedRoute.route.providerId}
                onChange={(e) => {
                  const route = resolvedRoute.group.routes.find((r) => r.providerId === e.target.value);
                  if (route) set({ providerId: route.providerId as AgentConfig["providerId"], modelId: route.modelId });
                }}
              >
                {routeOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="cell" />
          )}
          <div className="fcell">
            <label className="field-label">Context window</label>
            <input className="input" type="number" min={1} max={100} value={draft.contextWindow ?? 20} onChange={(e) => set({ contextWindow: Number(e.target.value) })} />
          </div>
          <div className="fcell">
            <label className="field-label">Enabled</label>
            <label className="checkbox-chip">
              <input type="checkbox" checked={draft.enabled ?? false} onChange={(e) => set({ enabled: e.target.checked })} />
              {draft.enabled ? "On" : "Off"}
            </label>
          </div>
        </div>
      {agent === "orchestrator" && (
        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "260px 1fr" }}>
          <div className="fcell">
            <label className="field-label">Directive cooldown</label>
            <input className="input" type="number" min={0} value={draft.directiveCooldown ?? 3} onChange={(e) => set({ directiveCooldown: Number(e.target.value) })} />
            <span className="field-hint">Decisions between steering directives.</span>
          </div>
          <div className="cell" />
        </div>
      )}
      {draft.modelId && (
        <Disclosure title="Model parameters" hint="temperature · reasoning · advanced">
          <div className="fused" style={{ flex: "none" }}>
            <ModelParamsForm
              providerId={draft.providerId ?? null}
              modelId={draft.modelId ?? null}
              value={draft.params ?? {}}
              onChange={(params) => set({ params })}
              onValidity={setParamsValid}
            />
          </div>
        </Disclosure>
      )}

      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label">{def.promptLabel ?? "Extra instructions"} · appended to the fixed harness prompt</label>
        <textarea className="textarea" rows={6} value={draft.prompt ?? ""} onChange={(e) => set({ prompt: e.target.value })} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "var(--line)", background: "var(--ink)", flex: "none" }}>
        <div className="cell" />
        <button
          className="cell clickable"
          style={{ background: "var(--mint)", height: 64, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}
          onClick={save}
          disabled={saving || !remote.data || (Boolean(draft.modelId) && !paramsValid)}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {agent === "orchestrator" && (history.data?.decisions.length ?? 0) > 0 && (
        <>
          <div className="cell" style={{ padding: "12px 26px 10px", flex: "none" }}>
            <span className="t-micro">Recent decisions · newest first</span>
          </div>
          {history.data!.decisions.slice(0, 8).map((decision, index) => (
            <div className="cell" style={{ padding: "12px 26px", flex: "none" }} key={decision.id ?? index}>
              <div className="t-micro" style={{ marginBottom: 3 }}>
                {decision.createdAt ? new Date(decision.createdAt).toLocaleTimeString() : ""} ·{" "}
                <span className={"chip " + (decision.action === "reply" ? "mint" : "lavender")}>{decision.action}</span>
                {decision.respondingWaifus?.length ? " · " + decision.respondingWaifus.map((w) => w.waifuId).join(", ") : ""}
              </div>
              <div className="t-small">{decision.reasoning}</div>
            </div>
          ))}
        </>
      )}
      <div className="cell growcell" />
    </div>
  );
}
