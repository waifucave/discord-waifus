import { useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, CheckCircle2, Circle } from "lucide-react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  DiscordBotsFile,
  ProvidersResponse,
  RuntimeState,
  ServersResponse,
  WaifusResponse
} from "../api/types";
import { Notice } from "../components/Notice";
import { Pill } from "../components/Pill";
import { Skeleton } from "../components/Skeleton";
import { DiscordBotGuide } from "../components/DiscordBotGuide";

export function SetupView({ onNavigate }: { onNavigate: (view: string) => void }) {
  const runtime = useApi<RuntimeState>((signal) => api.runtime(signal), []);
  const providers = useApi<ProvidersResponse>((signal) => api.providers(signal), []);
  const waifus = useApi<WaifusResponse>((signal) => api.waifus(signal), []);
  const servers = useApi<ServersResponse>((signal) => api.servers(signal), []);
  const bots = useApi<DiscordBotsFile>((signal) => api.discordBots(signal), []);
  const [intentAcknowledged, setIntentAcknowledged] = useState(false);

  const dataRoot = runtime.data?.dataRoot;
  const dataRootReady = Boolean(dataRoot);
  const orchestratorConnected = runtime.data?.discord.orchestratorConnected ?? false;
  const anyProvider = providers.data?.providers.some((p) => p.credentials.configured) ?? false;
  const hasWaifu = (waifus.data?.waifus.length ?? 0) > 0;
  const hasEnabledServer = useMemo(
    () =>
      (servers.data?.servers ?? []).some(
        (s) => Object.values(s.channels ?? {}).some((c) => (c.enabledWaifuIds?.length ?? 0) > 0)
      ),
    [servers.data]
  );

  const steps: Array<{ key: string; title: string; desc: string; done: boolean; action: () => void; actionLabel: string }> = [
    {
      key: "data",
      title: "Data directory",
      desc: dataRoot ? `Backend reports ${dataRoot}.` : "Data directory not detected yet.",
      done: dataRootReady,
      action: () => onNavigate("settings"),
      actionLabel: "View settings"
    },
    {
      key: "orchestrator",
      title: "Orchestrator bot",
      desc: orchestratorConnected
        ? "Orchestrator bot is connected to Discord."
        : bots.data?.orchestrator?.tokenConfigured
        ? "Token is saved but the runtime hasn't connected yet. Verify the token and intents."
        : "Create a Discord application in the Developer Portal, copy its Application ID and bot token into Orchestrator, then invite the bot to your server.",
      done: orchestratorConnected,
      action: () => onNavigate("orchestrator"),
      actionLabel: "Configure bot"
    },
    {
      key: "intent",
      title: "Message Content Intent",
      desc: "Enable MESSAGE_CONTENT in the Discord Developer Portal for both orchestrator and waifu bots.",
      done: intentAcknowledged,
      action: () => setIntentAcknowledged(true),
      actionLabel: intentAcknowledged ? "Acknowledged" : "Mark as enabled"
    },
    {
      key: "providers",
      title: "Provider API key",
      desc: anyProvider
        ? "At least one provider has credentials configured."
        : "Add at least one provider API key (x.ai, DeepSeek, Anthropic, OpenAI, Z.AI).",
      done: anyProvider,
      action: () => onNavigate("providers"),
      actionLabel: "Open providers"
    },
    {
      key: "waifu",
      title: "First waifu",
      desc: hasWaifu
        ? "Waifus exist - pick a model, persona, and link each one to its Discord bot in Waifus."
        : "Create your first waifu. Each waifu posts as its own Discord application — register it the same way as the orchestrator (separate token + intents).",
      done: hasWaifu,
      action: () => onNavigate("waifus"),
      actionLabel: "Open waifus"
    },
    {
      key: "server",
      title: "Server / channel enablement",
      desc: hasEnabledServer
        ? "At least one channel has a waifu selected."
        : "Invite the orchestrator and waifu bots to your Discord server, then choose which waifus are allowed in each channel.",
      done: hasEnabledServer,
      action: () => onNavigate("servers"),
      actionLabel: "Open servers"
    }
  ];

  const completed = steps.filter((s) => s.done).length;

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Setup</h2>
          <p className="view-subtitle">
            {completed} of {steps.length} steps complete.
          </p>
        </div>
      </div>

      <Notice tone="warn" title="Message Content Intent is required">
        Discord's <code>MESSAGE_CONTENT</code> intent is privileged. Without it, waifu bots receive
        empty channel context except for DMs, mentions, and message-context targets. Enable it in
        the Discord Developer Portal under <em>Bot → Privileged Gateway Intents</em> for every bot
        (orchestrator + each waifu).
      </Notice>

      <section className="section" style={{ marginTop: 16 }}>
        <div className="section-header">
          <h3 className="section-title">Discord setup walkthrough</h3>
          <span className="section-description">
            Same steps apply to the orchestrator and each waifu bot — they're separate Discord
            applications.
          </span>
        </div>
        <DiscordBotGuide
          kind="orchestrator"
          applicationId={bots.data?.orchestrator?.applicationId}
          botDisplayName={bots.data?.orchestrator?.displayName ?? "Orchestrator"}
          collapsedByDefault={Boolean(bots.data?.orchestrator?.tokenConfigured)}
        />
        {(bots.data?.waifus?.length ?? 0) > 0 && (
          <div style={{ marginTop: 12 }}>
            <Notice tone="info">
              Repeat the same steps for every waifu bot in the <strong>Waifus</strong> editor.
              Each waifu can have its own avatar, banner, and Discord display name.
            </Notice>
          </div>
        )}
      </section>

      <div className="stepper" style={{ marginTop: 16 }}>
        {steps.map((step, i) => (
          <div key={step.key} className={"step" + (step.done ? " complete" : "")}>
            <span className="num">
              {step.done ? (
                <CheckCircle2 className="icon" style={{ color: "var(--ok)" }} />
              ) : (
                <Circle className="icon" />
              )}
            </span>
            <div className="body">
              <div className="head">
                <span className="step-title">
                  {i + 1}. {step.title}
                </span>
                {step.done ? (
                  <Pill tone="ok" dot>
                    Done
                  </Pill>
                ) : (
                  <Pill tone="warn" dot>
                    Pending
                  </Pill>
                )}
              </div>
              <div className="step-desc">{step.desc}</div>
              <div>
                <button className="btn sm" onClick={step.action}>
                  {step.actionLabel}
                  <ArrowRight className="icon" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-header">
          <h3 className="section-title">Required intents and permissions</h3>
          <span className="section-description">From Discord developer docs.</span>
        </div>
        <div className="kv">
          <span className="k">Gateway intents</span>
          <span className="v">
            GUILDS · GUILD_MESSAGES · GUILD_MESSAGE_REACTIONS · MESSAGE_CONTENT (privileged) ·
            GUILD_MEMBERS (optional, privileged)
          </span>
          <span className="k">Bot permissions</span>
          <span className="v">VIEW_CHANNEL · SEND_MESSAGES · READ_MESSAGE_HISTORY · ADD_REACTIONS</span>
          <span className="k">Application commands</span>
          <span className="v">Slash commands for setup, enable channel, pause/resume, trigger.</span>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Runtime snapshot</h3>
          <span className="section-description">Live values from the backend.</span>
        </div>
        {runtime.loading && <Skeleton height={60} />}
        {runtime.data && (
          <div className="kv">
            <span className="k">Data root</span>
            <span className="v" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
              {runtime.data.dataRoot}
            </span>
            <span className="k">HTTP port</span>
            <span className="v">{runtime.data.port}</span>
            <span className="k">Discord</span>
            <span className="v">
              {runtime.data.discord.connected ? "connected" : "offline"} · orchestrator{" "}
              {runtime.data.discord.orchestratorConnected ? "online" : "offline"} ·{" "}
              {runtime.data.discord.waifuBotCount} waifu bots
            </span>
            {runtime.data.discord.warnings.length > 0 && (
              <>
                <span className="k">Warnings</span>
                <span className="v" style={{ color: "var(--warn)" }}>
                  <AlertTriangle
                    className="icon"
                    style={{ width: 12, height: 12, verticalAlign: "-2px", marginRight: 4 }}
                  />
                  {runtime.data.discord.warnings.join("; ")}
                </span>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
