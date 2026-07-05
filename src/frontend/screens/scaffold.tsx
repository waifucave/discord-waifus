import { useState, type ReactNode } from "react";
import { useApi } from "../api/useApi";
import { api } from "../api/client";
import type { ProvidersResponse, RuntimeState } from "../api/types";
import { SECTION_TABS, type ViewId } from "../nav";

/** Header row: [← back][title · sub][optional action cell] */
export function HeadRow({
  onBack,
  title,
  sub,
  action
}: {
  onBack: () => void;
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className={"headrow" + (action ? "" : " no-action")}>
      <button className="cell clickable backcell" data-hue onClick={onBack} aria-label="Back">
        ←
      </button>
      <div className="cell titlecell">
        <span className="t-big">{title}</span>
        {sub && <span className="sub">{sub}</span>}
      </div>
      {action}
    </div>
  );
}

/** Tab cells for sections with tabs (Direction, Activity, Settings). */
export function TabCells({
  view,
  active,
  onTab
}: {
  view: ViewId;
  active: string | undefined;
  onTab: (tab: string) => void;
}) {
  const tabs = SECTION_TABS[view] ?? [];
  return (
    <div className="tabcells" style={{ height: 64, flex: "none" }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={"cell clickable tabcell" + (tab.id === active ? " on" : "")}
          data-hue
          onClick={() => onTab(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** Bottom status strip, shared by every screen. */
export function FootRow() {
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const configured = (providers.data?.providers ?? []).filter((p) => p.credentials.configured).map((p) => p.id);
  const discord = runtime.data?.discord;
  return (
    <div className="footrow">
      <div className="cell t-micro">
        {runtime.data ? `${runtime.data.paused ? "paused" : "running"} · ${runtime.data.packageVersion}` : "…"}
      </div>
      <div className="cell t-micro">{configured.length ? configured.join(" · ") + " ok" : "no providers"}</div>
      <div className="cell t-micro">
        {discord?.connected ? "discord connected" : discord?.connecting ? "discord connecting" : "discord offline"}
      </div>
      <div className="cell t-micro">{runtime.data ? `${runtime.data.queues.active} queues` : ""}</div>
    </div>
  );
}

/** Collapsed-by-default stripe for advanced content; expands in place. */
export function Disclosure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="disclosure-head" style={{ flex: "none" }} onClick={() => setOpen((v) => !v)}>
        <span className="t-micro" style={{ color: "var(--ink)" }}>{title}</span>
        <span>
          {hint && <span className="t-micro" style={{ marginRight: 14 }}>{hint}</span>}
          <span className="caret">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && children}
    </>
  );
}
