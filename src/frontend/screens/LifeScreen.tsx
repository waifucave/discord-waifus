import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useApi, useInterval } from "../api/useApi";
import type { LifeLog, LifeLogLineView, LifeStatus, NeedsReviewResponse, SearchUsage, WaifuConfig, WaifusResponse } from "../api/types";
import { characterHue, type ViewId } from "../nav";
import { useClientContext } from "../state/clientContext";
import { FootRow, HeadRow } from "./scaffold";
import { Notice } from "../components/Notice";
import { ForgetPersonPanel } from "../components/ForgetPersonPanel";
import { blockRow, groupByTurn, lineLabel, stateLabel, usd, wakeOutcomeText, when } from "./lifeView";

const LOG_PAGE = 100;
const POLL_MS = 5000;

export function LifeScreen({
  waifuId,
  onNavigate
}: {
  waifuId?: string;
  onNavigate: (view: ViewId, tab?: string, id?: string) => void;
}) {
  if (waifuId) return <LifeDetail waifuId={waifuId} onNavigate={onNavigate} />;
  return <LifeMosaic onNavigate={onNavigate} />;
}

/* ================= every life at a glance ================= */

function useLives(cast: WaifuConfig[]) {
  const ids = cast.map((waifu) => waifu.id).join(",");
  return useApi<LifeStatus[]>(
    async (signal) => Promise.all(cast.map((waifu) => api.life(waifu.id, false, signal))),
    [ids]
  );
}

