import { useEffect, useMemo, useState } from "react";
import { Save } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type { AgentConfig } from "../api/types";
import { Notice } from "../components/Notice";
import { Skeleton } from "../components/Skeleton";
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

export function AssistantView() {
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.assistantConfig(s), []);
  const orchestratorConfig = useApi<AgentConfig>((s) => api.orchestratorConfig(s), []);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [paramsValid, setParamsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [errorViolations, setErrorViolations] = useState<SaveErrorViolation[] | undefined>(undefined);

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
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
  const fallbackModel = orchestratorConfig.data?.modelId;

  const save = async () => {
    if (!remoteConfig.data) return;
    setSaving(true);
    setMessage(undefined);
    setErrorViolations(undefined);
    try {
      const saved = await api.putAssistantConfig({
        revision: remoteConfig.data.revision,
        providerId: providerId || null,
        modelId: modelId || null,
        params
      });
      remoteConfig.setData(saved);
      setMessage("Assistant config saved.");
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
          <h2 className="view-title">Assistant</h2>
          <p className="view-subtitle">
            The dashboard helper agent. It reads and changes app configuration through the same API the dashboard
            uses, and answers questions from the built-in docs.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn primary" onClick={save} disabled={!remoteConfig.data || saving || paramsBlocked}>
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
          <span className="section-description">
            {modelSelected
              ? "The assistant runs on this model."
              : fallbackModel
                ? `No model set — the assistant currently borrows the orchestrator's model (${fallbackModel}).`
                : "No model set, and the orchestrator has none either — the assistant cannot run yet."}
          </span>
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
              <span className="field-hint">Leave unset to follow the orchestrator's model.</span>
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
    </>
  );
}
