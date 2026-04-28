"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatusDot } from "./ui";

type ConnectionState = "online" | "degraded" | "offline";

export function StatusBeacon(): JSX.Element {
  const [onlineBots, setOnlineBots] = useState<number>(0);
  const [totalBots, setTotalBots] = useState<number>(0);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [uptimeSeconds, setUptimeSeconds] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const status = await api.getStatus();
        if (cancelled) return;
        const online = status.bots.filter((bot) => bot.ready).length;
        setOnlineBots(online);
        setTotalBots(status.bots.length);
        setUptimeSeconds(status.uptimeSeconds);
        if (status.bots.length === 0) {
          setConnection("degraded");
        } else if (online === 0) {
          setConnection("degraded");
        } else if (online < status.bots.length) {
          setConnection("degraded");
        } else {
          setConnection("online");
        }
      } catch {
        if (!cancelled) setConnection("offline");
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const dotState = connection === "online" ? "ok" : connection === "degraded" ? "warn" : "danger";
  const label =
    connection === "offline"
      ? "Backend unreachable"
      : connection === "degraded"
        ? totalBots === 0
          ? "No bots configured"
          : `${onlineBots}/${totalBots} bots online`
        : `${onlineBots}/${totalBots} bots online`;

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border-soft bg-white/[0.025] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <StatusDot state={dotState} pulse={connection !== "offline"} />
        <div className="min-w-0">
          <p className="truncate text-[12px] font-medium text-ink">{label}</p>
          <p className="truncate text-[10px] uppercase tracking-[0.16em] text-ink-subtle">
            {connection === "offline" ? "Disconnected" : `Up ${formatUptime(uptimeSeconds)}`}
          </p>
        </div>
      </div>
    </div>
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
