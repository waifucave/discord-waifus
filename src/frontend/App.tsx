import { useState, type ReactNode } from "react";
import { useRoute } from "./state/router";
import type { ViewId } from "./nav";
import { HomeScreen } from "./screens/HomeScreen";
import { CastScreen } from "./screens/CastScreen";
import { LifeScreen } from "./screens/LifeScreen";
import { RoomsScreen } from "./screens/RoomsScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { AssistantLauncher, AssistantPanel } from "./components/assistant/AssistantPanel";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { useApi } from "./api/useApi";
import { api, loadClientContext } from "./api/client";
import type { ProvidersResponse } from "./api/types";
import { RemoteConnectionBanner } from "./components/RemoteConnectionBanner";
import { ClientContextProvider, useClientContext } from "./state/clientContext";
import { readAssistantOpen, shellClassName, writeAssistantOpen } from "./state/assistantDock";

export function App() {
  return (
    <ClientContextProvider loadContext={loadClientContext}>
      <ReadyApp />
    </ClientContextProvider>
  );
}

function ReadyApp() {
  const clientContext = useClientContext();
  const [route, navigate] = useRoute();
  const [assistantOpen, setAssistantOpenState] = useState(readAssistantOpen);
  const setAssistantOpen = (open: boolean) => {
    setAssistantOpenState(open);
    writeAssistantOpen(open);
  };
  const [onboardingDone, setOnboardingDone] = useState(() => localStorage.getItem("onboarding-dismissed") === "1");
  const [onboardingForced, setOnboardingForced] = useState(() => localStorage.getItem("onboarding-force") === "1");
  const providersState = useApi<ProvidersResponse>((s) => api.providers(s), [onboardingDone]);
  const needsOnboarding =
    onboardingForced ||
    (!onboardingDone &&
      providersState.data !== undefined &&
      !providersState.data.providers.some((p) => p.credentials.configured));

  const goto = (view: ViewId, tab?: string, id?: string) => navigate(view, tab, id);
  const home = () => navigate("home");

  const docked = assistantOpen && !needsOnboarding;
  return (
    <AppShell
      assistantOpen={docked}
      panel={<AssistantPanel open={docked} onClose={() => setAssistantOpen(false)} onNavigate={goto} />}
    >
      <RemoteConnectionBanner context={clientContext} />
      <Screen route={route} goto={goto} home={home} onAssistant={() => setAssistantOpen(true)} />

      {!needsOnboarding && <AssistantLauncher open={assistantOpen} onToggle={() => setAssistantOpen(!assistantOpen)} />}
      {needsOnboarding && (
        <OnboardingWizard
          onDone={() => {
            localStorage.removeItem("onboarding-force");
            setOnboardingForced(false);
            setOnboardingDone(true);
          }}
        />
      )}
    </AppShell>
  );
}

/**
 * The page layout: the main column, and the assistant docked beside it while it is open (the main
 * column gives it room and reflows narrower). Below ~900 px the panel is a full-width sheet (CSS).
 */
export function AppShell({ assistantOpen, panel, children }: { assistantOpen: boolean; panel: ReactNode; children: ReactNode }) {
  return (
    <div className={shellClassName(assistantOpen)}>
      <div className="frame">{children}</div>
      {assistantOpen && panel}
    </div>
  );
}

function Screen({
  route,
  goto,
  home,
  onAssistant
}: {
  route: ReturnType<typeof useRoute>[0];
  goto: (view: ViewId, tab?: string, id?: string) => void;
  home: () => void;
  onAssistant: () => void;
}) {
  switch (route.view) {
    case "home":
      return <HomeScreen onNavigate={goto} onAssistant={onAssistant} />;
    case "cast":
      return <CastScreen characterId={route.id} onNavigate={goto} />;
    case "life":
      return <LifeScreen waifuId={route.id} onNavigate={goto} />;
    case "rooms":
      return <RoomsScreen guildId={route.id} onNavigate={goto} />;
    case "activity":
      return <ActivityScreen tab={route.tab} onNavigate={goto} onTab={(tab) => goto("activity", tab)} />;
    case "settings":
      return <SettingsScreen tab={route.tab} onNavigate={goto} onTab={(tab) => goto("settings", tab)} />;
    default:
      return <HomeScreen onNavigate={goto} onAssistant={onAssistant} />;
  }
}
