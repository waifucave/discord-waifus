import type { ReactNode } from "react";
import Link from "next/link";
import { BookOpen, Bot, Bug, Home, RadioTower, Settings2, SlidersHorizontal, Theater, WandSparkles } from "lucide-react";
import { StatusBeacon } from "./status-beacon";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Overview", icon: Home },
  { href: "/orchestrator", label: "Orchestrator", icon: Theater },
  { href: "/waifus", label: "Waifus", icon: Bot },
  { href: "/stage-manager", label: "Stage Manager", icon: WandSparkles },
  { href: "/providers", label: "Providers", icon: SlidersHorizontal },
  { href: "/channels", label: "Channels", icon: Settings2 },
  { href: "/live", label: "Live", icon: RadioTower },
  { href: "/debug", label: "Debug", icon: Bug },
  { href: "/instructions", label: "Instructions", icon: BookOpen }
];

export function AppShell({
  pathname,
  children
}: {
  pathname: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="min-h-screen">
      <div className="mx-auto grid h-screen max-w-[1600px] grid-cols-1 gap-6 overflow-hidden px-4 py-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="glass app-grid flex min-h-0 flex-col rounded-[32px] border border-white/10 px-6 py-7">
          <div className="mb-10">
            <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Discord Waifus</p>
            <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">Orchestrator</h1>
            <p className="mt-3 text-sm text-slate-400">
              Run the cast, tune the voices, and watch the room breathe.
            </p>
          </div>

          <nav className="min-h-0 space-y-2 overflow-y-auto pr-1">
            {links.map((link) => {
              const Icon = link.icon;
              const active = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition",
                    active
                      ? "bg-accent/15 text-white"
                      : "text-slate-300 hover:bg-white/5 hover:text-white"
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="flex min-h-0 flex-col gap-6 overflow-hidden">
          <header className="flex flex-col gap-4 rounded-[32px] border border-white/10 bg-black/20 px-6 py-5 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.4em] text-slate-400">Control Room</p>
              <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">
                {links.find((link) => link.href === pathname)?.label ?? "Overview"}
              </h2>
            </div>
            <StatusBeacon />
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </main>
      </div>
    </div>
  );
}
