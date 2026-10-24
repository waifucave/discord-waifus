import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import type { DiscordBotsFile, ModelChoice, ModelsResponse, ProvidersResponse, ServersResponse, WaifusResponse } from "../../api/types";
import { Notice } from "../Notice";
import { DiscordBotGuide } from "../DiscordBotGuide";
import { ModelPicker } from "../ModelPicker";

const STEPS = ["Welcome", "Provider", "Model", "Cast", "Discord", "Channel"] as const;

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);

  // Step state
  const [keyProviderId, setKeyProviderId] = useState("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [waifuModel, setWaifuModel] = useState<ModelChoice | undefined>();
  const [houseToken, setHouseToken] = useState("");
  const [houseAppId, setHouseAppId] = useState("");
  const [botsSaved, setBotsSaved] = useState(false);

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
      providers.reload();
      models.reload();
    });

  const applyWaifuModels = () =>
    run(async () => {
      if (!waifuModel) return;
      const list = waifus.data?.waifus ?? [];
      for (const waifu of list.filter((w) => !w.model)) {
        const fresh = await api.waifu(waifu.id);
        await api.updateWaifu(waifu.id, { revision: fresh.revision, model: waifuModel });
      }
    });

  const saveBots = () =>
    run(async () => {
      const current = await api.discordBots();
      await api.putDiscordBots({
        ...current,
        orchestrator: {
          id: current.orchestrator?.id ?? "house",
          displayName: current.orchestrator?.displayName ?? "House",
          enabled: true,
          ...(current.orchestrator ?? {}),
          applicationId: houseAppId || current.orchestrator?.applicationId,
          ...(houseToken ? { token: houseToken } : {})
        }
      });
      setBotsSaved(true);
      await api.reload();
    });

  const modelLessWaifus = (waifus.data?.waifus ?? []).filter((w) => !w.model);
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
              Each character has her own persona, model, and Discord presence. Everything runs locally on this
              machine.
            </p>
            <p className="onboarding-lede">Setup takes about five minutes: one API key, one model pick, bots, and a channel.</p>
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
            <h1 className="onboarding-title">Pick a model.</h1>
            <p className="onboarding-lede">
              The cast default is applied to your characters in the next step. You can give each one her own model
              later in Cast.
            </p>
            <div className="fused" style={{ maxWidth: 640 }}><div className="grid grid-2">
              <ModelPicker value={waifuModel} models={models.data?.models ?? []} onChange={setWaifuModel} />
            </div></div>
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(1)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={() => setStep(3)} disabled={!waifuModel}>
                Continue
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
                  <span className="mono">{w.model?.modelId ?? (waifuModel ? `→ ${waifuModel.modelId}` : "no model")}</span>
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
            <DiscordBotGuide kind="house" collapsedByDefault={false} applicationId={houseAppId || undefined} />
            <div className="fused" style={{ maxWidth: 640, marginTop: 16 }}><div className="grid grid-2">
              <div className="field">
                <label className="field-label">Application ID</label>
                <input className="input" value={houseAppId} onChange={(e) => setHouseAppId(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Bot token</label>
                <input
                  className="input"
                  type="password"
                  value={houseToken}
                  onChange={(e) => setHouseToken(e.target.value)}
                />
              </div>
            </div></div>
            {botsSaved && <Notice tone="ok">Saved — the runtime is reconnecting.</Notice>}
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(3)}>
                <ArrowLeft className="icon" /> Back
              </button>
              <button className="btn primary" onClick={saveBots} disabled={saving || (!houseToken && !houseAppId)}>
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
