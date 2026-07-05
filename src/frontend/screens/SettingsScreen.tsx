import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { AppConfig, DiscordBotConfig, DiscordBotsFile, ProvidersResponse, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { FootRow, HeadRow, TabCells } from "./scaffold";
import { Notice } from "../components/Notice";
import { DiscordBotGuide } from "../components/DiscordBotGuide";

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
      <HeadRow onBack={() => onNavigate("home")} title="Settings" sub="providers · discord bots · app" />
      <TabCells view="settings" active={active} onTab={onTab} />
      {active === "providers" ? <ProvidersTab /> : <AppTab />}
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
                <a className="t-micro" href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ marginRight: 14, color: "var(--mute)" }}>
                  get a key ↗
                </a>
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
        <div className="headline">
          <span className="t-micro" style={{ color: "var(--ink)" }}>Runtime</span>
          <span className="t-micro">restart-free controls</span>
        </div>
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

      {config.data && <OcrSection config={config} onResult={(ok, text) => { setTone(ok ? "ok" : "err"); setMessage(text); }} />}
      <div className="cell growcell" />
    </div>
  );
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
      <div className="headline">
        <span className="t-micro" style={{ color: "var(--ink)" }}>OCR</span>
        <span className="t-micro">image text fallback for text-only models</span>
      </div>
      <div className="frow" style={{ gridTemplateColumns: "200px 260px 1fr" }}>
        <div className="field">
          <label className="field-label">Enabled</label>
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

  const entries: Array<{ key: string; label: string; bot: DiscordBotConfig | null; isOrchestrator: boolean }> = [
    { key: "orchestrator", label: "Director (orchestrator)", bot: bots.data?.orchestrator ?? null, isOrchestrator: true },
    ...(waifus.data?.waifus ?? []).map((waifu) => ({
      key: waifu.botId ?? `waifu-${waifu.id}`,
      label: waifu.displayName || waifu.name,
      bot: (bots.data?.waifus ?? []).find((b) => b.id === (waifu.botId ?? waifu.id)) ?? null,
      isOrchestrator: false
    }))
  ];

  const saveBot = async (entry: (typeof entries)[number]) => {
    const draft = drafts[entry.key];
    if (!draft || !bots.data) return;
    const patch: DiscordBotConfig = {
      id: entry.bot?.id ?? (entry.isOrchestrator ? "orchestrator" : entry.key),
      displayName: entry.bot?.displayName ?? entry.label,
      enabled: true,
      ...(entry.bot ?? {}),
      ...(draft.applicationId ? { applicationId: draft.applicationId } : {}),
      ...(draft.token ? { token: draft.token } : {})
    };
    try {
      await api.putDiscordBots(
        entry.isOrchestrator
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
      <div className="headline">
        <span className="t-micro" style={{ color: "var(--ink)" }}>Discord bots</span>
        <button className="btn sm" onClick={() => setShowGuide((v) => !v)}>
          {showGuide ? "Hide guide" : "How to create a bot"}
        </button>
      </div>
      {showGuide && <DiscordBotGuide kind="orchestrator" collapsedByDefault={false} />}
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
