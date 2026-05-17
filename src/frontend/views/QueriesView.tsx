import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ClipboardCopy, FileJson, Pause, Play, Trash2 } from "lucide-react";
import { openEventStream } from "../api/client";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { shortTime, safeJsonText } from "../utils/format";

type QueryRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

type CapturedQuery = {
  id: number;
  time: string;
  role: QueryRole;
  payload: {
    system?: unknown;
    instructions?: unknown;
    messages?: unknown;
    input?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
  };
};

const ROLE_LABEL: Record<QueryRole, string> = {
  orchestrator: "orchestrator",
  waifu: "waifu",
  stage_manager: "stage manager",
  reviewer: "reviewer"
};

const ROLE_TONE: Record<QueryRole, "ok" | "info" | "warn"> = {
  orchestrator: "info",
  waifu: "ok",
  stage_manager: "warn",
  reviewer: "warn"
};

export function QueriesView() {
  const [entries, setEntries] = useState<CapturedQuery[]>([]);
  const [paused, setPaused] = useState(false);
  const [roleFilter, setRoleFilter] = useState<"" | QueryRole>("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    let es: EventSource | undefined;
    try {
      es = openEventStream();
    } catch {
      return;
    }
    const push = (entry: CapturedQuery) => {
      if (pausedRef.current) return;
      setEntries((prev) => [entry, ...prev].slice(0, 200));
    };
    es.addEventListener("query", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as CapturedQuery;
        push(data);
      } catch {
        // ignore malformed entry
      }
    });
    return () => es?.close();
  }, []);

  const filtered = useMemo(
    () => (roleFilter ? entries.filter((e) => e.role === roleFilter) : entries),
    [entries, roleFilter]
  );

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyEntry = async (entry: CapturedQuery) => {
    try {
      await navigator.clipboard.writeText(safeJsonText(entry.payload));
      alert("Query payload copied.");
    } catch (err) {
      alert("Copy failed: " + (err as Error).message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Provider queries</h2>
          <p className="view-subtitle">
            Conversational payloads sent to LLM providers — system prompt and messages only.
            Model, sampling params, and other settings are omitted by design.
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
        </div>
      </div>

      <div className="toolbar">
        <select
          className="select"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as "" | QueryRole)}
          style={{ maxWidth: 180 }}
        >
          <option value="">All roles</option>
          <option value="orchestrator">Orchestrator</option>
          <option value="waifu">Waifu</option>
          <option value="stage_manager">Stage manager</option>
          <option value="reviewer">Reviewer</option>
        </select>
        <Pill tone={paused ? "warn" : "ok"} dot>
          {paused ? "paused" : "live"}
        </Pill>
      </div>

      {filtered.length === 0 ? (
        <Empty title="No provider queries yet" icon={<FileJson className="icon-lg" />}>
          Each call to an LLM provider will appear here. Trigger orchestration in a connected
          Discord channel to see a query.
        </Empty>
      ) : (
        <div className="log-list">
          {filtered.map((entry) => {
            const open = expanded.has(entry.id);
            return (
              <div key={entry.id} style={{ display: "flex", flexDirection: "column" }}>
                <button
                  className="log-line"
                  onClick={() => toggle(entry.id)}
                  style={{
                    background: "transparent",
                    border: "none",
                    textAlign: "left",
                    cursor: "pointer",
                    width: "100%"
                  }}
                >
                  <span className="ts">{shortTime(entry.time)}</span>
                  <span className="lvl info" style={{ minWidth: 92, textAlign: "center" }}>
                    {ROLE_LABEL[entry.role]}
                  </span>
                  <span className="src">
                    <Pill tone={ROLE_TONE[entry.role]} dot>
                      {entry.role}
                    </Pill>
                  </span>
                  <span className="msg">{querySummary(entry.payload)}</span>
                  <span style={{ marginLeft: "auto" }}>
                    {open ? <ChevronDown className="icon" /> : <ChevronRight className="icon" />}
                  </span>
                </button>
                {open && (
                  <div
                    style={{
                      margin: "4px 8px 12px 8px",
                      padding: 12,
                      background: "var(--surface-2, rgba(255,255,255,0.02))",
                      border: "1px solid var(--border, rgba(255,255,255,0.06))",
                      borderRadius: 8
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                      <button className="btn sm" onClick={() => copyEntry(entry)}>
                        <ClipboardCopy className="icon" /> Copy JSON
                      </button>
                    </div>
                    <pre
                      style={{
                        margin: 0,
                        fontFamily: "var(--font-mono)",
                        fontSize: "var(--fs-xs)",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word"
                      }}
                    >
                      {formatPayloadForDisplay(entry.payload)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function formatPayloadForDisplay(payload: CapturedQuery["payload"]): string {
  const raw = JSON.stringify(payload, null, 2);
  return raw.replace(/"((?:\\.|[^"\\])*)"/g, (_match, body: string, offset: number) => {
    const lineStart = raw.lastIndexOf("\n", offset - 1) + 1;
    const indent = " ".repeat(offset - lineStart + 1);
    const unescaped = body
      .replace(/(?<!\\)((?:\\\\)*)\\n/g, `$1\n${indent}`)
      .replace(/(?<!\\)((?:\\\\)*)\\t/g, "$1\t");
    return `"${unescaped}"`;
  });
}

function querySummary(payload: CapturedQuery["payload"]): string {
  const parts: string[] = [];
  if (Array.isArray(payload.messages)) parts.push(`${payload.messages.length} messages`);
  if (Array.isArray(payload.input)) parts.push(`${payload.input.length} input items`);
  if (Array.isArray(payload.tools)) parts.push(`${payload.tools.length} tools`);
  if (typeof payload.system === "string") {
    parts.push(`system ${payload.system.length}ch`);
  }
  if (typeof payload.instructions === "string") {
    parts.push(`instructions ${payload.instructions.length}ch`);
  }
  return parts.length ? parts.join(" · ") : "empty payload";
}
