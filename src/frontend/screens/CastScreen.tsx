import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { DiscordBotsFile, ModelWarning, ModelsResponse, RuntimeState, WaifuConfig, WaifusResponse } from "../api/types";
import { characterHue, type ViewId } from "../nav";
import { FootRow, HeadRow } from "./scaffold";
import { ModelPicker } from "../components/ModelPicker";
import { WaifuStyleFields, waifuStyleBlocksSave } from "../components/WaifuStyleFields";
import { Notice } from "../components/Notice";
import { violationsFromApiError, type SaveErrorViolation } from "../api/violations";
import { WaifuDmFields, WaifuLifeFields } from "../components/WaifuLifeFields";
import { waifuDirty, waifuPatch, waifuProblems } from "./castEdit";

export function CastScreen({
  characterId,
  onNavigate
}: {
  characterId?: string;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
}) {
  if (characterId) {
    return <CharacterEditor characterId={characterId} onNavigate={onNavigate} />;
  }
  return <CastMosaic onNavigate={onNavigate} />;
}

/** The model a waifu had before a notice (an upgrade with no curated equivalent, a dropped effort, a retired route). */
export function previousModelFor(warnings: readonly ModelWarning[] | undefined, waifuId: string): string | undefined {
  return (warnings ?? []).find((warning) => warning.scope === `waifu:${waifuId}` && warning.previous)?.previous;
}

/* ================= mosaic ================= */

