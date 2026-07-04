import { useApi } from "../api/useApi";
import { api } from "../api/client";
import type {
  MemoryStore,
  OrchestratorHistoryFile,
  ProvidersResponse,
  RuntimeState,
  ServersResponse,
  WaifusResponse
} from "../api/types";
import { SECTIONS, type ViewId } from "../nav";
import { FootRow } from "./scaffold";

type FeedItem = { at: string; who: string; what: string; kind: "reply" | "decision" | "memory" };

function feedFromHistory(history: OrchestratorHistoryFile | undefined): FeedItem[] {
  if (!history) return [];
  const items: FeedItem[] = [];
  for (const decision of history.decisions.slice(0, 12)) {
    const at = decision.createdAt ? new Date(decision.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    if (decision.action === "reply") {
      const who = decision.respondingWaifus?.map((w) => w.waifuId).join(", ") || "cast";
      items.push({ at, who: "director", what: `${who} replies — ${decision.reasoning ?? ""}`.slice(0, 140), kind: "decision" });
    } else {
      items.push({ at, who: "director", what: (decision.reasoning ?? "waiting").slice(0, 140), kind: "decision" });
    }
    if (items.length >= 6) break;
  }
  return items;
}

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
  const memories = useApi<MemoryStore>((s) => api.memories(s), []);
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const history = useApi<OrchestratorHistoryFile>((s) => api.orchestratorHistory(s), []);

  const cast = waifus.data?.waifus ?? [];
  const castNames = cast.map((w) => w.displayName || w.name).join(", ");
  const guilds = servers.data?.servers ?? [];
  const liveChannels = guilds.reduce(
    (sum, guild) => sum + Object.values(guild.channels ?? {}).filter((c) => (c.enabledWaifuIds?.length ?? 0) > 0).length,
    0
  );
  const memoryCount = (memories.data?.memories ?? []).filter((m) => m.status !== "archived").length;
  const anyProvider = (providers.data?.providers ?? []).some((p) => p.credentials.configured);
  const discord = runtime.data?.discord;
  const feed = feedFromHistory(history.data);

  const meta: Record<string, { text: string; needsSetup?: boolean }> = {
    cast: {
      text: cast.length ? `${cast.length} characters — ${castNames}`.slice(0, 110) : "no characters yet",
      needsSetup: cast.length === 0 || cast.some((w) => !w.modelId)
    },
    rooms: {
      text: guilds.length ? `${guilds.length} servers · ${liveChannels} channels live` : "no servers yet",
      needsSetup: guilds.length > 0 && liveChannels === 0
    },
    direction: { text: "director · stage manager · reviewer · assistant" },
    memory: { text: `${memoryCount} records` },
    activity: { text: "logs · prompts · replies" },
    settings: {
      text: anyProvider ? "providers · discord · app" : "add a provider key to start",
      needsSetup: !anyProvider
    }
  };

  const statusWord = !runtime.data ? "…" : runtime.data.paused ? "Paused" : discord?.connected ? "Live" : "Offline";
  const statusSub = runtime.data
    ? `${discord?.waifuBotCount ?? 0} bots · ${guilds.length} servers · ${cast.length} characters · ${memoryCount} memories`
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
          <span className="meta">"give nox a model", "why is lumi quiet?", "pause everything"</span>
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
        <button className="cell clickable tile" data-hue style={{ gridColumn: 3, gridRow: 2, ["--hover-hue" as string]: "var(--lavender)" }} onClick={() => onNavigate("direction")}>
          <span className="idx">04</span>
          <span className="nm">Direction</span>
          <span className="meta">{meta.direction.text}</span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 2, gridRow: 3, ["--hover-hue" as string]: "var(--butter)" }} onClick={() => onNavigate("memory")}>
          <span className="idx">05</span>
          <span className="nm">Memory</span>
          <span className="meta">{meta.memory.text}</span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 3, gridRow: 3, ["--hover-hue" as string]: "var(--peach)" }} onClick={() => onNavigate("activity")}>
          <span className="idx">06</span>
          <span className="nm">Activity</span>
          <span className="meta">{meta.activity.text}</span>
        </button>
        <button className="cell clickable tile inverts" style={{ gridColumn: 1, gridRow: 4 }} onClick={() => onNavigate("settings")}>
          <span className="idx">07</span>
          <span className="nm">Settings</span>
          <span className="meta">
            {meta.settings.text} {meta.settings.needsSetup && <span className="chip butter">needs setup</span>}
          </span>
        </button>

        <div style={{ gridColumn: 4, gridRow: "3 / 5", display: "flex", flexDirection: "column", gap: "var(--line)", background: "var(--ink)", minHeight: 0, overflow: "hidden" }}>
          <div className="cell" style={{ padding: "12px 20px 10px", flex: "none" }}>
            <span className="t-micro">Direction feed · newest first</span>
          </div>
          {feed.length === 0 && (
            <div className="cell" style={{ flex: 1, padding: 20 }}>
              <span className="t-mute t-small">No activity yet — decisions appear here once the director is running.</span>
            </div>
          )}
          {feed.map((item, index) => (
            <div className="cell" style={{ padding: "12px 20px", flex: index === feed.length - 1 ? 1 : "none" }} key={index}>
              <div className="t-micro" style={{ marginBottom: 3 }}>
                {item.at} · {item.who}
                <span className={"chip " + (item.kind === "reply" ? "mint" : item.kind === "memory" ? "butter" : "lavender")} style={{ marginLeft: 8 }}>
                  {item.kind}
                </span>
              </div>
              <div className="t-small" style={{ overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {item.what}
              </div>
            </div>
          ))}
        </div>

        <div className="cell" style={{ gridColumn: "2 / 4", gridRow: 4, display: "flex", alignItems: "flex-end", padding: "20px 26px" }}>
          <span className="t-mute t-small" style={{ lineHeight: 1.5 }}>
            Everything runs on this machine. The director decides who speaks; characters remember your server and dream at night.
          </span>
        </div>
      </div>
      <FootRow />
    </div>
  );
}
