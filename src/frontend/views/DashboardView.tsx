import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Compass,
  Layers,
  Pause,
  Play,
  RefreshCw,
  XCircle
} from "lucide-react";
import { api, openEventStream } from "../api/client";
import { useApi } from "../api/useApi";
import { useRuntimeStatus, runtimeStore } from "../state/runtimeStore";
import { Pill } from "../components/Pill";
import { Notice } from "../components/Notice";
import { Empty } from "../components/Empty";
import { Skeleton, SkeletonRows } from "../components/Skeleton";
import { safeJsonText, shortTime, timeAgo, uptimeSince } from "../utils/format";
import type { ProvidersResponse, ServersResponse, RuntimeState } from "../api/types";

type EventEntry = {
  id: number;
  time: string;
  type: string;
  message: string;
};

type BackendLogEntry = {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: unknown;
};

let _eid = 0;
function nextId(): number {
  return ++_eid;
}

export function DashboardView() {
  const status = useRuntimeStatus();
  const runtime = useApi<RuntimeState>((signal) => api.runtime(signal), []);
  const providers = useApi<ProvidersResponse>((signal) => api.providers(signal), []);
  const servers = useApi<ServersResponse>((signal) => api.servers(signal), []);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [actionPending, setActionPending] = useState<"pause" | "resume" | "reload" | undefined>(
    undefined
  );
  const [actionMessage, setActionMessage] = useState<string | undefined>(undefined);

  useEffect(() => {
    let es: EventSource | undefined;
    try {
      es = openEventStream();
    } catch {
      return;
    }
    es.addEventListener("runtime", (ev) => {
      setEvents((prev) =>
        [
          {
            id: nextId(),
            time: new Date().toISOString(),
            type: "runtime",
            message: snapshotMessage((ev as MessageEvent).data)
          },
          ...prev
        ].slice(0, 100)
      );
    });
    es.addEventListener("log", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BackendLogEntry;
        setEvents((prev) =>
          [
            {
              id: nextId(),
              time: data.time ?? new Date().toISOString(),
              type: data.level,
              message: data.context === undefined
                ? data.message
                : `${data.message} ${safeJsonText(data.context)}`
            },
            ...prev
          ].slice(0, 100)
        );
      } catch {
        // ignore
      }
    });
    es.onerror = () => {
      setEvents((prev) =>
        [
          {
            id: nextId(),
            time: new Date().toISOString(),
            type: "error",
            message: "Event stream disconnected; will retry."
          },
          ...prev
        ].slice(0, 100)
      );
    };
    return () => es?.close();
  }, []);

  const doAction = useCallback(
    async (kind: "pause" | "resume" | "reload") => {
      setActionPending(kind);
      setActionMessage(undefined);
      try {
        if (kind === "pause") await api.pause();
        else if (kind === "resume") await api.resume();
        else {
          const res = await api.reload();
          setActionMessage(res.message);
        }
        await runtimeStore.refresh();
        runtime.reload();
      } catch (err) {
        setActionMessage((err as Error).message);
      } finally {
        setActionPending(undefined);
      }
    },
    [runtime]
  );

  const isPaused = status?.paused ?? runtime.data?.paused ?? false;
  const connected = status?.discord.connected ?? false;
  const discordConnecting = status?.discord.connecting ?? false;
  const orchestratorConnected = status?.discord.orchestratorConnected ?? false;
  const discordRetrying = status?.discord.retrying ?? false;
  const discordRetryAttempt = status?.discord.retryAttempt ?? 0;
  const discordNextRetryAt = status?.discord.nextRetryAt;
  const discordRetryAttemptText = discordRetryAttempt > 0
    ? ` after ${discordRetryAttempt} failed attempt${discordRetryAttempt === 1 ? "" : "s"}`
    : "";
  const discordNextRetryText = discordNextRetryAt ? `; next retry at ${shortTime(discordNextRetryAt)}` : "";

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Dashboard</h2>
          <p className="view-subtitle">Runtime, Discord, providers, and live activity.</p>
        </div>
        <div className="view-actions">
          {isPaused ? (
            <button
              className="btn primary"
              onClick={() => doAction("resume")}
              disabled={actionPending !== undefined}
            >
              <Play className="icon" /> Resume
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => doAction("pause")}
              disabled={actionPending !== undefined}
            >
              <Pause className="icon" /> Pause
            </button>
          )}
          <button
            className="btn"
            onClick={() => doAction("reload")}
            disabled={actionPending !== undefined}
          >
            <RefreshCw className="icon" /> Reload
          </button>
          <button
            className="btn"
            onClick={() => {
              runtimeStore.refresh();
              runtime.reload();
              providers.reload();
              servers.reload();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {actionMessage && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="info">{actionMessage}</Notice>
        </div>
      )}

      <div className="stat-row">
        <div className="stat">
          <span className="stat-label">Status</span>
          <span className="stat-value" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {status ? (
              <>
                <Pill tone={isPaused ? "warn" : "ok"} dot>
                  {isPaused ? "Paused" : "Running"}
                </Pill>
              </>
            ) : (
              <Skeleton width={80} />
            )}
          </span>
          <span className="stat-foot">
            {runtime.data
              ? `up ${uptimeSince(runtime.data.startedAt)} · pid ${runtime.data.pid}`
              : "—"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Discord</span>
          <span className="stat-value" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Pill tone={connected ? "ok" : discordConnecting ? "info" : "neutral"} dot>
              {connected ? "Connected" : discordConnecting ? "Connecting" : "Offline"}
            </Pill>
          </span>
          <span className="stat-foot">
            orchestrator {discordConnecting ? "connecting" : orchestratorConnected ? "online" : "offline"} ·
            {" "}
            {status?.discord.waifuBotCount ?? 0} waifu bots
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Active queues</span>
          <span className="stat-value">{status?.queues.active ?? 0}</span>
          <span className="stat-foot">
            {(status?.queues.configuredGuilds ?? 0)} configured guilds
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Providers configured</span>
          <span className="stat-value">
            {providers.data
              ? providers.data.providers.filter((p) => p.credentials.configured).length
              : "—"}
            <span style={{ color: "var(--text-muted)", fontSize: "var(--fs-sm)", marginLeft: 4 }}>
              / {providers.data?.providers.length ?? 0}
            </span>
          </span>
          <span className="stat-foot">
            {providers.data
              ? providers.data.providers
                  .filter((p) => p.credentials.configured)
                  .map((p) => p.displayName)
                  .join(", ") || "None yet"
              : "—"}
          </span>
        </div>
      </div>

      {status?.discord.warnings && status.discord.warnings.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <Notice tone="warn" title="Discord runtime warnings">
            {discordRetrying && (
              <p style={{ marginTop: 0 }}>
                Auto-retry is active
                {discordRetryAttemptText}
                {discordNextRetryText}.
              </p>
            )}
            <ul style={{ paddingLeft: 18, margin: 0 }}>
              {status.discord.warnings.map((warn, i) => (
                <li key={i}>{warn}</li>
              ))}
            </ul>
          </Notice>
        </div>
      )}

      <div className="grid grid-2">
        <section className="section" style={{ marginBottom: 0 }}>
          <div className="section-header">
            <h3 className="section-title">Provider health</h3>
            <span className="section-description">
              {providers.loading ? "Loading…" : "Credential status only — secrets never leave backend."}
            </span>
          </div>
          {providers.loading && <SkeletonRows rows={3} />}
          {providers.error && (
            <Notice tone="err">Failed to load providers: {providers.error.message}</Notice>
          )}
          {providers.data && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Key hint</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.data.providers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{p.displayName}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                          {p.id}
                        </div>
                      </td>
                      <td>
                        {p.credentials.configured ? (
                          <Pill tone="ok" dot>
                            Configured
                          </Pill>
                        ) : (
                          <Pill tone="warn" dot>
                            No key
                          </Pill>
                        )}
                      </td>
                      <td>
                        {p.credentials.configured ? (
                          <span style={{ fontFamily: "var(--font-mono)" }}>{p.credentials.keyHint}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="section" style={{ marginBottom: 0 }}>
          <div className="section-header">
            <h3 className="section-title">Configured servers</h3>
            <span className="section-description">
              {servers.data ? `${servers.data.servers.length} guild${servers.data.servers.length === 1 ? "" : "s"}` : ""}
            </span>
          </div>
          {servers.loading && <SkeletonRows rows={3} />}
          {servers.error && (
            <Notice tone="err">Failed to load servers: {servers.error.message}</Notice>
          )}
          {servers.data && servers.data.servers.length === 0 && (
            <Empty title="No servers configured" icon={<Compass className="icon-lg" />}>
              Add a guild from the Servers page, or run the orchestrator bot in a guild it has been
              invited to.
            </Empty>
          )}
          {servers.data && servers.data.servers.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Guild</th>
                    <th>Status</th>
                    <th>Channels</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.data.servers.map((s) => {
                    const enabledChannels = Object.values(s.channels ?? {}).filter(
                      (c) => (c.enabledWaifuIds?.length ?? 0) > 0
                    ).length;
                    const totalChannels = Object.keys(s.channels ?? {}).length;
                    return (
                      <tr key={s.guildId}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{s.name || s.guildId}</div>
                          <div
                            style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)", fontFamily: "var(--font-mono)" }}
                          >
                            {s.guildId}
                          </div>
                        </td>
                        <td>
                          {enabledChannels > 0 ? (
                            <Pill tone="ok" dot>
                              Active
                            </Pill>
                          ) : (
                            <Pill tone="neutral" dot>
                              Inactive
                            </Pill>
                          )}
                        </td>
                        <td>
                          {enabledChannels}/{totalChannels} active
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-header">
          <h3 className="section-title">Live events</h3>
          <span className="section-description">
            From <code>/api/events</code> (SSE). Last {events.length} events.
          </span>
        </div>
        {events.length === 0 ? (
          <Empty title="Waiting for events" icon={<Activity className="icon-lg" />}>
            Backend runtime and log events will appear here.
          </Empty>
        ) : (
          <div className="log-list">
            {events.map((e) => (
              <div key={e.id} className="log-line">
                <span className="ts">{shortTime(e.time)}</span>
                <span className={"lvl " + eventTone(e.type)}>
                  {e.type}
                </span>
                <span className="src">stream</span>
                <span className="msg">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-header">
          <h3 className="section-title">Runtime triggers</h3>
          <span className="section-description">Manual control surfaces (advanced).</span>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={async () => {
              try {
                const res = await api.triggerOrchestrator();
                setActionMessage(res.message);
              } catch (err) {
                setActionMessage((err as Error).message);
              }
            }}
          >
            <Compass className="icon" /> Trigger orchestrator
          </button>
          <button
            className="btn"
            onClick={async () => {
              try {
                const res = await api.triggerStageManager();
                setActionMessage(res.message);
              } catch (err) {
                setActionMessage((err as Error).message);
              }
            }}
          >
            <Layers className="icon" /> Trigger stage manager
          </button>
        </div>
      </section>

      {runtime.data && (
        <section className="section" style={{ marginTop: 32 }}>
          <div className="section-header">
            <h3 className="section-title">Runtime details</h3>
            <span className="section-description">
              updated {timeAgo(runtime.data.updatedAt)}
            </span>
          </div>
          <div className="kv">
            <span className="k">Package version</span>
            <span className="v">{runtime.data.packageVersion}</span>
            <span className="k">Mode</span>
            <span className="v">{runtime.data.mode}</span>
            <span className="k">HTTP</span>
            <span className="v">{`http://127.0.0.1:${runtime.data.port}`}</span>
            <span className="k">Data root</span>
            <span className="v" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
              {runtime.data.dataRoot}
            </span>
            <span className="k">Started</span>
            <span className="v">{new Date(runtime.data.startedAt).toLocaleString()}</span>
            <span className="k">Discord</span>
            <span className="v">
              {runtime.data.discord.connected ? (
                <>
                  <CheckCircle2
                    className="icon"
                    style={{ width: 14, height: 14, color: "var(--ok)", verticalAlign: "-2px" }}
                  />
                  {" connected"}
                </>
              ) : runtime.data.discord.connecting ? (
                <>
                  <RefreshCw
                    className="icon"
                    style={{ width: 14, height: 14, color: "var(--info)", verticalAlign: "-2px" }}
                  />
                  {" connecting"}
                </>
              ) : (
                <>
                  <XCircle
                    className="icon"
                    style={{ width: 14, height: 14, color: "var(--text-muted)", verticalAlign: "-2px" }}
                  />
                  {" offline"}
                </>
              )}
            </span>
            {runtime.data.discord.warnings.length > 0 && (
              <>
                <span className="k">Warnings</span>
                <span className="v">
                  <AlertTriangle
                    className="icon"
                    style={{ width: 14, height: 14, color: "var(--warn)", verticalAlign: "-2px" }}
                  />{" "}
                  {runtime.data.discord.warnings.join("; ")}
                </span>
              </>
            )}
          </div>
        </section>
      )}
    </>
  );
}

function snapshotMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const paused = parsed?.paused ? "paused" : "running";
    const connected = parsed?.discord?.connected ? "discord-online" : "discord-offline";
    const queues = parsed?.queues?.active ?? 0;
    return `${paused} · ${connected} · ${queues} active queues`;
  } catch {
    return raw.slice(0, 200);
  }
}

function eventTone(type: string): string {
  if (type === "error") return "err";
  if (type === "warn") return "warn";
  if (type === "runtime") return "ok";
  return "info";
}
