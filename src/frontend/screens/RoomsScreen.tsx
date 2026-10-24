import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { DetectorConfigResponse, DetectorHistoryEntry, ServerConfig, ServersResponse, WaifusResponse } from "../api/types";
import { characterHue, type ViewId } from "../nav";
import { FootRow, HeadRow } from "./scaffold";
import { Notice } from "../components/Notice";

export function RoomsScreen({
  guildId,
  onNavigate
}: {
  guildId?: string;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
}) {
  if (guildId) return <GuildScreen guildId={guildId} onNavigate={onNavigate} />;
  return <GuildMosaic onNavigate={onNavigate} />;
}

function GuildMosaic({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const guilds = servers.data?.servers ?? [];
  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("home")} title="Rooms" sub={`${guilds.length} servers`} />
      <div className="content">
        {guilds.length === 0 && (
          <div className="cell growcell" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
            <span className="t-mute t-small" style={{ maxWidth: 460, textAlign: "center", lineHeight: 1.6 }}>
              No servers yet. When the House bot connects to Discord and is in a server, it appears here.
            </span>
          </div>
        )}
        {guilds.length > 0 && (
          <div className="mosaic" style={{ flex: 1, gridTemplateColumns: "repeat(3, 1fr)", gridAutoRows: "minmax(200px, 1fr)" }}>
            {guilds.map((guild, index) => {
              const channels = Object.values(guild.channels ?? {});
              const live = channels.filter((c) => (c.enabledWaifuIds?.length ?? 0) > 0);
              return (
                <button
                  key={guild.guildId}
                  className="cell clickable tile"
                  data-hue
                  style={{ ["--hover-hue" as string]: "var(--sky)", gridColumn: index === 0 ? "span 2" : undefined }}
                  onClick={() => onNavigate("rooms", undefined, guild.guildId)}
                >
                  <div>
                    <span className="nm" style={{ fontSize: index === 0 ? 44 : 30 }}>{guild.name ?? guild.guildId}</span>
                    <div className="t-micro" style={{ marginTop: 8 }}>{guild.guildId}</div>
                  </div>
                  <span className="meta">
                    {live.length} of {channels.length} channels live{guild.paused && " · paused"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <FootRow />
    </div>
  );
}

function GuildScreen({ guildId, onNavigate }: { guildId: string; onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const server = useApi<ServerConfig>((s) => api.server(guildId, s), [guildId]);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const detector = useApi<DetectorConfigResponse>((s) => api.detectorConfig(s), []);
  const history = useApi<{ guildId: string; entries: DetectorHistoryEntry[] }>((s) => api.detectorHistory(guildId, s), [guildId]);
  const [detectorDraft, setDetectorDraft] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const cast = waifus.data?.waifus ?? [];
  const channels = Object.values(server.data?.channels ?? {});

  const toggleWaifu = async (channelId: string, waifuId: string) => {
    if (!server.data) return;
    const channel = server.data.channels[channelId];
    const current = channel?.enabledWaifuIds ?? [];
    const next = current.includes(waifuId) ? current.filter((id) => id !== waifuId) : [...current, waifuId];
    await saveChannel(channelId, { enabledWaifuIds: next });
  };

  // A channel write sends only the field that changed (the others keep their values).
  const saveChannel = async (channelId: string, patch: { enabledWaifuIds?: string[]; threads?: "inherit" | "off" }) => {
    if (!server.data) return;
    try {
      const saved = await api.updateChannel(guildId, channelId, { revision: server.data.revision, ...patch });
      server.setData(saved);
      setMessage(undefined);
    } catch (err) {
      setMessage((err as Error).message);
      server.reload();
    }
  };

  const saveServerField = async (patch: Record<string, unknown>) => {
    if (!server.data) return;
    try {
      const saved = await api.updateServer(guildId, { revision: server.data.revision, ...patch });
      server.setData(saved);
      setMessage(undefined);
    } catch (err) {
      setMessage((err as Error).message);
      server.reload();
    }
  };
  const serverPaused = server.data?.paused ?? false;
  const override = server.data?.detector?.target;
  const detectorMode = detectorDraft ?? (override === undefined ? "__inherit__" : override);

  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("rooms")} title={server.data?.name ?? guildId} sub="toggle who may speak, per channel" />
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", maxHeight: "65vh", overflow: "auto" }}>
        <div className="fcell">
          <label className="field-label">Server switch</label>
          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={!serverPaused}
              onChange={(e) => void saveServerField({ paused: !e.target.checked })}
            />
            {serverPaused ? "Paused — nothing speaks until switched back on" : "Live"}
          </label>
          <span className="field-hint">
            The one switch for this server. Off mutes every channel: messages are still observed, but nothing
            replies, and nothing resumes after a restart. A channel is live when at least one waifu is enabled in it.
          </span>
        </div>
        <div className="fcell">
          <label className="field-label">Addressee detector here</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              className="select"
              value={detectorMode === "__inherit__" || detectorMode === "" ? detectorMode : "__custom__"}
              onChange={(e) => setDetectorDraft(e.target.value === "__custom__" ? detector.data?.target || "laya:english" : e.target.value)}
            >
              <option value="__inherit__">Inherit ({detector.data?.target || "none"})</option>
              <option value="">Off in this server</option>
              <option value="__custom__">Another target…</option>
            </select>
            {detectorMode !== "__inherit__" && detectorMode !== "" && (
              <input className="input" value={detectorMode} onChange={(e) => setDetectorDraft(e.target.value)} placeholder="openrouter:… or laya:english" />
            )}
            {detectorDraft !== undefined && (
              <button
                className="btn sm"
                onClick={async () => {
                  await saveServerField({ detector: detectorDraft === "__inherit__" ? null : { target: detectorDraft } });
                  setDetectorDraft(undefined);
                  history.reload();
                }}
              >
                Save
              </button>
            )}
          </div>
          <span className="field-hint">
            Picks who a message nobody addressed is for. Off: a first message in 10 minutes or a question wakes one waifu at random.
            {history.data && history.data.entries.length > 0 ? ` Last decision ${new Date(history.data.entries[0]!.at).toLocaleString()}.` : ""}
          </span>
        </div>
      </div>
      <div className="content">
        {message && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="err">{message}</Notice>
          </div>
        )}
        {channels.length === 0 && (
          <div className="cell growcell" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span className="t-mute t-small">No channels observed yet — they appear as messages arrive.</span>
          </div>
        )}
        {channels.map((channel) => (
          <div className="cell" style={{ padding: "18px 26px", flex: "none" }} key={channel.channelId}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 12 }}>
              <span className="t-title">#{channel.name ?? channel.channelId}</span>
              <span className="t-micro">
                {(channel.enabledWaifuIds?.length ?? 0) > 0 ? `${channel.enabledWaifuIds.length} talking` : "silent"}
              </span>
              <label className="checkbox-chip" style={{ marginLeft: "auto" }} title="Threads and forum posts under this channel">
                <input
                  type="checkbox"
                  checked={(channel.threads ?? "inherit") === "inherit"}
                  onChange={(e) => void saveChannel(channel.channelId, { threads: e.target.checked ? "inherit" : "off" })}
                />
                {(channel.threads ?? "inherit") === "inherit" ? "Threads share this cast" : "Threads stay silent"}
              </label>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {cast.map((waifu, index) => {
                const on = channel.enabledWaifuIds?.includes(waifu.id);
                const hue = characterHue(index);
                return (
                  <button
                    key={waifu.id}
                    className="clickable"
                    style={{
                      border: "var(--line) solid var(--ink)",
                      padding: "8px 14px",
                      fontSize: 13,
                      background: on ? `var(--${hue})` : "var(--paper)"
                    }}
                    onClick={() => toggleWaifu(channel.channelId, waifu.id)}
                  >
                    {waifu.displayName || waifu.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="cell growcell" />
      </div>
      <FootRow />
    </div>
  );
}
