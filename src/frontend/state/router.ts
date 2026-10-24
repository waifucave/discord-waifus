import { useEffect, useState } from "react";
import { SECTION_TABS, type ViewId } from "../nav";

const DEFAULT: ViewId = "home";
const VALID: ReadonlySet<ViewId> = new Set<ViewId>([
  "home",
  "cast",
  "rooms",
  "activity",
  "settings"
]);

/** Every pre-rebuild route keeps working. */
const LEGACY: Record<string, { view: ViewId; tab?: string }> = {
  dashboard: { view: "home" },
  setup: { view: "home" },
  waifus: { view: "cast" },
  servers: { view: "rooms" },
  // Living cast L1 retired Direction and Memory; their links land somewhere still meaningful.
  direction: { view: "settings", tab: "assistant" },
  memory: { view: "home" },
  orchestrator: { view: "home" },
  "stage-manager": { view: "home" },
  reviewer: { view: "home" },
  memories: { view: "home" },
  logs: { view: "activity", tab: "logs" },
  queries: { view: "activity", tab: "queries" },
  replies: { view: "activity", tab: "replies" },
  providers: { view: "settings", tab: "providers" },
  "app-settings": { view: "settings" }
};

export type Route = { view: ViewId; tab?: string; id?: string };

function defaultTab(view: ViewId): string | undefined {
  return SECTION_TABS[view]?.[0]?.id;
}

function readHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const params = new URLSearchParams(queryPart ?? "");
  const tabParam = params.get("tab") ?? undefined;
  const idParam = params.get("id") ?? undefined;
  const path = pathPart ?? "";
  if (VALID.has(path as ViewId)) {
    const view = path as ViewId;
    const tabs = SECTION_TABS[view];
    const tab = tabs?.some((t) => t.id === tabParam) ? tabParam : defaultTab(view);
    return { view, tab, id: idParam };
  }
  const legacy = LEGACY[path];
  if (legacy) return { view: legacy.view, tab: legacy.tab ?? defaultTab(legacy.view) };
  return { view: DEFAULT };
}

function hashFor(view: ViewId, tab?: string, id?: string): string {
  const tabs = SECTION_TABS[view];
  const effectiveTab = tabs?.some((t) => t.id === tab) && tab !== tabs?.[0]?.id ? tab : undefined;
  const query = new URLSearchParams();
  if (effectiveTab) query.set("tab", effectiveTab);
  if (id) query.set("id", id);
  const qs = query.toString();
  return qs ? `#/${view}?${qs}` : `#/${view}`;
}

export function useRoute(): [Route, (view: ViewId, tab?: string, id?: string) => void] {
  const [route, setRoute] = useState<Route>(readHash);
  useEffect(() => {
    const handler = () => setRoute(readHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const navigate = (view: ViewId, tab?: string, id?: string) => {
    const next = hashFor(view, tab, id);
    if (window.location.hash !== next) {
      window.location.hash = next;
    } else {
      setRoute(readHash());
    }
  };
  return [route, navigate];
}
