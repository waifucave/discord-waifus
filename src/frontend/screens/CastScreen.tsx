import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type { DiscordBotsFile, WaifuConfig, WaifusResponse } from "../api/types";
import { characterHue, type ViewId } from "../nav";
import { Disclosure, FootRow, HeadRow } from "./scaffold";
import { ModelParamsForm } from "../components/modelParams/ModelParamsForm";
import { PromptLayoutEditor } from "../components/PromptLayoutEditor";
import { Notice } from "../components/Notice";
import {
  buildModelGroupOptions,
  buildRouteOptions,
  defaultRoute,
  findRoute,
  groupModelRoutes,
  UNAVAILABLE_MODEL_VALUE
} from "../components/modelParams/logic";
import { violationsFromApiError, type SaveErrorViolation } from "../api/violations";

type LlmProviderSummary = Awaited<ReturnType<typeof llmProviders>>[number];

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

/* ================= mosaic ================= */

function CastMosaic({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const cast = waifus.data?.waifus ?? [];
  const botIds = new Set((bots.data?.waifus ?? []).map((b) => b.id));

  const talking = cast.filter((w) => w.enabled && w.modelId).length;
  const unconfigured = cast.filter((w) => !w.modelId || !w.botId).length;

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
            const missing = !waifu.modelId || !waifu.botId || !botIds.has(waifu.botId ?? "");
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
                    {waifu.modelId ?? "no model"} · {waifu.contextWindow} ctx{waifu.botId ? " · bot linked" : " · no bot"}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <span className="t-micro">{waifu.enabled ? (waifu.modelId ? "ready" : "no model") : "disabled"}</span>
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
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const bots = useApi<DiscordBotsFile>((s) => api.discordBots(s), []);
  const remote = useApi<WaifuConfig | undefined>(
    async (s) => (creating ? undefined : api.waifu(characterId, s)),
    [characterId]
  );

  const [draft, setDraft] = useState<Partial<WaifuConfig>>({});
  const [paramsValid, setParamsValid] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [violations, setViolations] = useState<SaveErrorViolation[] | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (creating) {
      setDraft({ id: "", name: "", displayName: "", persona: "", contextWindow: 50, enabled: true, params: {} });
    } else if (remote.data) {
      setDraft(remote.data);
    }
  }, [creating, remote.data]);

  const routeGroups = useMemo(() => groupModelRoutes(llmModelsState.data ?? []), [llmModelsState.data]);
  const configuredProviderIds = useMemo(
    () => new Set((llmProvidersState.data ?? []).filter((p) => p.credentialConfigured).map((p) => p.id)),
    [llmProvidersState.data]
  );
  const resolvedRoute = useMemo(() => {
    if (!draft.providerId || !draft.modelId) return undefined;
    return findRoute(llmModelsState.data ?? [], draft.providerId, draft.modelId);
  }, [llmModelsState.data, draft.providerId, draft.modelId]);
  const modelGroupOptions = useMemo(
    () =>
      buildModelGroupOptions(
        routeGroups,
        draft.providerId && draft.modelId && !resolvedRoute ? { providerId: draft.providerId, modelId: draft.modelId } : undefined
      ),
    [routeGroups, draft.providerId, draft.modelId, resolvedRoute]
  );
  const modelGroupValue = !draft.providerId || !draft.modelId ? "" : resolvedRoute ? resolvedRoute.group.key : UNAVAILABLE_MODEL_VALUE;
  const routeOptions = resolvedRoute ? buildRouteOptions(resolvedRoute.group, configuredProviderIds) : [];

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
          providerId: draft.providerId,
          modelId: draft.modelId,
          params: draft.params ?? {},
          contextWindow: draft.contextWindow
        });
        onNavigate("cast", undefined, created.id);
        setMessage("Character created.");
      } else if (remote.data) {
        const saved = await api.updateWaifu(remote.data.id, {
          revision: remote.data.revision,
          name: draft.name,
          displayName: draft.displayName,
          persona: draft.persona,
          enabled: draft.enabled,
          providerId: draft.providerId ?? null,
          modelId: draft.modelId ?? null,
          params: draft.params,
          contextWindow: draft.contextWindow,
          ...(draft.botId ? { botId: draft.botId } : {}),
          availability: draft.availability,
          tools: draft.tools,
          promptLayout: draft.promptLayout
        });
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

  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("cast")}
        title={title}
        sub={creating ? "define who she is" : remote.data?.modelId ?? "no model"}
        action={
          <button
            className="cell clickable actioncell"
            style={{ background: "var(--mint)" }}
            onClick={save}
            disabled={saving || (Boolean(draft.modelId) && !paramsValid)}
          >
            {saving ? "Saving…" : "Save"}
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
                    <li key={i}>
                      {v.param}: {v.code}
                      {v.rule ? ` (rule ${v.rule})` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </Notice>
          </div>
        )}

        <div className="cell slabel" style={{ flex: "none" }}>
          <span className="t-micro" style={{ color: "var(--ink)" }}>Identity</span>
          <span className="t-micro">who shows up in the room</span>
        </div>
        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: creating ? "1fr 1fr 1fr" : "1fr 1fr" }}>
          {creating && (
            <div className="fcell">
              <label className="field-label">Id (kebab-case)</label>
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
                <option value="">— none —</option>
                {(bots.data?.waifus ?? []).map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.displayName} ({bot.id})
                  </option>
                ))}
              </select>
              <span className="field-hint">Manage bot applications in Settings → Discord.</span>
            </div>
          </div>
        )}

        <div className="cell slabel" style={{ flex: "none" }}>
          <span className="t-micro" style={{ color: "var(--ink)" }}>Model</span>
          <span className="t-micro">her brain</span>
        </div>
        <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr 200px" }}>
            <div className="fcell">
              <label className="field-label">Model</label>
              <select
                className="select"
                value={modelGroupValue}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) return set({ providerId: undefined, modelId: undefined });
                  if (value === UNAVAILABLE_MODEL_VALUE) return;
                  const group = routeGroups.find((g) => g.key === value);
                  const route = group && defaultRoute(group, configuredProviderIds);
                  if (route) set({ providerId: route.providerId, modelId: route.modelId });
                }}
              >
                {modelGroupOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {resolvedRoute && resolvedRoute.group.routes.length > 1 ? (
              <div className="fcell">
                <label className="field-label">Route</label>
                <select
                  className="select"
                  value={resolvedRoute.route.providerId}
                  onChange={(e) => {
                    const route = resolvedRoute.group.routes.find((r) => r.providerId === e.target.value);
                    if (route) set({ providerId: route.providerId, modelId: route.modelId });
                  }}
                >
                  {routeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="cell" />
            )}
            <div className="fcell">
              <label className="field-label">Context window</label>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={draft.contextWindow ?? 50}
                onChange={(e) => set({ contextWindow: Number(e.target.value) })}
              />
            </div>
        </div>
        {draft.modelId && (
          <Disclosure title="Model parameters" hint="temperature · reasoning · advanced">
            <div className="fused" style={{ flex: "none" }}>
              <ModelParamsForm
                providerId={draft.providerId ?? null}
                modelId={draft.modelId ?? null}
                value={draft.params ?? {}}
                onChange={(params) => set({ params })}
                onValidity={setParamsValid}
              />
            </div>
          </Disclosure>
        )}

        {!creating && remote.data && draft.promptLayout && draft.tools && (
          <Disclosure title="Prompt layout" hint="advanced · defaults are sensible">
          <div className="fused" style={{ flex: "none" }}>
            <PromptLayoutEditor
              layout={draft.promptLayout}
              tools={draft.tools}
              onLayoutChange={(promptLayout) => set({ promptLayout })}
              onToolsChange={(tools) => set({ tools })}
              waifuName={draft.name || draft.id || "waifu"}
            />
          </div>
          </Disclosure>
        )}

        {!creating && remote.data && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--line)", background: "var(--ink)", flex: "none" }}>
            <button
              className="cell clickable"
              data-hue
              style={{ ["--hover-hue" as string]: "var(--lavender)", padding: "18px 26px" }}
              onClick={async () => {
                try {
                  const updated = await api.regeneratePersonaDigest(remote.data!.id);
                  remote.setData(updated);
                  setMessage("Digest regenerated.");
                } catch (err) {
                  setMessage((err as Error).message);
                }
              }}
            >
              <div className="t-body">Regenerate persona digest</div>
              <div className="t-micro" style={{ marginTop: 4, textTransform: "none" }}>
                {remote.data.personaDigest ? remote.data.personaDigest.voice.slice(0, 90) : "no digest yet"}
              </div>
            </button>
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
              <p className="t-small t-mute">Her config and persona are removed permanently. Memories about her stay in the store.</p>
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
