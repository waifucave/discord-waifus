import { useState } from "react";
import { useApi, useInterval } from "../api/useApi";
import { api } from "../api/client";
import type { LifeStatus, LogsResponse, OwnerNotices, ProvidersResponse, RuntimeState, ServersResponse, UsageResponse, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { FootRow } from "./scaffold";
import { castEvents, stateLabel, usd, when } from "./lifeView";

const NOTICE_PREVIEW = 4;
const POLL_MS = 10_000;

type HomeNotice = { key: string; title: string; chip: string; detail: string; dismiss?: () => Promise<void>; previous?: string };

/** Everything that needs the owner, in one list: owner notices first, then model notices. */
export function homeNotices(runtime: RuntimeState | undefined, owner: OwnerNotices | undefined, names: Map<string, string>): HomeNotice[] {
  const out: HomeNotice[] = [];
  for (const [index, text] of (owner?.notices ?? runtime?.discord.warnings ?? []).entries()) {
    out.push({ key: `notice-${index}`, title: "Owner notice", chip: "notice", detail: text });
  }
  for (const step of owner?.incompleteMigrations ?? []) {
    out.push({ key: `migration-${step.step}`, title: "Upgrade step waiting", chip: "migration", detail: `${step.step}: ${step.detail}. It runs again at the next start; repair or remove the file it names.` });
  }
  for (const job of owner?.forgetJobs ?? []) {
    const waiting = job.pending.filter((part) => part.retried);
    if (waiting.length > 0) out.push({ key: `forget-${job.userId}`, title: "Forget not finished", chip: "forget", detail: `${job.userId}: ${waiting.map((part) => part.part).join(", ")} run again at the next start.` });
  }
  if ((owner?.corruptForgetCopies ?? 0) > 0) {
    out.push({ key: "corrupt-copies", title: "Unreadable forget record", chip: "forget", detail: `${owner!.corruptForgetCopies} kept copy/copies of an unreadable forget record (deleted after 7 days).` });
  }
  for (const entry of owner?.pendingScrubs ?? []) {
    out.push({ key: `scrub-${entry.waifuId}`, title: names.get(entry.waifuId) ?? entry.waifuId, chip: "scrub queued", detail: `${entry.count} forget scrub(s) wait for her next start or nightly maintenance.` });
  }
  for (const warning of runtime?.models?.warnings ?? []) {
    out.push({
      key: `model-${warning.scope}-${warning.code}`,
      title: warning.label ?? warning.scope,
      chip: warning.code,
      detail: warning.detail,
      ...(warning.previous ? { previous: warning.previous } : {}),
      ...(warning.dismissible ? { dismiss: async () => void (await api.dismissModelWarnings(warning.scope)) } : {})
    });
  }
  return out;
}

/** Today's cost per waifu in the host's time zone (the report's last day), and the total. */
export function todaysCost(report: UsageResponse | undefined): { total: number; byWaifu: Map<string, number> } {
  const byWaifu = new Map<string, number>();
  let total = 0;
  for (const group of report?.groups ?? []) {
    if (group.key[0] !== report!.to) continue;
    total += group.costUsd;
    byWaifu.set(group.key[1] ?? "", (byWaifu.get(group.key[1] ?? "") ?? 0) + group.costUsd);
  }
  return { total, byWaifu };
}

export function HomeScreen({
  onNavigate,
  onAssistant
}: {
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onAssistant: () => void;
}) {
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const providers = useApi<ProvidersResponse>((s) => api.providers(s), []);
  const owner = useApi<OwnerNotices>((s) => api.ownerNotices(s), []);
  const logs = useApi<LogsResponse>((s) => api.logs(500, s), []);
  // The host's today: the last day of the default range, so a remote browser in another zone agrees.
  const usage = useApi<UsageResponse>((s) => api.usage({ groupBy: ["day", "waifu"] }, s), []);
  const today = todaysCost(usage.data);
  const cast = waifus.data?.waifus ?? [];
  const ids = cast.map((waifu) => waifu.id).join(",");
  const lives = useApi<LifeStatus[]>((s) => Promise.all(cast.map((waifu) => api.life(waifu.id, false, s))), [ids]);
  useInterval(() => {
    runtime.reload();
    lives.reload();
    logs.reload();
    usage.reload();
    owner.reload();
  }, POLL_MS);

  const names = new Map(cast.map((waifu) => [waifu.id, waifu.displayName || waifu.name]));
  const guilds = servers.data?.servers ?? [];
  const liveChannels = guilds.reduce(
    (sum, guild) => sum + Object.values(guild.channels ?? {}).filter((c) => (c.enabledWaifuIds?.length ?? 0) > 0).length,
    0
  );
  const anyProvider = (providers.data?.providers ?? []).some((p) => p.credentials.configured);
  const discord = runtime.data?.discord;
  const notices = homeNotices(runtime.data, owner.data, names);
  const [allNotices, setAllNotices] = useState(false);
  const shownNotices = allNotices ? notices : notices.slice(0, NOTICE_PREVIEW);
  const hiddenNotices = notices.length - shownNotices.length;
  const events = castEvents(logs.data, 10);
  const awake = (lives.data ?? []).filter((life) => stateLabel(life).word === "Awake" || life.status === "turn").length;
  const reviewCount = (lives.data ?? []).reduce((sum, life) => sum + life.counts.needsReview, 0);

  const statusWord = !runtime.data ? "…" : runtime.data.paused ? "Paused" : discord?.connected ? "Live" : "Offline";
  const statusSub = runtime.data
    ? `${awake} of ${cast.length} awake · today ${usd(today.total)} · ${discord?.waifuBotCount ?? 0} bots · ${guilds.length} servers`
    : "connecting to the backend…";

  return (
    <div className="screen" id="home-screen">
      <div
        className="mosaic"
        style={{
          flex: 1,
          gridTemplateColumns: "1.4fr 1fr 1fr 1.3fr",
          gridTemplateRows: "96px 1fr 1fr 1fr 1fr",
          minHeight: 0
        }}
      >
        <div className="cell" style={{ display: "flex", alignItems: "center", gap: 14, padding: "0 26px" }}>
          <span className="mark">W</span>
          <span className="t-title">Discord Waifus</span>
        </div>
        <div className="cell" style={{ gridColumn: "2 / 4", display: "flex", alignItems: "center", gap: 18, padding: "0 26px", overflow: "hidden" }}>
          <span className="t-hero">{statusWord}</span>
          <span className="t-mute t-small" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{statusSub}</span>
        </div>
        <button
          className="cell clickable tile"
          data-hue
          style={{ gridColumn: 4, gridRow: "1 / 3", ["--hover-hue" as string]: "var(--pink)" }}
          onClick={onAssistant}
        >
          <span className="t-micro">Ask · change · fix</span>
          <span className="t-big">Assistant</span>
          <span className="meta">"give Aria a model", "why is Riko quiet?", "pause everything"</span>
        </button>

        <button
          className="cell clickable tile"
          data-hue
          style={{ gridColumn: 1, gridRow: "2 / 4", ["--hover-hue" as string]: "var(--mint)" }}
          onClick={() => onNavigate("cast")}
        >
          <span className="idx">02</span>
          <span className="nm" style={{ fontSize: 46 }}>Cast</span>
          <span className="meta">
            {cast.length ? `${cast.length} characters — ${[...names.values()].join(", ")}`.slice(0, 110) : "no characters yet"}{" "}
            {(cast.length === 0 || cast.some((w) => !w.model)) && <span className="chip butter">needs setup</span>}
          </span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 2, gridRow: 2, ["--hover-hue" as string]: "var(--lavender)" }} onClick={() => onNavigate("life")}>
          <span className="idx">03</span>
          <span className="nm">Life</span>
          <span className="meta">
            timelines · wake · compact {reviewCount > 0 && <span className="chip butter">{reviewCount} to review</span>}
          </span>
        </button>
        <button className="cell clickable tile" data-hue style={{ gridColumn: 3, gridRow: 2, ["--hover-hue" as string]: "var(--sky)" }} onClick={() => onNavigate("rooms")}>
          <span className="idx">04</span>
          <span className="nm">Rooms</span>
          <span className="meta">
            {guilds.length ? `${guilds.length} servers · ${liveChannels} channels live` : "no servers yet"}{" "}
            {guilds.length > 0 && liveChannels === 0 && <span className="chip butter">enable a channel</span>}
          </span>
        </button>

        <div className="cell" style={{ gridColumn: "2 / 4", gridRow: 3, padding: "16px 26px", overflow: "auto" }}>
          <div className="t-micro" style={{ marginBottom: 8 }}>Who is up</div>
          {cast.length === 0 && <span className="t-mute t-small">No characters yet.</span>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px" }}>
            {(lives.data ?? []).map((life) => {
              const state = stateLabel(life);
              const spent = today.byWaifu.get(life.waifuId) ?? life.today.costUsd;
              return (
                <button key={life.waifuId} className="clickable" style={{ background: "transparent", padding: 0 }} onClick={() => onNavigate("life", undefined, life.waifuId)}>
                  <span className="t-small" style={{ marginRight: 6 }}>{life.displayName}</span>
                  <span className={`chip ${state.hue}`}>{state.word}</span>
                  <span className="t-micro" style={{ marginLeft: 6, textTransform: "none", letterSpacing: "0.04em" }}>{usd(spent)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <button className="cell clickable tile" data-hue style={{ gridColumn: 1, gridRow: 4, ["--hover-hue" as string]: "var(--peach)" }} onClick={() => onNavigate("activity")}>
          <span className="idx">05</span>
          <span className="nm">Activity</span>
          <span className="meta">logs · model calls · usage</span>
        </button>
        <div className="cell" style={{ gridColumn: "2 / 4", gridRow: "4 / 6", padding: "16px 26px", overflow: "auto" }}>
          <div className="t-micro" style={{ marginBottom: 8 }}>Recent sends and wakes</div>
          {events.length === 0 && <span className="t-mute t-small">Nothing since the host started.</span>}
          {events.map((event, index) => (
            <div key={`${event.at}-${index}`} className="t-small" style={{ padding: "3px 0" }}>
              <span className="t-micro" style={{ marginRight: 10 }}>{when(event.at)}</span>
              <span>{names.get(event.waifuId) ?? event.waifuId}</span> <span className="t-mute">{event.text}</span>
            </div>
          ))}
        </div>
        <button className="cell clickable tile inverts" style={{ gridColumn: 1, gridRow: 5 }} onClick={() => onNavigate("settings")}>
          <span className="idx">06</span>
          <span className="nm">Settings</span>
          <span className="meta">
            {anyProvider ? "providers · models · search · limits · app" : "add a provider key to start"}{" "}
            {!anyProvider && <span className="chip butter">needs setup</span>}
          </span>
        </button>

        <div
          style={{
            gridColumn: 4,
            gridRow: "3 / 6",
            display: "flex",
            flexDirection: "column",
            gap: "var(--line)",
            background: "var(--ink)",
            minHeight: 0,
            overflowY: allNotices ? "auto" : "hidden"
          }}
        >
          <div className="cell" style={{ padding: "12px 20px 10px", flex: "none" }}>
            <span className="t-micro">Needs you{notices.length > 0 ? ` · ${notices.length}` : ""}</span>
          </div>
          {notices.length === 0 && (
            <div className="cell" style={{ flex: 1, padding: 20 }}>
              <span className="t-mute t-small">Nothing needs you right now.</span>
            </div>
          )}
          {shownNotices.map((notice, index) => (
            <div
              className="cell"
              style={{ padding: "12px 20px", flex: index === shownNotices.length - 1 && hiddenNotices === 0 && !allNotices ? 1 : "none" }}
              key={notice.key}
            >
              <div className="t-micro" style={{ marginBottom: 3, display: "flex", alignItems: "baseline", gap: 8 }}>
                <span>{notice.title}</span>
                <span className="chip butter">{notice.chip}</span>
                {notice.dismiss && (
                  <button
                    className="btn ghost sm"
                    style={{ marginLeft: "auto" }}
                    title="Dismiss this notice"
                    onClick={async () => {
                      try {
                        await notice.dismiss!();
                      } finally {
                        void runtime.reload();
                      }
                    }}
                  >
                    dismiss
                  </button>
                )}
              </div>
              <div className="t-small" style={allNotices ? undefined : { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                {notice.detail}
              </div>
              {notice.previous && <div className="t-mute t-small">was: {notice.previous}</div>}
            </div>
          ))}
          {(hiddenNotices > 0 || allNotices) && notices.length > NOTICE_PREVIEW && (
            <button className="cell clickable" style={{ padding: "10px 20px", flex: 1, textAlign: "left" }} onClick={() => setAllNotices((open) => !open)}>
              <span className="t-micro">{allNotices ? "Show fewer" : `${hiddenNotices} more…`}</span>
            </button>
          )}
        </div>
      </div>
      <FootRow />
    </div>
  );
}
