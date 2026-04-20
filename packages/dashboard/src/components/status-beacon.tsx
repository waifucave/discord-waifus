"use client";

import { useEffect, useState } from "react";
import { Activity, Sparkles } from "lucide-react";
import { api } from "@/lib/api";

export function StatusBeacon(): JSX.Element {
  const [onlineBots, setOnlineBots] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const status = await api.getStatus();
        if (!cancelled) {
          setOnlineBots(status.bots.filter((bot) => bot.ready).length);
        }
      } catch {
        if (!cancelled) {
          setOnlineBots(0);
        }
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div className="flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm">
      <Activity className="h-4 w-4 text-emerald-300" />
      <span>{onlineBots} bots online</span>
      <Sparkles className="h-4 w-4 text-accent" />
    </div>
  );
}
