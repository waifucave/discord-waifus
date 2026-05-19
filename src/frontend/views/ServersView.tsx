import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  Hash,
  RefreshCw,
  Server as ServerIcon,
  Shield,
  Smile,
  Users
} from "lucide-react";
import { api, ConflictError } from "../api/client";
import { useApi } from "../api/useApi";
import type {
  DiscordBotsFile,
  GuildEmojisFile,
  GuildMembersFile,
  GuildRolesFile,
  ServerConfig,
  ServersResponse,
  WaifusResponse
} from "../api/types";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { Notice } from "../components/Notice";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { timeAgo } from "../utils/format";
import { buildInviteUrl, isLikelyApplicationId, type BotKind } from "../utils/discord";

export function ServersView() {
  const servers = useApi<ServersResponse>((signal) => api.servers(signal), []);
  const waifus = useApi<WaifusResponse>((signal) => api.waifus(signal), []);
  const bots = useApi<DiscordBotsFile>((signal) => api.discordBots(signal), []);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!selectedId && servers.data && servers.data.servers.length > 0) {
      setSelectedId(servers.data.servers[0].guildId);
    }
  }, [servers.data, selectedId]);

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Servers</h2>
          <p className="view-subtitle">
            Per-guild channel enablement, context windows, member/emoji caches.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={servers.reload}>Refresh</button>
        </div>
      </div>

      {servers.loading && <SkeletonRows rows={3} height={42} />}
      {servers.error && <Notice tone="err">Failed to load servers: {servers.error.message}</Notice>}

      {servers.data && servers.data.servers.length === 0 && (
        <Empty title="No servers yet" icon={<ServerIcon className="icon-lg" />}>
          When the orchestrator connects to Discord and lands in a guild, it appears here. You can
          also create one by PUTting <code>/api/servers/:guildId</code>.
        </Empty>
      )}

      {servers.data && servers.data.servers.length > 0 && (
        <div className="grid" style={{ gridTemplateColumns: "280px 1fr", gap: 16 }}>
          <div className="table-wrap" style={{ height: "fit-content" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Guild</th>
                </tr>
              </thead>
              <tbody>
                {servers.data.servers.map((s) => {
                  const enabledChannels = Object.values(s.channels ?? {}).filter(
                    (c) => (c.enabledWaifuIds?.length ?? 0) > 0
                  ).length;
                  return (
                    <tr
                      key={s.guildId}
                      onClick={() => setSelectedId(s.guildId)}
                      style={{
                        cursor: "pointer",
                        background: selectedId === s.guildId ? "var(--bg-panel-hover)" : undefined
                      }}
                    >
                      <td className="wrap">
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600 }}>{s.name || s.guildId}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)" }}>
                              {s.guildId}
                            </div>
                            <div style={{ marginTop: 4, display: "flex", gap: 4 }}>
                              <Pill tone={enabledChannels > 0 ? "ok" : "neutral"} dot>
                                {enabledChannels > 0 ? "active" : "inactive"}
                              </Pill>
                              <Pill tone="info">{enabledChannels} ch</Pill>
                            </div>
                          </div>
                          <ChevronRight className="icon" style={{ color: "var(--text-muted)" }} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {selectedId && (
            <ServerDetail
              guildId={selectedId}
              waifus={waifus.data?.waifus ?? []}
              bots={bots.data}
              onChanged={() => servers.reload()}
            />
          )}
        </div>
      )}
    </>
  );
}

function ServerDetail({
  guildId,
  waifus,
  bots,
  onChanged
}: {
  guildId: string;
  waifus: WaifusResponse["waifus"];
  bots: DiscordBotsFile | undefined;
  onChanged: () => void;
}) {
  const [server, setServer] = useState<ServerConfig | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<ServerConfig | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | undefined>(undefined);

  const members = useApi<GuildMembersFile>((signal) => api.members(guildId, signal), [guildId]);
  const emojis = useApi<GuildEmojisFile>((signal) => api.emojis(guildId, signal), [guildId]);
  const roles = useApi<GuildRolesFile>((signal) => api.roles(guildId, signal), [guildId]);

  const load = useCallback(async () => {
    try {
      const list = await api.servers();
      const found = list.servers.find((s) => s.guildId === guildId);
      setServer(found);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [guildId]);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (patch: Partial<ServerConfig>) =>
    setServer((s) => (s ? { ...s, ...patch } : s));

  const save = async () => {
    if (!server) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.updateServer(guildId, {
        revision: server.revision,
        name: server.name,
        enabled: true,
        contextWindows: server.contextWindows,
        channels: server.channels
      });
      setServer(updated);
      setConflict(undefined);
      onChanged();
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflict(err.latest as ServerConfig);
        setError("Server config changed elsewhere.");
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const setChannelWaifu = async (channelId: string, waifuId: string, enabled: boolean) => {
    if (!server) return;
    const channel = server.channels[channelId];
    const current = new Set(channel?.enabledWaifuIds ?? []);
    if (enabled) {
      current.add(waifuId);
    } else {
      current.delete(waifuId);
    }
    setError(undefined);
    try {
      const updated = await api.updateChannel(guildId, channelId, {
        revision: server.revision,
        name: channel?.name,
        enabled: current.size > 0,
        enabledWaifuIds: [...current]
      });
      setServer(updated);
      onChanged();
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflict(err.latest as ServerConfig);
        setError("Channel waifu allowlist conflicted with a newer server revision.");
      } else {
        setError((err as Error).message);
      }
    }
  };

  const duplicateDisplayNames = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of members.data?.members ?? []) {
      const key = (m.guildDisplayName || m.globalDisplayName || m.username || m.userId).toLowerCase();
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  }, [members.data]);

  if (!server) {
    return (
      <div>
        {error ? <Notice tone="err">{error}</Notice> : <SkeletonRows rows={6} height={28} />}
      </div>
    );
  }

  const channelEntries = Object.values(server.channels ?? {});

  return (
    <div>
      {conflict && (
        <Notice tone="warn" title="Stale revision">
          The server config changed (latest revision {conflict.revision}).{" "}
          <button
            className="btn sm"
            onClick={() => {
              setServer(conflict);
              setConflict(undefined);
              setError(undefined);
            }}
          >
            Reload server copy
          </button>
        </Notice>
      )}
      {error && !conflict && <Notice tone="err">{error}</Notice>}
      {actionMsg && <Notice tone="info">{actionMsg}</Notice>}

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">{server.name || server.guildId}</h3>
          <span className="section-description">
            Revision {server.revision} · updated {timeAgo(server.updatedAt)}
          </span>
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label">Display name</label>
            <input
              className="input"
              value={server.name ?? ""}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Optional friendly name"
            />
          </div>
        </div>
        <div className="grid grid-3" style={{ marginTop: 12 }}>
          <ContextWindowField
            label="Orchestrator"
            value={server.contextWindows.orchestrator}
            defaultValue={20}
            onChange={(v) =>
              set({ contextWindows: { ...server.contextWindows, orchestrator: v } })
            }
          />
          <ContextWindowField
            label="Waifu"
            value={server.contextWindows.waifu}
            defaultValue={50}
            onChange={(v) => set({ contextWindows: { ...server.contextWindows, waifu: v } })}
          />
          <ContextWindowField
            label="Stage manager"
            value={server.contextWindows.stageManager}
            defaultValue={80}
            onChange={(v) =>
              set({ contextWindows: { ...server.contextWindows, stageManager: v } })
            }
          />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <span className="field-hint">Idle-trigger bounds: 100–28800 seconds.</span>
          <span className="spacer" />
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save server"}
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Invite bots to this guild</h3>
          <span className="section-description">
            Pre-built OAuth2 URLs scoped to this guild. Requires <em>Manage Server</em> on the
            target guild.
          </span>
        </div>
        <InviteToGuildPanel guildId={guildId} bots={bots} />
      </section>

      <section className="section">
        <div className="section-header">
          <h3 className="section-title">Channels</h3>
          <span className="section-description">{channelEntries.length} known</span>
        </div>
        {channelEntries.length === 0 ? (
          <Empty title="No channels tracked" icon={<Hash className="icon-lg" />}>
            Channels appear here as soon as the orchestrator sees activity or you PUT a channel via
            the API.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Channel id</th>
                  <th>Runtime</th>
                  <th>Waifus</th>
                </tr>
              </thead>
              <tbody>
                {channelEntries.map((c) => (
                  <tr key={c.channelId}>
                    <td>{c.name || `#${c.channelId}`}</td>
                    <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
                      {c.channelId}
                    </td>
                    <td>
                      {(c.enabledWaifuIds?.length ?? 0) > 0 ? (
                        <Pill tone="ok" dot>enabled</Pill>
                      ) : (
                        <Pill tone="neutral" dot>disabled</Pill>
                      )}
                    </td>
                    <td>
                      <div className="row tight">
                        {waifus.length === 0 ? (
                          <span style={{ color: "var(--text-muted)" }}>none</span>
                        ) : (
                          waifus.map((w) => {
                            const checked = (c.enabledWaifuIds ?? []).includes(w.id);
                            return (
                              <label key={w.id} className="checkbox-chip">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => void setChannelWaifu(c.channelId, w.id, e.target.checked)}
                                />
                                {w.displayName}
                              </label>
                            );
                          })
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid grid-2">
        <CacheCard
          title="Members"
          icon={<Users className="icon" />}
          count={members.data?.members.length ?? 0}
          updatedAt={members.data?.updatedAt}
          onRefresh={async () => {
            try {
              const res = await api.refreshMembers(guildId);
              setActionMsg(res.message);
              members.reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          warning={
            duplicateDisplayNames.length > 0
              ? `Duplicate display name${duplicateDisplayNames.length > 1 ? "s" : ""}: ${duplicateDisplayNames.slice(0, 3).join(", ")}${duplicateDisplayNames.length > 3 ? "…" : ""}. ${"<@DisplayName>"} mentions will be ambiguous.`
              : undefined
          }
        />
        <CacheCard
          title="Emojis"
          icon={<Smile className="icon" />}
          count={emojis.data?.emojis.length ?? 0}
          updatedAt={emojis.data?.updatedAt}
          onRefresh={async () => {
            try {
              const res = await api.refreshEmojis(guildId);
              setActionMsg(res.message);
              emojis.reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          warning={
            emojis.data && emojis.data.emojis.some((e) => !e.available)
              ? "Some emojis are flagged unavailable. Refresh after fixing them in Discord."
              : undefined
          }
        />
        <CacheCard
          title="Roles"
          icon={<Shield className="icon" />}
          count={roles.data?.roles.length ?? 0}
          updatedAt={roles.data?.updatedAt}
          onRefresh={async () => {
            try {
              const res = await api.refreshRoles(guildId);
              setActionMsg(res.message);
              roles.reload();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
          warning={
            roles.data && roles.data.roles.length === 0
              ? "Role mentions will show as @unknown-role until roles are cached."
              : undefined
          }
        />
      </div>
    </div>
  );
}

function ContextWindowField({
  label,
  value,
  defaultValue,
  onChange
}: {
  label: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <label className="field-label">{label} context</label>
      <input
        className="input"
        type="number"
        min={1}
        max={100}
        value={value}
        onChange={(e) =>
          onChange(Math.max(1, Math.min(100, Number(e.target.value) || defaultValue)))
        }
      />
      <span className="field-hint">Default {defaultValue}</span>
    </div>
  );
}

function CacheCard({
  title,
  icon,
  count,
  updatedAt,
  onRefresh,
  warning
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  updatedAt?: string;
  onRefresh: () => Promise<void> | void;
  warning?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel">
      <div className="panel-header">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {icon}
          <h4 className="panel-title">{title}</h4>
        </div>
        <button
          className="btn sm"
          onClick={async () => {
            setBusy(true);
            try {
              await onRefresh();
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
        >
          <RefreshCw className="icon" />
          {busy ? "Refreshing…" : `Fetch ${title.toLowerCase()}`}
        </button>
      </div>
      <div className="kv">
        <span className="k">Cached</span>
        <span className="v">{count}</span>
        <span className="k">Last refresh</span>
        <span className="v">{updatedAt ? timeAgo(updatedAt) : "never"}</span>
      </div>
      {warning && (
        <div style={{ marginTop: 8 }}>
          <Notice tone="warn">
            <AlertTriangle className="icon" style={{ verticalAlign: "-2px" }} /> {warning}
          </Notice>
        </div>
      )}
    </div>
  );
}

function InviteToGuildPanel({
  guildId,
  bots
}: {
  guildId: string;
  bots: DiscordBotsFile | undefined;
}) {
  if (!bots) {
    return <SkeletonRows rows={2} height={28} />;
  }
  const entries: Array<{ kind: BotKind; bot: DiscordBotsFile["orchestrator"] }> = [];
  if (bots.orchestrator) entries.push({ kind: "orchestrator", bot: bots.orchestrator });
  for (const b of bots.waifus) entries.push({ kind: "waifu", bot: b });

  if (entries.length === 0) {
    return (
      <Notice tone="warn">
        No Discord bots configured yet. Register the orchestrator on <strong>Orchestrator</strong>{" "}
        and each waifu bot in the <strong>Waifus</strong> editor first.
      </Notice>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Bot</th>
            <th>Kind</th>
            <th>Application ID</th>
            <th>Token</th>
            <th>Invite</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            if (!entry.bot) return null;
            const valid = entry.bot.applicationId && isLikelyApplicationId(entry.bot.applicationId);
            return (
              <tr key={`${entry.kind}:${entry.bot.id}`}>
                <td>
                  <div style={{ fontWeight: 600 }}>{entry.bot.displayName}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                    <code>{entry.bot.id}</code>
                  </div>
                </td>
                <td>
                  <Pill tone={entry.kind === "orchestrator" ? "info" : "neutral"}>
                    {entry.kind}
                  </Pill>
                </td>
                <td style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
                  {entry.bot.applicationId || (
                    <span style={{ color: "var(--text-muted)" }}>not set</span>
                  )}
                </td>
                <td>
                  {entry.bot.tokenConfigured ? (
                    <Pill tone="ok" dot>
                      saved
                    </Pill>
                  ) : (
                    <Pill tone="warn" dot>
                      missing
                    </Pill>
                  )}
                </td>
                <td>
                  {valid ? (
                    <InviteUrlActions
                      url={buildInviteUrl(entry.bot.applicationId!, entry.kind, guildId)}
                    />
                  ) : (
                    <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                      add a valid Application ID on the matching bot page
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InviteUrlActions({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row tight">
      <a className="btn sm primary" href={url} target="_blank" rel="noreferrer">
        Open <ExternalLink className="icon" />
      </a>
      <button
        className="btn sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // ignore
          }
        }}
      >
        {copied ? <Check className="icon" /> : <Copy className="icon" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
