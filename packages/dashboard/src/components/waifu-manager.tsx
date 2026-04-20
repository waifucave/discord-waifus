"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ImagePlus, Plus, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type {
  InvalidWaifuRow,
  ProviderConfig,
  StageManagerGuildEditorState,
  WaifuDocument,
  WaifuEditorPayload,
  WaifuEditorWritePayload
} from "@/lib/types";
import { Panel, Button, Input, Label, Textarea, Select, Badge } from "./ui";
import { useToast } from "./toast-provider";

const emptyDraft: WaifuEditorPayload = {
  waifu: {
    id: "",
    name: "",
    displayName: "",
    botToken: "",
    applicationId: "",
    enabled: false,
    avatarPath: null,
    bannerPath: null,
    statusText: null,
    statusType: "online",
    personality: {
      description: "",
      traits: [],
      speechPatterns: [],
      likes: [],
      dislikes: [],
      backstory: "",
      quirks: [],
      relationshipsWithOtherWaifus: {}
    },
    schedule: {
      sleepTime: { start: "01:00", end: "09:00" },
      busyTime: { start: "09:00", end: "17:00", reason: "Busy" }
    },
    ai: {
      providerId: "",
      model: "",
      temperature: 0.8,
      repetitionPenalty: 1,
      maxTokens: 300,
      systemPromptOverride: null
    }
  },
  stageManager: {
    guilds: []
  },
  meta: {
    isDraft: true,
    isDiscordReady: false,
    isAiReady: false,
    isChatReady: false,
    isRuntimeReady: false,
    runtimeValidationErrors: [],
    migrationWarnings: []
  }
};

