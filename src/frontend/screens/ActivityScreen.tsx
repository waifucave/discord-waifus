import { useEffect, useState } from "react";
import { api, openEventStream } from "../api/client";
import { useApi } from "../api/useApi";
import type { UsageGroupKey, UsageResponse } from "../api/types";
import type { ViewId } from "../nav";
import { usd } from "./lifeView";
import { FootRow, HeadRow, TabCells } from "./scaffold";

type StreamEntry = { receivedAt: string; data: Record<string, unknown> };
export type ActivityFeedState = {
  logs: StreamEntry[];
  queries: StreamEntry[];
  replies: StreamEntry[];
};

export type ActivityFeedAction =
  | { type: "reset" }
  | { type: "event"; event: string; data: string; receivedAt: string };

const EMPTY_ACTIVITY: ActivityFeedState = { logs: [], queries: [], replies: [] };

function decodeActivityValue(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function restoreActivityEntries(entries: unknown, receivedAt: string): StreamEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries.slice(-200).reverse().map((entry) => ({
    receivedAt,
    data: entry && typeof entry === "object"
      ? entry as Record<string, unknown>
      : { raw: entry }
  }));
}

export function reduceActivityFeed(
  state: ActivityFeedState,
  action: ActivityFeedAction
): ActivityFeedState {
  if (action.type === "reset") return EMPTY_ACTIVITY;
  const data = decodeActivityValue(action.data);
  if (action.event === "snapshot") {
    return {
      logs: restoreActivityEntries(data.logs, action.receivedAt),
      queries: restoreActivityEntries(data.queries, action.receivedAt),
      replies: restoreActivityEntries(data.replies, action.receivedAt)
    };
  }
  const key = action.event === "log"
    ? "logs"
    : action.event === "query"
      ? "queries"
      : action.event === "reply"
        ? "replies"
        : undefined;
  if (!key) return state;
  return {
    ...state,
    [key]: [{ receivedAt: action.receivedAt, data }, ...state[key]].slice(0, 200)
  };
}

function useEventFeed() {
  const [state, setState] = useState<ActivityFeedState>(EMPTY_ACTIVITY);
  useEffect(() => {
    const feed = openEventStream({
      onReset: () => setState((current) => reduceActivityFeed(current, { type: "reset" })),
      onEvent: (event) => {
        setState((current) => reduceActivityFeed(current, {
          type: "event",
          event: event.event,
          data: event.data,
          receivedAt: new Date().toLocaleTimeString()
        }));
      }
    });
    return () => feed.close();
  }, []);

  return state;
}

function pick(data: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => data[key])
    .filter((v) => typeof v === "string" && v)
    .join(" · ");
}

/**
 * A captured model call's one-line form. Calls of a life, maintenance, compaction or web digest are
 * metadata only (the server never keeps their content): their line shows counts, usage and cost.
 */
