import type { ModelCapability, ReasoningConfig, ReasoningEffort } from "../api/types";
import { Toggle } from "./Toggle";

export function hasReasoningControls(model: ModelCapability | undefined): boolean {
  if (!model) return false;
  return (
    model.reasoningControls.includes("reasoning.enabled") ||
    model.reasoningControls.includes("reasoning.effort") ||
    model.reasoningControls.includes("reasoning.budget_tokens")
  );
}

export function ReasoningControls({
  model,
  value,
  onChange
}: {
  model: ModelCapability | undefined;
  value: ReasoningConfig;
  onChange: (next: ReasoningConfig) => void;
}) {
  if (!hasReasoningControls(model)) return null;
  const controls = new Set(model!.reasoningControls);
  const supportsToggle = controls.has("reasoning.enabled");
  const supportsEffort = controls.has("reasoning.effort");
  const supportsBudget = controls.has("reasoning.budget_tokens");

  return (
    <>
      {supportsToggle && (
        <div className="field">
          <label className="field-label">Reasoning</label>
          <Toggle
            checked={Boolean(value.enabled)}
            onChange={(next) => onChange({ ...value, enabled: next })}
            label={value.enabled ? "Thinking enabled" : "Thinking disabled"}
          />
          <span className="field-hint">{toggleHint(model!)}</span>
        </div>
      )}
      {supportsEffort && (
        <div className="field">
          <label className="field-label">Reasoning effort</label>
          <select
            className="select"
            value={value.effort ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                effort: (e.target.value || undefined) as ReasoningEffort | undefined
              })
            }
          >
            <option value="">— Provider default —</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <span className="field-hint">{effortHint(model!)}</span>
        </div>
      )}
      {supportsBudget && (
        <div className="field">
          <label className="field-label">Thinking budget tokens</label>
          <input
            className="input"
            type="number"
            min={1024}
            step={256}
            value={value.budgetTokens ?? ""}
            onChange={(e) =>
              onChange({
                ...value,
                budgetTokens:
                  e.target.value === ""
                    ? undefined
                    : Math.max(1024, Number(e.target.value) || 1024)
              })
            }
            placeholder="1024"
            disabled={supportsToggle && !value.enabled}
          />
          <span className="field-hint">
            Anthropic requires at least 1024 and less than max output tokens.
          </span>
        </div>
      )}
    </>
  );
}

function toggleHint(model: ModelCapability): string {
  if (model.providerId === "anthropic") {
    return "Sends thinking.type=disabled when off. Temperature is forced to 1 when on.";
  }
  if (model.providerId === "deepseek") {
    return "When enabled, DeepSeek ignores temperature and top_p.";
  }
  if (model.providerId === "zai") {
    return "Toggles GLM thinking mode per call.";
  }
  return "Toggle the model's thinking / chain-of-thought.";
}

function effortHint(model: ModelCapability): string {
  if (model.providerId === "anthropic") {
    if (model.modelId === "claude-opus-4-7") {
      return "Opus 4.7 uses adaptive thinking — always on. Effort guides depth.";
    }
    return "Adaptive thinking effort. Higher = deeper reasoning.";
  }
  if (model.providerId === "xai" && model.modelId === "grok-4.3") {
    return "Grok 4.3 accepts none/low/medium/high. Pick low or unset for fast replies.";
  }
  if (model.providerId === "deepseek") {
    return "DeepSeek only honors high and max; low/medium are mapped to high.";
  }
  return "Higher effort spends more thinking tokens per call.";
}
