import { useState } from "react";
import { Menu, X } from "lucide-react";
import { NAV, NAV_GROUPS, type ViewId } from "./nav";
import { useRoute } from "./state/router";
import { useRuntimeStatus } from "./state/runtimeStore";
import { Pill } from "./components/Pill";
import { DashboardView } from "./views/DashboardView";
import { SetupView } from "./views/SetupView";
import { ProvidersView } from "./views/ProvidersView";
import { WaifusView } from "./views/WaifusView";
import { ServersView } from "./views/ServersView";
import { OrchestratorView } from "./views/OrchestratorView";
import { ReviewerView } from "./views/ReviewerView";
import { StageManagerView } from "./views/StageManagerView";
import { MemoriesView } from "./views/MemoriesView";
import { LogsView } from "./views/LogsView";
import { QueriesView } from "./views/QueriesView";
import { SettingsView } from "./views/SettingsView";

export function App() {
  const [route, navigate] = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const status = useRuntimeStatus();

  const goto = (next: ViewId) => {
    navigate(next);
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      <aside className={"sidebar" + (menuOpen ? " open" : "")}>
        <div className="brand">
          <span className="brand-mark">W</span>
          <span>Discord Waifus</span>
          <span style={{ flex: 1 }} />
          <button
            className="btn ghost sm"
            style={{ display: menuOpen ? "inline-flex" : "none" }}
            onClick={() => setMenuOpen(false)}
            aria-label="Close menu"
          >
            <X className="icon" />
          </button>
        </div>
        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div key={group.id}>
              <div className="nav-section-label">{group.label}</div>
              {NAV.filter((e) => e.group === group.id).map((entry) => {
                const Icon = entry.icon;
                return (
                  <button
                    key={entry.id}
                    className={"nav-item" + (route === entry.id ? " active" : "")}
                    onClick={() => goto(entry.id)}
                  >
                    <Icon className="icon" />
                    <span>{entry.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div>
            {status ? (
              <Pill tone={status.paused ? "warn" : "ok"} dot>
                {status.paused ? "Paused" : "Running"}
              </Pill>
            ) : (
              <Pill tone="neutral" dot>
                Offline
              </Pill>
            )}
          </div>
          <div>
            {status?.discord.connected ? "Discord connected" : "Discord offline"}
          </div>
          <div>{status ? `${status.queues.active} active queues` : ""}</div>
        </div>
      </aside>
      <div
        className={"menu-backdrop" + (menuOpen ? " open" : "")}
        onClick={() => setMenuOpen(false)}
      />

      <header className="topbar">
        <button
          className="btn ghost sm menu-btn"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="icon" />
        </button>
        <h1>{NAV.find((n) => n.id === route)?.label ?? "Dashboard"}</h1>
        <div className="topbar-spacer" />
        <div className="topbar-status">
          {status?.discord.connected ? (
            <Pill tone="ok" dot>
              Discord
            </Pill>
          ) : (
            <Pill tone="warn" dot>
              Discord offline
            </Pill>
          )}
          {status && (
            <Pill tone="info" dot>
              {status.queues.active} queues
            </Pill>
          )}
          {status ? (
            <Pill tone={status.paused ? "warn" : "ok"} dot>
              {status.paused ? "Paused" : "Running"}
            </Pill>
          ) : (
            <Pill tone="neutral" dot>
              Connecting…
            </Pill>
          )}
        </div>
      </header>

      <main className="main">
        <ViewSwitch route={route} navigate={goto} />
      </main>
    </div>
  );
}

function ViewSwitch({ route, navigate }: { route: ViewId; navigate: (next: ViewId) => void }) {
  switch (route) {
    case "dashboard":
      return <DashboardView />;
    case "setup":
      return <SetupView onNavigate={(v) => navigate(v as ViewId)} />;
    case "providers":
      return <ProvidersView />;
    case "waifus":
      return <WaifusView />;
    case "servers":
      return <ServersView />;
    case "orchestrator":
      return <OrchestratorView />;
    case "reviewer":
      return <ReviewerView />;
    case "stage-manager":
      return <StageManagerView />;
    case "memories":
      return <MemoriesView />;
    case "logs":
      return <LogsView />;
    case "queries":
      return <QueriesView />;
    case "settings":
      return <SettingsView />;
    default:
      return <DashboardView />;
  }
}
