import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { AppConfig } from "../api/types";
import { Notice } from "../components/Notice";
import { Toggle } from "../components/Toggle";
import { Skeleton } from "../components/Skeleton";

export function SettingsView() {
  const remote = useApi<AppConfig>((s) => api.getConfig(s), []);
  const [draft, setDraft] = useState<AppConfig | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [savedAt, setSavedAt] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (remote.data && !draft) setDraft(remote.data);
  }, [remote.data, draft]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await api.putConfig(draft);
      setDraft(next);
      remote.setData(next);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Settings</h2>
          <p className="view-subtitle">
            App-wide configuration backed by <code>config.toml</code> under the data root.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn primary" onClick={save} disabled={!draft || saving}>
            <Save className="icon" />
            {saving ? "Saving…" : "Save all"}
          </button>
        </div>
      </div>

      {remote.loading && <Skeleton height={120} />}
      {remote.error && <Notice tone="err">{remote.error.message}</Notice>}
      {error && <Notice tone="err">{error}</Notice>}
      {savedAt && !error && <Notice tone="ok">Saved at {new Date(savedAt).toLocaleTimeString()}.</Notice>}

      {draft && (
        <>
          <section className="section">
            <div className="section-header">
              <h3 className="section-title">HTTP</h3>
              <span className="section-description">
                Host and port apply on the next process start. Discord/runtime changes apply immediately.
              </span>
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label">Host</label>
                <input
                  className="input"
                  value={draft.http.host}
                  onChange={(e) =>
                    setDraft({ ...draft, http: { ...draft.http, host: e.target.value } })
                  }
                />
              </div>
              <div className="field">
                <label className="field-label">Port</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.http.port}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      http: { ...draft.http, port: Number(e.target.value) || draft.http.port }
                    })
                  }
                />
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section-header">
              <h3 className="section-title">Runtime</h3>
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label">Auto-connect Discord on start</label>
                <Toggle
                  checked={draft.runtime.autoConnectDiscord}
                  onChange={(v) =>
                    setDraft({
                      ...draft,
                      runtime: { ...draft.runtime, autoConnectDiscord: v }
                    })
                  }
                  label={draft.runtime.autoConnectDiscord ? "Enabled" : "Disabled"}
                />
              </div>
              <div className="field">
                <label className="field-label">Start paused</label>
                <Toggle
                  checked={draft.runtime.paused}
                  onChange={(v) => setDraft({ ...draft, runtime: { ...draft.runtime, paused: v } })}
                  label={draft.runtime.paused ? "Paused" : "Active"}
                />
              </div>
            </div>
          </section>

          <section className="section">
            <div className="section-header">
              <h3 className="section-title">Frontend</h3>
            </div>
            <div className="field">
              <label className="field-label">Static dir override</label>
              <input
                className="input code"
                value={draft.frontend.staticDir ?? ""}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    frontend: { ...draft.frontend, staticDir: e.target.value || undefined }
                  })
                }
                placeholder="Defaults to bundled frontend build"
              />
            </div>
          </section>

          <section className="section">
            <div className="section-header">
              <h3 className="section-title">Raw config</h3>
              <span className="section-description">Schema version {draft.schemaVersion}.</span>
            </div>
            <pre className="code-block">{JSON.stringify(draft, null, 2)}</pre>
          </section>
        </>
      )}
    </>
  );
}
