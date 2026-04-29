"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Plus, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import type { ChannelConfig, WaifuEditorPayload } from "@/lib/types";
import { Panel, Button, Input, Label, Badge } from "./ui";
import { useToast } from "./toast-provider";

const emptyChannel: ChannelConfig = {
  guildId: "",
  channelId: "",
  channelName: "",
  enabled: true,
  activeWaifuIds: [],
  contextAnchorMessageId: null,
  contextMessageCount: 80,
  idleChatterEnabled: true,
  idleTimerMinSeconds: 100,
  idleTimerMaxSeconds: 300
};

export function ChannelsManager(): JSX.Element {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [waifus, setWaifus] = useState<WaifuEditorPayload[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<ChannelConfig>(emptyChannel);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const createEmptyDraft = (): ChannelConfig => ({
    ...emptyChannel,
    activeWaifuIds: waifus
      .filter((waifu) => waifu.meta.isChatReady)
      .map((waifu) => waifu.waifu.id)
  });

  useEffect(() => {
    void load();
  }, []);

  const load = async (preferredSelectedId = selectedId) => {
    setLoading(true);
    try {
      const [channelResponse, waifuResponse] = await Promise.all([
        api.getChannels(),
        api.getWaifus()
      ]);
      setChannels(channelResponse.channels);
      setWaifus(waifuResponse.waifus);
      if (preferredSelectedId) {
        const selectedChannel = channelResponse.channels.find(
          (channel) => channel.channelId === preferredSelectedId
        );
        if (selectedChannel) {
          setSelectedId(selectedChannel.channelId);
          setDraft(selectedChannel);
          return;
        }
      }

      if (channelResponse.channels[0]) {
        setSelectedId(channelResponse.channels[0].channelId);
        setDraft(channelResponse.channels[0]);
      } else {
        setSelectedId("");
        setDraft(emptyChannel);
      }
    } finally {
      setLoading(false);
    }
  };

  if (loading && channels.length === 0) {
    return <Panel className="h-[420px] animate-pulse" />;
  }

  return (
    <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
      <Panel className="flex min-h-0 flex-col p-5">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Channels</p>
          <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">Rooms</h3>
        </div>
        <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {channels.map((channel) => (
            <button
              key={channel.channelId}
              className={`w-full rounded-2xl border px-4 py-3 text-left ${
                selectedId === channel.channelId
                  ? "border-accent/40 bg-accent/[0.08]"
                  : "border-white/10 bg-white/5"
              }`}
              onClick={() => {
                setSelectedId(channel.channelId);
                setDraft(channel);
              }}
            >
              <p className="font-medium">{channel.channelName}</p>
              <p className="text-sm text-ink-muted">{channel.channelId}</p>
            </button>
          ))}
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Editor</p>
            <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">{draft.channelName || "New Channel"}</h3>
          </div>
          <div className="flex gap-3">
            <Button
              tone="ghost"
              onClick={() => {
                setSelectedId("");
                setDraft(createEmptyDraft());
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              New
            </Button>
            <Button
              tone="ghost"
              onClick={async () => {
                if (!selectedId) return;
                if (!window.confirm("Delete this channel?")) return;
                await api.deleteChannel(selectedId);
                toast("Channel deleted.");
                await load("");
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
            <Button
              onClick={async () => {
                const validWaifuIds = new Set(
                  waifus.filter((waifu) => waifu.meta.isChatReady).map((waifu) => waifu.waifu.id)
                );
                const sanitizedDraft = {
                  ...draft,
                  activeWaifuIds: draft.activeWaifuIds.filter((id) => validWaifuIds.has(id))
                };
                const duplicateChannel = channels.find(
                  (channel) =>
                    channel.channelId === sanitizedDraft.channelId &&
                    channel.channelId !== selectedId
                );
                if (duplicateChannel) {
                  toast("A channel with that ID already exists.");
                  return;
                }

                const nextSelectedId = sanitizedDraft.channelId;
                if (selectedId) {
                  await api.updateChannel(selectedId, sanitizedDraft);
                } else {
                  await api.createChannel({
                    ...sanitizedDraft,
                    contextAnchorMessageId: null
                  });
                }
                toast("Channel saved.");
                await load(nextSelectedId);
              }}
            >
              <Save className="mr-2 h-4 w-4" />
              Save
            </Button>
          </div>
        </div>

        <div className="mt-8 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid gap-6 lg:grid-cols-2">
          <Field label="Channel Enabled">
            <Button
              tone={draft.enabled ? "primary" : "ghost"}
              onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
              className="w-full justify-start"
            >
              {draft.enabled ? <Check className="mr-2 h-4 w-4" /> : <X className="mr-2 h-4 w-4" />}
              {draft.enabled ? "Enabled" : "Disabled"}
            </Button>
          </Field>
          <Field label="Idle Chatter">
            <Button
              tone={draft.idleChatterEnabled ? "primary" : "ghost"}
              onClick={() =>
                setDraft({ ...draft, idleChatterEnabled: !draft.idleChatterEnabled })
              }
              className="w-full justify-start"
            >
              {draft.idleChatterEnabled ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <X className="mr-2 h-4 w-4" />
              )}
              {draft.idleChatterEnabled ? "Idle Chatter On" : "Idle Chatter Off"}
            </Button>
          </Field>
          <Field label="Guild ID">
            <Input
              value={draft.guildId}
              onChange={(event) => setDraft({ ...draft, guildId: event.target.value })}
            />
          </Field>
          <Field label="Channel ID">
            <Input
              value={draft.channelId}
              onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}
            />
          </Field>
          <Field className="lg:col-span-2" label="Channel Name">
            <Input
              value={draft.channelName}
              onChange={(event) => setDraft({ ...draft, channelName: event.target.value })}
            />
          </Field>
          <Field className="lg:col-span-2" label="Context Anchor">
            <Input
              value={draft.contextAnchorMessageId ?? ""}
              placeholder="Use /context_anchor_here in Discord"
              readOnly
            />
          </Field>
          <Field className="lg:col-span-2" label={`Context Messages (${draft.contextMessageCount})`}>
            <Input
              type="range"
              min="20"
              max="100"
              step="5"
              value={draft.contextMessageCount}
              onChange={(event) =>
                setDraft({ ...draft, contextMessageCount: Number(event.target.value) })
              }
            />
          </Field>
          <Field label={`Idle Min (${draft.idleTimerMinSeconds}s)`}>
            <Input
              type="range"
              min="100"
              max="7200"
              step="10"
              value={draft.idleTimerMinSeconds}
              onChange={(event) =>
                setDraft({ ...draft, idleTimerMinSeconds: Number(event.target.value) })
              }
            />
          </Field>
          <Field label={`Idle Max (${draft.idleTimerMaxSeconds}s)`}>
            <Input
              type="range"
              min="100"
              max="7200"
              step="10"
              value={draft.idleTimerMaxSeconds}
              onChange={(event) =>
                setDraft({ ...draft, idleTimerMaxSeconds: Number(event.target.value) })
              }
            />
          </Field>
          </div>

        <div className="mt-8">
          <Label>Active Waifus</Label>
          <div className="flex flex-wrap gap-2">
            {waifus.map((waifu) => {
              const active = draft.activeWaifuIds.includes(waifu.waifu.id);
              const selectable = waifu.meta.isChatReady;
              return (
                <button
                  key={waifu.waifu.id}
                  className={`rounded-full border px-3 py-2 text-sm ${
                    active
                      ? selectable
                        ? "border-accent/60 bg-accent/15"
                        : "border-amber-400/30 bg-amber-400/10 text-[rgb(252,211,77)]"
                      : selectable
                        ? "border-white/10 bg-white/5"
                        : "border-white/10 bg-white/5 opacity-60"
                  }`}
                  onClick={() =>
                    !active && !selectable
                      ? undefined
                      : setDraft({
                          ...draft,
                          activeWaifuIds: active
                            ? draft.activeWaifuIds.filter((id) => id !== waifu.waifu.id)
                            : [...draft.activeWaifuIds, waifu.waifu.id]
                        })
                  }
                >
                  {waifu.waifu.displayName}
                  {!selectable ? (
                    <span className="ml-2 text-xs uppercase tracking-[0.2em] text-[rgb(252,211,77)]">
                      Draft
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {draft.activeWaifuIds.some(
            (waifuId) => !waifus.some((waifu) => waifu.waifu.id === waifuId && waifu.meta.isChatReady)
          ) ? (
            <p className="mt-3 text-sm text-[rgb(252,211,77)]">
              Saving will prune draft or missing waifu selections from this channel.
            </p>
          ) : null}
        </div>

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-4">
          <p className="text-sm font-medium">Timeline Preview</p>
          <div className="mt-4 h-5 overflow-hidden rounded-full bg-black/30">
            <div
              className="h-full bg-gradient-to-r from-sky-300/70 to-cyan-500/70"
              style={{ width: `${(draft.contextMessageCount / 100) * 100}%` }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {draft.activeWaifuIds.map((id) => {
              const waifu = waifus.find((entry) => entry.waifu.id === id);
              return (
                <Badge
                  key={id}
                  className={!waifu?.meta.isChatReady ? "border-warn/25 bg-warn/[0.08] text-[rgb(252,211,77)]" : undefined}
                >
                  {waifu?.waifu.displayName ?? id}
                </Badge>
              );
            })}
          </div>
        </div>

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-4">
          <p className="text-sm font-medium">Available Server Emojis</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(draft.availableEmojis ?? []).length > 0 ? (
              (draft.availableEmojis ?? []).map((emoji) => <Badge key={emoji}>{emoji}</Badge>)
            ) : (
              <p className="text-sm text-ink-muted">No custom server emojis fetched for this guild.</p>
            )}
          </div>
        </div>

        <div className="mt-8 rounded-3xl border border-white/10 bg-white/5 p-4">
          <p className="text-sm font-medium">Guild Members</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(draft.availableGuildMembers ?? []).length > 0 ? (
              (draft.availableGuildMembers ?? []).map((member) => (
                <Badge key={member.id}>
                  {member.displayName}
                  {member.bot ? " [bot]" : ""}
                </Badge>
              ))
            ) : (
              <p className="text-sm text-ink-muted">No guild members fetched for this guild.</p>
            )}
          </div>
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
