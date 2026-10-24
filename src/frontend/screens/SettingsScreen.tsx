import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  AppConfig,
  AssistantConfig,
  AutoUpdateStatus,
  DiscordBotConfig,
  DiscordBotsFile,
  ModelChoice,
  ModelsResponse,
  ProvidersResponse,
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
      <HeadRow onBack={() => onNavigate("home")} title="Settings" sub="providers · assistant · app · remote access" />
      <TabCells view="settings" active={active} onTab={onTab} />
      {active === "providers"
        ? <ProvidersTab />
        : active === "assistant"
          ? <AssistantTab />
          : active === "remote-access"
            ? <RemoteAccessTab />
            : <AppTab />}
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
      {config.data && <OcrSection config={config} onResult={(ok, text) => { setTone(ok ? "ok" : "err"); setMessage(text); }} />}
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

function OcrSection({
  config,
  onResult
}: {
  config: ReturnType<typeof useApi<AppConfig>>;
  onResult: (ok: boolean, text: string) => void;
}) {
  const [draft, setDraft] = useState<AppConfig | undefined>(config.data);
  useEffect(() => setDraft(config.data), [config.data]);
  if (!draft) return null;
  return (
    <div className="fused" style={{ flex: "none" }}>
      <div className="frow" style={{ gridTemplateColumns: "200px 260px 1fr" }}>
        <div className="field">
          <label className="field-label">OCR · image text fallback</label>
          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={draft.ocr.enabled}
              onChange={(e) => setDraft({ ...draft, ocr: { ...draft.ocr, enabled: e.target.checked } })}
            />
            {draft.ocr.enabled ? "On" : "Off"}
          </label>
        </div>
        <div className="field">
          <label className="field-label">Engine</label>
          <select
            className="select"
            value={draft.ocr.engine}
            onChange={(e) => setDraft({ ...draft, ocr: { ...draft.ocr, engine: e.target.value as AppConfig["ocr"]["engine"] } })}
          >
            <option value="auto">auto</option>
            <option value="apple-vision">apple-vision</option>
            <option value="bundled-tesseract">bundled-tesseract</option>
            <option value="system-tesseract">system-tesseract</option>
          </select>
        </div>
        <div className="field" style={{ justifyContent: "flex-end" }}>
          <button
            className="btn primary"
            style={{ alignSelf: "flex-start" }}
            onClick={async () => {
              try {
                const saved = await api.putConfig(draft);
                config.setData(saved);
                onResult(true, "App config saved.");
              } catch (err) {
                onResult(false, (err as Error).message);
              }
            }}
          >
            Save app config
          </button>
        </div>
      </div>
    </div>
  );
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