function CastMosaic({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const cast = waifus.data?.waifus ?? [];
  const botIds = new Set((bots.data?.waifus ?? []).map((b) => b.id));
  const notices = runtime.data?.models?.warnings;

  const talking = cast.filter((w) => w.enabled && w.model).length;
  // A waifu without her own bot speaks through the House bot; a link to a missing bot needs setup.
  const unconfigured = cast.filter((w) => !w.model || (w.botId !== undefined && !botIds.has(w.botId))).length;

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("home")}
        title="Cast"
        sub={`${talking} ready · ${unconfigured} need setup`}
        action={
          <button className="cell clickable actioncell" data-hue style={{ ["--hover-hue" as string]: "var(--mint)" }} onClick={() => onNavigate("cast", undefined, "__new__")}>
            + New character
          </button>
        }
      />
      <div className="content">
        <div
          className="mosaic"
          style={{ flex: 1, gridTemplateColumns: "repeat(4, 1fr)", gridAutoRows: "minmax(220px, 1fr)" }}
        >
          {cast.map((waifu, index) => {
            const hue = characterHue(index);
            const missing = !waifu.model || (waifu.botId !== undefined && !botIds.has(waifu.botId));
            const previous = previousModelFor(notices, waifu.id);
            const wide = index === 0;
            return (
              <button
                key={waifu.id}
                className="cell clickable tile"
                data-hue
                style={{
                  ["--hover-hue" as string]: `var(--${hue})`,
                  gridColumn: wide ? "span 2" : undefined
                }}
                onClick={() => onNavigate("cast", undefined, waifu.id)}
              >
                <div>
                  <span className="nm" style={{ fontSize: wide ? 52 : 34 }}>{waifu.displayName || waifu.name}</span>
                  <div className="t-micro" style={{ marginTop: 8, textTransform: "none", letterSpacing: "0.04em" }}>
                    {waifu.model?.modelId ?? "no model"}{waifu.botId ? " · own bot" : " · via the House bot"}
                  </div>
                  {previous && (
                    <div className="t-micro t-mute" style={{ marginTop: 4, textTransform: "none", letterSpacing: "0.04em" }}>
                      was: {previous}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span className="t-micro">{waifu.enabled ? (waifu.model ? "ready" : "no model") : "disabled"}</span>
                  {missing && <span className="chip butter">needs setup</span>}
                </div>
              </button>
            );
          })}
          <button
            className="cell clickable"
            data-hue
            style={{ ["--hover-hue" as string]: "var(--mint)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 44, color: "var(--mute)" }}
            onClick={() => onNavigate("cast", undefined, "__new__")}
          >
            +
          </button>
          {/* pad the final grid row so no ink shows through */}
          {Array.from({ length: (4 - ((cast.length + 1 + (cast.length > 0 ? 1 : 0)) % 4)) % 4 }, (_, i) => (
            <div className="cell" key={`pad-${i}`} />
          ))}
        </div>
      </div>
      <FootRow />
    </div>
  );
}

/* ================= editor screen ================= */

function CharacterEditor({
  characterId,
  onNavigate
}: {
  characterId: string;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
}) {
  const creating = characterId === "__new__";
  const models = useApi<ModelsResponse>((s) => api.models(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const runtime = useApi<RuntimeState | undefined>(async (s) => (creating ? undefined : api.runtime(s)), [characterId]);
  const previousModel = creating ? undefined : previousModelFor(runtime.data?.models?.warnings, characterId);
  const remote = useApi<WaifuConfig | undefined>(
    async (s) => (creating ? undefined : api.waifu(characterId, s)),
    [characterId]
  );

  const [draft, setDraft] = useState<Partial<WaifuConfig>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [violations, setViolations] = useState<SaveErrorViolation[] | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (creating) {
      setDraft({
        id: "",
        name: "",
        displayName: "",
        persona: "",
        enabled: true,
        verbosity: "terse",
        customInstructions: "",
        scheduleInPrompt: true,
        wakeOnName: true,
        life: { dailyBudgetUsd: null }
      });
    } else if (remote.data) {
      setDraft(remote.data);
    }
  }, [creating, remote.data]);

  const set = (patch: Partial<WaifuConfig>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    setViolations(undefined);
    try {
      if (creating) {
        const created = await api.createWaifu({
          id: draft.id || undefined,
          name: draft.name || draft.displayName || "Unnamed",
          displayName: draft.displayName || draft.name || "Unnamed",
          persona: draft.persona ?? "",
          ...(draft.model ? { model: draft.model } : {}),
          verbosity: draft.verbosity,
          customInstructions: draft.customInstructions,
          scheduleInPrompt: draft.scheduleInPrompt,
          ...(draft.wakeOnName !== undefined ? { wakeOnName: draft.wakeOnName } : {}),
          ...(draft.life ? { life: draft.life } : {}),
          ...(draft.availability ? { availability: draft.availability } : {}),
          ...(draft.dm ? { dm: draft.dm } : {})
        });
        onNavigate("cast", undefined, created.id);
        setMessage("Character created.");
      } else if (remote.data) {
        // Only what changed, with her revision (`null` unsets the model or the bot).
        const saved = await api.updateWaifu(remote.data.id, waifuPatch(remote.data, draft));
        remote.setData(saved);
        setMessage("Saved.");
      }
    } catch (err) {
      setMessage((err as Error).message);
      setViolations(violationsFromApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!remote.data) return;
    try {
      await api.deleteWaifu(remote.data.id, remote.data.revision);
      onNavigate("cast");
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const title = creating ? "New character" : draft.displayName || draft.name || characterId;
  const problems = waifuProblems(draft);
  const unchanged = !creating && !waifuDirty(remote.data, draft);

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("cast")}
        title={title}
        sub={creating ? "define who she is" : remote.data?.model?.modelId ?? "no model"}
        action={
          <button
            className="cell clickable actioncell"
            style={{ background: "var(--mint)" }}
            onClick={save}
            disabled={saving || waifuStyleBlocksSave(draft) || problems.length > 0 || unchanged}
          >
            {saving ? "Saving…" : unchanged ? "Saved" : "Save"}
          </button>
        }
      />
      <div className="content">
        {message && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone={violations?.length ? "err" : "ok"}>
              <div>{message}</div>
              {violations && violations.length > 0 && (
                <ul className="model-params-warnings">
                  {violations.map((v, i) => (
                    <li key={i} title={v.rule ? `rule ${v.rule}` : undefined}>
                      {v.message ?? `${v.param} isn't supported by this model`}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          </div>
        )}

        {problems.length > 0 && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="warn">
              {problems.map((problem) => (
                <div key={problem}>{problem}</div>
              ))}
            </Notice>
          </div>
        )}
        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: creating ? "1fr 1fr 1fr" : "1fr 1fr" }}>
          {creating && (
            <div className="fcell">
              <label className="field-label">ID (kebab-case)</label>
              <input className="input" value={draft.id ?? ""} onChange={(e) => set({ id: e.target.value })} placeholder="momo" />
            </div>
          )}
          <div className="fcell">
            <label className="field-label">Name</label>
            <input className="input" value={draft.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="fcell">
            <label className="field-label">Display name</label>
            <input className="input" value={draft.displayName ?? ""} onChange={(e) => set({ displayName: e.target.value })} />
          </div>
        </div>
        <div className="cell fcell" style={{ flex: "none" }}>
          <label className="field-label">Persona</label>
          <textarea className="textarea" rows={7} value={draft.persona ?? ""} onChange={(e) => set({ persona: e.target.value })} placeholder="Who is she? Voice, history, quirks, relationships…" />
          <span className="field-hint">Character only — message length and chat format are enforced by the harness, not the persona.</span>
        </div>
        <WaifuStyleFields
          verbosity={draft.verbosity}
          customInstructions={draft.customInstructions}
          onChange={set}
        />
        {!creating && (
          <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr" }}>
            <div className="fcell">
              <label className="field-label">Enabled</label>
              <label className="checkbox-chip">
                <input type="checkbox" checked={draft.enabled ?? false} onChange={(e) => set({ enabled: e.target.checked })} />
                {draft.enabled ? "In the cast" : "Benched"}
              </label>
            </div>
            <div className="fcell">
              <label className="field-label">Discord bot</label>
              <select className="select" value={draft.botId ?? ""} onChange={(e) => set({ botId: e.target.value || undefined })}>
                <option value="">— none: she speaks through the House bot —</option>
                {(bots.data?.waifus ?? []).map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.displayName} ({bot.id})
                  </option>
                ))}
              </select>
              <span className="field-hint">Manage bot applications in Settings → App.</span>
            </div>
          </div>
        )}

        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 240px" }}>
          <ModelPicker
            value={draft.model}
            models={models.data?.models ?? []}
            onChange={(model) => setDraft((d) => ({ ...d, model }))}
            unsetHint="She stays quiet until she has a model."
          />
        </div>
        {previousModel && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="warn">Was: {previousModel}. Pick a model from the list to replace it.</Notice>
          </div>
        )}
        {models.error && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="warn">The model list could not be loaded. Your saved model is kept.</Notice>
          </div>
        )}

        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr" }}>
          <div className="fcell">
            <label className="field-label">Schedule</label>
            <label className="checkbox-chip">
              <input
                type="checkbox"
                checked={draft.scheduleInPrompt ?? true}
                onChange={(e) => set({ scheduleInPrompt: e.target.checked })}
              />
              Mention her schedule in the prompt
            </label>
            <span className="field-hint">When on, she knows what she is doing right now (sleeping, busy) and can say so.</span>
          </div>
          {!creating ? (
            <button className="cell clickable" data-hue style={{ ["--hover-hue" as string]: "var(--lavender)", padding: "18px 26px" }} onClick={() => onNavigate("life", undefined, characterId)}>
              <div className="t-body">Open her life →</div>
              <div className="t-micro" style={{ marginTop: 4 }}>timeline · wake · compact · reset</div>
            </button>
          ) : (
            <div className="cell" />
          )}
        </div>
        <WaifuLifeFields draft={draft} onChange={set} />
        <WaifuDmFields draft={draft} onChange={set} />

        {!creating && remote.data && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--line)", background: "var(--ink)", flex: "none" }}>
            <div className="cell" />
            <button
              className="cell clickable"
              data-hue
              style={{ ["--hover-hue" as string]: "var(--danger)", padding: "18px 26px" }}
              onClick={() => setConfirmDelete(true)}
            >
              <div className="t-body">Delete {draft.displayName || draft.name}</div>
              <div className="t-micro" style={{ marginTop: 4 }}>permanent</div>
            </button>
          </div>
        )}
        <div className="cell growcell" />
      </div>
      <FootRow />

      {confirmDelete && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setConfirmDelete(false)}>
          <div className="modal" style={{ width: 480 }}>
            <div className="modal-header">
              <span className="t-title">Delete {draft.displayName || draft.name}?</span>
            </div>
            <div className="modal-body">
              <p className="t-small t-mute">Her config and persona are removed permanently.</p>
            </div>
            <div className="modal-footer">
              <button className="cell clickable" style={{ background: "var(--paper)" }} onClick={() => setConfirmDelete(false)}>
                Keep her
              </button>
              <button className="cell clickable" style={{ background: "var(--danger)" }} onClick={doDelete}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
