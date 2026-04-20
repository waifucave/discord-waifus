"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Activity, Bot, MessageSquare, Play, Square } from "lucide-react";
import { api } from "@/lib/api";
import type { StatusResponse, WaifuEditorPayload } from "@/lib/types";
import { Panel, Button, Badge } from "./ui";
import { useToast } from "./toast-provider";

export function DashboardHome(): JSX.Element {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [waifus, setWaifus] = useState<WaifuEditorPayload[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  useEffect(() => {
    void refresh();
  }, []);

  const refresh = async () => {
    setLoading(true);
    try {
      const [nextStatus, nextWaifus] = await Promise.all([api.getStatus(), api.getWaifus()]);
      setStatus(nextStatus);
      setWaifus(nextWaifus.waifus);
    } finally {
      setLoading(false);
    }
  };

  const toggleAll = async (mode: "start" | "stop") => {
    setBusy(true);
    try {
      const targetWaifus =
        mode === "start" ? waifus.filter((waifu) => waifu.meta.isDiscordReady) : waifus;
      await Promise.all(
        targetWaifus.map((waifu) =>
          mode === "start" ? api.startWaifu(waifu.waifu.id) : api.stopWaifu(waifu.waifu.id)
        )
      );
      toast(mode === "start" ? "Start requests sent." : "Stop requests sent.");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const cards = [
    {
      label: "Online Bots",
      value: status?.bots.filter((bot) => bot.ready).length ?? 0,
      icon: Bot
    },
    {
      label: "Active Generations",
      value: status?.activeGenerations.length ?? 0,
      icon: Activity
    },
    {
      label: "Configured Channels",
      value: status?.configSummary.channels ?? 0,
      icon: MessageSquare
    }
  ];

  if (loading && waifus.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <Panel key={index} className="h-40 animate-pulse p-5" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-hidden">
      <section className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Panel key={card.label} className="p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">{card.label}</p>
                  <p className="mt-3 text-4xl font-semibold">{card.value}</p>
                </div>
                <div className="rounded-2xl bg-accent/15 p-3 text-accent">
                  <Icon className="h-5 w-5" />
                </div>
              </div>
            </Panel>
          );
        })}
      </section>

      <section className="grid min-h-0 gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Panel className="flex min-h-0 flex-col p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Fleet</p>
              <h3 className="mt-2 font-display text-2xl">Startup Controls</h3>
            </div>
            <div className="flex gap-3">
              <Button disabled={busy} onClick={() => void toggleAll("start")}>
                <Play className="mr-2 h-4 w-4" />
                Start All
              </Button>
              <Button tone="ghost" disabled={busy} onClick={() => void toggleAll("stop")}>
                <Square className="mr-2 h-4 w-4" />
                Stop All
              </Button>
            </div>
          </div>

          <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="grid gap-3">
            {waifus.map((waifu) => {
              const online = status?.bots.some((bot) => bot.waifuId === waifu.waifu.id && bot.ready);
              return (
                <div
                  key={waifu.waifu.id}
                  className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                >
                  <div>
                    <p className="font-medium">{waifu.waifu.displayName}</p>
                    <p className="text-sm text-slate-400">
                      {waifu.waifu.ai.providerId || "No provider"}/{waifu.waifu.ai.model || "No model"}
                    </p>
                  </div>
                  <Badge
                    className={
                      online
                        ? "border-emerald-400/30 text-emerald-200"
                        : waifu.meta.isDiscordReady
                          ? ""
                          : "border-amber-400/30 text-amber-200"
                    }
                  >
                    {online ? "Online" : waifu.meta.isDiscordReady ? "Offline" : "Missing token"}
                  </Badge>
                </div>
              );
            })}
            </div>
          </div>
        </Panel>

        <Panel className="flex min-h-0 flex-col p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Runtime</p>
          <h3 className="mt-2 font-display text-2xl">Hot State</h3>
          <div className="mt-6 min-h-0 flex-1 overflow-y-auto pr-1">
            <div className="space-y-3">
            {(status?.activeGenerations ?? []).map((entry) => (
              <div
                key={`${entry.channelId}-${entry.waifuId ?? "none"}`}
                className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
              >
                <p className="text-sm text-slate-300">Channel {entry.channelId}</p>
                <p className="mt-1 font-medium">{entry.waifuId ?? "Decision pending"}</p>
              </div>
            ))}
            {status?.activeGenerations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 px-4 py-8 text-center text-sm text-slate-400">
                No active generations right now.
              </div>
            ) : null}
            </div>
          </div>
        </Panel>
      </section>

      <section className="min-h-0 flex-1 overflow-hidden">
        <Panel className="flex h-full min-h-0 flex-col p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Control Surfaces</p>
          <h3 className="mt-2 font-display text-2xl">Quick Links</h3>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <QuickLink
              href="/orchestrator"
              title="Orchestrator"
              description="Tune who speaks next, pacing, and model selection."
            />
            <QuickLink
              href="/stage-manager"
              title="Stage Manager"
              description="Review quiet-period memory curation, checkpoints, and manual runs."
            />
            <QuickLink
              href="/waifus"
              title="Waifus"
              description="Edit waifu identities, prompts, and per-character model settings."
            />
            <QuickLink
              href="/live"
              title="Live"
              description="Watch the room, decisions, and stage-manager events in real time."
            />
          </div>
        </Panel>
      </section>
    </div>
  );
}

function QuickLink({
  href,
  title,
  description
}: {
  href: string;
  title: string;
  description: string;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:bg-white/10"
    >
      <p className="font-medium">{title}</p>
      <p className="mt-2 text-sm text-slate-400">{description}</p>
    </Link>
  );
}
