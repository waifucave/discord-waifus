"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DebugResponse } from "@/lib/types";
import { formatTime } from "@/lib/utils";
import { Panel, Badge, Button } from "./ui";

export function DebugPanel(): JSX.Element {
  const [data, setData] = useState<DebugResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setData(await api.getDebug());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(interval);
  }, []);

  if (loading && !data) {
    return <Panel className="h-[520px] animate-pulse" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <Panel className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Runtime Debug</p>
            <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">Listener And Config Snapshot</h3>
          </div>
          <Button tone="ghost" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-sm text-ink-muted">Listener Bot</p>
            <p className="mt-2 text-lg font-medium">{data?.listener.listenerBotId ?? "none"}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-sm text-ink-muted">Uptime</p>
            <p className="mt-2 text-lg font-medium">{data?.uptimeSeconds ?? 0}s</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-sm text-ink-muted">Bots Ready</p>
            <p className="mt-2 text-lg font-medium">
              {data?.bots.filter((bot) => bot.ready).length ?? 0}/{data?.bots.length ?? 0}
            </p>
          </div>
        </div>
      </Panel>

      <div className="grid min-h-0 flex-1 gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <Panel className="flex min-h-0 flex-col p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Config</p>
          <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">Channels And Waifus</h3>

          <div className="mt-6 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {data?.config.channels.map((channel) => (
              <div key={channel.channelId} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{channel.channelName}</p>
                    <p className="text-sm text-ink-muted">{channel.channelId}</p>
                  </div>
                  <Badge>{channel.enabled ? "Enabled" : "Disabled"}</Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {channel.activeWaifuIds.map((waifuId) => {
                    const waifu = data.config.waifus.find((entry) => entry.id === waifuId);
                    return (
                      <Badge key={waifuId} className={!waifu ? "border-warn/25 bg-warn/[0.08] text-[rgb(252,211,77)]" : ""}>
                        {waifu?.displayName ?? `${waifuId} (missing)`}
                      </Badge>
                    );
                  })}
                </div>
                <p className="mt-3 text-xs text-ink-muted">
                  Context anchor: {channel.contextAnchorMessageId ?? "none"}
                </p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">Recent Events</p>
          <h3 className="mt-2 font-display text-lg font-semibold tracking-tight">Incoming Discord And Runtime Flow</h3>

          <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {data?.recentEvents.map((event, index) => (
              <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <Badge>{event.type}</Badge>
                  <span className="text-xs text-ink-muted">{formatTime(event.timestamp)}</span>
                </div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-ink-muted">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}
