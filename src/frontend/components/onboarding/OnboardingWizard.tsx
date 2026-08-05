import { useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../../api/llm";
import type { AgentConfig, DiscordBotsFile, ProvidersResponse, ServersResponse, WaifusResponse } from "../../api/types";
import { Notice } from "../Notice";
import { DiscordBotGuide } from "../DiscordBotGuide";
import {
  buildModelGroupOptions,
  defaultRoute,
  groupModelRoutes,
  UNAVAILABLE_MODEL_VALUE
} from "../modelParams/logic";

const STEPS = ["Welcome", "Provider", "Models", "Cast", "Discord", "Channel"] as const;

type LlmProviderSummary = Awaited<ReturnType<typeof llmProviders>>[number];

/** Compact registry-driven model picker used by the wizard steps. */
function ModelPicker({
  models,
  configuredProviderIds,
  value,
  onChange
}: {
  models: LlmModelSummary[];
  configuredProviderIds: Set<string>;
  value: { providerId: string; modelId: string } | undefined;
  onChange: (next: { providerId: string; modelId: string } | undefined) => void;
}) {
  const groups = useMemo(() => groupModelRoutes(models), [models]);
  const options = useMemo(() => buildModelGroupOptions(groups, undefined), [groups]);
  const selectedGroup = useMemo(() => {
    if (!value) return "";
    return groups.find((g) => g.routes.some((r) => r.providerId === value.providerId && r.modelId === value.modelId))?.key ?? "";
  }, [groups, value]);
  return (
    <select
      className="select"
      value={selectedGroup}
      onChange={(e) => {
        if (!e.target.value || e.target.value === UNAVAILABLE_MODEL_VALUE) {
          onChange(undefined);
          return;
        }
        const group = groups.find((g) => g.key === e.target.value);
        const route = group && defaultRoute(group, configuredProviderIds);
        onChange(route ? { providerId: route.providerId, modelId: route.modelId } : undefined);
      }}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const orchestrator = useApi<AgentConfig>((s) => api.orchestratorConfig(s), []);
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);

  // Step state
  const [keyProviderId, setKeyProviderId] = useState("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [orchestratorModel, setOrchestratorModel] = useState<{ providerId: string; modelId: string } | undefined>();
  const [waifuModel, setWaifuModel] = useState<{ providerId: string; modelId: string } | undefined>();
  const [orchestratorToken, setOrchestratorToken] = useState("");
  const [orchestratorAppId, setOrchestratorAppId] = useState("");
  const [botsSaved, setBotsSaved] = useState(false);

  const configuredProviderIds = useMemo(
    () =>
      new Set([
        ...(providers.data?.providers ?? []).filter((p) => p.credentials.configured).map((p) => p.id),
        ...(keySaved ? [keyProviderId] : [])
      ]),
    [providers.data, keySaved, keyProviderId]
  );

  const run = async (fn: () => Promise<void>, advance = true) => {
    setSaving(true);
    setError(undefined);
    try {
      await fn();
      if (advance) setStep((s) => s + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const skip = () => {
    setError(undefined);
    setStep((s) => s + 1);
  };

  const finish = () => {
    localStorage.setItem("onboarding-dismissed", "1");
    onDone();
  };

  const saveKey = () =>
    run(async () => {
      await api.putProviderCredentials(keyProviderId, { apiKey });
      setKeySaved(true);
      providers.reload();
    });

  const saveModels = () =>
    run(async () => {
      if (orchestratorModel && orchestrator.data) {
        await api.putOrchestratorConfig({
          revision: orchestrator.data.revision,
          providerId: orchestratorModel.providerId,
          modelId: orchestratorModel.modelId,
          enabled: true
        });
      }
    });

  const applyWaifuModels = () =>
    run(async () => {
      if (!waifuModel) return;
      const list = waifus.data?.waifus ?? [];
      for (const waifu of list.filter((w) => !w.modelId)) {
        const fresh = await api.waifu(waifu.id);
        await api.updateWaifu(waifu.id, {
          revision: fresh.revision,
          providerId: waifuModel.providerId,
          modelId: waifuModel.modelId
        });
      }
    });

  const saveBots = () =>
    run(async () => {
      const current = await api.discordBots();
      await api.putDiscordBots({
        ...current,
        orchestrator: {
          id: current.orchestrator?.id ?? "orchestrator",
          displayName: current.orchestrator?.displayName ?? "Orchestrator",
          enabled: true,
          ...(current.orchestrator ?? {}),
          applicationId: orchestratorAppId || current.orchestrator?.applicationId,
          ...(orchestratorToken ? { token: orchestratorToken } : {})
        }
      });
      setBotsSaved(true);
      await api.reload();
    });

  const modelLessWaifus = (waifus.data?.waifus ?? []).filter((w) => !w.modelId);
  const guilds = servers.data?.servers ?? [];

  return (
    <div className="onboarding">
      <aside className="onboarding-rail">
        <div className="brand" style={{ marginBottom: 24 }}>
          <span className="brand-mark">W</span>
          <span>Discord Waifus</span>
        </div>
        {STEPS.map((label, index) => (
          <div key={label} className={"onboarding-step-label" + (index === step ? " active" : index < step ? " done" : "")}>
            <span className="onboarding-step-index">{index < step ? <Check className="icon" /> : String(index + 1).padStart(2, "0")}</span>
            {label}
          </div>
        ))}
        <button className="btn ghost sm" style={{ marginTop: "auto" }} onClick={finish}>
          <X className="icon" /> Skip setup
        </button>
      </aside>
      <main className="onboarding-main fused-host">
        {error && <Notice tone="err">{error}</Notice>}

        {step === 0 && (
          <section>
            <h1 className="onboarding-title">Run a cast of AI characters in your Discord server.</h1>
            <p className="onboarding-lede">
              A director model decides who speaks and when. Each character has her own persona, model, and Discord
              presence, and they remember your server over time. Everything runs locally on this machine.
            </p>
            <p className="onboarding-lede">Setup takes about five minutes: one API key, two model picks, bots, and a channel.</p>
            <div className="onboarding-actions">
              <button className="btn primary" onClick={() => setStep(1)}>
                Start <ArrowRight className="icon" />
              </button>
              <button className="btn ghost" onClick={finish}>
                Skip for now
              </button>
            </div>
          </section>
        )}

        {step === 1 && (
          <section>
            <h1 className="onboarding-title">Add a model provider.</h1>
            <p className="onboarding-lede">Characters need a language model. Add one API key to start — more anytime in Settings.</p>
            <div className="fused" style={{ maxWidth: 640 }}><div className="grid grid-2">
              <div className="field">
                <label className="field-label">Provider</label>
                <select className="select" value={keyProviderId} onChange={(e) => setKeyProviderId(e.target.value)}>
                  {(providers.data?.providers ?? []).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="field-label">API key</label>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  placeholder="sk-…"
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <span className="field-hint">Stored locally, never shown again.</span>
              </div>
            </div></div>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(0)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={saveKey} disabled={!apiKey.trim() || saving}>
                {saving ? "Saving…" : "Save key & continue"}
              </button>
              <button className="btn ghost" onClick={skip}>
                Later
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section>
            <h1 className="onboarding-title">Pick the models.</h1>
            <p className="onboarding-lede">
              The director decides who speaks (needs solid tool-calling). The cast default is applied to your
              characters in the next step.
            </p>
            <div className="fused" style={{ maxWidth: 640 }}><div className="grid grid-2">
              <div className="field">
                <label className="field-label">Director (orchestrator)</label>
                <ModelPicker
                  models={llmModelsState.data ?? []}
                  configuredProviderIds={configuredProviderIds}
                  value={orchestratorModel}
                  onChange={setOrchestratorModel}
                />
              </div>
              <div className="field">
                <label className="field-label">Cast default</label>
                <ModelPicker
                  models={llmModelsState.data ?? []}
                  configuredProviderIds={configuredProviderIds}
                  value={waifuModel}
                  onChange={setWaifuModel}
                />
              </div>
            </div></div>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={saveModels} disabled={saving || !orchestratorModel}>
                {saving ? "Saving…" : "Save & continue"}
              </button>
              <button className="btn ghost" onClick={skip}>
                Later
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section>
            <h1 className="onboarding-title">Your cast.</h1>
            <p className="onboarding-lede">
              {modelLessWaifus.length > 0
                ? `${modelLessWaifus.length} of your characters have no model yet. Apply the cast default, then tune each one in Cast.`
                : "Every character has a model. Tune personas and models anytime in Cast."}
            </p>
            <ul className="onboarding-list">
              {(waifus.data?.waifus ?? []).map((w) => (
                <li key={w.id}>
                  <strong>{w.displayName || w.name}</strong>
                  <span className="mono">{w.modelId ?? (waifuModel ? `→ ${waifuModel.modelId}` : "no model")}</span>
                </li>
              ))}
            </ul>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(2)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button
                className="btn primary"
                onClick={modelLessWaifus.length > 0 && waifuModel ? applyWaifuModels : skip}
                disabled={saving}
              >
                {saving ? "Applying…" : modelLessWaifus.length > 0 && waifuModel ? "Apply default & continue" : "Continue"}
              </button>
              <button className="btn ghost" onClick={skip}>
                Later
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section>
            <h1 className="onboarding-title">Connect Discord.</h1>
            <p className="onboarding-lede">
              Each character is her own Discord bot. Start with the director's bot; add one per character in Cast
              afterwards.
            </p>
            <DiscordBotGuide kind="orchestrator" collapsedByDefault={false} applicationId={orchestratorAppId || undefined} />
            <div className="fused" style={{ maxWidth: 640, marginTop: 16 }}><div className="grid grid-2">
              <div className="field">
                <label className="field-label">Application ID</label>
                <input className="input" value={orchestratorAppId} onChange={(e) => setOrchestratorAppId(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Bot token</label>
                <input
                  className="input"
                  type="password"
                  value={orchestratorToken}
                  onChange={(e) => setOrchestratorToken(e.target.value)}
                />
              </div>
            </div></div>
            {botsSaved && <Notice tone="ok">Saved — the runtime is reconnecting.</Notice>}
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(3)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={saveBots} disabled={saving || (!orchestratorToken && !orchestratorAppId)}>
                {saving ? "Saving…" : "Save & continue"}
              </button>
              <button className="btn ghost" onClick={skip}>
                Later
              </button>
            </div>
          </section>
        )}

        {step === 5 && (
          <section>
            <h1 className="onboarding-title">Give them a room.</h1>
            {guilds.length === 0 ? (
              <p className="onboarding-lede">
                Once the director bot joins a server, it appears here and in Rooms — then enable your characters per
                channel. You can finish setup now.
              </p>
            ) : (
              <p className="onboarding-lede">Enable characters per channel in Rooms — this is where they'll talk.</p>
            )}
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(4)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={finish}>
                <Check className="icon" /> Finish setup
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
