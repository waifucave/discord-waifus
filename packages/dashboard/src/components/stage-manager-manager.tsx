"use client";

import { useEffect, useMemo, useState } from "react";
import { Play, Save } from "lucide-react";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import type {
  OrchestratorConfig,
  ProviderConfig,
  StageManagerConfig,
  StageManagerDiagnosticsRuntime,
  StageManagerDiagnosticsState,
  StageManagerRunSummary
} from "@/lib/types";
import { Badge, Button, Input, Label, Panel, Select } from "./ui";
import { useToast } from "./toast-provider";

export function StageManagerManager(): JSX.Element {
  const [config, setConfig] = useState<StageManagerConfig | null>(null);
  const [orchestrator, setOrchestrator] = useState<OrchestratorConfig | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [state, setState] = useState<StageManagerDiagnosticsState | null>(null);
  const [runtime, setRuntime] = useState<StageManagerDiagnosticsRuntime | null>(null);
  const [selectedGuildId, setSelectedGuildId] = useState("");
  const [lastRun, setLastRun] = useState<StageManagerRunSummary | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    const [nextConfig, nextState, nextProviders, nextOrchestrator] = await Promise.all([
      api.getStageManager(),
      api.getStageManagerState(),
      api.getProviders(),
      api.getOrchestrator()
    ]);
    setConfig(nextConfig.stageManager);
    setState(nextState.state);
    setRuntime(nextState.runtime);
    setProviders(nextProviders.providers);
    setOrchestrator(nextOrchestrator.orchestrator);
    setSelectedGuildId((current) => current || nextState.state.guilds[0]?.guildId || "");
  };

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === config?.providerId),
    [providers, config]
  );
  const selectedGuild = useMemo(
    () => state?.guilds.find((guild) => guild.guildId === selectedGuildId) ?? null,
    [selectedGuildId, state]
  );
  const effectiveProviderId = config?.providerId ?? orchestrator?.providerId ?? "";
  const effectiveModel = config?.model ?? orchestrator?.model ?? "";

  if (!config || !state || !runtime || !orchestrator) {
    return <Panel className="h-[520px] animate-pulse" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <Panel className="p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Memory Curator</p>
            <h3 className="mt-2 font-display text-2xl">Stage Manager Settings</h3>
            <p className="mt-2 text-sm text-slate-400">
              Quiet-period memory review with its own model and guild-scoped authored state.
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              tone="ghost"
              disabled={running || !selectedGuildId}
              onClick={async () => {
                setRunning(true);
                try {
                  const response = await api.runStageManager(selectedGuildId);
                  setLastRun(response.result);
                  toast("Stage manager run completed.");
                  await refresh();
                } finally {
                  setRunning(false);
                }
              }}
            >
              <Play className="mr-2 h-4 w-4" />
              Run Guild
            </Button>
            <Button
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await api.updateStageManager(config);
                  toast("Stage manager settings saved.");
                  await refresh();
                } finally {
                  setSaving(false);
                }
              }}
            >
              <Save className="mr-2 h-4 w-4" />
              Save Stage Manager
            </Button>
          </div>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <Field label="Enabled">
            <Select
              value={config.enabled ? "true" : "false"}
              onChange={(event) =>
                setConfig({
                  ...config,
                  enabled: event.target.value === "true"
                })
              }
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </Select>
          </Field>

          <Field label="Manual Run Guild">
            <Select value={selectedGuildId} onChange={(event) => setSelectedGuildId(event.target.value)}>
              {state.guilds.map((guild) => (
                <option key={guild.guildId} value={guild.guildId}>
                  {guild.guildId}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Provider">
            <Select
              value={config.providerId ?? ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  providerId: event.target.value || null,
                  model:
                    event.target.value === ""
                      ? null
                      : providers.find((provider) => provider.id === event.target.value)?.models[0] ?? null
                })
              }
            >
              <option value="">Fallback to orchestrator</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Model">
            <Select
              value={config.model ?? ""}
              onChange={(event) =>
                setConfig({
                  ...config,
                  model: event.target.value || null
                })
              }
            >
              <option value="">Fallback to orchestrator</option>
              {(selectedProvider?.models ?? []).map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={`Temperature (${config.temperature.toFixed(2)})`}>
            <Input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={config.temperature}
              onChange={(event) =>
                setConfig({
                  ...config,
                  temperature: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`Max Tokens (${config.maxTokens})`}>
            <Input
              type="range"
              min="100"
              max="1600"
              step="10"
              value={config.maxTokens}
              onChange={(event) =>
                setConfig({
                  ...config,
                  maxTokens: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`Quiet Period (${config.quietPeriodSeconds}s)`}>
            <Input
              type="range"
              min="10"
              max="900"
              step="10"
              value={config.quietPeriodSeconds}
              onChange={(event) =>
                setConfig({
                  ...config,
                  quietPeriodSeconds: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`History Limit (${config.historyLimit})`}>
            <Input
              type="range"
              min="10"
              max="100"
              step="5"
              value={config.historyLimit}
              onChange={(event) =>
                setConfig({
                  ...config,
                  historyLimit: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`Max Relationships (${config.maxRelationshipsPerWaifu})`}>
            <Input
              type="range"
              min="1"
              max="50"
              step="1"
              value={config.maxRelationshipsPerWaifu}
              onChange={(event) =>
                setConfig({
                  ...config,
                  maxRelationshipsPerWaifu: Number(event.target.value)
                })
              }
            />
          </Field>

          <Field label={`Max Memories (${config.maxMemoriesPerWaifu})`}>
            <Input
              type="range"
              min="1"
              max="20"
              step="1"
              value={config.maxMemoriesPerWaifu}
              onChange={(event) =>
                setConfig({
                  ...config,
                  maxMemoriesPerWaifu: Number(event.target.value)
                })
              }
            />
          </Field>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Badge>Effective provider: {effectiveProviderId || "orchestrator fallback"}</Badge>
          <Badge>Effective model: {effectiveModel || "orchestrator fallback"}</Badge>
          <Badge className={!config.enabled ? "border-amber-400/30 text-amber-200" : undefined}>
            {config.enabled ? "Guild-scoped state active" : "Disabled"}
          </Badge>
        </div>
      </Panel>

      <div className="grid min-h-0 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Panel className="flex min-h-0 flex-col p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Guild Runtime</p>
          <h3 className="mt-2 font-display text-2xl">Queues And Checkpoints</h3>

          <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-slate-400">Scheduled guild runs</p>
              <div className="mt-3 space-y-2">
                {runtime.scheduledGuilds.length === 0 ? (
                  <p className="text-sm text-slate-400">No scheduled guild runs.</p>
                ) : (
                  runtime.scheduledGuilds.map((entry) => (
                    <div
                      key={`${entry.guildId}-${entry.runAt}`}
                      className="rounded-2xl border border-white/10 px-3 py-2 text-sm"
                    >
                      <p>{entry.guildId}</p>
                      <p className="text-slate-400">{entry.reason}</p>
                      <p className="text-slate-400">{formatTime(entry.runAt)}</p>
                      <p className="text-xs text-slate-500">{entry.channelIds.join(", ")}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-slate-400">Runtime markers</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {runtime.runningGuilds.map((guildId) => (
                  <Badge key={`running-${guildId}`}>Running: {guildId}</Badge>
                ))}
                {runtime.dirtyGuilds.map((guildId) => (
                  <Badge key={`dirty-${guildId}`} className="border-amber-400/30 text-amber-200">
                    Dirty: {guildId}
                  </Badge>
                ))}
                {runtime.runningGuilds.length === 0 && runtime.dirtyGuilds.length === 0 ? (
                  <p className="text-sm text-slate-400">No guilds are queued or running.</p>
                ) : null}
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm text-slate-400">Guild checkpoints</p>
              <div className="mt-3 space-y-2">
                {state.guilds.length === 0 ? (
                  <p className="text-sm text-slate-400">No guild state yet.</p>
                ) : (
                  state.guilds.map((guild) => (
                    <div key={guild.guildId} className="rounded-2xl border border-white/10 px-3 py-2 text-sm">
                      <p>{guild.guildId}</p>
                      <p className="text-slate-400">
                        Last run: {guild.checkpoint.lastRunAt ? formatTime(guild.checkpoint.lastRunAt) : "never"}
                      </p>
                      <p className="text-slate-400">
                        Checkpoint: {guild.checkpoint.lastProcessedMessageId ?? "none"}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>

            {lastRun ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm text-slate-400">Last manual run</p>
                <div className="mt-3 space-y-2 text-sm text-slate-200">
                  <p>Messages reviewed: {lastRun.messageCount}</p>
                  <p>New messages: {lastRun.newMessageCount}</p>
                  <p>Relationship updates: {lastRun.applied.relationshipUpdateCount}</p>
                  <p>Memory updates: {lastRun.applied.memoryUpdateCount}</p>
                  <p>Fallback model: {lastRun.usedFallbackModel ? "yes" : "no"}</p>
                  <p className="text-slate-400">{lastRun.decision.reasoning || "No reasoning returned."}</p>
                </div>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Guild Detail</p>
          <h3 className="mt-2 font-display text-2xl">
            {selectedGuild ? `Relationships And Memories: ${selectedGuild.guildId}` : "Relationships And Memories"}
          </h3>

          <div className="mt-4">
            <Label>Viewed Guild</Label>
            <Select value={selectedGuildId} onChange={(event) => setSelectedGuildId(event.target.value)}>
              {state.guilds.map((guild) => (
                <option key={guild.guildId} value={guild.guildId}>
                  {guild.guildId}
                </option>
              ))}
            </Select>
          </div>

          <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {selectedGuild ? (
              <>
                <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">Source channels</p>
                      <p className="text-sm text-slate-400">
                        Stage Manager runs once per guild and uses these channels as sources.
                      </p>
                    </div>
                    <Badge>{selectedGuild.channels.length} channels</Badge>
                  </div>
                  <div className="mt-4 space-y-2">
                    {selectedGuild.channels.map((channel) => (
                      <div key={channel.channelId} className="rounded-2xl border border-white/10 px-3 py-2 text-sm">
                        <p>{channel.channelName}</p>
                        <p className="text-slate-400">{channel.channelId}</p>
                        <p className="text-xs text-slate-500">
                          Active waifus: {channel.activeWaifuIds.join(", ") || "none"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedGuild.waifus.map((waifu) => (
                  <div key={waifu.waifuId} className="rounded-3xl border border-white/10 bg-white/5 p-5">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{waifu.displayName}</p>
                        <p className="text-sm text-slate-400">{waifu.waifuId}</p>
                      </div>
                      <div className="flex gap-2">
                        <Badge>{waifu.relationships.length} relationships</Badge>
                        <Badge>{waifu.memories.length} memories</Badge>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Relationships</p>
                        <div className="mt-3 space-y-2">
                          {waifu.relationships.length === 0 ? (
                            <p className="text-sm text-slate-400">None saved.</p>
                          ) : (
                            waifu.relationships.map((entry) => (
                              <div
                                key={`${waifu.waifuId}-${entry.participantKey}`}
                                className="rounded-2xl border border-white/10 px-3 py-2 text-sm"
                              >
                                <p className="font-medium">{entry.targetName}</p>
                                <p className="mt-1 text-slate-300">{entry.relationship}</p>
                                <p className="mt-1 text-xs text-slate-400">
                                  {entry.participantKey} · {formatTime(entry.updatedAt)}
                                </p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>

                      <div>
                        <p className="text-xs uppercase tracking-[0.28em] text-slate-400">Memories</p>
                        <div className="mt-3 space-y-2">
                          {waifu.memories.length === 0 ? (
                            <p className="text-sm text-slate-400">None saved.</p>
                          ) : (
                            waifu.memories.map((entry) => (
                              <div
                                key={`${waifu.waifuId}-${entry.slot}`}
                                className="rounded-2xl border border-white/10 px-3 py-2 text-sm"
                              >
                                <p className="font-medium">Slot {entry.slot}</p>
                                <p className="mt-1 text-slate-300">{entry.note}</p>
                                <p className="mt-1 text-xs text-slate-400">{formatTime(entry.updatedAt)}</p>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {selectedGuild.waifus.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-400">
                    No authored Stage Manager data for this guild yet.
                  </div>
                ) : null}
              </>
            ) : (
              <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-400">
                No guild state available.
              </div>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