function LifeMosaic({ onNavigate }: { onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const waifus = useApi<WaifusResponse>((s) => api.waifus(s), []);
  const cast = waifus.data?.waifus ?? [];
  const lives = useLives(cast);
  useInterval(() => lives.reload(), POLL_MS * 2);
  const byId = new Map((lives.data ?? []).map((life) => [life.waifuId, life]));
  return (
    <div className="screen">
      <HeadRow onBack={() => onNavigate("home")} title="Life" sub="what each waifu is doing, live" />
      <div className="content">
        {cast.length === 0 && (
          <div className="cell growcell" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 40 }}>
            <span className="t-mute t-small">No characters yet. Create one in Cast.</span>
          </div>
        )}
        {cast.length > 0 && (
          <div className="mosaic" style={{ flex: 1, gridTemplateColumns: "repeat(3, 1fr)", gridAutoRows: "minmax(200px, 1fr)" }}>
            {cast.map((waifu, index) => {
              const life = byId.get(waifu.id);
              const state = life ? stateLabel(life) : undefined;
              const waiting = life ? life.queue.immediate + life.queue.deferred.items : 0;
              return (
                <button
                  key={waifu.id}
                  className="cell clickable tile"
                  data-hue
                  style={{ ["--hover-hue" as string]: `var(--${characterHue(index)})` }}
                  onClick={() => onNavigate("life", undefined, waifu.id)}
                >
                  <div>
                    <span className="nm">{waifu.displayName || waifu.name}</span>
                    <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "baseline" }}>
                      {state && <span className={`chip ${state.hue}`}>{state.word}</span>}
                      {state?.detail && <span className="t-micro" style={{ textTransform: "none", letterSpacing: "0.04em" }}>{state.detail}</span>}
                    </div>
                  </div>
                  <span className="meta">
                    {life
                      ? `${waiting} waiting · today ${usd(life.today.costUsd)}${life.today.budgetUsd !== null ? ` of ${usd(life.today.budgetUsd)}` : ""} · last turn ${when(life.lastTurnEndedAt)}`
                      : lives.error
                        ? "status unavailable"
                        : "…"}
                    {life && life.counts.needsReview > 0 && <span className="chip butter" style={{ marginLeft: 8 }}>review</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <FootRow />
    </div>
  );
}

/* ================= one life ================= */

function LifeDetail({ waifuId, onNavigate }: { waifuId: string; onNavigate: (view: ViewId, tab?: string, id?: string) => void }) {
  const context = useClientContext();
  const remote = context.mode === "remote";
  const [reveal, setReveal] = useState(false);
  const includePrivate = reveal && !remote;
  const status = useApi<LifeStatus>((s) => api.life(waifuId, includePrivate, s), [waifuId, includePrivate]);
  const [epoch, setEpoch] = useState<number | undefined>(undefined);
  const log = useApi<LifeLog>((s) => api.lifeLog(waifuId, { limit: LOG_PAGE, includePrivate, ...(epoch !== undefined ? { epoch } : {}) }, s), [waifuId, includePrivate, epoch]);
  const [older, setOlder] = useState<LifeLogLineView[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | undefined>(undefined);
  const review = useApi<NeedsReviewResponse>((s) => api.needsReview(waifuId, includePrivate, s), [waifuId, includePrivate]);
  const search = useApi<SearchUsage>((s) => api.searchUsage(s), []);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn"; text: string } | undefined>(undefined);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    setOlder([]);
    setOlderMore(undefined);
  }, [waifuId, includePrivate, epoch]);
  // Live: the current epoch refreshes every few seconds; an older epoch stays put.
  useInterval(() => {
    status.reload();
    if (epoch === undefined) log.reload();
  }, POLL_MS);

  const life = status.data;
  const name = life?.displayName ?? waifuId;
  const lines = [...older, ...(log.data?.lines ?? [])];
  const hasMore = olderMore ?? log.data?.hasMore ?? false;
  const myQueries = (search.data?.recent ?? []).filter((entry) => entry.waifuId === waifuId);

  const act = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setMessage(undefined);
    try {
      setMessage({ tone: "ok", text: await fn() });
      status.reload();
      log.reload();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const loadOlder = async () => {
    const first = lines[0];
    if (!first) return;
    try {
      const page = await api.lifeLog(waifuId, { before: first.seq, limit: LOG_PAGE, includePrivate, ...(epoch !== undefined ? { epoch } : {}) });
      setOlder((current) => [...page.lines, ...current]);
      setOlderMore(page.hasMore);
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    }
  };

  const state = life ? stateLabel(life) : undefined;
  return (
    <div className="screen">
      <HeadRow
        onBack={() => onNavigate("life")}
        title={name}
        sub={life ? `${state?.word ?? ""}${state?.detail ? ` · ${state.detail}` : ""} · epoch ${life.epoch}` : "loading her life…"}
        action={
          <button className="cell clickable actioncell" data-hue style={{ ["--hover-hue" as string]: "var(--mint)" }} onClick={() => onNavigate("cast", undefined, waifuId)}>
            Edit in Cast →
          </button>
        }
      />
      <div className="content">
        {status.error && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone="err">{status.error.message}</Notice>
          </div>
        )}
        {message && (
          <div className="cell" style={{ padding: 16, flex: "none" }}>
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        )}

        {life && (
          <div className="mosaic" style={{ gridTemplateColumns: "repeat(4, 1fr)", flex: "none" }}>
            <StatCell label="Now" value={state?.word ?? ""} detail={state?.detail || (life.currentTurn ? `turn of ${life.currentTurn.wakes} wake(s), round ${life.currentTurn.rounds}` : `last turn ${when(life.lastTurnEndedAt)}`)} />
            <StatCell
              label="Waiting"
              value={String(life.queue.immediate + life.queue.deferred.items)}
              detail={`${life.queue.immediate} now · ${life.queue.deferred.items} deferred${life.queue.deferred.reason ? ` (${life.queue.deferred.reason})` : ""} · ${life.queue.quiet} quiet`}
            />
            <StatCell
              label="Today"
              value={usd(life.today.costUsd)}
              detail={`${life.today.calls} calls${life.today.budgetUsd !== null ? ` · budget ${usd(life.today.budgetUsd)}` : " · no budget"} · ${life.today.searches} searches · ${life.today.fetches} pages`}
            />
            <StatCell
              label="Life"
              value={life.started ? `Epoch ${life.epoch}` : "Not started"}
              detail={`${life.logLines} lines · compacted ${life.lastCompaction ? when(life.lastCompaction.at) : "never"} · tidied ${when(life.lastMaintenanceAt)}`}
            />
          </div>
        )}

        {life && (
          <div className="fgrid" style={{ gridTemplateColumns: "1fr 140px 140px 140px", flex: "none" }}>
            <div className="fcell">
              <label className="field-label">Wake her (an owner wake skips sleep and budget)</label>
              <input className="input" maxLength={500} placeholder="A note she sees (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <button
              className="cell clickable btn"
              disabled={busy !== undefined}
              onClick={() =>
                void act("wake", async () => {
                  const result = await api.wake(waifuId, note.trim() || undefined);
                  setNote("");
                  return wakeOutcomeText(result.outcome);
                })
              }
            >
              {busy === "wake" ? "Waking…" : "Wake"}
            </button>
            <button
              className="cell clickable btn"
              disabled={busy !== undefined || !life.runtime.running}
              title={life.runtime.running ? "Summarise her life now and start a new epoch" : "Needs Discord connected"}
              onClick={() =>
                void act("compact", async () => {
                  const result = await api.compactLife(waifuId);
                  return result.state === "running" ? "Compacting: it finishes on its own." : `Compacted: epoch ${result.epoch ?? ""} started.`;
                })
              }
            >
              {busy === "compact" ? "Compacting…" : "Compact"}
            </button>
            <button className="cell clickable btn" data-hue style={{ ["--hover-hue" as string]: "var(--danger)" }} disabled={busy !== undefined || !life.runtime.running} onClick={() => setConfirmReset(true)}>
              Reset…
            </button>
          </div>
        )}

        <div className="cell" style={{ padding: "14px 26px", flex: "none", display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
          <span className="t-title">Timeline</span>
          {log.data && log.data.epochs.length > 1 && (
            <select className="select" style={{ maxWidth: 180 }} value={epoch ?? ""} onChange={(e) => setEpoch(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">Current epoch</option>
              {log.data.epochs
                .filter((value) => value !== life?.epoch)
                .map((value) => (
                  <option key={value} value={value}>
                    Epoch {value}
                  </option>
                ))}
            </select>
          )}
          <label className="checkbox-chip" title={remote ? "Private chats are only shown on the host itself." : undefined}>
            <input type="checkbox" checked={includePrivate} disabled={remote} onChange={(e) => setReveal(e.target.checked)} />
            Show private chats
          </label>
          <span className="t-micro" style={{ textTransform: "none", letterSpacing: "0.04em" }}>
            {remote
              ? "Private chats stay hidden over Remote Access: open the dashboard on the host to reveal them."
              : includePrivate
                ? "Showing everything, including DMs and her summary."
                : `${log.data?.redactedBlocks ?? 0} block(s) from private chats hidden on this page.`}
          </span>
        </div>

        {life && (life.summary.text || life.summary.hidden) && (
          <div className="cell" style={{ padding: "12px 26px", flex: "none" }}>
            <div className="t-micro" style={{ marginBottom: 4 }}>Her life so far (summary)</div>
            {life.summary.hidden ? (
              <span className="t-small t-mute">Hidden: it may hold things from private chats.</span>
            ) : (
              <div className="t-small" style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{life.summary.text}</div>
            )}
          </div>
        )}

        {hasMore && (
          <button className="cell clickable" style={{ padding: "10px 26px", flex: "none" }} onClick={() => void loadOlder()}>
            <span className="t-micro">Load older lines</span>
          </button>
        )}
        {log.data && lines.length === 0 && (
          <div className="cell" style={{ padding: 30, flex: "none", textAlign: "center" }}>
            <span className="t-mute t-small">Nothing in this epoch yet.</span>
          </div>
        )}
        {groupByTurn(lines).map((group) => (
          <TurnCell key={`${group.turnId ?? "line"}-${group.lines[0]!.seq}`} lines={group.lines} />
        ))}

        <div className="cell" style={{ padding: "18px 26px", flex: "none" }}>
          <div className="t-title" style={{ marginBottom: 8 }}>Needs review</div>
          {(review.data?.items ?? []).length === 0 ? (
            <span className="t-small t-mute">Nothing to review. After a forget, lines naming someone who shares a name with another person are listed here.</span>
          ) : (
            (review.data?.items ?? []).map((item) => (
              <div key={item.id} style={{ display: "flex", gap: 12, alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line-soft, #e6e6e6)" }}>
                <span className="t-micro" style={{ flex: "none" }}>{item.where}</span>
                <span className="t-small" style={{ flex: 1 }}>{item.line}</span>
                <button
                  className="btn ghost sm"
                  onClick={async () => {
                    try {
                      await api.dismissNeedsReview(waifuId, item.id);
                      review.reload();
                      status.reload();
                    } catch (err) {
                      setMessage({ tone: "err", text: (err as Error).message });
                    }
                  }}
                >
                  dismiss
                </button>
              </div>
            ))
          )}
        </div>

        <div className="cell" style={{ padding: "18px 26px", flex: "none" }}>
          <div className="t-title" style={{ marginBottom: 8 }}>Web searches today</div>
          {myQueries.length === 0 ? (
            <span className="t-small t-mute">None today.</span>
          ) : (
            myQueries.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="t-small" style={{ padding: "3px 0" }}>
                <span className="t-micro" style={{ marginRight: 10 }}>{when(entry.at)} · {entry.kind}</span>
                {entry.query}
                {!entry.ok && <span className="chip butter" style={{ marginLeft: 8 }}>failed</span>}
              </div>
            ))
          )}
        </div>

        <ForgetPersonPanel />
        <div className="cell growcell" />
      </div>
      <FootRow />

      {confirmReset && (
        <div className="modal-backdrop" onClick={(e) => e.target === e.currentTarget && setConfirmReset(false)}>
          <div className="modal" style={{ width: 520 }}>
            <div className="modal-header">
              <span className="t-title">Reset {name}&apos;s life?</span>
            </div>
            <div className="modal-body">
              <p className="t-small">
                She starts a fresh epoch with no summary of what happened before. Her notes, plans and queued wakes stay; the old
                log is kept for 7 days.
              </p>
            </div>
            <div className="modal-footer">
              <button className="cell clickable" style={{ background: "var(--paper)" }} onClick={() => setConfirmReset(false)}>
                Keep
              </button>
              <button
                className="cell clickable"
                style={{ background: "var(--danger)" }}
                onClick={() => {
                  setConfirmReset(false);
                  void act("reset", async () => {
                    const result = await api.resetLife(waifuId);
                    return result.deferred ? `Reset: epoch ${result.epoch} starts at her next turn.` : `Reset: epoch ${result.epoch} started.`;
                  });
                }}
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="cell" style={{ padding: "16px 22px" }}>
      <div className="t-micro">{label}</div>
      <div className="t-title" style={{ margin: "4px 0" }}>{value}</div>
      <div className="t-small t-mute" style={{ lineHeight: 1.4 }}>{detail}</div>
    </div>
  );
}

/** One turn (or one stray line) of her life log; tool calls show their own names and arguments. */
export function TurnCell({ lines }: { lines: LifeLogLineView[] }) {
  return (
    <div className="cell" style={{ padding: "12px 26px", flex: "none" }}>
      {lines.map((line) => (
        <div key={line.seq} style={{ marginBottom: 6 }}>
          <div className="t-micro" style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
            <span>{when(line.at)}</span>
            <span>{lineLabel(line)}</span>
            {line.dm && <span className="chip sky">private chat</span>}
            {line.boundary && <span className="chip lavender">from epoch {line.boundary.fromEpoch} · {line.boundary.reason}</span>}
            {line.origin?.modelId && <span style={{ marginLeft: "auto", textTransform: "none" }}>{line.origin.modelId}</span>}
          </div>
          {line.blocks.map((block, index) => {
            const row = blockRow(block);
            return (
              <div
                key={index}
                className="t-small"
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "2px 0 2px 14px",
                  color: row.tone === "muted" ? "var(--mute)" : row.tone === "error" ? "#c22f2f" : undefined,
                  whiteSpace: row.tone === "text" ? "pre-wrap" : undefined
                }}
              >
                {row.label && <span className="mono" style={{ flex: "none", fontSize: 11.5 }}>{row.tone === "call" ? `→ ${row.label}` : row.label}</span>}
                <span style={{ overflowWrap: "anywhere" }}>{row.text}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
