import { useMemo, useState } from "react";
import { Cpu, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  ModelCapability,
  ProviderId,
  ProviderMetadata,
  ProvidersResponse
} from "../api/types";
import { Pill } from "../components/Pill";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { SkeletonRows } from "../components/Skeleton";
import { timeAgo } from "../utils/format";

export function ProvidersView() {
  const providers = useApi<ProvidersResponse>((signal) => api.providers(signal), []);
  const [editing, setEditing] = useState<ProviderMetadata | undefined>(undefined);
  const [expanded, setExpanded] = useState<ProviderId | undefined>(undefined);

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Providers</h2>
          <p className="view-subtitle">
            API keys, model catalog, and per-provider capability flags.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={providers.reload}>Refresh</button>
        </div>
      </div>

      <Notice tone="info">
        Secrets are never returned by the API. Saved keys appear only as a hint such as
        <code> ****abcd</code>.
      </Notice>

      {providers.loading && (
        <div style={{ marginTop: 16 }}>
          <SkeletonRows rows={5} height={36} />
        </div>
      )}
      {providers.error && (
        <Notice tone="err">Failed to load providers: {providers.error.message}</Notice>
      )}

      {providers.data && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          {providers.data.providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              expanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? undefined : p.id)}
              onEdit={() => setEditing(p)}
            />
          ))}
        </div>
      )}

      <CredentialsModal
        provider={editing}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          providers.reload();
        }}
      />
    </>
  );
}

function ProviderRow({
  provider,
  expanded,
  onToggle,
  onEdit
}: {
  provider: ProviderMetadata;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const credentialPill = provider.credentials.configured ? (
    <Pill tone="ok" dot>
      Configured · {provider.credentials.keyHint}
    </Pill>
  ) : (
    <Pill tone="warn" dot>
      No API key
    </Pill>
  );

  return (
    <>
      <div className="provider-row">
        <div className="meta">
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="name">{provider.displayName}</span>
            {credentialPill}
            <span className="tag">{provider.id}</span>
          </div>
          <div className="sub">
            {provider.models.length} model{provider.models.length === 1 ? "" : "s"} · {provider.baseUrl}
            {provider.credentials.configured && (
              <>
                {" · updated "} {timeAgo(provider.credentials.updatedAt)}
              </>
            )}
          </div>
        </div>
        <div className="actions">
          <a className="btn ghost sm" href={provider.docsUrl} target="_blank" rel="noreferrer">
            Docs <ExternalLink className="icon" />
          </a>
          <button className="btn sm" onClick={onToggle}>
            <Cpu className="icon" />
            {expanded ? "Hide models" : "Models"}
          </button>
          <button className="btn primary sm" onClick={onEdit}>
            <KeyRound className="icon" />
            {provider.credentials.configured ? "Update key" : "Add key"}
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "var(--sp-3) var(--sp-4)", borderBottom: "1px solid var(--border-subtle)" }}>
          <div className="model-grid">
            {provider.models.map((m) => (
              <ModelCard key={m.modelId} model={m} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ModelCard({ model }: { model: ModelCapability }) {
  const reasoning = ReasoningControlSummary(model);
  return (
    <div className="model-card">
      <div className="row1">
        <h4 className="title">{model.displayName}</h4>
        <span className="id">{model.modelId}</span>
      </div>
      <div className="sub" style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
        {model.client} · endpoint {model.endpoint}
      </div>
      <div className="caps">
        {model.supportsTools && <Pill tone="info">tools</Pill>}
        {model.supportsStructuredOutput && <Pill tone="info">structured</Pill>}
        {model.supportsStreaming && <Pill tone="info">stream</Pill>}
        {model.supportsImageInput && <Pill tone="info">vision</Pill>}
        {reasoning && <Pill tone="warn">{reasoning}</Pill>}
      </div>
      <div className="sub" style={{ fontSize: "var(--fs-xs)", color: "var(--text-muted)" }}>
        Safe defaults: {model.safeDefaultRoles.join(", ")}
      </div>
    </div>
  );
}

function ReasoningControlSummary(model: ModelCapability): string | undefined {
  if (model.reasoningControls.length === 0) return undefined;
  if (model.modelId.includes("multi-agent")) return "agent count";
  const parts: string[] = [];
  if (model.reasoningControls.includes("reasoning.enabled")) parts.push("thinking");
  if (model.reasoningControls.includes("reasoning.effort")) parts.push("effort");
  if (model.reasoningControls.includes("reasoning.budget_tokens")) parts.push("budget");
  return parts.length ? parts.join(" + ") : model.reasoningControls.join(", ");
}

function CredentialsModal({
  provider,
  onClose,
  onSaved
}: {
  provider: ProviderMetadata | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (!provider) return;
    if (!apiKey.trim()) {
      setError("API key is required.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await api.putProviderCredentials(provider.id, {
        apiKey: apiKey.trim(),
        label: label.trim() || undefined
      });
      setApiKey("");
      setLabel("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const open = provider !== undefined;
  // Reset fields when target changes.
  useMemo(() => {
    setApiKey("");
    setLabel("");
    setError(undefined);
  }, [provider?.id]);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!saving) onClose();
      }}
      title={provider ? `${provider.displayName} credentials` : ""}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={saving}>
            <ShieldCheck className="icon" />
            {saving ? "Saving…" : "Save key"}
          </button>
        </>
      }
    >
      {provider && (
        <>
          <div className="field">
            <label className="field-label" htmlFor="api-key">
              API key for {provider.credentialName}
            </label>
            <input
              id="api-key"
              className="input code"
              type="password"
              autoComplete="off"
              autoFocus
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider.credentials.configured ? `Existing: ${provider.credentials.keyHint}` : "sk-..."}
            />
            <span className="field-hint">
              Stored under <code>~/.dc-waifus/user/providers.json</code>. Never sent to other providers.
            </span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="label">
              Label (optional)
            </label>
            <input
              id="label"
              className="input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="prod, personal, …"
            />
          </div>
          {error && <Notice tone="err">{error}</Notice>}
        </>
      )}
    </Modal>
  );
}
