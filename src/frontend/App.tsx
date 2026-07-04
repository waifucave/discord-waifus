import { useState } from "react";
import { useRoute } from "./state/router";
import type { ViewId } from "./nav";
import { HomeScreen } from "./screens/HomeScreen";
import { ComingScreen } from "./screens/ComingScreen";
import { AssistantLauncher, AssistantPanel } from "./components/assistant/AssistantPanel";
import { OnboardingWizard } from "./components/onboarding/OnboardingWizard";
import { useApi } from "./api/useApi";
import { api } from "./api/client";
import type { ProvidersResponse } from "./api/types";

export function App() {
  const [route, navigate] = useRoute();
  const [assistantOpen, setAssistantOpen] = useState(false);
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

  return (
    <div className="frame">
      <Screen route={route} goto={goto} home={home} onAssistant={() => setAssistantOpen((v) => !v)} />

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
      return <ComingScreen title="Cast" onBack={home} />;
    case "rooms":
      return <ComingScreen title="Rooms" onBack={home} />;
    case "direction":
      return <ComingScreen title="Direction" onBack={home} />;
    case "memory":
      return <ComingScreen title="Memory" onBack={home} />;
    case "activity":
      return <ComingScreen title="Activity" onBack={home} />;
    case "settings":
      return <ComingScreen title="Settings" onBack={home} />;
    default:
      return <HomeScreen onNavigate={goto} onAssistant={onAssistant} />;
  }
}
