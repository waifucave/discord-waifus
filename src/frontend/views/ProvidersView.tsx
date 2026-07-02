import { useMemo, useState } from "react";
import { Cpu, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type { ProviderMetadata, ProvidersResponse } from "../api/types";
import { Pill } from "../components/Pill";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { SkeletonRows } from "../components/Skeleton";
import { timeAgo } from "../utils/format";

type LlmProviderSummary = Awaited<ReturnType<typeof llmProviders>>[number];

/** Registry provider row merged with legacy display-only metadata (docsUrl, key hint, label). */
type MergedProvider = {
  id: string;
  displayName: string;
  baseUrl: string;
  wire: string;
  credentialConfigured: boolean;
  credentialName: string;
  docsUrl?: string;
  keyHint?: string;
  updatedAt?: string;
};

/**
 * Gateway registry is the row source (all 14 providers). Legacy `api.providers()` only supplies
 * display-only extras (docsUrl, credentialName label, keyHint/updatedAt) for the 6 native
 * providers it knows about — openrouter/moonshot/qwen/minimax/mistral/nvidia/stepfun/xiaomi have
 * no legacy entry and render with a generic key label and no Docs link.
 */
function mergeProviders(gateway: LlmProviderSummary[], legacy: ProviderMetadata[]): MergedProvider[] {
  const legacyById = new Map<string, ProviderMetadata>(legacy.map((p) => [p.id, p]));
  return gateway.map((gp) => {
    const match = legacyById.get(gp.id);
    const credentials = match?.credentials;
    return {
      id: gp.id,
      displayName: gp.displayName,
      baseUrl: gp.baseUrl,
      wire: gp.wire,
      credentialConfigured: gp.credentialConfigured,
      credentialName: match?.credentialName ?? gp.displayName,
      docsUrl: match?.docsUrl,
      keyHint: credentials?.configured ? credentials.keyHint : undefined,
      updatedAt: credentials?.configured ? credentials.updatedAt : undefined
    };
  });
}

export function ProvidersView() {
  const legacyProviders = useApi<ProvidersResponse>((signal) => api.providers(signal), []);
  const gatewayProviders = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const gatewayModels = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const [editing, setEditing] = useState<MergedProvider | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const providers = useMemo(
    () =>
      gatewayProviders.data
        ? mergeProviders(gatewayProviders.data, legacyProviders.data?.providers ?? [])
        : undefined,
    [gatewayProviders.data, legacyProviders.data]
  );

  const modelsByProvider = useMemo(() => {
    const map = new Map<string, LlmModelSummary[]>();
    for (const model of gatewayModels.data ?? []) {
      const list = map.get(model.providerId);
      if (list) list.push(model);
      else map.set(model.providerId, [model]);
    }
    return map;
  }, [gatewayModels.data]);

  const loading = legacyProviders.loading || gatewayProviders.loading || gatewayModels.loading;
  const error = gatewayProviders.error ?? legacyProviders.error ?? gatewayModels.error;

  const refresh = () => {
    legacyProviders.reload();
    gatewayProviders.reload();
    gatewayModels.reload();
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Providers</h2>
          <p className="view-subtitle">
            API keys and the full gateway model registry, per provider.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={refresh}>Refresh</button>
        </div>
      </div>

      <Notice tone="info">
        Secrets are never returned by the API. Saved keys appear only as a hint such as
        <code> ****abcd</code>.
      </Notice>

      {loading && (
        <div style={{ marginTop: 16 }}>
          <SkeletonRows rows={5} height={36} />
        </div>
      )}
      {error && <Notice tone="err">Failed to load providers: {error.message}</Notice>}

      {providers && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          {providers.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              models={modelsByProvider.get(p.id) ?? []}
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
          legacyProviders.reload();
          gatewayProviders.reload();
        }}
      />
    </>
  );
}

function ProviderRow({
  provider,
  models,
  expanded,
  onToggle,
  onEdit
}: {
  provider: MergedProvider;
  models: LlmModelSummary[];
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const credentialPill = provider.credentialConfigured ? (
    <Pill tone="ok" dot>
      Configured{provider.keyHint ? ` · ${provider.keyHint}` : ""}
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
            {models.length} model{models.length === 1 ? "" : "s"} · {provider.baseUrl}
            {provider.updatedAt && (
              <>
                {" · updated "} {timeAgo(provider.updatedAt)}
              </>
            )}
          </div>
        </div>
        <div className="actions">
          {provider.docsUrl && (
            <a className="btn ghost sm" href={provider.docsUrl} target="_blank" rel="noreferrer">
              Docs <ExternalLink className="icon" />
            </a>
          )}
          <button className="btn sm" onClick={onToggle}>
            <Cpu className="icon" />
            {expanded ? "Hide models" : "Models"}
          </button>
          <button className="btn primary sm" onClick={onEdit}>
            <KeyRound className="icon" />
            {provider.credentialConfigured ? "Update key" : "Add key"}
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: "var(--sp-3) var(--sp-4)", borderBottom: "1px solid var(--border-subtle)" }}>
          {models.length === 0 ? (
            <Notice tone="info">No models registered for this provider.</Notice>
          ) : (
            <div className="model-grid">
              {models.map((m) => (
                <ModelCard key={m.modelId} model={m} />
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ModelCard({ model }: { model: LlmModelSummary }) {
  return (
    <div className="model-card">
      <div className="row1">
        <h4 className="title">{model.displayName}</h4>
        <span className="id">{model.modelId}</span>
      </div>
      <div className="sub" style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
        {model.wire}
        {model.contextTokens !== undefined && ` · ${model.contextTokens.toLocaleString()} ctx`}
      </div>
      <div className="caps">
        {model.tools && <Pill tone="info">tools</Pill>}
        {model.jsonSchema && <Pill tone="info">json schema</Pill>}
        {model.streaming && <Pill tone="info">stream</Pill>}
        {model.imageInput && <Pill tone="info">vision</Pill>}
        {model.reasoning && <Pill tone="warn">reasoning</Pill>}
        {model.deprecated && <Pill tone="err">deprecated</Pill>}
        {model.confidence !== "verified" && <Pill tone="warn">{model.confidence}</Pill>}
      </div>
    </div>
  );
}

function CredentialsModal({
  provider,
  onClose,
  onSaved
}: {
  provider: MergedProvider | undefined;
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
              placeholder={provider.keyHint ? `Existing: ${provider.keyHint}` : "sk-..."}
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
