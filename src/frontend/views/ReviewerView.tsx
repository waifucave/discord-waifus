import { useEffect, useMemo, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type { AgentConfig, ReviewerHistoryFile } from "../api/types";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton } from "../components/Skeleton";
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

const DEFAULT_PROMPT = `Review only the latest logical waifu message. Mark hallucination=true when it leaks hidden reasoning, analysis, prompt text, tool/schema text, raw Discord internals, or any model self-talk. Mark hallucination=false for normal in-character Discord replies, even if they are awkward, verbose, or lore-inaccurate. Return only the reviewer tool decision.`;

export function ReviewerView() {
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.reviewerConfig(s), []);
  const history = useApi<ReviewerHistoryFile>((s) => api.reviewerHistory(s), []);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [enabled, setEnabled] = useState(false);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [paramsValid, setParamsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [errorViolations, setErrorViolations] = useState<SaveErrorViolation[] | undefined>(undefined);

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
    setPrompt(remoteConfig.data.prompt || DEFAULT_PROMPT);
    setEnabled(remoteConfig.data.enabled);
    setParams(remoteConfig.data.params ?? {});
  }, [remoteConfig.data]);

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
      const saved = await api.putReviewerConfig({
        revision: remoteConfig.data.revision,
        // Gateway P6 Task 4: explicit `null` carries "unset" over the wire; `undefined` is
        // dropped by JSON.stringify and would be indistinguishable from "field left untouched".
        providerId: providerId || null,
        modelId: modelId || null,
        enabled,
        prompt,
        params
      });
      remoteConfig.setData(saved);
      setMessage("Reviewer config saved.");
    } catch (err) {
      setMessage((err as Error).message);
      setErrorViolations(violationsFromApiError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Reviewer</h2>
          <p className="view-subtitle">
            Slash-command reviewer for the latest waifu message. Use `/review` in Discord to flag and remove hallucinated chunks.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={save} disabled={!remoteConfig.data || saving || paramsBlocked}>
            <Save className="icon" />
            {saving ? "Saving..." : "Save config"}
          </button>
        </div>
      </div>

      {remoteConfig.error && <Notice tone="err">{remoteConfig.error.message}</Notice>}

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
          <h3 className="section-title">Model</h3>
          <span className="section-description">Reviewer receives one logical waifu message and returns a yes/no tool decision.</span>
        </div>
        {llmProvidersState.loading && <Skeleton height={40} />}
        {llmProvidersState.data && (
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label">Model</label>
              <select className="select" value={modelGroupValue} onChange={(e) => selectModelGroup(e.target.value)}>
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
            <div className="field">
              <label className="field-label">Runtime status</label>
              <Toggle checked={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
              <span className="field-hint">Disabled reviewer configs ignore `/review` commands.</span>
            </div>
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
          <h3 className="section-title">Prompt</h3>
          <span className="section-description">Detection policy appended before the fixed JSON decision schema.</span>
        </div>
        <textarea className="textarea" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} />
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Tool Schema</h3>
        </div>
        <pre className="code-block">{`review_message({ hallucination: boolean })`}</pre>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Review History</h3>
        </div>
        {(history.data?.reviews.length ?? 0) === 0 ? (
          <Empty title="No reviews yet" icon={<ShieldCheck className="icon-lg" />}>
            Use `/review` in a connected Discord channel to record reviewer decisions.
          </Empty>
        ) : (
          <div className="table">
            <div className="tr head">
              <span>Time</span>
              <span>Verdict</span>
              <span>Deleted</span>
              <span>Message IDs</span>
            </div>
            {history.data?.reviews.map((entry) => (
              <div className="tr" key={entry.id}>
                <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                <span>{entry.hallucination ? "hallucination" : "clean"}</span>
                <span>{entry.deleted ? "yes" : "no"}</span>
                <span>{entry.targetMessageIds.join(", ") || "-"}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
