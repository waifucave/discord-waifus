import { useId, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { AppConfig, HelpKey, HelpTopic } from "../api/types";
import { useClientContext } from "../state/clientContext";
import { formChanges, formText, getPath, keyLabel, nestedPatch } from "../screens/settingsForm";
import { Notice } from "./Notice";
import { SectionHead } from "./SectionHead";

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
  hint,
  columns = 3
}: {
  topic: string;
  title: string;
  hint?: string;
  config: AppConfig | undefined;
  onSaved: (saved: AppConfig) => void;
  filter?: (key: HelpKey) => boolean;
  columns?: number;
}) {
  const help = useApi<HelpTopic>((s) => api.help(topic, s), [topic]);
  const formId = useId();
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

  if (help.data && keys.length === 0) return null;

  return (
    <>
      <SectionHead
        title={title}
        hint={help.error ? `Help unavailable: ${help.error.message}` : hint}
        actions={
          <>
            {dirty && (
              <button className="btn quiet sm" onClick={() => setDrafts({})}>
                Undo
              </button>
            )}
            <button className="btn primary sm" disabled={!dirty || saving || Object.keys(errors).length > 0} onClick={() => void save()}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          </>
        }
      />
      {message && (
        <div className="cell notice-cell" role="status">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      <div className={`fgrid cols-${columns}`}>
        {keys.map((key) => {
          const stored = getPath(config, key.path);
          const text = drafts[key.path] ?? formText(key, stored);
          const locked = remote && key.flags.includes("localOnlyWrite");
          const set = (value: string) => setDrafts((current) => ({ ...current, [key.path]: value }));
          const label = keyLabel(key);
          const secret = key.flags.includes("secret");
          const inputId = `${formId}-${key.path}`;
          const hintId = `${inputId}-hint`;
          const error = errors[key.path];
          return (
            <div className="fcell" key={key.path} title={key.cli[1] ?? key.cli[0]}>
              <label className="field-label" htmlFor={inputId}>
                <span>
                  {label}
                  {key.unit ? ` (${key.unit})` : ""}
                  {key.path in changes ? " •" : ""}
                </span>
              </label>
              {key.type === "boolean" ? (
                <label className="checkbox-chip">
                  <input
                    id={inputId}
                    type="checkbox"
                    aria-label={label}
                    aria-describedby={hintId}
                    disabled={locked}
                    checked={text === "true"}
                    onChange={(e) => set(e.target.checked ? "true" : "false")}
                  />
                  {text === "true" ? "On" : "Off"}
                </label>
              ) : key.type === "enum" ? (
                <select id={inputId} aria-describedby={hintId} className="select" disabled={locked} value={text} onChange={(e) => set(e.target.value)}>
                  {(key.enum ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : key.type === "string-list" || key.type === "json" ? (
                <textarea
                  id={inputId}
                  aria-describedby={hintId}
                  className="textarea"
                  rows={Math.min(8, Math.max(3, text.split("\n").length))}
                  disabled={locked}
                  value={text}
                  onChange={(e) => set(e.target.value)}
                />
              ) : (
                <input
                  id={inputId}
                  aria-describedby={hintId}
                  aria-invalid={error ? true : undefined}
                  className="input"
                  disabled={locked}
                  type={secret ? "password" : key.type === "integer" || key.type === "number" ? "number" : "text"}
                  autoComplete={secret ? "new-password" : undefined}
                  min={key.min}
                  max={key.max}
                  step={key.type === "integer" ? 1 : "any"}
                  // An emptied field must look empty: the default is in the hint, never a placeholder.
                  placeholder={secret ? "(write-only: type a new value to replace it)" : key.nullable || key.flags.includes("nullUnset") ? "none" : ""}
                  value={text}
                  onChange={(e) => set(e.target.value)}
                />
              )}
              {error ? (
                <span id={hintId} className="field-error" role="alert">
                  {error}
                </span>
              ) : (
                <span id={hintId} className="field-hint">
                  {key.help}
                  {key.default !== undefined && key.type !== "string-list" && !secret ? ` Default ${JSON.stringify(key.default)}.` : ""}
                  {locked ? " Change it on the host itself." : key.applies === "restart" ? " Applies at the next start." : ""}
                  <span className="field-key"> {key.path}</span>
                </span>
              )}
            </div>
          );
        })}
        {/* fill the last row so no ink shows through */}
        {Array.from({ length: (columns - (keys.length % columns)) % columns }, (_, index) => (
          <div className="fcell pad" key={`pad-${index}`} aria-hidden="true" />
        ))}
      </div>
    </>
  );
}
