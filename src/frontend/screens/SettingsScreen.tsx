import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AppConfig,
  AssistantConfig,
  AutoUpdateStatus,
  CuratedModel,
  DetectorConfigResponse,
  DetectorModelsResponse,
  HelpKey,
  ModelChoice,
  ModelsResponse,
  ProvidersResponse,
  SearchUsage,
  WaifusResponse
} from "../api/types";
import { useClientContext } from "../state/clientContext";
import type { ViewId } from "../nav";
import { FootRow, HeadRow, TabCells } from "./scaffold";
import { Notice } from "../components/Notice";
import { DiscordBotGuide } from "../components/DiscordBotGuide";
import { useDiscordBotSetup } from "../components/useDiscordBotSetup";
import { ContextExternalLink } from "../components/ContextExternalLink";
import { RemoteAccessTab } from "../components/remoteAccess/RemoteAccessTab";
import { ModelPicker } from "../components/ModelPicker";
import { RegistryForm } from "../components/RegistryForm";
import { SectionHead } from "../components/SectionHead";
import { allowedModelRows, toggleAllowed, type AllowedModelRow } from "./settingsForm";

export function SettingsScreen({
  tab,
  onNavigate,
  onTab
}: {
  tab: string | undefined;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onTab: (tab: string) => void;
}) {
  const active = tab ?? "providers";
  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("home")} title="Settings" sub="every setting is also in waifus help and GET /api/help" />
      <TabCells view="settings" active={active} onTab={onTab} />
      {active === "providers" ? (
        <ProvidersTab />
      ) : active === "models" ? (
        <ModelsTab />
      ) : active === "search" ? (
        <SearchTab />
      ) : active === "detector" ? (
        <DetectorTab />
      ) : active === "life" ? (
        <LifeLimitsTab />
      ) : active === "assistant" ? (
        <AssistantTab />
      ) : active === "remote-access" ? (
        <RemoteAccessTab />
      ) : (
        <AppTab onNavigate={onNavigate} />
      )}
      <FootRow />
    </div>
  );
}

type Message = { tone: "ok" | "err"; text: string };

function MessageCell({ message }: { message: Message | undefined }) {
  if (!message) return null;
  return (
    <div className="cell notice-cell" role="status">
      <Notice tone={message.tone}>{message.text}</Notice>
    </div>
  );
}

/* ================= providers ================= */

