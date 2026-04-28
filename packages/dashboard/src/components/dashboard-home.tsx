"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CalendarClock,
  CircleSlash,
  Clock3,
  Hash,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  RadioTower,
  Settings2,
  Sparkles,
  Square,
  Theater,
  WandSparkles
} from "lucide-react";
import { api } from "@/lib/api";
import type { ProviderConfig, StatusResponse, WaifuEditorPayload } from "@/lib/types";
import { Panel, Button, Badge } from "./ui";
import { useToast } from "./toast-provider";
import { cn, formatTime } from "@/lib/utils";

type FleetFilter = "all" | "online" | "offline" | "missing";

const POLL_INTERVAL_MS = 5_000;

export function DashboardHome(): JSX.Element {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [waifus, setWaifus] = useState<WaifuEditorPayload[]>([]);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [busy, setBusy] = useState(false);
  const [perWaifuBusy, setPerWaifuBusy] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FleetFilter>("all");
  const toast = useToast();

  const refresh = useCallback(async (showSpinner = false) => {
    if (showSpinner) {
      setLoading(true);
    }
    try {
      const [nextStatus, nextWaifus, nextProviders] = await Promise.all([
        api.getStatus(),
        api.getWaifus(),
        api.getProviders().catch(() => ({ providers: [] as ProviderConfig[] }))
      ]);
      setStatus(nextStatus);
      setWaifus(nextWaifus.waifus);
      setProviders(nextProviders.providers);
    } catch {
      // surface failure quietly; the status beacon shows the global state
    } finally {
      if (showSpinner) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh(true);
    const interval = window.setInterval(() => void refresh(false), POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const onlineIds = useMemo(
    () => new Set((status?.bots ?? []).filter((bot) => bot.ready).map((bot) => bot.waifuId)),
    [status]
  );

  const fleetCounts = useMemo(() => {
    let online = 0;
    let offline = 0;
    let missing = 0;
    for (const waifu of waifus) {
      if (!waifu.meta.isDiscordReady) {
        missing += 1;
      } else if (onlineIds.has(waifu.waifu.id)) {
        online += 1;
      } else {
        offline += 1;
      }
    }
    return { online, offline, missing };
  }, [waifus, onlineIds]);

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled).length,
    [providers]
  );

  const cards = [
    {
      label: "Online bots",
      value: `${fleetCounts.online}`,
      sub:
        waifus.length > 0
          ? `of ${waifus.length} configured`
          : "no waifus configured yet",
      icon: Bot,
      tone: fleetCounts.online > 0 ? "ok" : "muted"
    },
    {
      label: "Active generations",
      value: `${status?.activeGenerations.length ?? 0}`,
      sub:
        (status?.activeGenerations.length ?? 0) === 0
          ? "room is quiet"
          : "rooms in motion",
      icon: Activity,
      tone: (status?.activeGenerations.length ?? 0) > 0 ? "accent" : "muted"
    },
    {
      label: "Stage manager",
      value: `${status?.stageManager.runningChannels.length ?? 0}`,
      sub: `${status?.stageManager.scheduledChannels.length ?? 0} scheduled · ${status?.stageManager.dirtyChannels.length ?? 0} dirty`,
      icon: WandSparkles,
      tone: (status?.stageManager.runningChannels.length ?? 0) > 0 ? "accent" : "muted"
    },
    {
      label: "Uptime",
      value: formatUptime(status?.uptimeSeconds ?? 0),
      sub: `${enabledProviders} providers · ${status?.configSummary.channels ?? 0} channels`,
      icon: Clock3,
      tone: (status?.uptimeSeconds ?? 0) > 0 ? "ok" : "muted"
    }
  ] as const;

  const filtered = useMemo(() => {
    if (filter === "all") return waifus;
    return waifus.filter((waifu) => {
      if (!waifu.meta.isDiscordReady) {
        return filter === "missing";
      }
      const isOnline = onlineIds.has(waifu.waifu.id);
      if (filter === "online") return isOnline;
      if (filter === "offline") return !isOnline;
      return true;
    });
  }, [filter, waifus, onlineIds]);

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
      await refresh(false);
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = async (waifu: WaifuEditorPayload, mode: "start" | "stop") => {
    setPerWaifuBusy((current) => ({ ...current, [waifu.waifu.id]: true }));
    try {
      if (mode === "start") {
        await api.startWaifu(waifu.waifu.id);
        toast(`Start sent to ${waifu.waifu.displayName}.`);
      } else {
        await api.stopWaifu(waifu.waifu.id);
        toast(`Stop sent to ${waifu.waifu.displayName}.`);
      }
      await refresh(false);
    } finally {
      setPerWaifuBusy((current) => {
        const next = { ...current };
        delete next[waifu.waifu.id];
        return next;
      });
    }
  };

  if (loading && waifus.length === 0) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Panel key={index} className="h-32 animate-pulse p-5" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-6 overflow-y-auto pr-1">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <StatCard
            key={card.label}
            label={card.label}
            value={card.value}
            sub={card.sub}
            icon={card.icon}
            tone={card.tone}
          />
        ))}
      </section>

      <section className="grid min-h-0 gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Panel className="flex min-h-[420px] flex-col p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Fleet</p>
              <h3 className="mt-2 font-display text-2xl">Waifu roster</h3>
              <p className="mt-1 text-sm text-slate-400">
                {fleetCounts.online} online · {fleetCounts.offline} offline ·{" "}
                {fleetCounts.missing} missing token
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || waifus.length === 0} onClick={() => void toggleAll("start")}>
                <Play className="mr-2 h-4 w-4" />
                Start all
              </Button>
              <Button
                tone="ghost"
                disabled={busy || waifus.length === 0}
                onClick={() => void toggleAll("stop")}
              >
                <Square className="mr-2 h-4 w-4" />
                Stop all
              </Button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              All <span className="ml-2 text-slate-400">{waifus.length}</span>
            </FilterChip>
            <FilterChip active={filter === "online"} onClick={() => setFilter("online")}>
              Online <span className="ml-2 text-slate-400">{fleetCounts.online}</span>
            </FilterChip>
            <FilterChip active={filter === "offline"} onClick={() => setFilter("offline")}>
              Offline <span className="ml-2 text-slate-400">{fleetCounts.offline}</span>
            </FilterChip>
            <FilterChip active={filter === "missing"} onClick={() => setFilter("missing")}>
              Missing <span className="ml-2 text-slate-400">{fleetCounts.missing}</span>
            </FilterChip>
          </div>

          <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <EmptyHint
                title={waifus.length === 0 ? "No waifus configured" : "No waifus match this filter"}
                hint={
                  waifus.length === 0
                    ? "Open the Waifus page to add a character."
                    : "Try a different filter or clear it."
                }
                cta={waifus.length === 0 ? { href: "/waifus", label: "Add a waifu" } : undefined}
              />
            ) : (
              <ul className="grid gap-3">
                {filtered.map((waifu) => {
                  const online = onlineIds.has(waifu.waifu.id);
                  const ready = waifu.meta.isDiscordReady;
                  const pending = perWaifuBusy[waifu.waifu.id] ?? false;
                  return (
                    <li
                      key={waifu.waifu.id}
                      className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <StatusDot online={online} ready={ready} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{waifu.waifu.displayName}</p>
                          <p className="truncate text-xs text-slate-400">
                            {waifu.waifu.ai.providerId || "no provider"} ·{" "}
                            {waifu.waifu.ai.model || "no model"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          className={cn(
                            online && "border-emerald-400/30 text-emerald-200",
                            !online && ready && "border-white/10 text-slate-300",
                            !ready && "border-amber-400/30 text-amber-200"
                          )}
                        >
                          {online ? "Online" : ready ? "Offline" : "Missing token"}
                        </Badge>
                        {ready ? (
                          online ? (
                            <Button
                              tone="ghost"
                              className="h-9 px-3"
                              disabled={pending}
                              onClick={() => void toggleOne(waifu, "stop")}
                            >
                              {pending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Pause className="h-4 w-4" />
                              )}
                            </Button>
                          ) : (
                            <Button
                              className="h-9 px-3"
                              disabled={pending}
                              onClick={() => void toggleOne(waifu, "start")}
                            >
                              {pending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <Play className="h-4 w-4" />
                              )}
                            </Button>
                          )
                        ) : (
                          <Link
                            href={`/waifus`}
                            className="inline-flex h-9 items-center rounded-2xl border border-amber-400/30 px-3 text-xs text-amber-200 hover:bg-amber-400/10"
                          >
                            Configure
                          </Link>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 flex-col gap-6">
          <Panel className="flex min-h-0 flex-col p-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Runtime</p>
                <h3 className="mt-2 font-display text-2xl">Hot state</h3>
              </div>
              <Sparkles className="h-5 w-5 text-accent" />
            </div>
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              {(status?.activeGenerations.length ?? 0) === 0 ? (
                <EmptyHint
                  title="No active generations"
                  hint="When the orchestrator decides who speaks next, you'll see it here."
                  icon={CircleSlash}
                />
              ) : (
                <ul className="space-y-3">
                  {(status?.activeGenerations ?? []).map((entry) => {
                    const waifu = waifus.find((w) => w.waifu.id === entry.waifuId);
                    return (
                      <li
                        key={`${entry.channelId}-${entry.waifuId ?? "none"}`}
                        className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                      >
                        <div className="flex items-center gap-2 text-xs text-slate-400">
                          <Hash className="h-3 w-3" />
                          {entry.channelId}
                        </div>
                        <p className="mt-1 font-medium">
                          {waifu?.waifu.displayName ?? entry.waifuId ?? "Decision pending"}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="flex min-h-0 flex-col p-6">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Stage manager</p>
                <h3 className="mt-2 font-display text-2xl">Schedule</h3>
              </div>
              <CalendarClock className="h-5 w-5 text-accent" />
            </div>
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              {(status?.stageManager.scheduledChannels.length ?? 0) === 0 &&
              (status?.stageManager.runningChannels.length ?? 0) === 0 ? (
                <EmptyHint
                  title="Nothing scheduled"
                  hint="Quiet-period runs will appear here as channels go idle."
                />
              ) : (
                <ul className="space-y-3">
                  {(status?.stageManager.runningChannels ?? []).map((channelId) => (
                    <li
                      key={`run-${channelId}`}
                      className="rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3"
                    >
                      <div className="flex items-center gap-2 text-xs text-emerald-200">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        running
                      </div>
                      <p className="mt-1 font-medium">{channelId}</p>
                    </li>
                  ))}
                  {(status?.stageManager.scheduledChannels ?? []).map((entry) => (
                    <li
                      key={`sched-${entry.channelId}-${entry.runAt}`}
                      className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3"
                    >
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>{entry.reason.replace(/_/g, " ")}</span>
                        <span>{formatTime(entry.runAt)}</span>
                      </div>
                      <p className="mt-1 font-medium">{entry.channelId}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <Panel className="p-6">
          <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Control surfaces</p>
          <h3 className="mt-2 font-display text-2xl">Quick links</h3>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <QuickLink
              href="/orchestrator"
              title="Orchestrator"
              description="Tune who speaks next, pacing, and model selection."
              icon={Theater}
            />
            <QuickLink
              href="/stage-manager"
              title="Stage manager"
              description="Review quiet-period memory curation and manual runs."
              icon={WandSparkles}
            />
            <QuickLink
              href="/channels"
              title="Channels"
              description="Bind waifus to Discord channels and tune idle chatter."
              icon={Settings2}
            />
            <QuickLink
              href="/live"
              title="Live"
              description="Watch the room and decision trace in real time."
              icon={RadioTower}
            />
          </div>
        </Panel>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Bot;
  tone: "ok" | "accent" | "muted";
}): JSX.Element {
  const tones = {
    ok: "bg-emerald-400/15 text-emerald-200",
    accent: "bg-accent/15 text-accent",
    muted: "bg-white/5 text-slate-300"
  } as const;
  return (
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.28em] text-slate-400">{label}</p>
          <p className="mt-3 font-display text-3xl font-semibold tracking-tight">{value}</p>
          <p className="mt-1 truncate text-xs text-slate-400">{sub}</p>
        </div>
        <div className={cn("rounded-2xl p-3", tones[tone])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </Panel>
  );
}

function FilterChip({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs transition",
        active
          ? "border-accent/50 bg-accent/15 text-white"
          : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
      )}
    >
      {children}
    </button>
  );
}

function StatusDot({ online, ready }: { online: boolean; ready: boolean }): JSX.Element {
  const color = !ready ? "bg-amber-400" : online ? "bg-emerald-400" : "bg-slate-500";
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      <span
        className={cn(
          "absolute inline-flex h-full w-full rounded-full opacity-60",
          online && ready ? "animate-ping" : "",
          color
        )}
      />
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", color)} />
    </span>
  );
}

function EmptyHint({
  title,
  hint,
  cta,
  icon: Icon = MessageSquare
}: {
  title: string;
  hint: string;
  cta?: { href: string; label: string };
  icon?: typeof MessageSquare;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/15 px-4 py-10 text-center">
      <Icon className="h-6 w-6 text-slate-400" />
      <p className="mt-3 text-sm font-medium text-slate-200">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-slate-400">{hint}</p>
      {cta ? (
        <Link
          href={cta.href}
          className="mt-4 inline-flex h-9 items-center rounded-2xl bg-accent px-4 text-xs font-medium text-slate-950 hover:bg-sky-300"
        >
          {cta.label}
        </Link>
      ) : null}
    </div>
  );
}

function QuickLink({
  href,
  title,
  description,
  icon: Icon
}: {
  href: string;
  title: string;
  description: string;
  icon: typeof Theater;
}): JSX.Element {
  return (
    <Link
      href={href}
      className="group flex h-full flex-col rounded-3xl border border-white/10 bg-white/5 p-5 transition hover:border-accent/40 hover:bg-white/10"
    >
      <div className="flex items-center justify-between">
        <div className="rounded-2xl bg-accent/15 p-2.5 text-accent">
          <Icon className="h-4 w-4" />
        </div>
        <span className="text-xs text-slate-400 transition group-hover:text-slate-200">
          Open →
        </span>
      </div>
      <p className="mt-4 font-medium">{title}</p>
      <p className="mt-1 text-sm text-slate-400">{description}</p>
    </Link>
  );
}

function formatUptime(seconds: number): string {
  if (!seconds || seconds < 1) return "—";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}
