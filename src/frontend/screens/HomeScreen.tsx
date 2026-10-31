import { useState } from "react";
import { useApi, useInterval } from "../api/useApi";
import { api } from "../api/client";
import type { OwnerNotices, RuntimeState, WaifusResponse } from "../api/types";
import type { ViewId } from "../nav";
import { FootRow } from "./scaffold";

const POLL_MS = 10_000;

export type HomeNotice = { key: string; title: string; chip: string; detail: string; dismiss?: () => Promise<void>; previous?: string };

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
    out.push({ key: `scrub-${entry.waifuId}`, title: names.get(entry.waifuId) ?? entry.waifuId, chip: "scrub queued", detail: `${entry.count} forget scrub(s) wait for her next start or daily maintenance.` });
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

/** Where a menu tile goes: a screen (and tab), or the assistant panel. */
export type MenuTarget = { view: Exclude<ViewId, "home">; tab?: string } | "assistant";

export type MenuEntry = { id: string; index: string; title: string; line: string; hue: string; target: MenuTarget; wide?: boolean };

/** Home is a menu: one tile per section, each with one line of what is inside. */
export const HOME_MENU: readonly MenuEntry[] = Object.freeze([
  { id: "cast", index: "01", title: "Cast", line: "Who each waifu is: persona, her Discord bot, model, budget and DMs.", hue: "mint", target: { view: "cast" }, wide: true },
  { id: "life", index: "02", title: "Life", line: "What each waifu is doing: her timeline, files, wakeups and wakes.", hue: "lavender", target: { view: "life" } },
  { id: "rooms", index: "03", title: "Rooms", line: "Servers and channels, and who may speak where.", hue: "sky", target: { view: "rooms" } },
  { id: "activity", index: "04", title: "Activity", line: "Host logs, model calls and replies, usage and cost.", hue: "peach", target: { view: "activity" } },
  { id: "settings", index: "05", title: "Settings", line: "Provider keys, models, search, the detector, limits and the app.", hue: "mint", target: { view: "settings" } },
  { id: "assistant", index: "06", title: "Assistant", line: "Ask Norma to explain, change or fix your setup.", hue: "pink", target: "assistant" },
  { id: "remote-access", index: "07", title: "Remote Access", line: "Open this dashboard from your other devices.", hue: "sky", target: { view: "settings", tab: "remote-access" } }
]);

/** The one notice bar: absent when nothing needs the owner, one line (expandable) otherwise. */
export function NeedsYouBar({ notices, onDismissed }: { notices: readonly HomeNotice[]; onDismissed?: () => void }) {
  const [open, setOpen] = useState(false);
  if (notices.length === 0) return null;
  const first = notices[0]!;
  return (
    <section className="needs-bar" aria-label="Needs you">
      <div className="cell needs-summary">
        <div className="needs-text">
          <span className="t-micro">Needs you · {notices.length}</span>
          <span className="t-small">
            {first.title}: {first.detail}
          </span>
        </div>
        <div className="needs-actions">
          <button className="btn sm" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? "Hide" : notices.length > 1 ? `Show all ${notices.length}` : "Show"}
          </button>
        </div>
      </div>
      {open &&
        notices.map((notice) => (
          <div className="cell needs-item" key={notice.key}>
            <div className="needs-item-head">
              <span className="t-small">{notice.title}</span>
              <span className="chip butter">{notice.chip}</span>
              {notice.dismiss && (
                <button
                  className="btn quiet sm"
                  title="Dismiss this notice"
                  onClick={async () => {
                    try {
                      await notice.dismiss!();
                    } finally {
                      onDismissed?.();
                    }
                  }}
                >
                  Dismiss
                </button>
              )}
            </div>
            <div className="t-small t-mute">{notice.detail}</div>
            {notice.previous && <div className="t-small t-mute">Was: {notice.previous}</div>}
          </div>
        ))}
    </section>
  );
}

/** The menu grid itself (no data): seven tiles, no empty cells. */
export function HomeMenu({ onOpen }: { onOpen: (target: MenuTarget) => void }) {
  return (
    <nav className="mosaic tiles home-menu" aria-label="Sections">
      {HOME_MENU.map((entry) => (
        <button
          key={entry.id}
          className={"cell clickable tile" + (entry.wide ? " wide" : "")}
          data-hue
          data-section={entry.id}
          style={{ ["--hover-hue" as string]: `var(--${entry.hue})` }}
          onClick={() => onOpen(entry.target)}
        >
          <span>
            <span className="idx" style={{ display: "block", marginBottom: 10 }}>{entry.index}</span>
            <span className="nm" style={{ display: "block" }}>{entry.title}</span>
          </span>
          <span className="meta">{entry.line}</span>
        </button>
      ))}
    </nav>
  );
}

export function HomeScreen({
  onNavigate,
  onAssistant
}: {
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
  onAssistant: () => void;
}) {
  const runtime = useApi<RuntimeState>((s) => api.runtime(s), []);
  const owner = useApi<OwnerNotices>((s) => api.ownerNotices(s), []);
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  useInterval(() => {
    runtime.reload();
    owner.reload();
  }, POLL_MS);

  const names = new Map((waifus.data?.waifus ?? []).map((waifu) => [waifu.id, waifu.displayName || waifu.name]));
  const notices = homeNotices(runtime.data, owner.data, names);
  const discord = runtime.data?.discord;
  const status = !runtime.data ? "connecting…" : runtime.data.paused ? "paused" : discord?.connected ? "live" : "Discord offline";

  return (
    <div className="screen" id="home-screen">
      <header className="home-head">
        <div className="cell markcell">
          <span className="mark">W</span>
        </div>
        <div className="cell titlecell">
          <h1 className="t-big" style={{ fontWeight: 400 }}>Discord Waifus</h1>
          <span className="sub">{status}</span>
        </div>
      </header>
      <NeedsYouBar notices={notices} onDismissed={() => void runtime.reload()} />
      <HomeMenu onOpen={(target) => (target === "assistant" ? onAssistant() : onNavigate(target.view, target.tab))} />
      <FootRow />
    </div>
  );
}
