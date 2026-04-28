"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  BookOpen,
  Bot,
  Bug,
  Home,
  RadioTower,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Theater,
  WandSparkles
} from "lucide-react";
import { StatusBeacon } from "./status-beacon";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  description?: string;
};

const navSections: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: Home, description: "At-a-glance fleet health" }
    ]
  },
  {
    heading: "Configure",
    items: [
      { href: "/orchestrator", label: "Orchestrator", icon: Theater, description: "Who speaks next" },
      { href: "/waifus", label: "Waifus", icon: Bot, description: "Identities & personas" },
      { href: "/stage-manager", label: "Stage Manager", icon: WandSparkles, description: "Memory curation" },
      { href: "/providers", label: "Providers", icon: SlidersHorizontal, description: "AI routes" },
      { href: "/channels", label: "Channels", icon: Settings2, description: "Discord rooms" }
    ]
  },
  {
    heading: "Observe",
    items: [
      { href: "/live", label: "Live", icon: RadioTower, description: "Realtime feed" },
      { href: "/debug", label: "Debug", icon: Bug, description: "Runtime snapshot" }
    ]
  },
  {
    heading: "Help",
    items: [{ href: "/instructions", label: "Instructions", icon: BookOpen, description: "Setup guide" }]
  }
];

const flatNav = navSections.flatMap((section) => section.items);

export function AppShell({
  pathname,
  children
}: {
  pathname: string;
  children: ReactNode;
}): JSX.Element {
  const active = flatNav.find((link) => link.href === pathname);

  return (
    <div className="min-h-screen">
      <div className="mx-auto grid h-screen max-w-[1600px] grid-cols-1 gap-5 overflow-hidden px-4 py-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="surface-raised flex min-h-0 flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center gap-2.5 px-5 pt-5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15 text-accent">
              <Sparkles className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.18em] text-ink-subtle">
                Discord Waifus
              </p>
              <p className="truncate font-display text-[13px] font-semibold text-ink">
                Orchestrator
              </p>
            </div>
          </div>

          <nav className="mt-5 min-h-0 flex-1 space-y-5 overflow-y-auto px-3 pb-4">
            {navSections.map((section) => (
              <div key={section.heading}>
                <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-subtle">
                  {section.heading}
                </p>
                <ul className="space-y-0.5">
                  {section.items.map((link) => {
                    const Icon = link.icon;
                    const isActive = pathname === link.href;
                    return (
                      <li key={link.href}>
                        <Link
                          href={link.href}
                          className={cn(
                            "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition duration-150 ease-smooth",
                            isActive
                              ? "bg-white/[0.06] text-ink"
                              : "text-ink-muted hover:bg-white/[0.03] hover:text-ink"
                          )}
                        >
                          {isActive ? (
                            <span className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent" />
                          ) : null}
                          <Icon
                            className={cn(
                              "h-4 w-4 shrink-0 transition",
                              isActive ? "text-accent" : "text-ink-subtle group-hover:text-ink-muted"
                            )}
                          />
                          <span className="truncate">{link.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>

          <div className="border-t border-border-soft px-3 py-3">
            <StatusBeacon />
          </div>
        </aside>

        <main className="flex min-h-0 flex-col gap-5 overflow-hidden">
          <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-ink-subtle">
                <span>Dashboard</span>
                <span className="text-ink-subtle/50">/</span>
                <span className="text-ink-muted">{active?.label ?? "Overview"}</span>
              </div>
              <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
                {active?.label ?? "Overview"}
              </h1>
              {active?.description ? (
                <p className="mt-1 text-[13px] text-ink-muted">{active.description}</p>
              ) : null}
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
        </main>
      </div>
    </div>
  );
}
