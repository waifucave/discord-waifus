import { useMemo } from "react";
import { ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { ProvidersResponse, RuntimeState, ServersResponse, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { DashboardView } from "./DashboardView";

type SetupStep = { key: string; title: string; done: boolean; view: ViewId; tab?: string };

/** Home = the runtime dashboard, with a setup checklist card while anything is missing. */
export function HomeView({ onNavigate }: { onNavigate: (view: ViewId, tab?: string) => void }) {
  const runtime = useApi<RuntimeState>((signal) => api.runtime(signal), []);
  const providers = useApi<ProvidersResponse>((signal) => api.providers(signal), []);
  const waifus = useApi<WaifusResponse>((signal) => api.waifus(signal), []);
  const servers = useApi<ServersResponse>((signal) => api.servers(signal), []);

  const anyProvider = providers.data?.providers.some((p) => p.credentials.configured) ?? false;
  const hasWaifu = (waifus.data?.waifus.length ?? 0) > 0;
  const orchestratorConnected = runtime.data?.discord.orchestratorConnected ?? false;
  const hasEnabledServer = useMemo(
    () =>
      (servers.data?.servers ?? []).some((s) =>
        Object.values(s.channels ?? {}).some((c) => (c.enabledWaifuIds?.length ?? 0) > 0)
      ),
    [servers.data]
  );

  const loaded = Boolean(runtime.data && providers.data && waifus.data && servers.data);
  const steps: SetupStep[] = [
    { key: "provider", title: "Add a provider API key", done: anyProvider, view: "app-settings", tab: "providers" },
    { key: "waifu", title: "Create a waifu", done: hasWaifu, view: "cast" },
    { key: "bots", title: "Connect the Discord bots", done: orchestratorConnected, view: "direction", tab: "orchestrator" },
    { key: "channel", title: "Enable waifus in a channel", done: hasEnabledServer, view: "rooms" }
  ];
  const missing = steps.filter((step) => !step.done);

  return (
    <>
      {loaded && missing.length > 0 && (
        <section className="panel setup-card">
          <div className="panel-header">
            <div>
              <h3 className="panel-title">Setup</h3>
              <p className="panel-subtitle">
                {steps.length - missing.length} of {steps.length} steps done — finish these to get the cast talking.
              </p>
            </div>
          </div>
          <div className="setup-steps">
            {steps.map((step) => (
              <button key={step.key} className="setup-step" onClick={() => onNavigate(step.view, step.tab)}>
                {step.done ? (
                  <CheckCircle2 className="icon done" />
                ) : (
                  <Circle className="icon" />
                )}
                <span className={step.done ? "done" : ""}>{step.title}</span>
                <ArrowRight className="icon go" />
              </button>
            ))}
          </div>
        </section>
      )}
      <DashboardView />
    </>
  );
}
