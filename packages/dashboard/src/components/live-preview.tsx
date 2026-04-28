"use client";

import { useEffect, useMemo, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/utils";
import type {
  ChannelConfig,
  ChatMessageEvent,
  OrchestratorDecisionEvent,
  StageManagerCompleteEvent,
  StageManagerScheduledEvent
} from "@/lib/types";
import { Panel, Select, Badge } from "./ui";

export function LivePreview(): JSX.Element {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessageEvent[]>([]);
  const [decisions, setDecisions] = useState<OrchestratorDecisionEvent[]>([]);
  const [stageManagerEvents, setStageManagerEvents] = useState<
    Array<StageManagerScheduledEvent | StageManagerCompleteEvent>
  >([]);
  const [socketState, setSocketState] = useState<"connecting" | "connected" | "disconnected">(
    "connecting"
  );

  useEffect(() => {
    void api.getChannels().then((response) => {
      setChannels(response.channels);
      if (response.channels[0]) {
        setChannelId(response.channels[0].channelId);
      }
    });
  }, []);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const resolvedSocketUrl =
      process.env.NEXT_PUBLIC_SOCKET_URL ??
      `${window.location.protocol}//${window.location.hostname}:4000`;

    const socket: Socket = io(resolvedSocketUrl, {
      transports: ["websocket"]
    });
    setSocketState("connecting");

    socket.emit("subscribe", { channelId });
    socket.on("connect", () => {
      setSocketState("connected");
      socket.emit("subscribe", { channelId });
    });
    socket.on("disconnect", () => {
      setSocketState("disconnected");
    });
    socket.on("chat:message", (payload: ChatMessageEvent) => {
      setMessages((current) => [...current.slice(-39), payload]);
    });
    socket.on("orchestrator:decision", (payload: OrchestratorDecisionEvent) => {
      setDecisions((current) => [...current.slice(-24), payload]);
    });
    socket.on("stage-manager:scheduled", (payload: StageManagerScheduledEvent) => {
      setStageManagerEvents((current) => [...current.slice(-24), payload]);
    });
    socket.on("stage-manager:complete", (payload: StageManagerCompleteEvent) => {
      setStageManagerEvents((current) => [...current.slice(-24), payload]);
    });

    return () => {
      socket.emit("unsubscribe", { channelId });
      socket.close();
    };
  }, [channelId]);

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.channelId === channelId),
    [channelId, channels]
  );

  return (
    <div className="grid h-full min-h-0 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <Panel className="flex min-h-0 flex-col p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Live Feed</p>
            <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">
              {selectedChannel?.channelName ?? "Select a channel"}
            </h3>
            <p className="mt-2 text-sm text-ink-muted">Socket: {socketState}</p>
          </div>
          <div className="w-[260px]">
            <Select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
              {channels.map((channel) => (
                <option key={channel.channelId} value={channel.channelId}>
                  {channel.channelName}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
          {messages.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-ink-muted">
              No live messages received yet.
            </div>
          ) : null}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-2xl border px-4 py-3 ${
                message.isWaifu ? "border-sky-400/25 bg-sky-500/10" : "border-white/10 bg-white/5"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Badge>{message.isWaifu ? "Waifu" : "User"}</Badge>
                  <p className="font-medium">{message.authorName}</p>
                </div>
                <p className="text-xs text-ink-muted">{formatTime(message.timestamp)}</p>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm text-ink">{message.content}</p>
            </div>
          ))}
          </div>
        </div>
      </Panel>

      <Panel className="flex min-h-0 flex-col p-6">
        <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Decision Trace</p>
        <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">Room Control Log</h3>
        <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="space-y-3">
          {decisions.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-ink-muted">
              No orchestrator decisions received yet.
            </div>
          ) : null}
          {decisions.map((decision, index) => (
            <div key={`${decision.timestamp}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="flex items-center justify-between">
                <Badge>{decision.action}</Badge>
                <span className="text-xs text-ink-muted">{formatTime(decision.timestamp)}</span>
              </div>
              <p className="mt-3 text-sm text-ink">{decision.reasoning}</p>
              {decision.retriggerAfterSeconds ? (
                <p className="mt-2 text-xs text-ink-muted">
                  Follow-up in {decision.retriggerAfterSeconds}s
                </p>
              ) : null}
              {decision.directInteraction ? (
                <p className="mt-2 text-xs text-ink-muted">
                  Emoji beat: {decision.directInteraction.waifuId} sends{" "}
                  {decision.directInteraction.emoji} in {decision.directInteraction.delaySeconds}s
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {decision.respondingWaifus.map((entry) => (
                  <Badge key={`${entry.waifuId}-${entry.delaySeconds}`}>
                    {entry.waifuId} in {entry.delaySeconds}s
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          {stageManagerEvents.map((event, index) => (
            <div
              key={`stage-${event.timestamp}-${index}`}
              className="rounded-2xl border border-emerald-400/15 bg-emerald-500/10 p-4"
            >
              <div className="flex items-center justify-between">
                <Badge>Stage Manager</Badge>
                <span className="text-xs text-ink-muted">{formatTime(event.timestamp)}</span>
              </div>
              {"runAt" in event ? (
                <p className="mt-3 text-sm text-ink">
                  Scheduled {event.reason} run for {formatTime(event.runAt)}
                </p>
              ) : (
                <>
                  <p className="mt-3 text-sm text-ink">
                    {event.noOp
                      ? "No durable updates applied."
                      : `${event.relationshipUpdateCount} relationship update(s), ${event.memoryUpdateCount} memory update(s).`}
                  </p>
                  <p className="mt-2 text-xs text-ink-muted">
                    Trigger: {event.trigger} · Fallback model: {event.usedFallbackModel ? "yes" : "no"}
                  </p>
                  {event.reasoning ? (
                    <p className="mt-2 text-xs text-ink-muted">{event.reasoning}</p>
                  ) : null}
                </>
              )}
            </div>
          ))}
          </div>
        </div>
      </Panel>
    </div>
  );
}
