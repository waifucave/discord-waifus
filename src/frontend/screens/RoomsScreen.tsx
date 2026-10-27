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
          <div className="cell growcell empty">
            <span className="t-mute t-small" style={{ maxWidth: 460, lineHeight: 1.6 }}>
              No servers yet. When the House bot connects to Discord and is in a server, it appears here.
            </span>
          </div>
        )}
        {guilds.length > 0 && (
          <div className="mosaic tiles rooms-mosaic">
            {guilds.map((guild, index) => {
              const channels = Object.values(guild.channels ?? {});
              const live = channels.filter((c) => (c.enabledWaifuIds?.length ?? 0) > 0);
              return (
                <button
                  key={guild.guildId}
                  className={"cell clickable tile" + (index === 0 ? " wide" : "")}
                  data-hue
                  style={{ ["--hover-hue" as string]: "var(--sky)" }}
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
            {Array.from({ length: (3 - ((guilds.length + 1) % 3)) % 3 }, (_, i) => (
              <div className="cell pad" key={`pad-${i}`} aria-hidden="true" />
            ))}
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
  const [detectorDraft, setDetectorDraft] = useState<DetectorChoice | undefined>(undefined);
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
  const detectorNow = detectorDraft ?? detectorChoiceOf(server.data?.detector?.target);
  const detectorSave = detectorDraft ? detectorPatch(detectorDraft) : undefined;

  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("rooms")} title={server.data?.name ?? guildId} sub="toggle who may speak, per channel" />
      <div className="fgrid cols-2">
        <div className="fcell">
          <span className="field-label">Server switch</span>
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
          <label className="field-label" htmlFor="rooms-detector-mode">Addressee detector here</label>
          <div className="fcell-row">
            <select
              id="rooms-detector-mode"
              className="select"
              aria-label="Addressee detector here"
              value={detectorNow.mode}
              onChange={(e) => {
                const mode = e.target.value as DetectorChoice["mode"];
                setDetectorDraft({ mode, target: mode === "custom" ? detectorNow.target || detector.data?.target || "laya:english" : "" });
              }}
            >
              <option value="inherit">Inherit ({detector.data?.target || "none"})</option>
              <option value="off">Off in this server</option>
              <option value="custom">Another target…</option>
            </select>
            {detectorNow.mode === "custom" && (
              <input
                className="input"
                aria-label="Detector target"
                value={detectorNow.target}
                onChange={(e) => setDetectorDraft({ mode: "custom", target: e.target.value })}
                placeholder="openrouter:… or laya:english"
              />
            )}
            {detectorDraft !== undefined && (
              <button
                className="btn primary sm"
                disabled={!detectorSave}
                title={detectorSave ? undefined : "Name a target, or pick Inherit or Off"}
                onClick={async () => {
                  if (!detectorSave) return;
                  await saveServerField({ detector: detectorSave.detector });
                  setDetectorDraft(undefined);
                  history.reload();
                }}
              >
                Save
              </button>
            )}
          </div>
          <span className="field-hint">
            Picks who a message nobody addressed is for. Off: a first message in 10 minutes or a question wakes one waifu who is around, by a weighted draw that favours whoever spoke there least recently.
            {history.data && history.data.entries.length > 0 ? ` Last decision ${new Date(history.data.entries[0]!.at).toLocaleString()}.` : ""}
          </span>
        </div>
      </div>
      <div className="content">
        {message && (
          <div className="cell notice-cell" role="alert">
            <Notice tone="err">{message}</Notice>
          </div>
        )}
        {channels.length === 0 && (
          <div className="cell growcell empty">
            <span className="t-mute t-small">No channels observed yet — they appear as messages arrive.</span>
          </div>
        )}
        {channels.map((channel) => (
          <div className="cell cell-pad" key={channel.channelId}>
            <div className="channel-head">
              <span className="t-title">#{channel.name ?? channel.channelId}</span>
              <span className="t-micro">
                {(channel.enabledWaifuIds?.length ?? 0) > 0 ? `${channel.enabledWaifuIds.length} talking` : "silent"}
              </span>
              <label className="checkbox-chip" title="Threads and forum posts under this channel">
                <input
                  type="checkbox"
                  checked={(channel.threads ?? "inherit") === "inherit"}
                  onChange={(e) => void saveChannel(channel.channelId, { threads: e.target.checked ? "inherit" : "off" })}
                />
                {(channel.threads ?? "inherit") === "inherit" ? "Threads share this cast" : "Threads stay silent"}
              </label>
            </div>
            <div className="cast-picks" role="group" aria-label={`Who speaks in #${channel.name ?? channel.channelId}`}>
              {cast.map((waifu, index) => {
                const on = channel.enabledWaifuIds?.includes(waifu.id) ?? false;
                return (
                  <button
                    key={waifu.id}
                    type="button"
                    className="cast-pick"
                    aria-pressed={on}
                    style={{ ["--hue" as string]: `var(--${characterHue(index)})` }}
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

/** The detector override as the form edits it: an empty custom target stays custom (never "off"). */
export type DetectorChoice = { mode: "inherit" | "off" | "custom"; target: string };

export function detectorChoiceOf(override: string | null | undefined): DetectorChoice {
  if (override === undefined || override === null) return { mode: "inherit", target: "" };
  return override === "" ? { mode: "off", target: "" } : { mode: "custom", target: override };
}

/** The server patch for a choice; undefined while a custom target is empty (nothing to save yet). */
export function detectorPatch(choice: DetectorChoice): { detector: { target: string } | null } | undefined {
  if (choice.mode === "inherit") return { detector: null };
  if (choice.mode === "off") return { detector: { target: "" } };
  const target = choice.target.trim();
  return target ? { detector: { target } } : undefined;
}
