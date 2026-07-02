import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Clock, Image as ImageIcon, MessageSquare, Plus, Save, Sparkles, Trash2 } from "lucide-react";
import { api, ConflictError } from "../api/client";
import { useApi } from "../api/useApi";
import { violationsFromApiError, type SaveErrorViolation } from "../api/violations";
import { llmModels, llmProviders, type LlmModelSummary } from "../api/llm";
import type {
  DiscordBotsFile,
  UpdateWaifuBody,
  WaifuAvailability,
  WaifuBusyInterval,
  WaifuConfig,
  WaifuPromptLayout,
  WaifuToolSettings,
  WaifusResponse
} from "../api/types";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { Modal } from "../components/Modal";
import { Notice } from "../components/Notice";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { DiscordBotGuide } from "../components/DiscordBotGuide";
import { ModelParamsForm } from "../components/modelParams/ModelParamsForm";
import {
  buildModelGroupOptions,
  buildRouteOptions,
  defaultRoute,
  findRoute,
  groupModelRoutes,
  UNAVAILABLE_MODEL_VALUE
} from "../components/modelParams/logic";
import { Toggle } from "../components/Toggle";
import { PromptLayoutEditor } from "../components/PromptLayoutEditor";
import { defaultWaifuPromptLayout, reconcileLayout } from "../utils/promptLayout";
import { slugify, timeAgo } from "../utils/format";

type LlmProviderSummary = Awaited<ReturnType<typeof llmProviders>>[number];