function ProvidersTab() {
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const save = async (providerId: string) => {
    try {
      await api.putProviderCredentials(providerId, { apiKey: key });
      setEditing(undefined);
      setKey("");
      setMessage(undefined);
      providers.reload();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };

  return (
    <div className="content">
      <SectionHead title="Provider keys" hint="Keys are stored locally, sent only to their provider, and never shown again once saved." />
      <MessageCell message={message} />
      {(providers.data?.providers ?? []).map((provider) => (
        <div className="cell provider-row" key={provider.id}>
          <div className="provider-head">
            <span className="t-title">{provider.displayName}</span>
            <span className="t-micro">
              {provider.credentials.configured ? `key set${provider.credentials.keyHint ? ` · ${provider.credentials.keyHint}` : ""}` : "no key"}
            </span>
            {provider.credentials.configured && <span className="chip mint">active</span>}
            <span className="provider-actions">
              {provider.docsUrl && (
                <ContextExternalLink className="btn quiet sm" href={provider.docsUrl}>
                  Get a key ↗
                </ContextExternalLink>
              )}
              <button
                className="btn sm"
                aria-expanded={editing === provider.id}
                onClick={() => {
                  setEditing(editing === provider.id ? undefined : provider.id);
                  setKey("");
                }}
              >
                {provider.credentials.configured ? "Replace key" : "Add key"}
              </button>
              {provider.credentials.configured && (
                <button
                  className="btn danger sm"
                  onClick={async () => {
                    if (!window.confirm(`Remove the ${provider.displayName} key?`)) return;
                    try {
                      await api.deleteProviderCredentials(provider.id);
                      providers.reload();
                    } catch (err) {
                      setMessage({ tone: "err", text: (err as Error).message });
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </span>
          </div>
          {editing === provider.id && (
            <div className="fgrid key-row">
              <div className="fcell">
                <label className="field-label" htmlFor={`key-${provider.id}`}>{provider.displayName} API key</label>
                <input
                  id={`key-${provider.id}`}
                  className="input"
                  type="password"
                  placeholder="paste the API key…"
                  value={key}
                  autoFocus
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && key.trim() && save(provider.id)}
                />
              </div>
              <button className="cell clickable btn primary" onClick={() => save(provider.id)} disabled={!key.trim()}>
                Save
              </button>
              <button className="cell clickable btn" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="cell growcell" />
    </div>
  );
}

/* ================= assistant ================= */

function sameChoice(a: ModelChoice | undefined, b: ModelChoice | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Norma's own model (Living cast §9.3); unset = the first configured waifu's model. */
function AssistantTab() {
  const remote = useApi<AssistantConfig>((s) => api.assistantConfig(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const [draft, setDraft] = useState<ModelChoice | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | undefined>(undefined);

  useEffect(() => {
    if (remote.data) setDraft(remote.data.model);
  }, [remote.data]);

  const list = waifus.data?.waifus ?? [];
  const fallback = [...list.filter((w) => w.enabled), ...list.filter((w) => !w.enabled)].find((w) => w.model);
  const changed = remote.data !== undefined && !sameChoice(draft, remote.data.model);

  const save = async () => {
    if (!remote.data) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.putAssistantConfig({ revision: remote.data.revision, model: draft ?? null });
      remote.setData(saved);
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="content">
      <SectionHead
        title="Norma's model"
        hint="Norma, the dashboard assistant, reads and changes your setup through the same API this dashboard uses. Give her a model of her own, or leave it unset to borrow a waifu's."
      />
      <MessageCell message={message} />
      <div className="fgrid model-pair">
        <ModelPicker
          value={draft}
          models={models.data?.models ?? []}
          onChange={setDraft}
          unsetLabel="— use a waifu's model —"
          unsetHint={
            fallback?.model ? `Unset: borrowing ${fallback.displayName || fallback.name}'s ${fallback.model.modelId}.` : "Unset, and no waifu has a model either."
          }
        />
      </div>
      <div className="cell action-row">
        <div className="action-text">
          <span className="t-small t-mute">
            Unset, she uses an enabled waifu&apos;s model that is offered and has a key, never a contributor variant. Her calls show in
            Activity under the assistant.
          </span>
        </div>
        <div className="action-buttons">
          {changed && (
            <button className="btn quiet" onClick={() => setDraft(remote.data?.model)}>
              Undo
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={saving || !remote.data || !changed}>
            {saving ? "Saving…" : changed ? "Save" : "Saved"}
          </button>
        </div>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= app + discord bots ================= */

function AppTab({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const [message, setMessage] = useState<Message | undefined>(undefined);

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      setMessage({ tone: "ok", text: okText });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };

  return (
    <div className="content">
      <MessageCell message={message} />

      <BotsSection onNavigate={onNavigate} />

      <SectionHead title="Controls" hint="Pause stops every life without losing queues; Reload Discord reconnects the bots." />
      <div className="fgrid controls-row">
        <button className="cell clickable btn" onClick={() => act(() => api.pause(), "Paused — no new turns will start.")}>Pause</button>
        <button className="cell clickable btn" onClick={() => act(() => api.resume(), "Resumed.")}>Resume</button>
        <button className="cell clickable btn" onClick={() => act(() => api.reload(), "Reload accepted — Discord reconnecting.")}>Reload Discord</button>
        <button className="cell clickable btn" onClick={() => act(() => api.clearOcrCache(), "OCR cache cleared.")}>Clear OCR cache</button>
        <button
          className="cell clickable btn"
          onClick={() => {
            try {
              localStorage.removeItem("onboarding-dismissed");
              localStorage.setItem("onboarding-force", "1");
            } catch {
              // The wizard still opens after the reload when no provider has a key.
            }
            window.location.reload();
          }}
        >
          Run setup wizard
        </button>
      </div>

      {config.data && <UpdatesSection config={config} onResult={(ok, text) => setMessage({ tone: ok ? "ok" : "err", text })} />}
      <RegistryForm topic="app.runtime" title="Runtime" config={config.data} onSaved={config.setData} columns={2} />
      <RegistryForm
        topic="app.discord"
        title="Discord"
        hint="Image downloads and the member lists the House bot keeps."
        config={config.data}
        onSaved={config.setData}
        filter={(key) => !key.path.startsWith("discord.debounce.") && !key.path.startsWith("discord.dm.")}
      />
      <RegistryForm topic="app.ocr" title="OCR" hint="Text read out of images for models without image input." config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.http" title="Dashboard and API" config={config.data} onSaved={config.setData} columns={2} />
      <RegistryForm topic="app.frontend" title="Dashboard build" config={config.data} onSaved={config.setData} columns={1} />
      <div className="cell growcell" />
    </div>
  );
}

function UpdatesSection({ config, onResult }: { config: ReturnType<typeof useApi<AppConfig>>; onResult: (ok: boolean, text: string) => void }) {
  const context = useClientContext();
  const status = useApi<AutoUpdateStatus>((signal) => api.updates(signal), []);
  const [draft, setDraft] = useState(config.data?.updates);
  const [saving, setSaving] = useState(false);
  const enabled = config.data?.updates.enabled;
  const interval = config.data?.updates.checkIntervalMinutes;
  const idle = config.data?.updates.idleMinutes;
  useEffect(() => {
    if (enabled !== undefined && interval !== undefined && idle !== undefined) {
      setDraft({ enabled, checkIntervalMinutes: interval, idleMinutes: idle });
    }
  }, [enabled, interval, idle]);
  useEffect(() => {
    const timer = setInterval(status.reload, 15000);
    return () => clearInterval(timer);
  }, [status.reload]);
  if (!draft) return null;
  const disabled = context?.mode === "remote" || !status.data || status.data.state === "unsupported";
  const valid =
    Number.isInteger(draft.checkIntervalMinutes) &&
    draft.checkIntervalMinutes >= 15 &&
    draft.checkIntervalMinutes <= 1440 &&
    Number.isInteger(draft.idleMinutes) &&
    draft.idleMinutes >= 1 &&
    draft.idleMinutes <= 120;
  const statusLine = status.error
    ? "Update status unavailable"
    : status.data
      ? `${status.data.currentVersion} · ${status.data.state.replaceAll("_", " ")}${status.data.candidateVersion ? ` · available ${status.data.candidateVersion}` : ""}${status.data.reason !== "none" ? ` · ${status.data.reason.replaceAll("_", " ")}` : ""}`
      : "Checking update support…";
  return (
    <section aria-label="Automatic updates" style={{ display: "contents" }}>
      <SectionHead
        title="Idle-only updates"
        hint="Stage and verify newer patch releases, then restart this machine only after all managed hosts and remote gateways are quiet. Active conversations, assistant work and transfers are never interrupted."
      />
      <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "contents" }}>
        <div className="fgrid cols-3">
          <div className="fcell">
            <span className="field-label">Automatic updates</span>
            <label className="checkbox-chip">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              {draft.enabled ? "On" : "Off"}
            </label>
            <span className="field-hint t-plain">{statusLine}</span>
          </div>
          <div className="fcell">
            <label className="field-label" htmlFor="updates-interval">Check every (minutes)</label>
            <input id="updates-interval" className="input" type="number" min={15} max={1440} value={draft.checkIntervalMinutes} onChange={(e) => setDraft({ ...draft, checkIntervalMinutes: Number(e.target.value) })} />
            <span className="field-hint">15 to 1440.</span>
          </div>
          <div className="fcell">
            <label className="field-label" htmlFor="updates-idle">Quiet window (minutes)</label>
            <input id="updates-idle" className="input" type="number" min={1} max={120} value={draft.idleMinutes} onChange={(e) => setDraft({ ...draft, idleMinutes: Number(e.target.value) })} />
            <span className="field-hint">1 to 120.</span>
          </div>
        </div>
        <div className="cell action-row">
          <div className="action-text">
            <span className="t-small t-mute">
              Local control only. Global npm installs only; source checkouts are not modified. On macOS, remote-enabled processes wait for an unlocked keychain without asking for a password. A restarted remote gateway ends its browser sessions, but preserves saved pairing.
            </span>
            {context?.mode === "remote" && <Notice>Change these settings on the host locally; remote management cannot schedule host process restarts.</Notice>}
          </div>
          <div className="action-buttons">
            <button
              className="btn primary"
              disabled={!valid || saving}
              onClick={async () => {
                setSaving(true);
                try {
                  const saved = await api.putUpdateSettings(draft);
                  config.setData(saved);
                  status.reload();
                  onResult(true, "Automatic-update settings saved.");
                } catch (error) {
                  onResult(false, (error as Error).message);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Saving…" : "Save update settings"}
            </button>
          </div>
        </div>
      </fieldset>
    </section>
  );
}

function BotsSection({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  // One guide for every bot: the list at its top picks the bot, the steps take its values.
  const setup = useDiscordBotSetup();
  return (
    <>
      <SectionHead title="Discord bots" hint="Pick a bot, then follow the steps and paste each value where it appears." />
      <div className="cell" style={{ padding: "16px 26px", flex: "none" }}>
        <DiscordBotGuide setup={setup} pickerStyle="list" onOpenRooms={() => onNavigate("rooms")} />
      </div>
    </>
  );
}

/* ================= models ================= */

const HIDDEN_REASONS: Record<string, string> = {
  not_in_catalog: "not in the installed catalog",
  provider_blocked: "provider blocked",
  deprecated: "retired",
  no_tool_calling: "no tool calling",
  over_price_cap: "over the price cap",
  openrouter_reasoning_replay: "OpenRouter cannot replay its reasoning"
};

function price(model: CuratedModel): string {
  return model.pricing ? `$${model.pricing.inputPerMTokUsd} in · $${model.pricing.outputPerMTokUsd} out per M` : "no list price";
}

function ModelRow({ row, onToggle }: { row: AllowedModelRow; onToggle: (on: boolean) => void }) {
  const model = row.model;
  return (
    <div className={"cell model-item" + (row.on ? "" : " off")}>
      <label className="checkbox-chip" title={row.on ? "Offered in every model picker" : "Not offered"}>
        <input type="checkbox" checked={row.on} aria-label={`Allow ${model?.displayName ?? row.id}`} onChange={(e) => onToggle(e.target.checked)} />
      </label>
      <div className="model-name">
        <span className="t-body">{model ? `${model.displayName}` : row.id}</span>
        <span className="mono">{model ? `${row.id} · ${model.providerDisplayName}` : "route key"}</span>
      </div>
      <div className="model-facts t-small t-mute">
        {model ? (
          <>
            <span>{price(model)}</span>
            <span>{model.efforts.length ? `effort ${model.efforts.join(", ")}` : "no reasoning control"}</span>
          </>
        ) : (
          <span>{row.hiddenReason ? `Hidden: ${HIDDEN_REASONS[row.hiddenReason] ?? row.hiddenReason}` : "Described after you save."}</span>
        )}
      </div>
      <div className="model-tags">
        {model?.contributor && <span className="chip butter">contributor</span>}
        {model && !model.credentialsConfigured && <span className="chip peach">no key</span>}
        {row.hiddenReason && <span className="chip lavender">hidden</span>}
      </div>
    </div>
  );
}

function ModelsTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const stored = config.data?.models?.allowed;
  const models = useApi<ModelsResponse>((s) => api.models(s), [stored?.join(","), config.data?.models?.maxOutputUsdPerMTok]);
  const [draft, setDraft] = useState<string[] | undefined>(undefined);
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const allowed = draft ?? stored ?? [];
  const rows = allowedModelRows(models.data, allowed);
  const changed = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(stored ?? []);
  const onCount = rows.filter((row) => row.on).length;

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.putConfig({ models: { allowed: draft } });
      config.setData(saved);
      setDraft(undefined);
      setMessage({ tone: "ok", text: "Saved. Every model picker offers the switched-on models." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const addExtra = () => {
    const id = extra.trim();
    if (!id || allowed.includes(id)) return;
    setDraft(toggleAllowed(allowed, id, true));
    setExtra("");
  };

  return (
    <div className="content">
      <SectionHead
        title="Allowed models"
        hint={`What every model picker offers: ${onCount} switched on. A route the installed catalog lacks, or one over the price cap, stays hidden. Contributor variants share your prompts for training and are only ever an explicit choice.`}
        actions={
          <>
            {changed && (
              <button className="btn quiet sm" onClick={() => setDraft(undefined)}>
                Undo
              </button>
            )}
            <button className="btn primary sm" disabled={!changed || saving} onClick={() => void save()}>
              {saving ? "Saving…" : changed ? "Save" : "Saved"}
            </button>
          </>
        }
      />
      <MessageCell message={message} />
      {models.error && <MessageCell message={{ tone: "err", text: `The model list could not be loaded: ${models.error.message}` }} />}
      <div className="model-list">
        {rows.map((row) => (
          <ModelRow key={row.id} row={row} onToggle={(on) => setDraft(toggleAllowed(allowed, row.id, on))} />
        ))}
      </div>
      <div className="fgrid pair-action">
        <div className="fcell" style={{ gridColumn: "span 2" }}>
          <label className="field-label" htmlFor="models-extra">Another route</label>
          <input
            id="models-extra"
            className="input mono"
            placeholder="provider/model, e.g. anthropic/claude-haiku-5-5"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addExtra()}
          />
          <span className="field-hint">A winter route key outside the curated list. It is hidden unless the installed catalog has it and it passes the checks.</span>
        </div>
        <button className="cell clickable btn" disabled={!extra.trim() || allowed.includes(extra.trim())} onClick={addExtra}>
          Add
        </button>
      </div>
      <RegistryForm
        topic="app.models"
        title="Price cap"
        config={config.data}
        onSaved={config.setData}
        columns={1}
        filter={(key: HelpKey) => key.path !== "models.allowed"}
      />
      <div className="cell growcell" />
    </div>
  );
}

/* ================= web search ================= */

function SearchTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const usage = useApi<SearchUsage>((s) => api.searchUsage(false, s), []);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const saveKey = async () => {
    try {
      await api.putProviderCredentials("exa", { apiKey: key.trim() });
      setKey("");
      setMessage({ tone: "ok", text: "Exa key saved." });
      usage.reload();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };
  const removeKey = async () => {
    try {
      await api.deleteProviderCredentials("exa");
      usage.reload();
      setMessage({ tone: "ok", text: "Exa key removed; search stays keyless." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };
  return (
    <div className="content">
      <SectionHead
        title="Exa"
        hint={
          <>
            Waifus search the web through Exa. It works without a key; a key is used when the keyless service is busy or limited.
            {usage.data && ` Today (${usage.data.day}): ${usage.data.searches} of ${usage.data.limits.maxPerDay} searches · ${usage.data.fetches} pages read.`}
          </>
        }
        actions={<span className="t-micro">{usage.data ? (usage.data.exaKeyConfigured ? "key set" : "keyless") : "…"}</span>}
      />
      <MessageCell message={message} />
      <div className="fgrid key-row">
        <div className="fcell">
          <label className="field-label" htmlFor="exa-key">Exa API key (optional)</label>
          <input id="exa-key" className="input" type="password" placeholder={usage.data?.exaKeyConfigured ? "type a new key to replace it" : "paste the key…"} value={key} onChange={(e) => setKey(e.target.value)} />
        </div>
        <button className="cell clickable btn primary" disabled={!key.trim()} onClick={() => void saveKey()}>
          Save key
        </button>
        <button className="cell clickable btn danger" disabled={!usage.data?.exaKeyConfigured} onClick={() => void removeKey()}>
          Remove key
        </button>
      </div>
      <RegistryForm topic="app.search" title="Search caps" hint="0 turns web search off." config={config.data} onSaved={(saved) => { config.setData(saved); usage.reload(); }} />
      <RegistryForm topic="app.life.webFetch" title="Reading web pages" hint="WebFetch: pages she opens, and the digest call that reads long ones." config={config.data} onSaved={config.setData} columns={4} />
      <div className="cell growcell" />
    </div>
  );
}

/* ================= addressee detector ================= */

function DetectorTab() {
  const detector = useApi<DetectorConfigResponse>((s) => api.detectorConfig(s), []);
  const models = useApi<DetectorModelsResponse>((s) => api.detectorModels(s), []);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  const value = draft ?? detector.data?.target ?? "";
  const known = (models.data?.models ?? []).some((model) => model.target === value);
  const save = async () => {
    try {
      const saved = await api.putDetectorConfig(value.trim());
      detector.setData(saved);
      setDraft(undefined);
      setMessage({ tone: "ok", text: saved.target ? `The detector is ${saved.target}.` : "The detector is off." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };
  return (
    <div className="content">
      <SectionHead
        title="Addressee detector"
        hint="A message nobody addressed (no mention, reply or name) goes to the detector, which picks the waifu it is for, if any. Off: a first message in 10 minutes or a question wakes one waifu at random. A server can override this in Rooms."
      />
      <MessageCell message={message} />
      <div className="fgrid pair-action">
        <div className="fcell">
          <label className="field-label" htmlFor="detector-pick">Detector</label>
          <select id="detector-pick" className="select" value={known || value === "" ? value : "__custom__"} onChange={(e) => setDraft(e.target.value === "__custom__" ? value : e.target.value)}>
            <option value="">Off</option>
            {(models.data?.models ?? []).map((model) => (
              <option key={model.target} value={model.target}>
                {model.label}
                {model.configured ? "" : " (needs setup)"}
              </option>
            ))}
            {!known && value !== "" && <option value="__custom__">{value}</option>}
          </select>
          <span className="field-hint">
            Default {detector.data?.default ?? "…"}.{models.data?.unavailable ? " The online model list is unavailable right now; the built-in ones are shown." : ""}
          </span>
        </div>
        <div className="fcell">
          <label className="field-label" htmlFor="detector-target">Or a target</label>
          <input id="detector-target" className="input mono" value={value} onChange={(e) => setDraft(e.target.value)} placeholder="openrouter:… · openai:… · laya:english" />
          <span className="field-hint">Any native-choice target, written as provider:model.</span>
        </div>
        <button className={"cell clickable btn" + (draft === undefined ? "" : " primary")} disabled={draft === undefined} onClick={() => void save()}>
          {draft === undefined ? "Saved" : "Save"}
        </button>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= life limits ================= */

type LifeGroup = { title: string; hint: string; paths: string[]; columns?: number };

/** Host-wide life limits, grouped by what they bound. Any app.life key not listed lands in "Other limits". */
export const LIFE_LIMIT_GROUPS: readonly LifeGroup[] = [
  { title: "Turns", hint: "How many lives run at once, how long a turn may take, and when her nightly dream runs.", paths: ["life.maxConcurrentTurns", "life.maxTurnMs", "life.maintenanceHourLocal"] },
  { title: "Sending", hint: "What she may send in one turn.", paths: ["life.maxSendsPerTurn", "life.maxSendPlacesPerTurn", "life.send.maxFiles"] },
  { title: "Wakes", hint: "How often people, watches and other waifus may wake her, and how many notification lines a place gets (also in her morning summary).", paths: ["life.maxWakesPerUserPerHour", "life.maxWatchFiresPerDay", "life.maxWaifuTriggeredTurns", "life.notificationLinesPerPlace", "life.morningLinesPerPlace"] },
  { title: "Her day", hint: "She writes her own day each morning in ~/life/schedule.json; while busy, only people talking to her get through. Her bed time is soft: up late, dozing, then asleep.", paths: ["life.dayStartHourLocal", "life.busyEngagedMinutes", "life.bedDozeMinutes", "life.dreamAfterAsleepMinutes"], columns: 2 },
  { title: "Context and images", hint: "How long her life gets before compaction, and the pictures she sees as images.", paths: ["life.maxLogMessages", "life.maxContextTokens", "life.maxInlineImagesPerEpoch", "life.maxInlineImageBytesPerEpoch"], columns: 2 },
  { title: "Rest before her memory fills", hint: "Near the compaction trigger she writes her own summary in a turn of her own; a new epoch starts from it alone. She may also end any turn with only <summary>…</summary> for a fresh start.", paths: ["life.restNotice", "life.restNoticeRatio", "life.restSummaryMinChars", "life.selfSummaryMinRatio", "life.selfSummaryCooldownMinutes"] },
  { title: "Her home folder", hint: "Her notes, reminders, watches and anything she keeps.", paths: ["life.home.maxBytes", "life.home.maxFiles", "life.home.maxFolders"] },
  { title: "/tmp and downloads", hint: "Files people sent her and her scratch files.", paths: ["life.tmp.maxBytes", "life.tmp.maxFiles", "life.tmp.retentionDays", "life.attachments.maxBytes"], columns: 2 },
  { title: "Simulated Bash", hint: "just-bash over a copy of her two folders: never a real program, no network.", paths: ["life.bash.enabled", "life.bash.python", "life.bash.maxTimeoutMs", "life.bash.maxOutputChars", "life.bash.maxMemoryMb"] },
  { title: "Dreaming limits", hint: "Her nightly dream reads what was said since the last one; a long window runs in several sessions.", paths: ["life.dreamMaxRounds", "life.dreamWindowMaxChars"], columns: 2 }
];

/** The dream model (spec §18.4, §18.6): a ModelPicker over GET /api/models; unset = her own model. */
function DreamModelSection({ config }: { config: ReturnType<typeof useApi<AppConfig>> }) {
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const current = config.data?.life.dreamModel;
  const [draft, setDraft] = useState<ModelChoice | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message | undefined>(undefined);
  useEffect(() => {
    setDraft(config.data?.life.dreamModel);
  }, [config.data]);
  const changed = config.data !== undefined && !sameChoice(draft, current);
  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      config.setData(await api.putConfig({ life: { dreamModel: draft ?? null } }));
      setMessage({ tone: "ok", text: "Saved." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SectionHead
        title="Dreaming"
        hint="While she sleeps, a memory keeper reads her transcripts since the last dream, adds what is new to her notes and patches what the day contradicted. It never deletes a note for lack of evidence."
      />
      <MessageCell message={message} />
      <div className="fgrid model-pair">
        <ModelPicker value={draft} models={models.data?.models ?? []} onChange={setDraft} unsetLabel="— her own model —" unsetHint="Dream model — defaults to her model." />
      </div>
      <div className="cell action-row">
        <div className="action-text">
          <span className="t-small t-mute">Dream model — defaults to her model. Its calls show in Activity under maintenance.</span>
        </div>
        <div className="action-buttons">
          {changed && (
            <button className="btn quiet" onClick={() => setDraft(current)}>
              Undo
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={saving || !config.data || !changed}>
            {saving ? "Saving…" : changed ? "Save" : "Saved"}
          </button>
        </div>
      </div>
    </>
  );
}

function LifeLimitsTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const listed = new Set(LIFE_LIMIT_GROUPS.flatMap((group) => group.paths));
  return (
    <div className="content">
      <div className="cell action-row">
        <span className="t-small t-mute">
          Host-wide limits on every life. A waifu&apos;s own budget, schedule and DMs are in Cast; web search and page reading are under Search.
        </span>
      </div>
      {LIFE_LIMIT_GROUPS.map((group) => (
        <RegistryForm
          key={group.title}
          topic="app.life"
          title={group.title}
          hint={group.hint}
          columns={group.columns ?? 3}
          config={config.data}
          onSaved={config.setData}
          filter={(key) => group.paths.includes(key.path)}
        />
      ))}
      <DreamModelSection config={config} />
      <RegistryForm topic="app.life" title="Other limits" config={config.data} onSaved={config.setData} filter={(key) => !listed.has(key.path) && key.path !== "life.dreamModel" && !key.path.startsWith("life.webFetch.")} />
      <RegistryForm topic="app.compaction" title="Compaction" hint="Summarising a life that got long." config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.discord.debounce" title="Waiting before a wake" hint="How long a burst of messages waits before it wakes her." config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.discord.dm" title="After a restart" config={config.data} onSaved={config.setData} columns={1} />
      <div className="cell growcell" />
    </div>
  );
}