export function WaifuManager(): JSX.Element {
  const [waifus, setWaifus] = useState<WaifuEditorPayload[]>([]);
  const [invalidWaifus, setInvalidWaifus] = useState<InvalidWaifuRow[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState<WaifuEditorPayload>(clonePayload(emptyDraft));
  const [loading, setLoading] = useState(true);
  const [loadingTemplate, setLoadingTemplate] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const found = waifus.find((waifu) => waifu.waifu.id === selectedId);
    if (found) {
      setDraft(clonePayload(found));
      setIsCreating(false);
    } else if (!isCreating && waifus[0]) {
      setSelectedId(waifus[0].waifu.id);
      setDraft(clonePayload(waifus[0]));
    }
  }, [isCreating, selectedId, waifus]);

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === draft.waifu.ai.providerId),
    [draft.waifu.ai.providerId, providers]
  );

  const load = async (preferredWaifuId?: string) => {
    setLoading(true);
    try {
      const [waifuResponse, providerResponse] = await Promise.all([
        api.getWaifus(),
        api.getProviders()
      ]);
      setWaifus(waifuResponse.waifus);
      setInvalidWaifus(waifuResponse.invalidWaifus);
      setProviders(providerResponse.providers);
      const preferredWaifu = preferredWaifuId
        ? waifuResponse.waifus.find((waifu) => waifu.waifu.id === preferredWaifuId)
        : undefined;
      if (preferredWaifu) {
        setSelectedId(preferredWaifu.waifu.id);
        setDraft(clonePayload(preferredWaifu));
        setIsCreating(false);
      } else if (!isCreating && waifuResponse.waifus[0]) {
        setSelectedId(waifuResponse.waifus[0].waifu.id);
        setDraft(clonePayload(waifuResponse.waifus[0]));
      }
    } finally {
      setLoading(false);
    }
  };

  const createDraft = async () => {
    setLoadingTemplate(true);
    try {
      const template = await api.getWaifuTemplate();
      setSelectedId("");
      setDraft(clonePayload(template));
      setIsCreating(true);
    } finally {
      setLoadingTemplate(false);
    }
  };

  const save = async () => {
    if (!draft.waifu.id) {
      toast("Choose a waifu ID before saving.");
      return;
    }

    const payload: WaifuEditorWritePayload = {
      waifu: draft.waifu,
      stageManager: draft.stageManager
    };

    if (isCreating) {
      await api.createWaifu(payload);
      toast("Waifu created.");
    } else {
      await api.updateWaifu(draft.waifu.id, payload);
      toast("Waifu saved.");
    }
    await load(draft.waifu.id);
  };

  const remove = async () => {
    if (!selectedId) {
      return;
    }

    if (!window.confirm("Delete this waifu?")) {
      return;
    }

    await api.deleteWaifu(selectedId);
    toast("Waifu deleted.");
    setSelectedId("");
    setIsCreating(false);
    setDraft(clonePayload(emptyDraft));
    await load();
  };

  const updateWaifu = (patch: Partial<WaifuDocument>) => {
    setDraft((current) => ({
      ...current,
      waifu: {
        ...current.waifu,
        ...patch
      }
    }));
  };

  const updateStageGuild = (
    guildId: string,
    updater: (guild: StageManagerGuildEditorState) => StageManagerGuildEditorState
  ) => {
    setDraft((current) => ({
      ...current,
      stageManager: {
        guilds: current.stageManager.guilds.map((guild) =>
          guild.guildId === guildId ? updater(guild) : guild
        )
      }
    }));
  };

  if (loading && waifus.length === 0) {
    return <Panel className="h-[480px] animate-pulse" />;
  }

  return (
    <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Panel className="flex min-h-0 flex-col p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Roster</p>
            <h3 className="mt-2 font-display text-2xl">Waifu Cast</h3>
          </div>
          <Button tone="ghost" onClick={() => void createDraft()} disabled={loadingTemplate}>
            <Plus className="mr-2 h-4 w-4" />
            Add
          </Button>
        </div>

        <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {waifus.map((waifu) => (
            <button
              key={waifu.waifu.id}
              className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                selectedId === waifu.waifu.id
                  ? "border-accent/70 bg-accent/10"
                  : "border-white/10 bg-white/5 hover:bg-white/10"
              }`}
              onClick={() => {
                setSelectedId(waifu.waifu.id);
                setDraft(clonePayload(waifu));
                setIsCreating(false);
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{waifu.waifu.displayName || waifu.waifu.name}</p>
                  <p className="text-sm text-slate-400">
                    {waifu.waifu.personality.description || "No description yet"}
                  </p>
                </div>
                <Badge
                  className={
                    waifu.meta.isChatReady
                      ? "border-emerald-400/30 text-emerald-200"
                      : waifu.meta.isDiscordReady
                        ? "border-sky-400/30 text-sky-200"
                        : "border-amber-400/30 text-amber-200"
                  }
                >
                  {waifu.meta.isChatReady
                    ? "Chat Ready"
                    : waifu.meta.isDiscordReady
                      ? "Discord Only"
                      : "Draft"}
                </Badge>
              </div>
            </button>
          ))}
          {waifus.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-400">
              No waifus saved yet.
            </div>
          ) : null}
        </div>

        {invalidWaifus.length > 0 ? (
          <div className="mt-6 rounded-3xl border border-amber-400/20 bg-amber-400/5 p-4">
            <div className="flex items-center gap-2 text-amber-100">
              <AlertTriangle className="h-4 w-4" />
              <p className="text-sm font-medium">Malformed waifu files</p>
            </div>
            <div className="mt-3 space-y-2">
              {invalidWaifus.map((entry) => (
                <div key={`${entry.filePath}-${entry.idHint ?? "unknown"}`} className="text-sm text-amber-100/90">
                  <p>{entry.idHint ?? "Unknown ID"}</p>
                  <p className="text-xs text-amber-100/70">{entry.error}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>

      <Panel className="flex min-h-0 flex-col p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Editor</p>
            <h3 className="mt-2 font-display text-2xl">
              {selectedId ? draft.waifu.displayName || draft.waifu.name || "Waifu" : "New Waifu"}
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge>{draft.meta.isDraft ? "Draft" : "Configured"}</Badge>
              <Badge className={draft.meta.isDiscordReady ? "border-sky-400/30 text-sky-200" : undefined}>
                {draft.meta.isDiscordReady ? "Discord Ready" : "Discord Incomplete"}
              </Badge>
              <Badge className={draft.meta.isChatReady ? "border-emerald-400/30 text-emerald-200" : undefined}>
                {draft.meta.isChatReady ? "Chat Ready" : "Chat Incomplete"}
              </Badge>
            </div>
          </div>
          <div className="flex gap-3">
            <Button tone="ghost" onClick={() => void remove()} disabled={!selectedId}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button onClick={() => void save()}>
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          {draft.meta.runtimeValidationErrors.map((error) => (
            <Badge key={error} className="border-amber-400/30 text-amber-200">
              {error}
            </Badge>
          ))}
          {draft.meta.migrationWarnings.map((warning) => (
            <Badge key={`${warning.field}-${warning.message}`} className="border-amber-400/30 text-amber-200">
              {warning.field}: {warning.message}
            </Badge>
          ))}
        </div>

        <div className="mt-8 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-6 lg:grid-cols-2">
            <Field label="Waifu Enabled">
              <Button
                tone={draft.waifu.enabled ? "primary" : "ghost"}
                onClick={() => updateWaifu({ enabled: !draft.waifu.enabled })}
                className="w-full justify-start"
              >
                {draft.waifu.enabled ? (
                  <Check className="mr-2 h-4 w-4" />
                ) : (
                  <X className="mr-2 h-4 w-4" />
                )}
                {draft.waifu.enabled ? "Enabled" : "Disabled"}
              </Button>
            </Field>
            <Field label="Status Type">
              <Select
                value={draft.waifu.statusType}
                onChange={(event) =>
                  updateWaifu({
                    statusType: event.target.value as WaifuDocument["statusType"]
                  })
                }
              >
                <option value="online">online</option>
                <option value="idle">idle</option>
                <option value="dnd">dnd</option>
                <option value="invisible">invisible</option>
              </Select>
            </Field>
            <Field label="ID">
              <Input
                value={draft.waifu.id}
                onChange={(event) => updateWaifu({ id: event.target.value })}
                disabled={!isCreating}
              />
            </Field>
            <Field label="Name">
              <Input
                value={draft.waifu.name}
                onChange={(event) => updateWaifu({ name: event.target.value })}
              />
            </Field>
            <Field label="Guild Nickname">
              <div className="space-y-2">
                <Input
                  value={draft.waifu.displayName}
                  onChange={(event) => updateWaifu({ displayName: event.target.value })}
                />
                <p className="text-sm text-slate-400">
                  Discord guild nickname only. AI prompts always use the canonical Name, and DMs
                  still use the bot username rather than this nickname.
                </p>
              </div>
            </Field>
            <Field label="Status Text">
              <Input
                value={draft.waifu.statusText ?? ""}
                onChange={(event) => updateWaifu({ statusText: event.target.value || null })}
              />
            </Field>
            <Field label="Bot Token">
              <Input
                type="password"
                value={draft.waifu.botToken}
                onChange={(event) => updateWaifu({ botToken: event.target.value })}
              />
            </Field>
            <Field label="Application ID">
              <Input
                value={draft.waifu.applicationId}
                onChange={(event) => updateWaifu({ applicationId: event.target.value })}
              />
            </Field>
            <Field className="lg:col-span-2" label="Avatar / Banner">
              <div className="grid gap-4 md:grid-cols-2">
                <UploadCard
                  title="Avatar"
                  preview={draft.waifu.avatarPath}
                  disabled={isCreating || !draft.waifu.id}
                  onUpload={async (file) => {
                    await api.uploadWaifuAsset(draft.waifu.id, "avatar", file);
                    toast("Avatar uploaded.");
                    await load(draft.waifu.id);
                  }}
                />
                <UploadCard
                  title="Banner"
                  preview={draft.waifu.bannerPath}
                  disabled={isCreating || !draft.waifu.id}
                  onUpload={async (file) => {
                    await api.uploadWaifuAsset(draft.waifu.id, "banner", file);
                    toast("Banner uploaded.");
                    await load(draft.waifu.id);
                  }}
                />
              </div>
            </Field>
            <Field className="lg:col-span-2" label="Description">
              <Textarea
                value={draft.waifu.personality.description}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      description: event.target.value
                    }
                  })
                }
              />
            </Field>
            <Field label="Traits">
              <Input
                value={draft.waifu.personality.traits.join(", ")}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      traits: parseList(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field label="Speech Patterns">
              <Input
                value={draft.waifu.personality.speechPatterns.join(", ")}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      speechPatterns: parseList(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field label="Likes">
              <Input
                value={draft.waifu.personality.likes.join(", ")}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      likes: parseList(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field label="Dislikes">
              <Input
                value={draft.waifu.personality.dislikes.join(", ")}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      dislikes: parseList(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field className="lg:col-span-2" label="Backstory">
              <Textarea
                value={draft.waifu.personality.backstory}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      backstory: event.target.value
                    }
                  })
                }
              />
            </Field>
            <Field label="Quirks">
              <Input
                value={draft.waifu.personality.quirks.join(", ")}
                onChange={(event) =>
                  updateWaifu({
                    personality: {
                      ...draft.waifu.personality,
                      quirks: parseList(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field label="Provider">
              <Select
                value={draft.waifu.ai.providerId}
                onChange={(event) =>
                  updateWaifu({
                    ai: {
                      ...draft.waifu.ai,
                      providerId: event.target.value,
                      model:
                        providers.find((provider) => provider.id === event.target.value)?.models[0] ?? ""
                    }
                  })
                }
              >
                <option value="">Select provider</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Model">
              <Select
                value={draft.waifu.ai.model}
                onChange={(event) =>
                  updateWaifu({
                    ai: {
                      ...draft.waifu.ai,
                      model: event.target.value
                    }
                  })
                }
              >
                <option value="">Select model</option>
                {(selectedProvider?.models ?? []).map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Temperature (${draft.waifu.ai.temperature.toFixed(2)})`}>
              <Input
                type="range"
                min="0"
                max="2"
                step="0.05"
                value={draft.waifu.ai.temperature}
                onChange={(event) =>
                  updateWaifu({
                    ai: {
                      ...draft.waifu.ai,
                      temperature: Number(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field label={`Repetition Penalty (${draft.waifu.ai.repetitionPenalty.toFixed(2)})`}>
              <div className="space-y-2">
                <Input
                  type="range"
                  min="0"
                  max="2"
                  step="0.05"
                  value={draft.waifu.ai.repetitionPenalty}
                  onChange={(event) =>
                    updateWaifu({
                      ai: {
                        ...draft.waifu.ai,
                        repetitionPenalty: Number(event.target.value)
                      }
                    })
                  }
                />
                <p className="text-sm text-slate-400">
                  Sent as provider-native repetition control when supported; ignored otherwise.
                </p>
              </div>
            </Field>
            <Field label={`Max Tokens (${draft.waifu.ai.maxTokens})`}>
              <Input
                type="range"
                min="50"
                max="800"
                step="10"
                value={draft.waifu.ai.maxTokens}
                onChange={(event) =>
                  updateWaifu({
                    ai: {
                      ...draft.waifu.ai,
                      maxTokens: Number(event.target.value)
                    }
                  })
                }
              />
            </Field>
            <Field className="lg:col-span-2" label="System Prompt Override">
              <Textarea
                value={draft.waifu.ai.systemPromptOverride ?? ""}
                onChange={(event) =>
                  updateWaifu({
                    ai: {
                      ...draft.waifu.ai,
                      systemPromptOverride: event.target.value || null
                    }
                  })
                }
              />
            </Field>
            <Field label="Sleep Window">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  type="time"
                  value={draft.waifu.schedule.sleepTime.start}
                  onChange={(event) =>
                    updateWaifu({
                      schedule: {
                        ...draft.waifu.schedule,
                        sleepTime: {
                          ...draft.waifu.schedule.sleepTime,
                          start: event.target.value
                        }
                      }
                    })
                  }
                />
                <Input
                  type="time"
                  value={draft.waifu.schedule.sleepTime.end}
                  onChange={(event) =>
                    updateWaifu({
                      schedule: {
                        ...draft.waifu.schedule,
                        sleepTime: {
                          ...draft.waifu.schedule.sleepTime,
                          end: event.target.value
                        }
                      }
                    })
                  }
                />
              </div>
            </Field>
            <Field label="Busy Window">
              <div className="grid grid-cols-2 gap-3">
                <Input
                  type="time"
                  value={draft.waifu.schedule.busyTime.start}
                  onChange={(event) =>
                    updateWaifu({
                      schedule: {
                        ...draft.waifu.schedule,
                        busyTime: {
                          ...draft.waifu.schedule.busyTime,
                          start: event.target.value
                        }
                      }
                    })
                  }
                />
                <Input
                  type="time"
                  value={draft.waifu.schedule.busyTime.end}
                  onChange={(event) =>
                    updateWaifu({
                      schedule: {
                        ...draft.waifu.schedule,
                        busyTime: {
                          ...draft.waifu.schedule.busyTime,
                          end: event.target.value
                        }
                      }
                    })
                  }
                />
              </div>
            </Field>
            <Field className="lg:col-span-2" label="Busy Reason">
              <Input
                value={draft.waifu.schedule.busyTime.reason}
                onChange={(event) =>
                  updateWaifu({
                    schedule: {
                      ...draft.waifu.schedule,
                      busyTime: {
                        ...draft.waifu.schedule.busyTime,
                        reason: event.target.value
                      }
                    }
                  })
                }
              />
            </Field>
            <Field className="lg:col-span-2" label="Manual Relationships">
              <div className="space-y-3">
                {waifus
                  .filter((waifu) => waifu.waifu.id !== draft.waifu.id)
                  .map((waifu) => (
                    <div
                      key={waifu.waifu.id}
                      className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)]"
                    >
                      <Input value={waifu.waifu.name} disabled />
                      <Input
                        placeholder="Describe the relationship"
                        value={draft.waifu.personality.relationshipsWithOtherWaifus[waifu.waifu.id] ?? ""}
                        onChange={(event) =>
                          updateWaifu({
                            personality: {
                              ...draft.waifu.personality,
                              relationshipsWithOtherWaifus: {
                                ...draft.waifu.personality.relationshipsWithOtherWaifus,
                                [waifu.waifu.id]: event.target.value
                              }
                            }
                          })
                        }
                      />
                    </div>
                  ))}
                {waifus.filter((waifu) => waifu.waifu.id !== draft.waifu.id).length === 0 ? (
                  <p className="text-sm text-slate-400">No other waifus yet.</p>
                ) : null}
              </div>
            </Field>
            <Field className="lg:col-span-2" label="Stage Manager Relationships">
              <div className="space-y-4">
                {draft.stageManager.guilds.map((guild) => (
                  <div key={guild.guildId} className="rounded-3xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">Guild {guild.guildId}</p>
                      <Badge>{guild.relationships.length} rows</Badge>
                    </div>
                    <div className="mt-4 space-y-3">
                      {guild.relationships.map((relationship) => (
                        <div
                          key={`${guild.guildId}-${relationship.participantKey}`}
                          className="rounded-2xl border border-white/10 px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">{relationship.targetName}</p>
                              <p className="text-xs text-slate-400">{relationship.participantKey}</p>
                            </div>
                            <Button
                              tone="ghost"
                              onClick={() =>
                                updateStageGuild(guild.guildId, (currentGuild) => ({
                                  ...currentGuild,
                                  relationships: currentGuild.relationships.filter(
                                    (entry) => entry.participantKey !== relationship.participantKey
                                  )
                                }))
                              }
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <Textarea
                            className="mt-3"
                            value={relationship.relationship}
                            onChange={(event) =>
                              updateStageGuild(guild.guildId, (currentGuild) => ({
                                ...currentGuild,
                                relationships: currentGuild.relationships.map((entry) =>
                                  entry.participantKey === relationship.participantKey
                                    ? { ...entry, relationship: event.target.value }
                                    : entry
                                )
                              }))
                            }
                          />
                          <p className="mt-2 text-xs text-slate-400">
                            {relationship.targetKind}
                            {relationship.targetUserId ? ` · user ${relationship.targetUserId}` : ""}
                            {relationship.targetWaifuId ? ` · waifu ${relationship.targetWaifuId}` : ""}
                            {` · updated ${relationship.updatedAt}`}
                          </p>
                        </div>
                      ))}
                      {guild.relationships.length === 0 ? (
                        <p className="text-sm text-slate-400">No stage-manager relationships for this guild.</p>
                      ) : null}
                    </div>
                  </div>
                ))}
                {draft.stageManager.guilds.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No stage-manager-authored relationship data yet.
                  </p>
                ) : null}
              </div>
            </Field>
            <Field className="lg:col-span-2" label="Stage Manager Memories">
              <div className="space-y-4">
                {draft.stageManager.guilds.map((guild) => (
                  <div key={`${guild.guildId}-memories`} className="rounded-3xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-medium">Guild {guild.guildId}</p>
                      <Button
                        tone="ghost"
                        onClick={() =>
                          updateStageGuild(guild.guildId, (currentGuild) => ({
                            ...currentGuild,
                            memories: [
                              ...currentGuild.memories,
                              {
                                slot: nextMemorySlot(currentGuild.memories),
                                note: "",
                                sourceMessageIds: [],
                                updatedAt: new Date().toISOString()
                              }
                            ].sort((left, right) => left.slot - right.slot)
                          }))
                        }
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add Memory
                      </Button>
                    </div>
                    <div className="mt-4 space-y-3">
                      {guild.memories.map((memory) => (
                        <div
                          key={`${guild.guildId}-slot-${memory.slot}`}
                          className="rounded-2xl border border-white/10 px-4 py-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium">Slot {memory.slot}</p>
                              <p className="text-xs text-slate-400">
                                {memory.sourceMessageIds.length > 0
                                  ? `Sources: ${memory.sourceMessageIds.join(", ")}`
                                  : "No source message ids"}
                              </p>
                            </div>
                            <Button
                              tone="ghost"
                              onClick={() =>
                                updateStageGuild(guild.guildId, (currentGuild) => ({
                                  ...currentGuild,
                                  memories: currentGuild.memories.filter((entry) => entry.slot !== memory.slot)
                                }))
                              }
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                          <Textarea
                            className="mt-3"
                            value={memory.note}
                            onChange={(event) =>
                              updateStageGuild(guild.guildId, (currentGuild) => ({
                                ...currentGuild,
                                memories: currentGuild.memories.map((entry) =>
                                  entry.slot === memory.slot
                                    ? { ...entry, note: event.target.value }
                                    : entry
                                )
                              }))
                            }
                          />
                          <p className="mt-2 text-xs text-slate-400">Updated {memory.updatedAt}</p>
                        </div>
                      ))}
                      {guild.memories.length === 0 ? (
                        <p className="text-sm text-slate-400">No stage-manager memories for this guild.</p>
                      ) : null}
                    </div>
                  </div>
                ))}
                {draft.stageManager.guilds.length === 0 ? (
                  <p className="text-sm text-slate-400">No stage-manager-authored memory data yet.</p>
                ) : null}
              </div>
            </Field>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function Field({
  label,
  children,
  className
}: {
  label: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function parseList(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function clonePayload(payload: WaifuEditorPayload): WaifuEditorPayload {
  return JSON.parse(JSON.stringify(payload)) as WaifuEditorPayload;
}

function nextMemorySlot(memories: StageManagerGuildEditorState["memories"]): number {
  const occupied = new Set(memories.map((memory) => memory.slot));
  let slot = 1;
  while (occupied.has(slot)) {
    slot += 1;
  }
  return slot;
}

function toAssetPreviewUrl(assetPath: string | null): string | null {
  if (!assetPath) {
    return null;
  }

  if (assetPath.startsWith("http://") || assetPath.startsWith("https://") || assetPath.startsWith("/")) {
    return assetPath;
  }

  return `/local-assets/${assetPath}`;
}

function UploadCard({
  title,
  preview,
  onUpload,
  disabled
}: {
  title: string;
  preview: string | null;
  onUpload: (file: File) => Promise<void>;
  disabled: boolean;
}): JSX.Element {
  const normalizedPreview = toAssetPreviewUrl(preview);

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center justify-between">
        <p className="font-medium">{title}</p>
        <label
          className={`inline-flex items-center rounded-full border border-white/10 px-3 py-2 text-sm ${
            disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
          }`}
        >
          <ImagePlus className="mr-2 h-4 w-4" />
          Upload
          <input
            type="file"
            className="hidden"
            accept="image/*"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onUpload(file);
              }
            }}
          />
        </label>
      </div>
      {disabled ? (
        <p className="mt-3 text-sm text-slate-400">Save the waifu once before uploading assets.</p>
      ) : null}
      <div className="mt-4 overflow-hidden rounded-2xl border border-white/10 bg-black/20">
        {normalizedPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={title} src={normalizedPreview} className="h-40 w-full object-cover" />
        ) : (
          <div className="flex h-40 items-center justify-center text-sm text-slate-400">
            No image uploaded
          </div>
        )}
      </div>
    </div>
  );
}