export function WaifusView() {
  const waifus = useApi<WaifusResponse>((signal) => api.waifus(signal), []);
  const llmModelsState = useApi<LlmModelSummary[]>(() => llmModels(), []);
  const llmProvidersState = useApi<LlmProviderSummary[]>(() => llmProviders(), []);
  const bots = useApi<DiscordBotsFile>((signal) => api.discordBots(signal), []);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Waifus</h2>
          <p className="view-subtitle">
            Persona, model, Discord bot, and memory configuration per waifu.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={waifus.reload}>Refresh</button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus className="icon" /> New waifu
          </button>
        </div>
      </div>

      {waifus.loading && <SkeletonRows rows={4} height={32} />}
      {waifus.error && <Notice tone="err">Failed to load waifus: {waifus.error.message}</Notice>}

      {waifus.data && waifus.data.waifus.length === 0 && (
        <Empty title="No waifus yet" icon={<Sparkles className="icon-lg" />}>
          Create your first waifu. You'll set a persona, pick a model, and add a Discord bot token.
        </Empty>
      )}

      {waifus.data && waifus.data.waifus.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Internal name</th>
                <th>Model</th>
                <th>Bot</th>
                <th>Context</th>
                <th>Updated</th>
                <th>Setup</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {waifus.data.waifus.map((w) => (
                <tr key={w.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{w.displayName}</div>
                    <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)" }}>
                      {w.id}
                    </div>
                  </td>
                  <td style={{ fontFamily: "var(--font-mono)" }}>{w.name}</td>
                  <td>
                    {w.modelId ? (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
                        {w.providerId}/{w.modelId}
                      </span>
                    ) : (
                      <Pill tone="warn">unset</Pill>
                    )}
                  </td>
                  <td>
                    {w.botId ? (
                      <Pill tone="info" dot>
                        bot:{w.botId}
                      </Pill>
                    ) : (
                      <Pill tone="warn" dot>
                        no bot
                      </Pill>
                    )}
                  </td>
                  <td>{w.contextWindow}</td>
                  <td>{timeAgo(w.updatedAt)}</td>
                  <td><WaifuSetupPill waifu={w} bots={bots.data} /></td>
                  <td className="right">
                    <button className="btn sm" onClick={() => setEditingId(w.id)}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingId && (
        <WaifuEditor
          waifuId={editingId}
          llmModels={llmModelsState.data}
          llmProviders={llmProvidersState.data}
          bots={bots.data}
          onClose={() => setEditingId(undefined)}
          onSaved={() => {
            waifus.reload();
          }}
          onDeleted={() => {
            setEditingId(undefined);
            waifus.reload();
          }}
        />
      )}

      {creating && (
        <CreateWaifuModal
          onClose={() => setCreating(false)}
          onCreated={(w) => {
            setCreating(false);
            waifus.reload();
            setEditingId(w.id);
          }}
        />
      )}
    </>
  );
}

function CreateWaifuModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  onCreated: (w: WaifuConfig) => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [availability, setAvailability] = useState<WaifuAvailability>(() => defaultAvailability());
  const [tools, setTools] = useState<WaifuToolSettings>(() => defaultToolSettings());
  const [promptLayout, setPromptLayout] = useState<WaifuPromptLayout>(() => defaultWaifuPromptLayout());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);

  const submit = async () => {
    if (!name.trim() || !displayName.trim()) {
      setErr("Both names are required.");
      return;
    }
    setBusy(true);
    setErr(undefined);
    try {
      const created = await api.createWaifu({
        name: name.trim(),
        displayName: displayName.trim(),
        id: slugify(name),
        availability,
        tools,
        promptLayout
      });
      onCreated(created);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      title="Create waifu"
      wide
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={submit} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <div className="field">
        <label className="field-label">Internal name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="aria"
          autoFocus
        />
        <span className="field-hint">Lowercase, used as the id. Slug: <code>{slugify(name) || "—"}</code></span>
      </div>
      <div className="field">
        <label className="field-label">Display name</label>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Aria"
        />
      </div>
      <ScheduleEditor value={availability} onChange={setAvailability} />
      <PromptLayoutEditor
        layout={promptLayout}
        tools={tools}
        onLayoutChange={setPromptLayout}
        onToolsChange={setTools}
        waifuName={displayName || name || "waifu"}
      />
      {err && <Notice tone="err">{err}</Notice>}
    </Modal>
  );
}

function WaifuSetupPill({
  waifu,
  bots
}: {
  waifu: WaifuConfig;
  bots: DiscordBotsFile | undefined;
}) {
  const linkedBot = bots?.waifus.find((bot) => bot.id === waifu.botId);
  if (!waifu.modelId) {
    return <Pill tone="warn" dot>missing model</Pill>;
  }
  if (!waifu.botId) {
    return <Pill tone="warn" dot>missing bot</Pill>;
  }
  if (!linkedBot?.tokenConfigured) {
    return <Pill tone="warn" dot>missing token</Pill>;
  }
  return <Pill tone="ok" dot>ready</Pill>;
}

function WaifuEditor({
  waifuId,
  llmModels: llmModelList,
  llmProviders: llmProviderList,
  bots,
  onClose,
  onSaved,
  onDeleted
}: {
  waifuId: string;
  llmModels: LlmModelSummary[] | undefined;
  llmProviders: LlmProviderSummary[] | undefined;
  bots: DiscordBotsFile | undefined;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [waifu, setWaifu] = useState<WaifuConfig | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingBot, setSavingBot] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [errorViolations, setErrorViolations] = useState<SaveErrorViolation[] | undefined>(undefined);
  const [conflict, setConflict] = useState<WaifuConfig | undefined>(undefined);
  const [paramsValid, setParamsValid] = useState(true);
  const [pfpUploadMsg, setPfpUploadMsg] = useState<string | undefined>(undefined);
  const [botMessage, setBotMessage] = useState<string | undefined>(undefined);
  const [botDisplayName, setBotDisplayName] = useState("");
  const [botApplicationId, setBotApplicationId] = useState("");
  const [botToken, setBotToken] = useState("");
  const botState = useApi<DiscordBotsFile>((signal) => api.discordBots(signal), [waifuId]);
  const [digestBusy, setDigestBusy] = useState(false);
  const [digestError, setDigestError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoadError(undefined);
    setParamsValid(true);
    try {
      const data = await api.waifu(waifuId);
      setWaifu(data);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [waifuId]);

  useEffect(() => {
    void load();
  }, [load]);

  const botFile = botState.data ?? bots;
  const linkedBot = botFile?.waifus.find((b) => b.id === waifu?.botId);

  useEffect(() => {
    if (!waifu) return;
    setBotDisplayName(linkedBot?.displayName ?? waifu.displayName);
    setBotApplicationId(linkedBot?.applicationId ?? "");
    setBotToken("");
  }, [waifu?.id, waifu?.botId, waifu?.displayName, linkedBot?.id, linkedBot?.applicationId]);

  const set = (patch: Partial<WaifuConfig>) => {
    setWaifu((w) => (w ? { ...w, ...patch } : w));
  };

  const routeGroups = useMemo(() => groupModelRoutes(llmModelList ?? []), [llmModelList]);
  const configuredProviderIds = useMemo(
    () => new Set((llmProviderList ?? []).filter((p) => p.credentialConfigured).map((p) => p.id)),
    [llmProviderList]
  );
  const resolvedRoute = useMemo(() => {
    if (!waifu?.providerId || !waifu?.modelId) return undefined;
    return findRoute(llmModelList ?? [], waifu.providerId, waifu.modelId);
  }, [llmModelList, waifu?.providerId, waifu?.modelId]);
  const modelGroupOptions = useMemo(
    () =>
      buildModelGroupOptions(
        routeGroups,
        waifu?.providerId && waifu?.modelId && !resolvedRoute
          ? { providerId: waifu.providerId, modelId: waifu.modelId }
          : undefined
      ),
    [routeGroups, waifu?.providerId, waifu?.modelId, resolvedRoute]
  );
  const modelGroupValue = !waifu?.providerId || !waifu?.modelId
    ? ""
    : resolvedRoute
      ? resolvedRoute.group.key
      : UNAVAILABLE_MODEL_VALUE;
  const routeOptions = resolvedRoute ? buildRouteOptions(resolvedRoute.group, configuredProviderIds) : [];

  const selectModelGroup = (value: string) => {
    if (value === "") {
      set({ providerId: undefined, modelId: undefined });
      return;
    }
    if (value === UNAVAILABLE_MODEL_VALUE) {
      return;
    }
    const group = routeGroups.find((g) => g.key === value);
    const route = group && defaultRoute(group, configuredProviderIds);
    if (!route) return;
    set({ providerId: route.providerId, modelId: route.modelId });
  };

  const selectRoute = (providerId: string) => {
    const route = resolvedRoute?.group.routes.find((r) => r.providerId === providerId);
    if (!route) return;
    set({ providerId: route.providerId, modelId: route.modelId });
  };

  const modelSelected = Boolean(waifu?.providerId && waifu?.modelId);
  const paramsBlocked = modelSelected && !paramsValid;

  const persistWaifu = async (draft: WaifuConfig): Promise<WaifuConfig> => {
    const body: UpdateWaifuBody = {
      revision: draft.revision,
      name: draft.name,
      displayName: draft.displayName,
      enabled: true,
      persona: draft.persona,
      // Gateway P6 Task 4: send explicit `null` (not `undefined`) when no model is selected, so
      // an unset carries over the wire instead of silently vanishing under JSON.stringify.
      providerId: draft.providerId ?? null,
      modelId: draft.modelId ?? null,
      botId: draft.botId,
      contextWindow: draft.contextWindow,
      params: draft.params,
      availability: draft.availability,
      tools: draft.tools,
      promptLayout: draft.promptLayout
    };
    const updated = await api.updateWaifu(draft.id, body);
    setWaifu(updated);
    setConflict(undefined);
    onSaved();
    return updated;
  };

  const save = async () => {
    if (!waifu) return;
    setSaving(true);
    setError(undefined);
    setErrorViolations(undefined);
    try {
      await persistWaifu(waifu);
    } catch (err) {
      handleWaifuSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  const regenerateDigest = async () => {
    if (!waifu) return;
    setDigestBusy(true);
    setDigestError(undefined);
    try {
      const updated = await api.regeneratePersonaDigest(waifu.id);
      setWaifu(updated);
    } catch (err) {
      setDigestError((err as Error).message);
    } finally {
      setDigestBusy(false);
    }
  };

  const saveAndLinkBot = async () => {
    if (!waifu) return;
    const displayName = botDisplayName.trim() || waifu.displayName;
    setSavingBot(true);
    setError(undefined);
    setErrorViolations(undefined);
    setBotMessage(undefined);
    try {
      const currentBots = botFile ?? await api.discordBots();
      const existing = waifu.botId
        ? currentBots.waifus.find((b) => b.id === waifu.botId)
        : undefined;
      const ids = new Set(currentBots.waifus.map((b) => b.id));
      const baseId = existing?.id || slugify(displayName) || slugify(waifu.name) || "waifu-bot";
      let id = baseId;
      let suffix = 2;
      while (!existing && ids.has(id)) {
        id = `${baseId}-${suffix++}`;
      }
      const nextBot = {
        id,
        displayName,
        applicationId: botApplicationId.trim() || undefined,
        token: botToken.trim() || undefined,
        enabled: true
      };
      const nextBots = {
        ...currentBots,
        waifus: currentBots.waifus.some((b) => b.id === id)
          ? currentBots.waifus.map((b) => (b.id === id ? { ...b, ...nextBot } : b))
          : [...currentBots.waifus, nextBot]
      };
      const savedBots = await api.putDiscordBots(nextBots);
      botState.setData(savedBots);
      setBotToken("");
      await persistWaifu({ ...waifu, botId: id });
      setBotMessage("Waifu bot saved and linked.");
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflict(err.latest as WaifuConfig);
        setError("Saved data was modified elsewhere. Reload before linking the bot.");
      } else {
        setError((err as Error).message);
      }
      setErrorViolations(violationsFromApiError(err));
    } finally {
      setSavingBot(false);
    }
  };

  const handleWaifuSaveError = (err: unknown) => {
    if (err instanceof ConflictError) {
      setConflict(err.latest as WaifuConfig);
      setError("Saved data was modified elsewhere. Reload or overwrite.");
    } else {
      setError((err as Error).message);
    }
    setErrorViolations(violationsFromApiError(err));
  };

  const remove = async () => {
    if (!waifu) return;
    if (!window.confirm(`Delete waifu "${waifu.displayName}"? This removes its folder.`)) return;
    setDeleting(true);
    setError(undefined);
    setErrorViolations(undefined);
    try {
      await api.deleteWaifu(waifu.id, waifu.revision);
      onDeleted();
    } catch (err) {
      if (err instanceof ConflictError) {
        setError("Conflict: another change occurred. Reload first.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => !saving && !deleting && onClose()}
      wide
      title={waifu ? `Edit · ${waifu.displayName}` : `Edit · ${waifuId}`}
      footer={
        <>
          <button className="btn danger" onClick={remove} disabled={!waifu || saving || deleting}>
            <Trash2 className="icon" /> {deleting ? "Deleting…" : "Delete"}
          </button>
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose} disabled={saving || deleting}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={!waifu || saving || paramsBlocked}>
            <Save className="icon" />
            {saving ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {loadError && <Notice tone="err">{loadError}</Notice>}
      {!waifu && !loadError && <SkeletonRows rows={5} />}

      {conflict && (
        <Notice tone="warn" title="Stale revision">
          Stored revision is {conflict.revision} (you had {waifu?.revision}).{" "}
          <button
            className="btn sm"
            onClick={() => {
              setWaifu(conflict);
              setConflict(undefined);
              setError(undefined);
              setErrorViolations(undefined);
            }}
          >
            <ArrowLeft className="icon" /> Reload server copy
          </button>
        </Notice>
      )}

      {error && !conflict && (
        <Notice tone="err">
          <div>{error}</div>
          {errorViolations && errorViolations.length > 0 && (
            <ul className="model-params-warnings">
              {errorViolations.map((v, i) => (
                <li key={i}>
                  {v.param}: {v.code}
                  {v.rule ? ` (rule ${v.rule})` : ""}
                </li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {waifu && (
        <>
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label">Internal name</label>
              <input
                className="input"
                value={waifu.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">Display name</label>
              <input
                className="input"
                value={waifu.displayName}
                onChange={(e) => set({ displayName: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">Discord bot</label>
              <select
                className="select"
                value={waifu.botId ?? ""}
                onChange={(e) => set({ botId: e.target.value || undefined })}
              >
                <option value="">— Unlinked —</option>
                {(botFile?.waifus ?? []).map((b) => {
                  const ready = b.applicationId && b.tokenConfigured;
                  return (
                    <option key={b.id} value={b.id}>
                      {b.displayName} ({b.id}) {ready ? "" : "— needs setup"}
                    </option>
                  );
                })}
              </select>
              <span className="field-hint">
                Choose an existing bot record or save the Discord bot details below.
              </span>
            </div>
            <div className="field">
              <label className="field-label">Context window (messages)</label>
              <input
                className="input"
                type="number"
                min={1}
                max={100}
                value={waifu.contextWindow}
                onChange={(e) =>
                  set({ contextWindow: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })
                }
              />
              <span className="field-hint">Default 50. Range 1–100.</span>
            </div>
            <div className="field">
              <label className="field-label">Model</label>
              <select
                className="select"
                value={modelGroupValue}
                onChange={(e) => selectModelGroup(e.target.value)}
              >
                {modelGroupOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            {resolvedRoute && resolvedRoute.group.routes.length > 1 && (
              <div className="field">
                <label className="field-label">Route</label>
                <select
                  className="select"
                  value={resolvedRoute.route.providerId}
                  onChange={(e) => selectRoute(e.target.value)}
                >
                  {routeOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <ModelParamsForm
            providerId={waifu.providerId ?? null}
            modelId={waifu.modelId ?? null}
            value={waifu.params ?? {}}
            onChange={(params) => set({ params })}
            onValidity={setParamsValid}
          />

          <ScheduleEditor
            value={waifu.availability}
            onChange={(availability) => set({ availability })}
          />

          <PromptLayoutEditor
            layout={reconcileLayout(waifu.promptLayout)}
            tools={waifu.tools}
            onLayoutChange={(promptLayout) => set({ promptLayout })}
            onToolsChange={(tools) => set({ tools })}
            waifuName={waifu.displayName || waifu.name || waifu.id}
          />

          {botState.error && <Notice tone="err">{botState.error.message}</Notice>}
          {botMessage && <Notice tone="ok">{botMessage}</Notice>}

          <section className="section" style={{ marginTop: 16 }}>
            <div className="section-header">
              <h3 className="section-title">Discord bot token</h3>
              <span className="section-description">
                Create or update the waifu bot record, then link it to this waifu.
              </span>
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="field-label">Bot display name</label>
                <input
                  className="input"
                  value={botDisplayName}
                  onChange={(e) => setBotDisplayName(e.target.value)}
                  placeholder={waifu.displayName}
                />
              </div>
              <div className="field">
                <label className="field-label">Application ID</label>
                <input
                  className="input code"
                  value={botApplicationId}
                  onChange={(e) => setBotApplicationId(e.target.value)}
                  placeholder="17–20 digit Discord application id"
                />
              </div>
              <div className="field">
                <label className="field-label">Bot token</label>
                <input
                  className="input code"
                  type="password"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  placeholder={
                    linkedBot?.tokenConfigured
                      ? `Saved ${linkedBot.tokenHint ?? ""} — leave blank to keep`
                      : "Paste bot token"
                  }
                />
                <span className="field-hint">
                  Tokens are write-only and redacted after save.
                </span>
              </div>
              <div className="field">
                <label className="field-label">Linked bot status</label>
                <div className="row">
                  {linkedBot ? (
                    <Pill tone={linkedBot.tokenConfigured ? "ok" : "warn"} dot>
                      {linkedBot.tokenConfigured ? "token saved" : "missing token"}
                    </Pill>
                  ) : (
                    <Pill tone="warn" dot>not linked</Pill>
                  )}
                  <button
                    className="btn primary"
                    onClick={saveAndLinkBot}
                    disabled={saving || savingBot || !waifu || paramsBlocked}
                  >
                    <Save className="icon" />
                    {savingBot ? "Saving…" : "Save bot & link"}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <div className="field">
            <label className="field-label">Personality prompt</label>
            <textarea
              className="textarea"
              value={waifu.persona}
              onChange={(e) => set({ persona: e.target.value })}
              placeholder="Describe how the waifu speaks, what she cares about, conversational quirks, etc."
              rows={6}
            />
            <span className="field-hint">
              This becomes part of the waifu system prompt. Available server emojis and mention
              rules are appended automatically.
            </span>
          </div>

          <div className="field">
            <label className="field-label">Persona digest</label>
            <div className="field-hint" style={{ marginBottom: 4 }}>
              {waifu.personaDigest ? (
                <>
                  <div><strong>Voice:</strong> {waifu.personaDigest.voice}</div>
                  <div><strong>Drives:</strong> {waifu.personaDigest.role}</div>
                </>
              ) : (
                <span style={{ opacity: 0.6 }}>(not generated yet)</span>
              )}
            </div>
            {digestError && <Notice tone="err">{digestError}</Notice>}
            <button
              className="btn sm"
              type="button"
              onClick={regenerateDigest}
              disabled={digestBusy || saving}
            >
              {digestBusy ? "Generating…" : "Regenerate digest"}
            </button>
          </div>

          <div className="grid grid-2">
            <AssetUpload
              kind="pfp"
              waifuId={waifu.id}
              message={pfpUploadMsg}
              onMessage={setPfpUploadMsg}
            />
            <AssetUpload
              kind="banner"
              waifuId={waifu.id}
              message={pfpUploadMsg}
              onMessage={setPfpUploadMsg}
            />
          </div>

          <DiscordBotGuide
            kind="waifu"
            applicationId={linkedBot?.applicationId}
            botDisplayName={linkedBot?.displayName ?? waifu.displayName}
            collapsedByDefault
          />

          <PreviewPanel waifu={waifu} />

          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">Revision</span>
            <span className="v">
              {waifu.revision} · updated {timeAgo(waifu.updatedAt)}
            </span>
            <span className="k">Storage</span>
            <span className="v" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
              user/waifus/{waifu.id}/waifu.json
            </span>
          </div>
        </>
      )}
    </Modal>
  );
}

function ScheduleEditor({
  value,
  onChange
}: {
  value: WaifuAvailability;
  onChange: (next: WaifuAvailability) => void;
}) {
  const overlapping = busyOverlapIndexes(value.busy);
  const setSleep = (patch: Partial<WaifuAvailability["sleep"]>) => {
    onChange({ ...value, sleep: { ...value.sleep, ...patch } });
  };
  const setBusy = (index: number, patch: Partial<WaifuBusyInterval>) => {
    onChange({
      ...value,
      busy: value.busy.map((interval, i) => (i === index ? { ...interval, ...patch } : interval))
    });
  };
  const addBusy = () => {
    onChange({
      ...value,
      busy: [...value.busy, { start: "09:00", end: "10:00", reason: "busy" }]
    });
  };
  const removeBusy = (index: number) => {
    onChange({ ...value, busy: value.busy.filter((_interval, i) => i !== index) });
  };

  return (
    <section className="section" style={{ marginTop: 16 }}>
      <div className="section-header">
        <h3 className="section-title">
          <Clock className="icon" style={{ verticalAlign: "-2px" }} /> Availability
        </h3>
        <span className="section-description">Daily local-time context for orchestrator decisions.</span>
      </div>
      <div className="grid grid-3">
        <div className="field">
          <label className="field-label">Sleep window</label>
          <Toggle
            checked={value.sleep.enabled}
            onChange={(enabled) => setSleep({ enabled })}
            label={value.sleep.enabled ? "Enabled" : "Disabled"}
          />
          <span className="field-hint">Soft context only; this never blocks replies.</span>
        </div>
        <div className="field">
          <label className="field-label">Sleep start</label>
          <input
            className="input"
            type="time"
            value={value.sleep.start}
            disabled={!value.sleep.enabled}
            onChange={(e) => setSleep({ start: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="field-label">Sleep end</label>
          <input
            className="input"
            type="time"
            value={value.sleep.end}
            disabled={!value.sleep.enabled}
            onChange={(e) => setSleep({ end: e.target.value })}
          />
        </div>
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <label className="field-label">Busy intervals</label>
          <button className="btn sm" type="button" onClick={addBusy}>
            <Plus className="icon" /> Add busy time
          </button>
        </div>
        {value.busy.length === 0 && (
          <span className="field-hint">No busy intervals configured.</span>
        )}
        {value.busy.map((interval, index) => (
          <div className="grid grid-4" key={index} style={{ alignItems: "end" }}>
            <div className="field">
              <label className="field-label">Start</label>
              <input
                className="input"
                type="time"
                value={interval.start}
                onChange={(e) => setBusy(index, { start: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">End</label>
              <input
                className="input"
                type="time"
                value={interval.end}
                onChange={(e) => setBusy(index, { end: e.target.value })}
              />
            </div>
            <div className="field">
              <label className="field-label">Reason</label>
              <input
                className="input"
                value={interval.reason}
                onChange={(e) => setBusy(index, { reason: e.target.value })}
                placeholder="class, work, commute..."
              />
              {overlapping.has(index) && (
                <span className="field-hint" style={{ color: "var(--warn)" }}>
                  Busy intervals cannot overlap.
                </span>
              )}
            </div>
            <div className="field">
              <label className="field-label">Remove</label>
              <button
                className="btn danger"
                type="button"
                onClick={() => removeBusy(index)}
                aria-label="Remove busy interval"
                title="Remove busy interval"
              >
                <Trash2 className="icon" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function defaultAvailability(): WaifuAvailability {
  return {
    sleep: {
      enabled: false,
      start: "23:00",
      end: "07:00"
    },
    busy: []
  };
}

function defaultToolSettings(): WaifuToolSettings {
  return {
    toolUse: true
  };
}

function busyOverlapIndexes(intervals: WaifuBusyInterval[]): Set<number> {
  const indexes = new Set<number>();
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      if (dailyIntervalsOverlap(intervals[i], intervals[j])) {
        indexes.add(i);
        indexes.add(j);
      }
    }
  }
  return indexes;
}

function dailyIntervalsOverlap(a: WaifuBusyInterval, b: WaifuBusyInterval): boolean {
  return dailyIntervalRanges(a).some(([aStart, aEnd]) =>
    dailyIntervalRanges(b).some(([bStart, bEnd]) => Math.max(aStart, bStart) < Math.min(aEnd, bEnd))
  );
}

function dailyIntervalRanges(interval: { start: string; end: string }): Array<[number, number]> {
  const start = timeInputMinutes(interval.start);
  const end = timeInputMinutes(interval.end);
  if (start === end) return [];
  if (start < end) return [[start, end]];
  return [[start, 24 * 60], [0, end]];
}

function timeInputMinutes(value: string): number {
  const [hours = "0", minutes = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function AssetUpload({
  kind,
  waifuId,
  message,
  onMessage
}: {
  kind: "pfp" | "banner";
  waifuId: string;
  message?: string;
  onMessage: (m: string | undefined) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async (_file: File) => {
    setBusy(true);
    try {
      const url = `/api/waifus/${encodeURIComponent(waifuId)}/assets/${kind}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": _file.type || "application/octet-stream" },
        body: _file
      });
      const text = await res.text();
      onMessage(`${kind}: HTTP ${res.status} ${text.slice(0, 160)}`);
    } catch (err) {
      onMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <label className="field-label">{kind === "pfp" ? "Profile picture" : "Banner"}</label>
      <div className="row">
        <input
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void submit(file);
          }}
          style={{ flex: 1 }}
        />
        <ImageIcon className="icon" style={{ color: "var(--text-muted)" }} />
      </div>
      {message && message.startsWith(`${kind}:`) && (
        <span className="field-hint" style={{ color: "var(--warn)" }}>
          {message}
        </span>
      )}
      <span className="field-hint">
        Uploads are stored under the waifu folder in the local data root.
      </span>
    </div>
  );
}

function PreviewPanel({ waifu }: { waifu: WaifuConfig }) {
  // Mock conversation preview; clearly labeled as preview-only.
  const lines: Array<{ author: string; content: string; system?: boolean }> = [
    {
      author: "system",
      content: `You are ${waifu.displayName}. ${waifu.persona ? waifu.persona.slice(0, 140) + (waifu.persona.length > 140 ? "…" : "") : "(no persona set)"}`,
      system: true
    },
    {
      author: "<@Kevin>",
      content: "hey, are you around?"
    },
    {
      author: waifu.displayName,
      content: waifu.persona
        ? `mhm, just thinking — what's up <@Kevin>?`
        : "yeah, what's up?"
    }
  ];
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <div className="panel-header">
        <div>
          <h4 className="panel-title">
            <MessageSquare className="icon" style={{ verticalAlign: "-2px" }} /> Preview
          </h4>
          <div className="panel-subtitle">Mock conversation. Not a live generation.</div>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 12 }}>
            <span
              style={{
                color: line.system ? "var(--text-muted)" : "var(--text-secondary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-xs)"
              }}
            >
              {line.system ? "system" : line.author}
            </span>
            <span style={{ color: line.system ? "var(--text-muted)" : "var(--text-primary)" }}>
              {line.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
