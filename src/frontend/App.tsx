import { useState } from "react";
import { Menu, X } from "lucide-react";
import { NAV, type ViewId } from "./nav";
import { useRoute, type Route } from "./state/router";
import { useRuntimeStatus } from "./state/runtimeStore";
import { Pill } from "./components/Pill";
import { HomeView } from "./views/HomeView";
import { WaifusView } from "./views/WaifusView";
import { ServersView } from "./views/ServersView";
import { DirectionView } from "./views/DirectionView";
import { MemoriesView } from "./views/MemoriesView";
import { ActivityView } from "./views/ActivityView";
import { SettingsSectionView } from "./views/SettingsSectionView";
import { AssistantLauncher, AssistantPanel } from "./components/assistant/AssistantPanel";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { useApi } from "./api/useApi";
import { api } from "./api/client";
import type { ProvidersResponse } from "./api/types";

export function App() {
  const [route, navigate] = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(() => localStorage.getItem("onboarding-dismissed") === "1");
  const [onboardingForced, setOnboardingForced] = useState(() => localStorage.getItem("onboarding-force") === "1");
  const providersState = useApi<ProvidersResponse>((s) => api.providers(s), [onboardingDone]);
  const needsOnboarding =
    onboardingForced ||
    (!onboardingDone &&
      providersState.data !== undefined &&
      !providersState.data.providers.some((p) => p.credentials.configured));
  const status = useRuntimeStatus();
  const discordConnecting = status?.discord.connecting ?? false;

  const goto = (next: ViewId, tab?: string) => {
    navigate(next, tab);
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
          <div className="nav-section-label">Control</div>
          {NAV.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                className={"nav-item" + (route.view === entry.id ? " active" : "")}
                onClick={() => goto(entry.id)}
              >
                <Icon className="icon" />
                <span>{entry.label}</span>
              </button>
            );
          })}
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
            {status?.discord.connected
              ? "Discord connected"
              : discordConnecting
                ? "Discord connecting"
                : "Discord offline"}
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
        <h1>{NAV.find((n) => n.id === route.view)?.label ?? "Home"}</h1>
        <div className="topbar-spacer" />
        <div className="topbar-status">
          {status?.discord.connected ? (
            <Pill tone="ok" dot>
              Discord
            </Pill>
          ) : discordConnecting ? (
            <Pill tone="info" dot>
              Discord connecting
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

      {!needsOnboarding && (
        <>
          <AssistantLauncher open={assistantOpen} onToggle={() => setAssistantOpen((v) => !v)} />
          <AssistantPanel open={assistantOpen} onClose={() => setAssistantOpen(false)} onNavigate={goto} />
        </>
      )}
      {needsOnboarding && (
        <OnboardingWizard
          onDone={() => {
            localStorage.removeItem("onboarding-force");
            setOnboardingForced(false);
            setOnboardingDone(true);
          }}
        />
      )}
    </div>
  );
}

function ViewSwitch({ route, navigate }: { route: Route; navigate: (next: ViewId, tab?: string) => void }) {
  const onTab = (tab: string) => navigate(route.view, tab);
  switch (route.view) {
    case "home":
      return <HomeView onNavigate={navigate} />;
    case "cast":
      return <WaifusView />;
    case "rooms":
      return <ServersView />;
    case "direction":
      return <DirectionView tab={route.tab} onTab={onTab} />;
    case "memory":
      return <MemoriesView />;
    case "activity":
      return <ActivityView tab={route.tab} onTab={onTab} />;
    case "app-settings":
      return <SettingsSectionView tab={route.tab} onTab={onTab} />;
    default:
      return <HomeView onNavigate={navigate} />;
  }
}
