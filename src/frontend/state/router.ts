import { useEffect, useState } from "react";
import { SECTION_TABS, type ViewId } from "../nav";

const DEFAULT: ViewId = "home";
const VALID: ReadonlySet<ViewId> = new Set<ViewId>([
  "home",
  "cast",
  "rooms",
  "direction",
  "memory",
  "activity",
  "app-settings"
]);

/** Pre-redesign routes keep working: old hash → new section (+ tab). */
const LEGACY: Record<string, { view: ViewId; tab?: string }> = {
  dashboard: { view: "home" },
  setup: { view: "home" },
  waifus: { view: "cast" },
  servers: { view: "rooms" },
  orchestrator: { view: "direction", tab: "orchestrator" },
  "stage-manager": { view: "direction", tab: "stage-manager" },
  reviewer: { view: "direction", tab: "reviewer" },
  memories: { view: "memory" },
  logs: { view: "activity", tab: "logs" },
  queries: { view: "activity", tab: "queries" },
  replies: { view: "activity", tab: "replies" },
  providers: { view: "app-settings", tab: "providers" },
  settings: { view: "app-settings", tab: "app" }
};

export type Route = { view: ViewId; tab?: string };

function defaultTab(view: ViewId): string | undefined {
  return SECTION_TABS[view]?.[0]?.id;
}

function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const tabParam = new URLSearchParams(queryPart ?? "").get("tab") ?? undefined;
  const path = pathPart ?? "";
  if (VALID.has(path as ViewId)) {
    const view = path as ViewId;
    const tabs = SECTION_TABS[view];
    const tab = tabs?.some((t) => t.id === tabParam) ? tabParam : defaultTab(view);
    return { view, tab };
  }
  const legacy = LEGACY[path];
  if (legacy) return { view: legacy.view, tab: legacy.tab ?? defaultTab(legacy.view) };
  return { view: DEFAULT, tab: defaultTab(DEFAULT) };
}

function hashFor(view: ViewId, tab?: string): string {
  const tabs = SECTION_TABS[view];
  const effective = tabs?.some((t) => t.id === tab) ? tab : undefined;
  return effective && effective !== tabs?.[0]?.id ? `#/${view}?tab=${effective}` : `#/${view}`;
}

export function useRoute(): [Route, (view: ViewId, tab?: string) => void] {
  const [route, setRoute] = useState<Route>(readHash);
  useEffect(() => {
    const handler = () => setRoute(readHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const navigate = (view: ViewId, tab?: string) => {
    const next = hashFor(view, tab);
    if (window.location.hash !== next) {
      window.location.hash = next;
    } else {
      setRoute(readHash());
    }
  };
  return [route, navigate];
}
