import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ClipboardCopy, Pause, Play, Trash2 } from "lucide-react";
import { openEventStream, api } from "../api/client";
import { useApi } from "../api/useApi";
import type { RuntimeState } from "../api/types";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { Notice } from "../components/Notice";
import { Skeleton } from "../components/Skeleton";
import { shortTime, safeJsonText } from "../utils/format";

type LogLevel = "info" | "warn" | "err" | "ok";

type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
};

type BackendLogEntry = {
  time: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: unknown;
};

let _id = 0;

export function LogsView() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const [levelFilter, setLevelFilter] = useState<string>("");
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);

  useEffect(() => {
    let es: EventSource | undefined;
    try {
      es = openEventStream();
    } catch {
      return;
    }
    const push = (entry: Omit<LogEntry, "id">) => {
      if (pausedRef.current) return;
      setEntries((prev) =>
        [{ id: ++_id, ...entry }, ...prev].slice(0, 500)
      );
    };
    es.addEventListener("runtime", (ev) => {
      const data = (ev as MessageEvent).data;
      try {
        const parsed = JSON.parse(data);
        push({
          ts: new Date().toISOString(),
          level: parsed?.discord?.warnings?.length ? "warn" : "ok",
          source: "runtime",
          message: snapshotSummary(parsed)
        });
      } catch {
        push({
          ts: new Date().toISOString(),
          level: "info",
          source: "runtime",
          message: data
        });
      }
    });
    es.addEventListener("log", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as BackendLogEntry;
        push({
          ts: data.time ?? new Date().toISOString(),
          level: mapBackendLogLevel(data.level),
          source: "backend",
          message: data.context === undefined
            ? data.message
            : `${data.message} ${safeJsonText(data.context)}`
        });
      } catch {
        push({
          ts: new Date().toISOString(),
          level: "info",
          source: "backend",
          message: (ev as MessageEvent).data
        });
      }
    });
    es.onerror = () => {
      push({
        ts: new Date().toISOString(),
        level: "err",
        source: "sse",
        message: "Event stream disconnected; will retry."
      });
    };
    return () => es?.close();
  }, []);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (levelFilter && e.level !== levelFilter) return false;
      if (filter && !`${e.source} ${e.message}`.toLowerCase().includes(filter.toLowerCase())) return false;
      return true;
    });
  }, [entries, filter, levelFilter]);

  const copyBundle = async () => {
    try {
      const serverBundle = await api.diagnosticsBundle();
      const bundle = {
        ...serverBundle,
        clientEntries: filtered.slice(0, 200)
      };
      await navigator.clipboard.writeText(safeJsonText(bundle));
      alert("Diagnostic bundle copied to clipboard.");
    } catch (err) {
      alert("Copy failed: " + (err as Error).message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Logs &amp; diagnostics</h2>
          <p className="view-subtitle">
            Live SSE events from <code>/api/events</code>. Provider, Discord, queue, and runtime events
            appear here as the backend emits them.
          </p>
        </div>
        <div className="view-actions">
          <button className="btn" onClick={() => setPaused((p) => !p)}>
            {paused ? (
              <>
                <Play className="icon" /> Resume stream
              </>
            ) : (
              <>
                <Pause className="icon" /> Pause stream
              </>
            )}
          </button>
          <button className="btn" onClick={() => setEntries([])}>
            <Trash2 className="icon" /> Clear
          </button>
          <button className="btn primary" onClick={copyBundle}>
            <ClipboardCopy className="icon" /> Copy diagnostic bundle
          </button>
        </div>
      </div>

      <div className="toolbar">
        <select
          className="select"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          style={{ maxWidth: 140 }}
        >
          <option value="">All levels</option>
          <option value="info">info</option>
          <option value="ok">ok</option>
          <option value="warn">warn</option>
          <option value="err">err</option>
        </select>
        <input
          className="input"
          placeholder="Search source/message…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <Pill tone={paused ? "warn" : "ok"} dot>
          {paused ? "paused" : "live"}
        </Pill>
      </div>

      {filtered.length === 0 ? (
        <Empty title="No log lines" icon={<Activity className="icon-lg" />}>
          Backend, provider, Discord, and queue events will appear here as the orchestrator
          pipeline runs.
        </Empty>
      ) : (
        <div className="log-list">
          {filtered.map((e) => (
            <div key={e.id} className="log-line">
              <span className="ts">{shortTime(e.ts)}</span>
              <span className={"lvl " + e.level}>{e.level}</span>
              <span className="src">{e.source}</span>
              <span className="msg">{e.message}</span>
            </div>
          ))}
        </div>
      )}

      <section className="section" style={{ marginTop: 32 }}>
        <div className="section-header">
          <h3 className="section-title">Doctor</h3>
          <span className="section-description">Snapshot of runtime + intent / credential status.</span>
        </div>
        {runtime.loading && <Skeleton height={80} />}
        {runtime.error && <Notice tone="err">{runtime.error.message}</Notice>}
        {runtime.data && (
          <div className="kv">
            <span className="k">Node version</span>
            <span className="v">requires &gt;= 20</span>
            <span className="k">Package version</span>
            <span className="v">{runtime.data.packageVersion}</span>
            <span className="k">PID</span>
            <span className="v">{runtime.data.pid}</span>
            <span className="k">Mode</span>
            <span className="v">{runtime.data.mode}</span>
            <span className="k">Data root</span>
            <span className="v" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-xs)" }}>
              {runtime.data.dataRoot}
            </span>
            <span className="k">Discord</span>
            <span className="v">
              {runtime.data.discord.connected ? (
                <Pill tone="ok" dot>connected</Pill>
              ) : (
                <Pill tone="warn" dot>offline</Pill>
              )}
              {" "}
              {runtime.data.discord.waifuBotCount} waifu bots
            </span>
            <span className="k">Required intents</span>
            <span className="v">GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, MESSAGE_CONTENT</span>
            <span className="k">Optional intents</span>
            <span className="v">GUILD_MEMBERS (for full member refresh)</span>
            {runtime.data.discord.warnings.length > 0 && (
              <>
                <span className="k">Warnings</span>
                <span className="v" style={{ color: "var(--warn)" }}>
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

function mapBackendLogLevel(level: BackendLogEntry["level"]): LogLevel {
  if (level === "error") return "err";
  if (level === "warn") return "warn";
  return "info";
}

function snapshotSummary(snapshot: unknown): string {
  const s = snapshot as RuntimeState | undefined;
  if (!s) return "runtime snapshot";
  const parts = [
    s.paused ? "paused" : "running",
    s.discord?.connected ? "discord-online" : "discord-offline",
    `${s.queues?.active ?? 0} queues`
  ];
  return parts.join(" · ");
}
