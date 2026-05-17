import { useEffect, useState } from "react";
import type { ViewId } from "../nav";

const DEFAULT: ViewId = "dashboard";
const VALID: ReadonlySet<ViewId> = new Set<ViewId>([
  "dashboard",
  "setup",
  "providers",
  "waifus",
  "servers",
  "orchestrator",
  "reviewer",
  "stage-manager",
  "memories",
  "logs",
  "queries",
  "settings"
]);

function readHash(): ViewId {
  const raw = window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return VALID.has(raw as ViewId) ? (raw as ViewId) : DEFAULT;
}

export function useRoute(): [ViewId, (next: ViewId) => void] {
  const [view, setView] = useState<ViewId>(readHash);
  useEffect(() => {
    const handler = () => setView(readHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  const navigate = (next: ViewId) => {
    if (window.location.hash !== `#/${next}`) {
      window.location.hash = `#/${next}`;
    } else {
      setView(next);
    }
  };
  return [view, navigate];
}
