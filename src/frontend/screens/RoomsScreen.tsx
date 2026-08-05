import { useState } from "react";
import { api } from "../api/client";
import { useApi } from "../api/useApi";
import type { ServerConfig, ServersResponse, WaifusResponse } from "../api/types";
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
              No servers yet. When the director bot connects to Discord and lands in a guild, it appears here.
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
                    {live.length} of {channels.length} channels live{!guild.enabled && " · server disabled"}
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
  const [message, setMessage] = useState<string | undefined>(undefined);

  const cast = waifus.data?.waifus ?? [];
  const channels = Object.values(server.data?.channels ?? {});

  const toggleWaifu = async (channelId: string, waifuId: string) => {
    if (!server.data) return;
    const channel = server.data.channels[channelId];
    const current = channel?.enabledWaifuIds ?? [];
    const next = current.includes(waifuId) ? current.filter((id) => id !== waifuId) : [...current, waifuId];
    try {
      const saved = await api.updateChannel(guildId, channelId, {
        revision: server.data.revision,
        name: channel?.name,
        enabled: next.length > 0,
        enabledWaifuIds: next
      });
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
  const mode = server.data?.orchestratorMode ?? "model";
  const stageManagerOn = server.data?.stageManagerEnabled ?? true;
  const serverPaused = server.data?.paused ?? false;

  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("rooms")} title={server.data?.name ?? guildId} sub="toggle who may speak, per channel" />
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr 1fr" }}>
        <div className="fcell">
          <label className="field-label">Server</label>
          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={serverPaused}
              onChange={(e) => void saveServerField({ paused: e.target.checked })}
            />
            {serverPaused ? "Paused — nothing speaks until unpaused" : "Live"}
          </label>
          <span className="field-hint">
            Pause mutes every channel of this server: messages are still observed, but no replies, wakes, or
            memory passes run.
          </span>
        </div>
        <div className="fcell">
          <label className="field-label">Orchestration for this server</label>
          <select
            className="select"
            value={mode}
            onChange={(e) => void saveServerField({ orchestratorMode: e.target.value })}
          >
            <option value="model">AI model (global orchestrator)</option>
            <option value="deterministic">Deterministic (free, structural)</option>
          </select>
          <span className="field-hint">
            Deterministic picks speakers from reply-targets, addressing, rotation, and availability — zero
            orchestration API spend, no directives or topic pivots.
          </span>
        </div>
        <div className="fcell">
          <label className="field-label">Stage manager</label>
          <label className="checkbox-chip">
            <input
              type="checkbox"
              checked={stageManagerOn}
              onChange={(e) => void saveServerField({ stageManagerEnabled: e.target.checked })}
            />
            {stageManagerOn ? "Active — observes, records memories, dreams" : "Disabled for this server"}
          </label>
          <span className="field-hint">Off = no observers, no new memories, no nightly dreams for this server.</span>
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