export function entrySummary(data: Record<string, unknown>): { title: string; metadataOnly: boolean; line: string | undefined } {
  const title = [pick(data, ["role", "agent", "source", "waifuId", "kind"]), typeof data.modelId === "string" ? data.modelId : ""].filter(Boolean).join(" · ");
  const metadataOnly = data.metadataOnly === true;
  const payload = (data.payload && typeof data.payload === "object" ? data.payload : {}) as Record<string, unknown>;
  if (metadataOnly) {
    const parts: string[] = [];
    if (typeof payload.messageCount === "number") parts.push(`${payload.messageCount} messages`);
    if (typeof payload.toolCount === "number") parts.push(`${payload.toolCount} tools`);
    if (typeof payload.finishReason === "string") parts.push(`stop: ${payload.finishReason}`);
    const usage = payload.usage && typeof payload.usage === "object" ? (payload.usage as Record<string, unknown>) : undefined;
    if (usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number") parts.push(`${usage.inputTokens} in / ${usage.outputTokens} out`);
    if (typeof payload.costUsd === "number") parts.push(usd(payload.costUsd, 4));
    if (typeof payload.durationMs === "number") parts.push(`${(payload.durationMs / 1000).toFixed(1)} s`);
    return { title, metadataOnly, line: parts.length ? parts.join(" · ") : "content not kept" };
  }
  return { title, metadataOnly, line: typeof data.content === "string" ? data.content : replyText(payload) };
}

/** A captured model reply's words: its text blocks, or its error. */
function replyText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (typeof content === "string") return content || undefined;
  if (Array.isArray(content)) {
    const parts = content.flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const record = block as Record<string, unknown>;
      if (record.type === "text" && typeof record.text === "string") return [record.text];
      if ((record.type === "tool_use" || record.type === "tool_call") && typeof record.name === "string") return [`→ ${record.name}`];
      return [];
    });
    if (parts.length) return parts.join(" ");
  }
  const error = payload.error && typeof payload.error === "object" ? (payload.error as Record<string, unknown>) : undefined;
  if (error) return `failed: ${[error.kind, error.message].filter((part) => typeof part === "string").join(" · ") || "error"}`;
  return undefined;
}

function ExpandableEntry({ entry, hue }: { entry: StreamEntry; hue: string }) {
  const [open, setOpen] = useState(false);
  const { title: summary, metadataOnly, line: body } = entrySummary(entry.data);
  return (
    <div className="cell cell-pad" style={{ paddingTop: 12, paddingBottom: 12 }}>
      <button className="clickable" style={{ background: "transparent", width: "100%" }} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="t-micro" style={{ marginBottom: 3 }}>
          {entry.receivedAt} · <span className={`chip ${hue}`}>{summary || "event"}</span>
          {metadataOnly && <span className="chip butter" style={{ marginLeft: 6 }} title="A life, maintenance, compaction or web call: only its metadata is kept">metadata only</span>}
          <span style={{ float: "right" }}>{open ? "−" : "+"}</span>
        </div>
        {body && !open && (
          <div className="t-small" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{body}</div>
        )}
      </button>
      {open && <pre className="code-block" style={{ marginTop: 8, maxHeight: 400, overflow: "auto" }}>{JSON.stringify(entry.data, null, 2)}</pre>}
    </div>
  );
}

export function ActivityScreen({
  tab,
  onNavigate,
  onTab
}: {
  tab: string | undefined;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onTab: (tab: string) => void;
}) {
  const { logs, queries, replies } = useEventFeed();
  const active = tab ?? "logs";
  const subtitle =
    active === "logs"
      ? `${logs.length} recent lines · live`
      : active === "queries"
        ? `${queries.length} model calls · live`
        : active === "usage"
          ? "model calls and cost by local day"
          : `${replies.length} model replies · live`;

  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("home")} title="Activity" sub={subtitle} />
      <TabCells view="activity" active={active} onTab={onTab} />
      <div className="content">
        {active === "logs" &&
          (logs.length === 0 ? (
            <EmptyCell text="No log lines yet." />
          ) : (
            logs.map((entry, index) => (
              <div className="logrow" key={index} style={{ flex: "none" }}>
                <div>{entry.receivedAt}</div>
                <div className={"lvl " + String(entry.data.level ?? "")}>{String(entry.data.level ?? "info")}</div>
                <div>{String(entry.data.message ?? entry.data.msg ?? JSON.stringify(entry.data))}</div>
              </div>
            ))
          ))}
        {active === "queries" &&
          (queries.length === 0 ? (
            <EmptyCell text="No model calls captured since the backend started." />
          ) : (
            queries.map((entry, index) => <ExpandableEntry key={index} entry={entry} hue="lavender" />)
          ))}
        {active === "replies" &&
          (replies.length === 0 ? (
            <EmptyCell text="No model replies captured since the backend started." />
          ) : (
            replies.map((entry, index) => <ExpandableEntry key={index} entry={entry} hue="mint" />)
          ))}
        {(active === "queries" || active === "replies") && (
          <div className="cell cell-pad">
            <span className="t-mute t-small">
              Every model call and its reply, as they happen. The assistant&apos;s and the detector&apos;s calls keep their content. A waifu&apos;s life, maintenance, compaction and web calls
              keep metadata only; her own turns are on the Life screen.
            </span>
          </div>
        )}
        {active === "usage" && <UsagePanel />}
        <div className="cell growcell" />
      </div>
      <FootRow />
    </div>
  );
}

