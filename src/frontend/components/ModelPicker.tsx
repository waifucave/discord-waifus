import type { CuratedModel, ModelChoice } from "../api/types";

/** Select value for a stored choice the curated list no longer offers. */
const UNAVAILABLE = "__unavailable__";

function routeId(choice: Pick<ModelChoice, "providerId" | "modelId">): string {
  return `${choice.providerId}/${choice.modelId}`;
}

export function modelOptionLabel(model: CuratedModel): string {
  return [
    `${model.displayName} · ${model.providerDisplayName}`,
    model.contributor ? "contributor: shares prompts for training" : undefined,
    model.credentialsConfigured ? undefined : "no API key"
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The curated model picker (Living cast §9.2): one route select over GET /api/models and one effort
 * select over the chosen route's own efforts. Contributor variants are labelled and never picked
 * implicitly. A stored choice the list no longer offers stays visible as "not offered".
 */
export function ModelPicker({
  value,
  onChange,
  models,
  unsetLabel = "— no model —",
  unsetHint
}: {
  value: ModelChoice | undefined;
  onChange: (value: ModelChoice | undefined) => void;
  models: CuratedModel[];
  unsetLabel?: string;
  /** Shown under the route select while nothing is chosen. */
  unsetHint?: string;
}) {
  const selected = value ? models.find((model) => model.id === routeId(value)) : undefined;
  const routeValue = !value ? "" : selected ? selected.id : UNAVAILABLE;
  const efforts = selected?.efforts ?? [];
  const effortUnsupported = value?.effort !== undefined && selected !== undefined && !efforts.includes(value.effort);

  return (
    <>
      <div className="fcell">
        <label className="field-label">Model</label>
        <select
          className="select"
          value={routeValue}
          onChange={(e) => {
            const next = e.target.value;
            if (next === UNAVAILABLE) return;
            if (!next) return onChange(undefined);
            const model = models.find((candidate) => candidate.id === next);
            if (model) onChange({ providerId: model.providerId, modelId: model.modelId });
          }}
        >
          <option value="">{unsetLabel}</option>
          {value && !selected && <option value={UNAVAILABLE}>{routeId(value)} (not offered)</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {modelOptionLabel(model)}
            </option>
          ))}
        </select>
        {!value && unsetHint && <span className="field-hint">{unsetHint}</span>}
        {value && !selected && (
          <span className="field-hint" style={{ color: "var(--danger)" }}>
            This model is no longer offered. Pick another one.
          </span>
        )}
        {selected && !selected.credentialsConfigured && (
          <span className="field-hint">Add a {selected.providerDisplayName} API key in Settings → Providers.</span>
        )}
        {selected?.contributor && (
          <span className="field-hint">Contributor variant: your prompts are shared for model training.</span>
        )}
      </div>
      <div className="fcell">
        <label className="field-label">Reasoning effort</label>
        <select
          className="select"
          value={value?.effort ?? ""}
          disabled={!selected || efforts.length === 0}
          onChange={(e) => {
            if (!value) return;
            const { effort: _effort, ...route } = value;
            onChange(e.target.value ? { ...route, effort: e.target.value } : route);
          }}
        >
          <option value="">{selected?.defaultEffort ? `default (${selected.defaultEffort})` : "default"}</option>
          {effortUnsupported && <option value={value!.effort}>{value!.effort} (unsupported)</option>}
          {efforts.map((effort) => (
            <option key={effort} value={effort}>
              {effort}
            </option>
          ))}
        </select>
        {selected && efforts.length === 0 && <span className="field-hint">This model has no reasoning control.</span>}
      </div>
    </>
  );
}
