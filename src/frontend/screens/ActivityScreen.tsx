import { useEffect, useState } from "react";
import { openEventStream } from "../api/client";
import type { ViewId } from "../nav";
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

function ExpandableEntry({ entry, hue }: { entry: StreamEntry; hue: string }) {
  const [open, setOpen] = useState(false);
  const summary =
    pick(entry.data, ["agent", "source", "waifuId", "kind"]) +
    (entry.data.modelId ? ` · ${String(entry.data.modelId)}` : "");
  const body = typeof entry.data.content === "string" ? entry.data.content : undefined;
  return (
    <div className="cell" style={{ padding: "12px 26px", flex: "none" }}>
      <button className="clickable" style={{ background: "transparent", width: "100%" }} onClick={() => setOpen((v) => !v)}>
        <div className="t-micro" style={{ marginBottom: 3 }}>
          {entry.receivedAt} · <span className={`chip ${hue}`}>{summary || "event"}</span>
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
        ? `${queries.length} captured queries · live`
        : `${replies.length} captured replies · live`;

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
            <EmptyCell text="No replies captured since the backend started." />
          ) : (
            replies.map((entry, index) => <ExpandableEntry key={index} entry={entry} hue="mint" />)
          ))}
        <div className="cell growcell" />
      </div>
      <FootRow />
    </div>
  );
}

function EmptyCell({ text }: { text: string }) {
  return (
    <div className="cell" style={{ padding: 40, textAlign: "center", flex: "none" }}>
      <span className="t-mute t-small">{text}</span>
    </div>
  );
}