const GROUPINGS: Array<{ id: UsageGroupKey[]; label: string }> = [
  { id: ["day"], label: "By day" },
  { id: ["waifu"], label: "By waifu" },
  { id: ["day", "waifu"], label: "By day and waifu" },
  { id: ["purpose"], label: "By purpose" },
  { id: ["model"], label: "By model" },
  { id: ["provider"], label: "By provider" }
];

/** The usage ledger, grouped (GET /api/usage; the host's time zone, last 7 days by default). */
function UsagePanel() {
  const [grouping, setGrouping] = useState(0);
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const groupBy = GROUPINGS[grouping]!.id;
  const usage = useApi<UsageResponse>((s) => api.usage({ ...range, groupBy }, s), [grouping, range.from, range.to]);
  const report = usage.data;
  return (
    <>
      <div className="fgrid cols-3">
        <div className="fcell">
          <label className="field-label" htmlFor="usage-group">Group</label>
          <select id="usage-group" className="select" value={grouping} onChange={(e) => setGrouping(Number(e.target.value))}>
            {GROUPINGS.map((option, index) => (
              <option key={option.label} value={index}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="fcell">
          <label className="field-label" htmlFor="usage-from">From</label>
          <input id="usage-from" className="input" type="date" value={range.from ?? report?.from ?? ""} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value || undefined }))} />
        </div>
        <div className="fcell">
          <label className="field-label" htmlFor="usage-to">To</label>
          <input id="usage-to" className="input" type="date" value={range.to ?? report?.to ?? ""} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value || undefined }))} />
        </div>
      </div>
      {usage.error && <EmptyCell text={usage.error.message} />}
      {report && (
        <div className="cell cell-pad" style={{ overflowX: "auto" }}>
          <table className="t-small data-table">
            <thead>
              <tr className="t-micro">
                <th>{groupBy.join(" · ")}</th>
                <th className="num">calls</th>
                <th className="num">tokens in</th>
                <th className="num">tokens out</th>
                <th className="num">cost</th>
              </tr>
            </thead>
            <tbody>
              {[...report.groups, { ...report.totals, key: ["total"], label: "Total" }].map((group) => (
                <tr key={group.key.join("|")} className={group.key[0] === "total" ? "total" : undefined}>
                  <td>{group.label ?? group.key.join(" · ")}</td>
                  <td className="num">{group.calls}{group.failedCalls ? ` (${group.failedCalls} failed)` : ""}</td>
                  <td className="num">{(group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens).toLocaleString()}</td>
                  <td className="num">{group.outputTokens.toLocaleString()}</td>
                  <td className="num">{usd(group.costUsd, 4)}{group.unpricedCalls ? "*" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="t-micro t-plain" style={{ marginTop: 8 }}>
            {report.from} … {report.to} · {report.timeZone}
            {report.totals.unpricedCalls ? " · * some calls have no known price" : ""}
            {report.skippedLines ? ` · ${report.skippedLines} unreadable ledger line(s) skipped` : ""}
            {report.groupsCapped ? " · over 1000 groups: the rest are added up under (other)" : ""}
          </div>
        </div>
      )}
    </>
  );
}

function EmptyCell({ text }: { text: string }) {
  return (
    <div className="cell empty-cell">
      <span className="t-mute t-small">{text}</span>
    </div>
  );
}
