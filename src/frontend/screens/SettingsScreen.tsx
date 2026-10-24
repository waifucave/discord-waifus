import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AppConfig,
  AssistantConfig,
  AutoUpdateStatus,
  DetectorConfigResponse,
  DetectorModelsResponse,
  DiscordBotConfig,
  DiscordBotsFile,
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
import { ContextExternalLink } from "../components/ContextExternalLink";
import { RemoteAccessTab } from "../components/remoteAccess/RemoteAccessTab";
import { ModelPicker } from "../components/ModelPicker";
import { RegistryForm } from "../components/RegistryForm";

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
        <AppTab />
      )}
      <FootRow />
    </div>
  );
}

/* ================= providers ================= */

function ProvidersTab() {
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);

  const save = async (providerId: string) => {
    try {
      await api.putProviderCredentials(providerId, { apiKey: key });
      setEditing(undefined);
      setKey("");
      setMessage(undefined);
      providers.reload();
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  return (
    <div className="content">
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone="err">{message}</Notice>
        </div>
      )}
      {(providers.data?.providers ?? []).map((provider) => (
        <div className="cell" style={{ padding: "18px 26px", flex: "none" }} key={provider.id}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span className="t-title">{provider.displayName}</span>
            <span className="t-micro">
              {provider.credentials.configured
                ? `key set${provider.credentials.keyHint ? ` · ${provider.credentials.keyHint}` : ""}`
                : "no key"}
            </span>
            {provider.credentials.configured && <span className="chip mint">active</span>}
            <span style={{ marginLeft: "auto" }}>
              {provider.docsUrl && (
                <ContextExternalLink className="t-micro" href={provider.docsUrl} style={{ marginRight: 14, color: "var(--mute)" }}>
                  Get a key ↗
                </ContextExternalLink>
              )}
              <button
                className="btn sm"
                onClick={() => {
                  setEditing(editing === provider.id ? undefined : provider.id);
                  setKey("");
                }}
              >
                {provider.credentials.configured ? "Replace key" : "Add key"}
              </button>
              {provider.credentials.configured && (
                <button
                  className="btn ghost sm"
                  style={{ marginLeft: 8 }}
                  onClick={async () => {
                    if (!window.confirm(`Remove the ${provider.displayName} key?`)) return;
                    try {
                      await api.deleteProviderCredentials(provider.id);
                      providers.reload();
                    } catch (err) {
                      setMessage((err as Error).message);
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </span>
          </div>
          {editing === provider.id && (
            <div className="fgrid" style={{ gridTemplateColumns: "1fr 120px 120px", margin: "14px -26px -18px", borderTop: "var(--line) solid var(--ink)" }}>
              <div className="fcell" style={{ padding: "12px 16px" }}>
                <input
                  className="input"
                  type="password"
                  placeholder="paste the API key…"
                  value={key}
                  autoFocus
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && key.trim() && save(provider.id)}
                />
              </div>
              <button className="cell clickable btn" onClick={() => save(provider.id)} disabled={!key.trim()}>
                Save
              </button>
              <button className="cell clickable btn ghost" onClick={() => setEditing(undefined)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="cell" style={{ padding: "14px 26px", flex: "none" }}>
        <span className="t-mute t-small">Keys are stored locally, sent only to their provider, and never shown again once saved.</span>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= assistant ================= */

/** Norma's own model (Living cast §9.3); unset = the first configured waifu's model. */
function AssistantTab() {
  const remote = useApi<AssistantConfig>((s) => api.assistantConfig(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const [draft, setDraft] = useState<ModelChoice | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | undefined>(undefined);

  useEffect(() => {
    if (remote.data) setDraft(remote.data.model);
  }, [remote.data]);

  const list = waifus.data?.waifus ?? [];
  const fallback = [...list.filter((w) => w.enabled), ...list.filter((w) => !w.enabled)].find((w) => w.model);

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
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className="cell" style={{ padding: "14px 26px", flex: "none" }}>
        <span className="t-mute t-small">
          Norma, the dashboard helper, reads and changes app configuration through the same API this UI uses.
        </span>
      </div>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 240px" }}>
        <ModelPicker
          value={draft}
          models={models.data?.models ?? []}
          onChange={setDraft}
          unsetLabel="— use a waifu's model —"
          unsetHint={
            fallback?.model
              ? `Unset: borrowing ${fallback.displayName || fallback.name}'s ${fallback.model.modelId}.`
              : "Unset, and no waifu has a model either."
          }
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: "var(--line)", background: "var(--ink)", flex: "none" }}>
        <div className="cell" />
        <button
          className="cell clickable"
          style={{ background: "var(--mint)", height: 64, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}
          onClick={save}
          disabled={saving || !remote.data}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= app + discord bots ================= */

function AppTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [tone, setTone] = useState<"ok" | "err">("ok");

  const act = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn();
      setTone("ok");
      setMessage(okText);
    } catch (err) {
      setTone("err");
      setMessage((err as Error).message);
    }
  };

  return (
    <div className="content">
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone={tone}>{message}</Notice>
        </div>
      )}

      <BotsSection bots={bots} waifus={waifus} onResult={(ok, text) => { setTone(ok ? "ok" : "err"); setMessage(text); }} />

      <div className="fused" style={{ flex: "none" }}>
        <div className="fgrid" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
          <button className="cell clickable btn" style={{ padding: "18px 0" }} onClick={() => act(() => api.pause(), "Paused — no new replies will start.")}>Pause</button>
          <button className="cell clickable btn" style={{ padding: "18px 0" }} onClick={() => act(() => api.resume(), "Resumed.")}>Resume</button>
          <button className="cell clickable btn" style={{ padding: "18px 0" }} onClick={() => act(() => api.reload(), "Reload accepted — Discord reconnecting.")}>Reload Discord</button>
          <button className="cell clickable btn" style={{ padding: "18px 0" }} onClick={() => act(() => api.clearOcrCache(), "OCR cache cleared.")}>Clear OCR cache</button>
          <button
            className="cell clickable btn"
            style={{ padding: "18px 0" }}
            onClick={() => {
              localStorage.removeItem("onboarding-dismissed");
              localStorage.setItem("onboarding-force", "1");
              window.location.reload();
            }}
          >
            Run setup wizard
          </button>
        </div>
      </div>

      {config.data && <UpdatesSection config={config} onResult={(ok, text) => { setTone(ok ? "ok" : "err"); setMessage(text); }} />}
      <RegistryForm topic="app.runtime" title="Runtime" config={config.data} onSaved={config.setData} />
      <RegistryForm
        topic="app.discord"
        title="Discord"
        config={config.data}
        onSaved={config.setData}
        filter={(key) => !key.path.startsWith("discord.debounce.") && !key.path.startsWith("discord.dm.")}
      />
      <RegistryForm topic="app.ocr" title="OCR · image text for models without image input" config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.http" title="Dashboard and API" config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.frontend" title="Dashboard build" config={config.data} onSaved={config.setData} />
      <div className="cell growcell" />
    </div>
  );
}

function UpdatesSection({ config, onResult }: {
  config: ReturnType<typeof useApi<AppConfig>>; onResult: (ok: boolean, text: string) => void;
}) {
  const context = useClientContext();
  const status = useApi<AutoUpdateStatus>(signal => api.updates(signal), []);
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
  const valid = Number.isInteger(draft.checkIntervalMinutes) && draft.checkIntervalMinutes >= 15 && draft.checkIntervalMinutes <= 1440
    && Number.isInteger(draft.idleMinutes) && draft.idleMinutes >= 1 && draft.idleMinutes <= 120;
  return <section className="cell" style={{ padding: "18px 26px", flex: "none" }} aria-label="Automatic updates">
    <h3 className="t-title">Idle-only updates</h3>
    <p className="t-mute t-small">Stage and verify newer patch releases, then restart this machine only after all managed hosts and remote gateways are quiet. Active conversations, assistant work and transfers are never interrupted.</p>
    <p className="t-micro">{status.error ? "Update status unavailable" : status.data ? `${status.data.currentVersion} · ${status.data.state.replaceAll("_", " ")}${status.data.candidateVersion ? ` · available ${status.data.candidateVersion}` : ""}${status.data.reason !== "none" ? ` · ${status.data.reason.replaceAll("_", " ")}` : ""}` : "Checking update support…"}</p>
    <fieldset disabled={disabled} style={{ border: 0, padding: 0, display: "flex", flexWrap: "wrap", gap: 16 }}>
      <label className="checkbox-chip"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />Enable automatic updates</label>
      <label className="field">Check every (minutes)<input className="input" type="number" min={15} max={1440} value={draft.checkIntervalMinutes} onChange={e => setDraft({ ...draft, checkIntervalMinutes: Number(e.target.value) })} /></label>
      <label className="field">Quiet window (minutes)<input className="input" type="number" min={1} max={120} value={draft.idleMinutes} onChange={e => setDraft({ ...draft, idleMinutes: Number(e.target.value) })} /></label>
      <button className="btn primary" disabled={!valid || saving} onClick={async () => {
        setSaving(true);
        try {
          const saved = await api.putUpdateSettings(draft);
          config.setData(saved); status.reload(); onResult(true, "Automatic-update settings saved.");
        } catch (error) { onResult(false, (error as Error).message); }
        finally { setSaving(false); }
      }}>{saving ? "Saving…" : "Save update settings"}</button>
    </fieldset>
    <p className="t-mute t-small">Local control only. Global npm installs only; source checkouts are not modified. On macOS, remote-enabled processes wait for an unlocked keychain without asking for a password. A restarted remote gateway ends its browser sessions, but preserves saved pairing.</p>
    {context?.mode === "remote" && <Notice>Change these settings on the host locally; remote management cannot schedule host process restarts.</Notice>}
  </section>;
}

function BotsSection({
  bots,
  waifus,
  onResult
}: {
  bots: ReturnType<typeof useApi<DiscordBotsFile>>;
  waifus: ReturnType<typeof useApi<WaifusResponse>>;
  onResult: (ok: boolean, text: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, { applicationId: string; token: string }>>({});
  const [showGuide, setShowGuide] = useState(false);

  const entries: Array<{ key: string; label: string; bot: DiscordBotConfig | null; isHouse: boolean }> = [
    { key: "house", label: "House bot", bot: bots.data?.orchestrator ?? null, isHouse: true },
    ...(waifus.data?.waifus ?? []).map((waifu) => ({
      key: waifu.botId ?? `waifu-${waifu.id}`,
      label: waifu.displayName || waifu.name,
      bot: (bots.data?.waifus ?? []).find((b) => b.id === (waifu.botId ?? waifu.id)) ?? null,
      isHouse: false
    }))
  ];

  const saveBot = async (entry: (typeof entries)[number]) => {
    const draft = drafts[entry.key];
    if (!draft || !bots.data) return;
    const patch: DiscordBotConfig = {
      id: entry.bot?.id ?? (entry.isHouse ? "house" : entry.key),
      displayName: entry.bot?.displayName ?? entry.label,
      enabled: true,
      ...(entry.bot ?? {}),
      ...(draft.applicationId ? { applicationId: draft.applicationId } : {}),
      ...(draft.token ? { token: draft.token } : {})
    };
    try {
      await api.putDiscordBots(
        entry.isHouse
          ? { ...bots.data, orchestrator: patch }
          : {
              ...bots.data,
              waifus: [...bots.data.waifus.filter((b) => b.id !== patch.id), patch]
            }
      );
      await api.reload();
      setDrafts((d) => ({ ...d, [entry.key]: { applicationId: "", token: "" } }));
      bots.reload();
      onResult(true, `${entry.label} bot saved — reconnecting.`);
    } catch (err) {
      onResult(false, (err as Error).message);
    }
  };

  return (
    <div className="fused" style={{ flex: "none" }}>
      <button className="disclosure-head" onClick={() => setShowGuide((v) => !v)}>
        <span className="t-micro" style={{ color: "var(--ink)" }}>How to create a Discord bot</span>
        <span className="caret">{showGuide ? "▾" : "▸"}</span>
      </button>
      {showGuide && <div className="cell" style={{ padding: "16px 20px" }}><DiscordBotGuide kind="house" collapsedByDefault={false} hideHeader /></div>}
      {entries.map((entry) => {
        const draft = drafts[entry.key] ?? { applicationId: "", token: "" };
        return (
          <div key={entry.key} style={{ display: "flex", flexDirection: "column", gap: "var(--line)", background: "var(--ink)" }}>
            <div className="cell slabel">
              <span className="t-small">{entry.label}</span>
              <span className="t-micro">
                {entry.bot
                  ? `${entry.bot.applicationId ? `app ${entry.bot.applicationId}` : "no app id"} · ${entry.bot.tokenConfigured ? `token set${entry.bot.tokenHint ? ` (${entry.bot.tokenHint})` : ""}` : "no token"}`
                  : "not linked"}
                {entry.bot?.tokenConfigured && <span className="chip sky" style={{ marginLeft: 8 }}>connected</span>}
              </span>
            </div>
            <div className="fgrid" style={{ gridTemplateColumns: "1fr 1fr 120px" }}>
              <div className="fcell">
                <label className="field-label">Application ID</label>
                <input
                  className="input"
                  value={draft.applicationId}
                  onChange={(e) => setDrafts((d) => ({ ...d, [entry.key]: { ...draft, applicationId: e.target.value } }))}
                />
              </div>
              <div className="fcell">
                <label className="field-label">Bot token · write-only</label>
                <input
                  className="input"
                  type="password"
                  value={draft.token}
                  onChange={(e) => setDrafts((d) => ({ ...d, [entry.key]: { ...draft, token: e.target.value } }))}
                />
              </div>
              <button className="cell clickable btn" onClick={() => saveBot(entry)} disabled={!draft.applicationId && !draft.token}>
                Save
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================= models ================= */

function ModelsTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const models = useApi<ModelsResponse>((s) => api.models(s), [config.data?.models?.allowed.join(","), config.data?.models?.maxOutputUsdPerMTok]);
  return (
    <div className="content">
      <div className="cell" style={{ padding: "14px 26px", flex: "none" }}>
        <span className="t-mute t-small">
          The curated list every model picker offers: the allowed routes the installed catalog has, at most the price cap per million
          output tokens. Contributor variants share your prompts for training and are only ever an explicit choice.
        </span>
      </div>
      <RegistryForm topic="app.models" title="Allowed models" config={config.data} onSaved={config.setData} columns={2} />
      <div className="cell" style={{ padding: "12px 26px", flex: "none", overflowX: "auto" }}>
        <table className="t-small" style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr className="t-micro" style={{ textAlign: "left" }}>
              <th style={{ padding: "6px 8px" }}>model</th>
              <th style={{ padding: "6px 8px" }}>route</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>$ in / out per M</th>
              <th style={{ padding: "6px 8px" }}>efforts</th>
              <th style={{ padding: "6px 8px" }}>key</th>
            </tr>
          </thead>
          <tbody>
            {(models.data?.models ?? []).map((model) => (
              <tr key={model.id} style={{ borderTop: "1px solid #e6e6e6" }}>
                <td style={{ padding: "6px 8px" }}>
                  {model.displayName}
                  {model.contributor && <span className="chip butter" style={{ marginLeft: 6 }}>contributor</span>}
                </td>
                <td style={{ padding: "6px 8px" }} className="mono">{model.id}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{model.pricing ? `${model.pricing.inputPerMTokUsd} / ${model.pricing.outputPerMTokUsd}` : "—"}</td>
                <td style={{ padding: "6px 8px" }}>{model.efforts.join(", ") || "—"}</td>
                <td style={{ padding: "6px 8px" }}>{model.credentialsConfigured ? "yes" : "no key"}</td>
              </tr>
            ))}
            {(models.data?.hidden ?? []).map((hidden) => (
              <tr key={hidden.id} style={{ borderTop: "1px solid #e6e6e6", color: "var(--mute)" }}>
                <td style={{ padding: "6px 8px" }}>hidden</td>
                <td style={{ padding: "6px 8px" }} className="mono">{hidden.id}</td>
                <td style={{ padding: "6px 8px" }} colSpan={3}>{hidden.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= web search ================= */

function SearchTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  const usage = useApi<SearchUsage>((s) => api.searchUsage(s), []);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | undefined>(undefined);
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
  return (
    <div className="content">
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className="cell" style={{ padding: "18px 26px", flex: "none" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 8 }}>
          <span className="t-title">Exa</span>
          <span className="t-micro">{usage.data ? (usage.data.exaKeyConfigured ? "key set" : "keyless") : "…"}</span>
        </div>
        <p className="t-small t-mute" style={{ margin: "0 0 10px", lineHeight: 1.5 }}>
          Waifus search the web through Exa. It works without a key; a key is used when the keyless service is busy or limited.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="input" type="password" style={{ maxWidth: 360 }} placeholder="Exa API key (optional)" value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn" disabled={!key.trim()} onClick={() => void saveKey()}>
            Save key
          </button>
          {usage.data?.exaKeyConfigured && (
            <button
              className="btn ghost"
              onClick={async () => {
                try {
                  await api.deleteProviderCredentials("exa");
                  usage.reload();
                  setMessage({ tone: "ok", text: "Exa key removed; search stays keyless." });
                } catch (err) {
                  setMessage({ tone: "err", text: (err as Error).message });
                }
              }}
            >
              Remove key
            </button>
          )}
        </div>
        {usage.data && (
          <p className="t-micro" style={{ marginTop: 12, textTransform: "none", letterSpacing: "0.04em" }}>
            Today ({usage.data.day}): {usage.data.searches} searches of {usage.data.limits.maxPerDay} · {usage.data.fetches} pages read
          </p>
        )}
      </div>
      <RegistryForm topic="app.search" title="Search caps (0 turns search off)" config={config.data} onSaved={(saved) => { config.setData(saved); usage.reload(); }} />
      <RegistryForm topic="app.life.webFetch" title="Reading web pages" config={config.data} onSaved={config.setData} />
      <div className="cell growcell" />
    </div>
  );
}

/* ================= addressee detector ================= */

function DetectorTab() {
  const detector = useApi<DetectorConfigResponse>((s) => api.detectorConfig(s), []);
  const models = useApi<DetectorModelsResponse>((s) => api.detectorModels(s), []);
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | undefined>(undefined);
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
      {message && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className="cell" style={{ padding: "14px 26px", flex: "none" }}>
        <span className="t-mute t-small">
          A message nobody addressed (no mention, reply or name) goes to the addressee detector, which picks the waifu it is for, if any.
          Off: a first message in 10 minutes or a question wakes one waifu at random. A server can override this in Rooms.
        </span>
      </div>
      <div className="fgrid" style={{ gridTemplateColumns: "1fr 1fr 140px", flex: "none" }}>
        <div className="fcell">
          <label className="field-label">Detector</label>
          <select className="select" value={known || value === "" ? value : "__custom__"} onChange={(e) => setDraft(e.target.value === "__custom__" ? value : e.target.value)}>
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
          <label className="field-label">Or a target</label>
          <input className="input" value={value} onChange={(e) => setDraft(e.target.value)} placeholder="openrouter:… · openai:… · laya:english" />
        </div>
        <button className="cell clickable btn" disabled={draft === undefined} onClick={() => void save()}>
          Save
        </button>
      </div>
      <div className="cell growcell" />
    </div>
  );
}

/* ================= life limits ================= */

function LifeLimitsTab() {
  const config = useApi<AppConfig>((s) => api.getConfig(s), []);
  return (
    <div className="content">
      <div className="cell" style={{ padding: "14px 26px", flex: "none" }}>
        <span className="t-mute t-small">
          Host-wide limits on every life: how long a turn runs, how much she may send, how big her context grows before compaction,
          and when nightly maintenance runs. A waifu&apos;s own budget, schedule and DMs are in Cast.
        </span>
      </div>
      <RegistryForm topic="app.life" title="Turns and lives" config={config.data} onSaved={config.setData} filter={(key) => !key.path.startsWith("life.webFetch.")} />
      <RegistryForm topic="app.compaction" title="Compaction" config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.discord.debounce" title="Waiting before a wake" config={config.data} onSaved={config.setData} />
      <RegistryForm topic="app.discord.dm" title="After a restart" config={config.data} onSaved={config.setData} />
      <div className="cell growcell" />
    </div>
  );
}
