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
  Square,
  Theater,
  WandSparkles
} from "lucide-react";
import { api } from "@/lib/api";
import type { ProviderConfig, StatusResponse, WaifuEditorPayload } from "@/lib/types";
import { Badge, Button, EmptyState, Panel, SectionHeader, StatusDot } from "./ui";
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
    if (showSpinner) setLoading(true);
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
      // sidebar status pill surfaces failures
    } finally {
      if (showSpinner) setLoading(false);
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
      if (!waifu.meta.isDiscordReady) missing += 1;
      else if (onlineIds.has(waifu.waifu.id)) online += 1;
      else offline += 1;
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
      sub: waifus.length > 0 ? `of ${waifus.length} configured` : "no waifus configured yet",
      icon: Bot,
      tone: fleetCounts.online > 0 ? ("ok" as const) : ("muted" as const)
    },
    {
      label: "Active generations",
      value: `${status?.activeGenerations.length ?? 0}`,
      sub:
        (status?.activeGenerations.length ?? 0) === 0 ? "room is quiet" : "rooms in motion",
      icon: Activity,
      tone:
        (status?.activeGenerations.length ?? 0) > 0
          ? ("accent" as const)
          : ("muted" as const)
    },
    {
      label: "Stage manager",
      value: `${status?.stageManager.runningChannels.length ?? 0}`,
      sub: `${status?.stageManager.scheduledChannels.length ?? 0} scheduled · ${status?.stageManager.dirtyChannels.length ?? 0} dirty`,
      icon: WandSparkles,
      tone:
        (status?.stageManager.runningChannels.length ?? 0) > 0
          ? ("accent" as const)
          : ("muted" as const)
    },
    {
      label: "Uptime",
      value: formatUptime(status?.uptimeSeconds ?? 0),
      sub: `${enabledProviders} providers · ${status?.configSummary.channels ?? 0} channels`,
      icon: Clock3,
      tone: (status?.uptimeSeconds ?? 0) > 0 ? ("ok" as const) : ("muted" as const)
    }
  ];

  const filtered = useMemo(() => {
    if (filter === "all") return waifus;
    return waifus.filter((waifu) => {
      if (!waifu.meta.isDiscordReady) return filter === "missing";
      const isOnline = onlineIds.has(waifu.waifu.id);
      if (filter === "online") return isOnline;
      if (filter === "offline") return !isOnline;
      return true;
    });
  }, [filter, waifus, onlineIds]);

  const toggleAll = async (mode: "start" | "stop") => {
    setBusy(true);
    try {
      const targets =
        mode === "start" ? waifus.filter((waifu) => waifu.meta.isDiscordReady) : waifus;
      await Promise.all(
        targets.map((waifu) =>
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
          <Panel key={index} className="h-28 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <StatCard key={card.label} {...card} />
        ))}
      </section>

      <section className="grid min-h-0 gap-5 xl:grid-cols-[1.3fr_0.7fr]">
        <Panel className="flex min-h-[420px] flex-col p-5">
          <SectionHeader
            eyebrow="Fleet"
            title="Waifu roster"
            description={
              <span>
                {fleetCounts.online} online · {fleetCounts.offline} offline ·{" "}
                {fleetCounts.missing} missing token
              </span>
            }
            actions={
              <>
                <Button
                  size="sm"
                  disabled={busy || waifus.length === 0}
                  onClick={() => void toggleAll("start")}
                >
                  <Play className="h-3.5 w-3.5" />
                  Start all
                </Button>
                <Button
                  size="sm"
                  tone="secondary"
                  disabled={busy || waifus.length === 0}
                  onClick={() => void toggleAll("stop")}
                >
                  <Square className="h-3.5 w-3.5" />
                  Stop all
                </Button>
              </>
            }
          />

          <div className="mt-4 flex flex-wrap gap-1.5">
            <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
              All <span className="ml-1.5 text-ink-subtle">{waifus.length}</span>
            </FilterChip>
            <FilterChip active={filter === "online"} onClick={() => setFilter("online")}>
              Online <span className="ml-1.5 text-ink-subtle">{fleetCounts.online}</span>
            </FilterChip>
            <FilterChip active={filter === "offline"} onClick={() => setFilter("offline")}>
              Offline <span className="ml-1.5 text-ink-subtle">{fleetCounts.offline}</span>
            </FilterChip>
            <FilterChip active={filter === "missing"} onClick={() => setFilter("missing")}>
              Missing <span className="ml-1.5 text-ink-subtle">{fleetCounts.missing}</span>
            </FilterChip>
          </div>

          <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <EmptyState
                title={waifus.length === 0 ? "No waifus configured" : "No matching waifus"}
                description={
                  waifus.length === 0
                    ? "Open the Waifus page to add a character."
                    : "Adjust the filter to see more."
                }
                icon={Bot}
                cta={waifus.length === 0 ? { href: "/waifus", label: "Add a waifu" } : undefined}
              />
            ) : (
              <ul className="grid gap-2">
                {filtered.map((waifu) => {
                  const online = onlineIds.has(waifu.waifu.id);
                  const ready = waifu.meta.isDiscordReady;
                  const pending = perWaifuBusy[waifu.waifu.id] ?? false;
                  const dotState = !ready ? "warn" : online ? "ok" : "idle";
                  return (
                    <li
                      key={waifu.waifu.id}
                      className="flex flex-col gap-3 rounded-xl border border-border-soft bg-white/[0.02] px-4 py-3 transition hover:border-border hover:bg-white/[0.035] sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <StatusDot state={dotState} />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-ink">
                            {waifu.waifu.displayName}
                          </p>
                          <p className="truncate text-xs text-ink-subtle">
                            {waifu.waifu.ai.providerId || "no provider"} ·{" "}
                            {waifu.waifu.ai.model || "no model"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={online ? "ok" : !ready ? "warn" : "neutral"}>
                          {online ? "Online" : ready ? "Offline" : "Missing token"}
                        </Badge>
                        {ready ? (
                          online ? (
                            <Button
                              size="icon"
                              tone="secondary"
                              disabled={pending}
                              onClick={() => void toggleOne(waifu, "stop")}
                              aria-label="Stop waifu"
                            >
                              {pending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Pause className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              disabled={pending}
                              onClick={() => void toggleOne(waifu, "start")}
                              aria-label="Start waifu"
                            >
                              {pending ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Play className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          )
                        ) : (
                          <Link
                            href="/waifus"
                            className="ring-focus inline-flex h-8 items-center rounded-lg border border-warn/25 bg-warn/[0.08] px-2.5 text-[11px] font-medium text-[rgb(252,211,77)] transition hover:bg-warn/[0.14]"
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

        <div className="flex min-h-0 flex-col gap-5">
          <Panel className="flex min-h-0 flex-col p-5">
            <SectionHeader eyebrow="Runtime" title="Hot state" />
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              {(status?.activeGenerations.length ?? 0) === 0 ? (
                <EmptyState
                  title="No active generations"
                  description="When the orchestrator picks who speaks next, you'll see it here."
                  icon={CircleSlash}
                />
              ) : (
                <ul className="space-y-2">
                  {(status?.activeGenerations ?? []).map((entry) => {
                    const waifu = waifus.find((w) => w.waifu.id === entry.waifuId);
                    return (
                      <li
                        key={`${entry.channelId}-${entry.waifuId ?? "none"}`}
                        className="rounded-xl border border-border-soft bg-white/[0.02] px-3.5 py-2.5"
                      >
                        <div className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
                          <Hash className="h-3 w-3" />
                          {entry.channelId}
                        </div>
                        <p className="mt-0.5 text-[13px] font-medium text-ink">
                          {waifu?.waifu.displayName ?? entry.waifuId ?? "Decision pending"}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="flex min-h-0 flex-col p-5">
            <SectionHeader eyebrow="Stage manager" title="Schedule" />
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              {(status?.stageManager.scheduledChannels.length ?? 0) === 0 &&
              (status?.stageManager.runningChannels.length ?? 0) === 0 ? (
                <EmptyState
                  title="Nothing scheduled"
                  description="Quiet-period runs queue here as channels go idle."
                  icon={CalendarClock}
                />
              ) : (
                <ul className="space-y-2">
                  {(status?.stageManager.runningChannels ?? []).map((channelId) => (
                    <li
                      key={`run-${channelId}`}
                      className="rounded-xl border border-ok/20 bg-ok/[0.06] px-3.5 py-2.5"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-[rgb(110,231,183)]">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        running
                      </div>
                      <p className="mt-0.5 text-[13px] font-medium text-ink">{channelId}</p>
                    </li>
                  ))}
                  {(status?.stageManager.scheduledChannels ?? []).map((entry) => (
                    <li
                      key={`sched-${entry.channelId}-${entry.runAt}`}
                      className="rounded-xl border border-border-soft bg-white/[0.02] px-3.5 py-2.5"
                    >
                      <div className="flex items-center justify-between text-[11px] text-ink-subtle">
                        <span>{entry.reason.replace(/_/g, " ")}</span>
                        <span>{formatTime(entry.runAt)}</span>
                      </div>
                      <p className="mt-0.5 text-[13px] font-medium text-ink">{entry.channelId}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      </section>

      <section>
        <Panel className="p-5">
          <SectionHeader eyebrow="Control surfaces" title="Quick links" />
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
    ok: "bg-ok/12 text-[rgb(110,231,183)]",
    accent: "bg-accent/15 text-[rgb(196,181,253)]",
    muted: "bg-white/[0.04] text-ink-muted"
  } as const;
  return (
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-ink-subtle">
            {label}
          </p>
          <p className="mt-3 font-display text-[28px] font-semibold leading-none tracking-tight text-ink">
            {value}
          </p>
          <p className="mt-2 truncate text-xs text-ink-muted">{sub}</p>
        </div>
        <div className={cn("rounded-lg p-2", tones[tone])}>
          <Icon className="h-4 w-4" />
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
        "ring-focus rounded-md border px-2.5 py-1 text-[11px] font-medium transition",
        active
          ? "border-accent/40 bg-accent/15 text-ink"
          : "border-border-soft bg-white/[0.02] text-ink-muted hover:border-border hover:bg-white/[0.04] hover:text-ink"
      )}
    >
      {children}
    </button>
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
      className="group flex h-full flex-col rounded-xl border border-border-soft bg-white/[0.02] p-4 transition duration-150 ease-smooth hover:border-accent/40 hover:bg-white/[0.04]"
    >
      <div className="flex items-center justify-between">
        <div className="rounded-lg bg-accent/15 p-2 text-accent">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <span className="text-[11px] text-ink-subtle transition group-hover:text-ink-muted">
          Open →
        </span>
      </div>
      <p className="mt-3 text-[13px] font-medium text-ink">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">{description}</p>
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
