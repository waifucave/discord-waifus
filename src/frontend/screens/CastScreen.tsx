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
import { DailyBudgetField, OwnDayNote, SleepFields, WaifuDmFields, WakeOnNameField } from "../components/WaifuLifeFields";
import { SectionHead } from "../components/SectionHead";
import { WaifuDiscordProfileFields } from "../components/WaifuDiscordProfileFields";
import { waifuDirty, waifuPatch, waifuProblems } from "./castEdit";
import { ConfirmDialog } from "../components/ConfirmDialog";

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

/** Her model as provider and route, e.g. `openrouter · anthropic/claude-haiku-5.5`. */
function modelText(model: WaifuConfig["model"] | undefined): string {
  return model ? `${model.providerId} · ${model.modelId}` : "no model";
}

/* ================= mosaic ================= */

/** Her avatar as saved here (uploaded, or imported from her bot's Discord profile); nothing when she has none. */
function WaifuAvatar({ id, size }: { id: string; size: number }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    api
      .waifuImage(id, "pfp", controller.signal)
      .then((blob) => {
        if (!blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(undefined);
    };
  }, [id]);
  if (!url) return null;
  return <img src={url} alt="" width={size} height={size} style={{ objectFit: "cover", flex: "none" }} />;
}

function CastMosaic({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const cast = waifus.data?.waifus ?? [];
  const botIds = new Set((bots.data?.waifus ?? []).map((b) => b.id));
  const notices = runtime.data?.models?.warnings;

  // A waifu without her own bot cannot post (the House bot only reads), so she needs setup.
  const needsSetup = (w: (typeof cast)[number]) => !w.model || !w.botId || !botIds.has(w.botId);
  const talking = cast.filter((w) => w.enabled && !needsSetup(w)).length;
  const unconfigured = cast.filter(needsSetup).length;

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("home")}
        title="Cast"
        sub={`${talking} ready · ${unconfigured} need setup`}
        action={
          <button className="cell clickable actioncell" onClick={() => onNavigate("cast", undefined, "__new__")}>
            + New character
          </button>
        }
      />
      <div className="content">
        <div className="mosaic tiles cast-mosaic">
          {cast.map((waifu, index) => {
            const hue = characterHue(index);
            const missing = needsSetup(waifu);
            const previous = previousModelFor(notices, waifu.id);
            const wide = index === 0;
            return (
              <button
                key={waifu.id}
                className={"cell clickable tile" + (wide ? " wide" : "")}
                data-hue
                style={{ ["--hover-hue" as string]: `var(--${hue})` }}
                onClick={() => onNavigate("cast", undefined, waifu.id)}
              >
                <div>
                  <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
                    <WaifuAvatar id={waifu.id} size={wide ? 64 : 44} />
                    <span className="nm" style={{ fontSize: wide ? 52 : 34 }}>{waifu.displayName || waifu.name}</span>
                  </span>
                  <div className="t-micro t-plain" style={{ marginTop: 8 }}>
                    {modelText(waifu.model)}{waifu.botId ? " · own bot" : " · no bot yet"}
                  </div>
                  {previous && (
                    <div className="t-micro t-plain" style={{ marginTop: 4 }}>
                      was: {previous}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span className="t-micro">{!waifu.enabled ? "disabled" : !waifu.model ? "no model" : !waifu.botId ? "no bot" : "ready"}</span>
                  {missing && <span className="chip butter">needs setup</span>}
                </div>
              </button>
            );
          })}
          <button className="cell clickable add-tile" aria-label="New character" onClick={() => onNavigate("cast", undefined, "__new__")}>
            +
          </button>
          {/* pad the final grid row so no ink shows through */}
          {Array.from({ length: (4 - ((cast.length + 1 + (cast.length > 0 ? 1 : 0)) % 4)) % 4 }, (_, i) => (
            <div className="cell pad" key={`pad-${i}`} aria-hidden="true" />
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

  const name = draft.displayName || draft.name || characterId;
  const blocked = saving || waifuStyleBlocksSave(draft) || problems.length > 0 || unchanged;

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("cast")}
        title={title}
        sub={creating ? "define who she is" : modelText(remote.data?.model)}
        action={
          <button className={"cell clickable actioncell" + (blocked ? "" : " primary")} onClick={save} disabled={blocked}>
            {saving ? "Saving…" : unchanged ? "Saved" : creating ? "Create" : "Save"}
          </button>
        }
      />
      <div className="content">
        {message && (
          <div className="cell notice-cell" role="status">
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
          <div className="cell notice-cell">
            <Notice tone="warn">
              {problems.map((problem) => (
                <div key={problem}>{problem}</div>
              ))}
            </Notice>
          </div>
        )}

        {/* ---------- Profile ---------- */}
        <SectionHead
          index="01"
          title="Profile"
          hint="Who she is: her names, persona and extra instructions."
          actions={
            !creating ? (
              <button type="button" className="btn sm" onClick={() => onNavigate("life", undefined, characterId)}>
                Open her life →
              </button>
            ) : undefined
          }
        />
        <div className="fgrid cols-3">
          {creating && (
            <div className="fcell">
              <label className="field-label" htmlFor="waifu-id">ID (kebab-case)</label>
              <input id="waifu-id" className="input" value={draft.id ?? ""} onChange={(e) => set({ id: e.target.value })} placeholder="momo" />
            </div>
          )}
          <div className="fcell">
            <label className="field-label" htmlFor="waifu-name">Name</label>
            <input id="waifu-name" className="input" value={draft.name ?? ""} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="fcell">
            <label className="field-label" htmlFor="waifu-display-name">Display name</label>
            <input id="waifu-display-name" className="input" value={draft.displayName ?? ""} onChange={(e) => set({ displayName: e.target.value })} />
          </div>
          {!creating && (
            <div className="fcell">
              <span className="field-label">Enabled</span>
              <label className="checkbox-chip">
                <input type="checkbox" checked={draft.enabled ?? false} onChange={(e) => set({ enabled: e.target.checked })} />
                {draft.enabled ? "In the cast" : "Benched"}
              </label>
              <span className="field-hint">Benched: she never wakes.</span>
            </div>
          )}
        </div>
        <div className="cell fcell">
          <label className="field-label" htmlFor="waifu-persona">Persona</label>
          <textarea id="waifu-persona" className="textarea" rows={7} value={draft.persona ?? ""} onChange={(e) => set({ persona: e.target.value })} placeholder="Who is she? Voice, history, quirks, relationships…" />
          <span className="field-hint">Who she is, including how she writes: short and lowercase, long and careful, and so on.</span>
        </div>
        <WaifuStyleFields customInstructions={draft.customInstructions} onChange={set} />

        {/* ---------- Discord ---------- */}
        {!creating && remote.data && (
          <>
            <SectionHead index="02" title="Discord" hint="Her own bot and how it looks on Discord. Set up or link bots in Settings → App." />
            <WaifuDiscordProfileFields
              waifuId={remote.data.id}
              revision={remote.data.revision}
              draft={draft}
              onChange={set}
              botField={
                <div className="fcell">
                  <label className="field-label" htmlFor="waifu-bot">Discord bot</label>
                  <select id="waifu-bot" className="select" value={draft.botId ?? ""} onChange={(e) => set({ botId: e.target.value || undefined })}>
                    <option value="">— none: she cannot post until she has a bot —</option>
                    {(bots.data?.waifus ?? []).map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.displayName} ({bot.id})
                      </option>
                    ))}
                  </select>
                  <span className="field-hint">Without her own bot she cannot post or answer DMs.</span>
                </div>
              }
            />
          </>
        )}

        {/* ---------- Model ---------- */}
        <SectionHead index={creating ? "02" : "03"} title="Model" hint="What she thinks with, and how much she may spend a day." />
        <div className="fgrid model-row">
          <ModelPicker
            value={draft.model}
            models={models.data?.models ?? []}
            onChange={(model) => setDraft((d) => ({ ...d, model }))}
            unsetHint="She stays quiet until she has a model."
          />
          <DailyBudgetField draft={draft} onChange={set} />
        </div>
        {previousModel && (
          <div className="cell notice-cell">
            <Notice tone="warn">Was: {previousModel}. Pick a model from the list to replace it.</Notice>
          </div>
        )}
        {models.error && (
          <div className="cell notice-cell">
            <Notice tone="warn">The model list could not be loaded. Your saved model is kept.</Notice>
          </div>
        )}

        {/* ---------- Schedule ---------- */}
        <SectionHead index={creating ? "03" : "04"} title="Schedule" hint="When she is around, and what wakes her." />
        <div className="fgrid cols-2">
          <div className="fcell">
            <span className="field-label">Schedule in her prompt</span>
            <label className="checkbox-chip">
              <input type="checkbox" checked={draft.scheduleInPrompt ?? true} onChange={(e) => set({ scheduleInPrompt: e.target.checked })} />
              Show her schedule in her prompt
            </label>
            <span className="field-hint">When on, her prompt shows her sleep and today's plan (the one she wrote this morning).</span>
          </div>
          <WakeOnNameField draft={draft} onChange={set} />
        </div>
        <SleepFields draft={draft} onChange={set} />
        <OwnDayNote />

        {/* ---------- Direct messages ---------- */}
        <SectionHead index={creating ? "04" : "05"} title="Direct messages" hint="Whether she answers DMs to her bot, and how often." />
        <WaifuDmFields draft={draft} onChange={set} />

        {/* ---------- Danger zone ---------- */}
        {!creating && remote.data && (
          <>
            <SectionHead index="06" title="Danger zone" tone="danger" />
            <div className="cell action-row">
              <div className="action-text">
                <span className="t-body">Delete {name}</span>
                <span className="t-small t-mute">Her config and persona are removed permanently.</span>
              </div>
              <div className="action-buttons">
                <button type="button" className="btn danger" onClick={() => setConfirmDelete(true)}>
                  Delete {name}…
                </button>
              </div>
            </div>
          </>
        )}
        <div className="cell growcell" />
      </div>
      <FootRow />

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${name}?`}
          cancelLabel="Keep her"
          confirmLabel="Delete"
          width={480}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            void doDelete();
          }}
        >
          <p className="t-small t-mute">Her config and persona are removed permanently.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
