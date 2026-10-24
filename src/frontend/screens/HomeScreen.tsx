import { useApi } from "../api/useApi";
import { api } from "../api/client";
import type { ProvidersResponse, RuntimeState, ServersResponse, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { FootRow } from "./scaffold";

export function HomeScreen({
  onNavigate,
  onAssistant
}: {
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onAssistant: () => void;
}) {
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);

  const cast = waifus.data?.waifus ?? [];
  const castNames = cast.map((w) => w.displayName || w.name).join(", ");
  const guilds = servers.data?.servers ?? [];
  const liveChannels = guilds.reduce(
    (sum, guild) => sum + Object.values(guild.channels ?? {}).filter((c) => (c.enabledWaifuIds?.length ?? 0) > 0).length,
    0
  );
  const anyProvider = (providers.data?.providers ?? []).some((p) => p.credentials.configured);
  const discord = runtime.data?.discord;
  const warnings = runtime.data?.models?.warnings ?? [];

  const meta: Record<string, { text: string; needsSetup?: boolean }> = {
    cast: {
      text: cast.length ? `${cast.length} characters — ${castNames}`.slice(0, 110) : "no characters yet",
      needsSetup: cast.length === 0 || cast.some((w) => !w.model)
    },
    rooms: {
      text: guilds.length ? `${guilds.length} servers · ${liveChannels} channels live` : "no servers yet",
      needsSetup: guilds.length > 0 && liveChannels === 0
    },
    activity: { text: "logs · queries · events" },
    settings: {
      text: anyProvider ? "providers · assistant · app" : "add a provider key to start",
      needsSetup: !anyProvider
    }
  };

  const statusWord = !runtime.data ? "…" : runtime.data.paused ? "Paused" : discord?.connected ? "Live" : "Offline";
  const statusSub = runtime.data
    ? `${discord?.waifuBotCount ?? 0} bots · ${guilds.length} servers · ${cast.length} characters`
    : "connecting to the backend…";

  return (
    <div className="screen" id="home-screen">
      <div
        className="mosaic"
        style={{
          flex: 1,
          gridTemplateColumns: "1.6fr 1fr 1fr 1.2fr",
          gridTemplateRows: "96px 1fr 1fr 1fr",
          minHeight: 0
        }}
      >
        <div className="cell" style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 26px" }}>
          <span className="mark">W</span>
          <span className="t-title">Discord Waifus</span>
        </div>
        <div className="cell" style={{ gridColumn: "2 / 4", display: "flex", alignItems: "center", gap: 18, padding: "0 26px", overflow: "hidden" }}>
          <span className="t-hero">{statusWord}</span>
          <span className="t-mute t-small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{statusSub}</span>
        </div>
        <button
          className="cell clickable tile"
          data-hue
          style={{ gridColumn: 4, gridRow: "1 / 3", ["--hover-hue" as string]: "var(--pink)" }}
          onClick={onAssistant}
        >
          <span className="t-micro">Ask · change · fix</span>
          <span className="t-big">Assistant</span>
          <span className="meta">"give Aria a model", "why is Riko quiet?", "pause everything"</span>
        </button>

        <button
          className="cell clickable tile"
          data-hue
          style={{ gridColumn: 1, gridRow: "2 / 4", ["--hover-hue" as string]: "var(--mint)" }}
          onClick={() => onNavigate("cast")}
        >
          <span className="idx">02</span>
          <span className="nm" style={{ fontSize: 46 }}>Cast</span>
          <span className="meta">
            {meta.cast.text} {meta.cast.needsSetup && <span className="chip butter">needs setup</span>}
          </span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 2, gridRow: 2, ["--hover-hue" as string]: "var(--sky)" }} onClick={() => onNavigate("rooms")}>
          <span className="idx">03</span>
          <span className="nm">Rooms</span>
          <span className="meta">
            {meta.rooms.text} {meta.rooms.needsSetup && <span className="chip butter">enable a channel</span>}
          </span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 3, gridRow: 2, ["--hover-hue" as string]: "var(--peach)" }} onClick={() => onNavigate("activity")}>
          <span className="idx">04</span>
          <span className="nm">Activity</span>
          <span className="meta">{meta.activity.text}</span>
        </button>
        <div className="cell" style={{ gridColumn: "2 / 4", gridRow: 3, display: "flex", flexDirection: "column", justifyContent: "flex-end", gap: 6, padding: "20px 26px" }}>
          <span className="t-micro">Living cast · in progress</span>
          <span className="t-small" style={{ lineHeight: 1.5 }}>
            The cast is being rebuilt to live on its own. Until that lands, characters do not answer in Discord or
            DMs; configuration keeps working.
          </span>
        </div>
        <button className="cell clickable tile inverts" style={{ gridColumn: 1, gridRow: 4 }} onClick={() => onNavigate("settings")}>
          <span className="idx">05</span>
          <span className="nm">Settings</span>
          <span className="meta">
            {meta.settings.text} {meta.settings.needsSetup && <span className="chip butter">needs setup</span>}
          </span>
        </button>

        <div style={{ gridColumn: 4, gridRow: "3 / 5", display: "flex", flexDirection: "column", gap: "var(--line)", background: "var(--ink)", minHeight: 0, overflow: "hidden" }}>
          <div className="cell" style={{ padding: "12px 20px 10px", flex: "none" }}>
            <span className="t-micro">Model notices</span>
          </div>
          {warnings.length === 0 && (
            <div className="cell" style={{ flex: 1, padding: 20 }}>
              <span className="t-mute t-small">Every stored model choice is on the curated list.</span>
            </div>
          )}
          {warnings.slice(0, 6).map((warning, index, shown) => (
            <div className="cell" style={{ padding: "12px 20px", flex: index === shown.length - 1 ? 1 : "none" }} key={`${warning.scope}-${warning.code}-${index}`}>
              <div className="t-micro" style={{ marginBottom: 3 }}>
                {warning.scope}
                <span className="chip butter" style={{ marginLeft: 8 }}>{warning.code}</span>
              </div>
              <div className="t-small" style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {warning.detail}
              </div>
            </div>
          ))}
        </div>

        <div className="cell" style={{ gridColumn: "2 / 4", gridRow: 4, display: "flex", alignItems: "flex-end", padding: "20px 26px" }}>
          <span className="t-mute t-small" style={{ lineHeight: 1.5 }}>
            Everything runs on this machine. Each character has her own persona, model and Discord bot.
          </span>
        </div>
      </div>
      <FootRow />
    </div>
  );
}
