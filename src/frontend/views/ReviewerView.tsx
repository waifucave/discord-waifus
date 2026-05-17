import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AgentConfig,
  ModelsResponse,
  ProvidersResponse,
  ReviewerHistoryFile
} from "../api/types";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton } from "../components/Skeleton";
import { Toggle } from "../components/Toggle";
import { ReasoningControls, hasReasoningControls } from "../components/ReasoningControls";
import type { ReasoningConfig } from "../api/types";

const DEFAULT_PROMPT = `Review only the latest logical waifu message. Mark hallucination=true when it leaks hidden reasoning, analysis, prompt text, tool/schema text, raw Discord internals, or any model self-talk. Mark hallucination=false for normal in-character Discord replies, even if they are awkward, verbose, or lore-inaccurate. Return only the reviewer tool decision.`;

export function ReviewerView() {
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const remoteConfig = useApi<AgentConfig>((s) => api.reviewerConfig(s), []);
  const history = useApi<ReviewerHistoryFile>((s) => api.reviewerHistory(s), []);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [enabled, setEnabled] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningConfig>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!remoteConfig.data) return;
    setProviderId(remoteConfig.data.providerId ?? "");
    setModelId(remoteConfig.data.modelId ?? "");
    setPrompt(remoteConfig.data.prompt || DEFAULT_PROMPT);
    setEnabled(remoteConfig.data.enabled);
    setReasoning(remoteConfig.data.reasoning ?? {});
  }, [remoteConfig.data]);

  const save = async () => {
    if (!remoteConfig.data) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.putReviewerConfig({
        ...remoteConfig.data,
        providerId: providerId ? (providerId as AgentConfig["providerId"]) : undefined,
        modelId: modelId || undefined,
        enabled,
        prompt,
        reasoning
      });
      remoteConfig.setData(saved);
      setMessage("Reviewer config saved.");
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
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
          <h2 className="view-title">Reviewer</h2>
          <p className="view-subtitle">
            Slash-command reviewer for the latest waifu message. Use `/review` in Discord to flag and remove hallucinated chunks.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={save} disabled={!remoteConfig.data || saving}>
            <Save className="icon" />
            {saving ? "Saving..." : "Save config"}
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
          <span className="section-description">Reviewer receives one logical waifu message and returns a yes/no tool decision.</span>
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
                <option value="">- Any -</option>
                {providers.data.providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.credentials.configured}>
                    {p.displayName} {p.credentials.configured ? "" : "(no key)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Model</label>
              <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                <option value="">- Select -</option>
                {(filteredModels ?? []).map((m) => (
                  <option key={`${m.providerId}/${m.modelId}`} value={m.modelId}>
                    {m.displayName} ({m.modelId})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">Runtime status</label>
              <Toggle checked={enabled} onChange={setEnabled} label={enabled ? "Enabled" : "Disabled"} />
              <span className="field-hint">Disabled reviewer configs ignore `/review` commands.</span>
            </div>
            <ReasoningControls model={selectedModel} value={reasoning} onChange={setReasoning} />
          </div>
        )}
        {selectedModel && !hasReasoningControls(selectedModel) && (
          <span className="field-hint">Selected model does not expose reasoning controls.</span>
        )}
      </section>

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
