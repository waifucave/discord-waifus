import { Activity, Brain, Cog, Compass, ScrollText, Server, Sparkles } from "lucide-react";

export type ViewId = "home" | "cast" | "rooms" | "direction" | "memory" | "activity" | "app-settings";

export type NavEntry = {
  id: ViewId;
  label: string;
  icon: typeof Activity;
};

export const NAV: NavEntry[] = [
  { id: "home", label: "Home", icon: Activity },
  { id: "cast", label: "Cast", icon: Sparkles },
  { id: "rooms", label: "Rooms", icon: Server },
  { id: "direction", label: "Direction", icon: Compass },
  { id: "memory", label: "Memory", icon: Brain },
  { id: "activity", label: "Activity", icon: ScrollText },
  { id: "app-settings", label: "Settings", icon: Cog }
];

/** Tab sets per section; the first entry is the default tab. */
export const SECTION_TABS: Partial<Record<ViewId, Array<{ id: string; label: string }>>> = {
  direction: [
    { id: "orchestrator", label: "Orchestrator" },
    { id: "stage-manager", label: "Stage manager" },
    { id: "reviewer", label: "Reviewer" },
    { id: "assistant", label: "Assistant" }
  ],
  activity: [
    { id: "logs", label: "Logs" },
    { id: "queries", label: "Queries" },
    { id: "replies", label: "Replies" }
  ],
  "app-settings": [
    { id: "providers", label: "Providers" },
    { id: "app", label: "App" }
  ]
};
