import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { api } from "../../api/client";
import { useApi } from "../../api/useApi";
import type { ModelChoice, ModelsResponse, ProvidersResponse, ServersResponse, WaifusResponse } from "../../api/types";
import { Notice } from "../Notice";
import { DiscordBotGuide } from "../DiscordBotGuide";
import { useDiscordBotSetup } from "../useDiscordBotSetup";
import { ModelPicker } from "../ModelPicker";

const STEPS = ["Welcome", "Provider", "Model", "Cast", "Discord", "Channel"] as const;

export function OnboardingWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);

  // Step state
  const [keyProviderId, setKeyProviderId] = useState("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [waifuModel, setWaifuModel] = useState<ModelChoice | undefined>();
  // Step 4: the interactive guide, House bot only (a waifu's own bot is set up in Cast or Settings).
  const botSetup = useDiscordBotSetup({ houseOnly: true });

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

  /** "Save & continue": saves what is typed in the guide, and moves on only if that worked. */
  const saveBotsAndContinue = async () => {
    setError(undefined);
    if (await botSetup.save()) setStep((s) => s + 1);
  };

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
              Start with the House bot: it reads your rooms and runs <code>/wake</code>, <code>/print</code> and the
              other owner commands. Each character then gets a bot of her own; add those in Cast or Settings afterwards.
            </p>
            <DiscordBotGuide setup={botSetup} />
            <div className="onboarding-actions">
              <button className="btn ghost" onClick={() => setStep(3)}>
                <ArrowLeft className="icon" /> Back
              </button>
              {botSetup.dirty ? (
                <button className="btn primary" onClick={saveBotsAndContinue} disabled={!botSetup.saveable || botSetup.saving}>
                  {botSetup.saving ? "Saving…" : "Save & continue"}
                </button>
              ) : (
                <button className="btn primary" onClick={skip} disabled={botSetup.saving}>
                  Continue
                </button>
              )}
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
                Once the House bot joins a server, it appears here and in Rooms — then enable your characters per
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
