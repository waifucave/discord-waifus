import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ClipboardCopy, MessageSquareReply, Pause, Play, Trash2 } from "lucide-react";
import { openEventStream } from "../api/client";
import { Empty } from "../components/Empty";
import { Pill } from "../components/Pill";
import { shortTime, safeJsonText } from "../utils/format";

type QueryRole =
  | "orchestrator"
  | "waifu"
  | "stage_manager_observer"
  | "stage_manager_librarian"
  | "reviewer";

type CapturedReply = {
  id: number;
  time: string;
  role: QueryRole;
  queryId: number;
  status: number;
  ok: boolean;
  payload: unknown;
};

const ROLE_LABEL: Record<QueryRole, string> = {
  orchestrator: "orchestrator",
  waifu: "waifu",
  stage_manager_observer: "stage mgr · observer",
  stage_manager_librarian: "stage mgr · librarian",
  reviewer: "reviewer"
};

const ROLE_TONE: Record<QueryRole, "ok" | "info" | "warn"> = {
  orchestrator: "info",
  waifu: "ok",
  stage_manager_observer: "info",
  stage_manager_librarian: "warn",
  reviewer: "warn"
};

export function RepliesView() {
  const [entries, setEntries] = useState<CapturedReply[]>([]);
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
    const push = (entry: CapturedReply) => {
      if (pausedRef.current) return;
      setEntries((prev) => [entry, ...prev].slice(0, 200));
    };
    es.addEventListener("reply", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as CapturedReply;
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

  const copyEntry = async (entry: CapturedReply) => {
    try {
      await navigator.clipboard.writeText(safeJsonText(entry.payload));
      alert("Reply payload copied.");
    } catch (err) {
      alert("Copy failed: " + (err as Error).message);
    }
  };

  return (
    <>
      <div className="view-header">
        <div>
          <h2 className="view-title">Provider replies</h2>
          <p className="view-subtitle">
            Full provider response bodies returned by LLM calls, including HTTP error bodies.
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
          <option value="stage_manager_observer">Stage mgr · observer</option>
          <option value="stage_manager_librarian">Stage mgr · librarian</option>
          <option value="reviewer">Reviewer</option>
        </select>
        <Pill tone={paused ? "warn" : "ok"} dot>
          {paused ? "paused" : "live"}
        </Pill>
      </div>

      {filtered.length === 0 ? (
        <Empty title="No provider replies yet" icon={<MessageSquareReply className="icon-lg" />}>
          Each response returned by an LLM provider will appear here. Trigger orchestration in a
          connected Discord channel to see a reply.
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
                  <span
                    className={"lvl " + (entry.ok ? "ok" : "warn")}
                    style={{ minWidth: 92, textAlign: "center" }}
                  >
                    HTTP {entry.status}
                  </span>
                  <span className="src">
                    <Pill tone={ROLE_TONE[entry.role]} dot>
                      {ROLE_LABEL[entry.role]}
                    </Pill>
                  </span>
                  <span className="msg">
                    query #{entry.queryId} · {replySummary(entry.payload)}
                  </span>
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

function formatPayloadForDisplay(payload: unknown): string {
  const raw = safeJsonText(payload);
  return raw.replace(/"((?:\\.|[^"\\])*)"/g, (_match, body: string, offset: number) => {
    const lineStart = raw.lastIndexOf("\n", offset - 1) + 1;
    const indent = " ".repeat(offset - lineStart + 1);
    const unescaped = body
      .replace(/(?<!\\)((?:\\\\)*)\\n/g, `$1\n${indent}`)
      .replace(/(?<!\\)((?:\\\\)*)\\t/g, "$1\t");
    return `"${unescaped}"`;
  });
}

function replySummary(payload: unknown): string {
  if (typeof payload === "string") return `${payload.length}ch text`;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "empty body";
  const body = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(body.choices)) parts.push(`${body.choices.length} choices`);
  if (Array.isArray(body.output)) parts.push(`${body.output.length} output items`);
  if (typeof body.output_text === "string") parts.push(`output ${body.output_text.length}ch`);
  if (Array.isArray(body.content)) parts.push(`${body.content.length} content parts`);
  if (Array.isArray(body.candidates)) parts.push(`${body.candidates.length} candidates`);
  if (typeof body.error === "string") parts.push(`error ${body.error}`);
  if (typeof body.message === "string") parts.push(body.message);
  if (typeof body.raw === "string") parts.push(`raw ${body.raw.length}ch`);
  return parts.length ? parts.join(" · ") : `${Object.keys(body).length} fields`;
}
