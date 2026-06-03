import {
  Activity,
  Boxes,
  Brain,
  Cog,
  Compass,
  FileJson,
  Layers,
  MessageSquareReply,
  PlayCircle,
  ScrollText,
  Server,
  ShieldCheck,
  Sparkles
} from "lucide-react";

export type ViewId =
  | "dashboard"
  | "setup"
  | "providers"
  | "waifus"
  | "servers"
  | "orchestrator"
  | "reviewer"
  | "stage-manager"
  | "memories"
  | "logs"
  | "queries"
  | "replies"
  | "settings";

export type NavEntry = {
  id: ViewId;
  label: string;
  icon: typeof Activity;
  group: "operate" | "configure" | "diagnostics";
};

export const NAV: NavEntry[] = [
  { id: "dashboard", label: "Dashboard", icon: Activity, group: "operate" },
  { id: "setup", label: "Setup", icon: PlayCircle, group: "operate" },
  { id: "providers", label: "Providers", icon: Boxes, group: "configure" },
  { id: "waifus", label: "Waifus", icon: Sparkles, group: "configure" },
  { id: "servers", label: "Servers", icon: Server, group: "configure" },
  { id: "orchestrator", label: "Orchestrator", icon: Compass, group: "configure" },
  { id: "reviewer", label: "Reviewer", icon: ShieldCheck, group: "configure" },
  { id: "stage-manager", label: "Stage Manager", icon: Layers, group: "configure" },
  { id: "memories", label: "Memories", icon: Brain, group: "configure" },
  { id: "logs", label: "Logs", icon: ScrollText, group: "diagnostics" },
  { id: "queries", label: "Queries", icon: FileJson, group: "diagnostics" },
  { id: "replies", label: "Replies", icon: MessageSquareReply, group: "diagnostics" },
  { id: "settings", label: "Settings", icon: Cog, group: "diagnostics" }
];

export const NAV_GROUPS: Array<{ id: NavEntry["group"]; label: string }> = [
  { id: "operate", label: "Operate" },
  { id: "configure", label: "Configure" },
  { id: "diagnostics", label: "Diagnostics" }
];
