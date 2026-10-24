import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { AppConfig, HelpKey, HelpTopic } from "../api/types";
import { useClientContext } from "../state/clientContext";
import { formChanges, formText, getPath, nestedPatch } from "../screens/settingsForm";
import { Notice } from "./Notice";

function keysOf(topic: HelpTopic | undefined): HelpKey[] {
  if (!topic) return [];
  if (topic.kind === "group" || topic.kind === "subtree") return topic.keys;
  if (topic.kind === "key") return [topic.key];
  return [];
}

/**
 * App settings from the registry: every key of a help topic (`app.life`, `app.search`, …) with its
 * type, bounds, default and help. Save sends only the changed keys (`PUT /api/config`).
 */
export function RegistryForm({
  topic,
  title,
  config,
  onSaved,
  filter,
  columns = 4
}: {
  topic: string;
  title: string;
  config: AppConfig | undefined;
  onSaved: (saved: AppConfig) => void;
  filter?: (key: HelpKey) => boolean;
  columns?: number;
}) {
  const help = useApi<HelpTopic>((s) => api.help(topic, s), [topic]);
  const remote = useClientContext().mode === "remote";
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | undefined>(undefined);
  const keys = keysOf(help.data).filter((key) => !key.flags.includes("readOnly") && (filter ? filter(key) : true));
  const { changes, errors } = formChanges(keys, config, drafts);
  const dirty = Object.keys(changes).length > 0;
  const restart = keys.some((key) => key.applies === "restart" && key.path in changes);

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await api.putConfig(nestedPatch(changes));
      onSaved(saved);
      setDrafts({});
      setMessage({ tone: "ok", text: restart ? "Saved. Some of these apply at the next start." : "Saved." });
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fused" style={{ flex: "none" }}>
      <div className="cell slabel" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <span className="t-small">{title}</span>
        {help.error && <span className="t-micro">help unavailable: {help.error.message}</span>}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {dirty && (
            <button className="btn ghost sm" onClick={() => setDrafts({})}>
              Undo
            </button>
          )}
          <button className="btn primary sm" disabled={!dirty || saving || Object.keys(errors).length > 0} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </button>
        </span>
      </div>
      {message && (
        <div className="cell" style={{ padding: "10px 16px" }}>
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className="fgrid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {keys.map((key) => {
          const stored = getPath(config, key.path);
          const text = drafts[key.path] ?? formText(key, stored);
          const locked = remote && key.flags.includes("localOnlyWrite");
          const set = (value: string) => setDrafts((current) => ({ ...current, [key.path]: value }));
          const label = key.path.split(".").slice(-1)[0];
          return (
            <div className="fcell" key={key.path} title={key.cli[1] ?? key.cli[0]}>
              <label className="field-label">
                {label}
                {key.unit ? ` (${key.unit})` : ""}
                {key.path in changes ? " •" : ""}
              </label>
              {key.type === "boolean" ? (
                <label className="checkbox-chip">
                  <input type="checkbox" disabled={locked} checked={text === "true"} onChange={(e) => set(e.target.checked ? "true" : "false")} />
                  {text === "true" ? "On" : "Off"}
                </label>
              ) : key.type === "enum" ? (
                <select className="select" disabled={locked} value={text} onChange={(e) => set(e.target.value)}>
                  {(key.enum ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : key.type === "string-list" || key.type === "json" ? (
                <textarea className="textarea" rows={Math.min(8, Math.max(3, text.split("\n").length))} disabled={locked} value={text} onChange={(e) => set(e.target.value)} />
              ) : (
                <input
                  className="input"
                  disabled={locked}
                  type={key.type === "integer" || key.type === "number" ? "number" : "text"}
                  min={key.min}
                  max={key.max}
                  step={key.type === "integer" ? 1 : "any"}
                  placeholder={key.nullable ? "none" : key.default !== undefined ? String(key.default) : ""}
                  value={text}
                  onChange={(e) => set(e.target.value)}
                />
              )}
              <span className="field-hint" style={errors[key.path] ? { color: "var(--danger)" } : undefined}>
                {errors[key.path] ?? key.help}
                {!errors[key.path] && key.default !== undefined && key.type !== "string-list" ? ` Default ${JSON.stringify(key.default)}.` : ""}
                {locked ? " Change it on the host itself." : key.applies === "restart" ? " Applies at the next start." : ""}
              </span>
            </div>
          );
        })}
        {/* fill the last row so no ink shows through */}
        {Array.from({ length: (columns - (keys.length % columns)) % columns }, (_, index) => (
          <div className="fcell" key={`pad-${index}`} />
        ))}
      </div>
    </div>
  );
}
