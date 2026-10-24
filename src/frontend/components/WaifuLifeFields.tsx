import type { WaifuConfig } from "../api/types";

type Draft = Partial<WaifuConfig>;
type Patch = (patch: Draft) => void;

const DEFAULT_SLEEP = { enabled: false, start: "23:00", end: "07:00" };
const DEFAULT_DM = { allowDms: false, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" };

/** Waking, budget and schedule (Living cast §4.1, §4.4, §4.5). */
export function WaifuLifeFields({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const availability = draft.availability ?? { sleep: DEFAULT_SLEEP, busy: [] };
  const sleep = availability.sleep ?? DEFAULT_SLEEP;
  const busy = availability.busy ?? [];
  const setAvailability = (next: Partial<typeof availability>) => onChange({ availability: { ...availability, ...next } });
  const budget = draft.life?.dailyBudgetUsd ?? null;
  return (
    <>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr" }}>
        <div className="fcell">
          <label className="field-label">Wake on her name</label>
          <label className="checkbox-chip">
            <input type="checkbox" checked={draft.wakeOnName ?? true} onChange={(e) => onChange({ wakeOnName: e.target.checked })} />
            {draft.wakeOnName ?? true ? "Her name in a message wakes her" : "Only mentions, replies and DMs wake her"}
          </label>
          <span className="field-hint">Turn off for names that are common words.</span>
        </div>
        <div className="fcell">
          <label className="field-label">Daily budget (USD)</label>
          <input
            className="input"
            type="number"
            min={0.01}
            max={10000}
            step={0.5}
            placeholder="no budget"
            value={budget ?? ""}
            onChange={(e) => onChange({ life: { ...(draft.life ?? { dailyBudgetUsd: null }), dailyBudgetUsd: e.target.value === "" ? null : Number(e.target.value) } })}
          />
          <span className="field-hint">When she reaches it, her wakes wait for the next local day; yours still go through. Empty = no budget.</span>
        </div>
      </div>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 140px 140px" }}>
        <div className="fcell">
          <label className="field-label">Sleep</label>
          <label className="checkbox-chip">
            <input type="checkbox" checked={sleep.enabled} onChange={(e) => setAvailability({ sleep: { ...sleep, enabled: e.target.checked } })} />
            {sleep.enabled ? "She sleeps every night" : "She never sleeps"}
          </label>
          <span className="field-hint">While she sleeps, wakes wait and she gets a morning summary; your own wakes still reach her.</span>
        </div>
        <div className="fcell">
          <label className="field-label">From</label>
          <input className="input" type="time" value={sleep.start} disabled={!sleep.enabled} onChange={(e) => setAvailability({ sleep: { ...sleep, start: e.target.value } })} />
        </div>
        <div className="fcell">
          <label className="field-label">Until</label>
          <input className="input" type="time" value={sleep.end} disabled={!sleep.enabled} onChange={(e) => setAvailability({ sleep: { ...sleep, end: e.target.value } })} />
        </div>
      </div>
      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label">Busy blocks (daily)</label>
        {busy.length === 0 && <span className="field-hint">None. A busy block tells her (and the people she talks to) she is away.</span>}
        {busy.map((block, index) => (
          <div key={index} style={{ display: "grid", gridTemplateColumns: "110px 110px 1fr 80px", gap: 8, marginTop: 6 }}>
            <input className="input" type="time" value={block.start} onChange={(e) => setAvailability({ busy: busy.map((b, i) => (i === index ? { ...b, start: e.target.value } : b)) })} />
            <input className="input" type="time" value={block.end} onChange={(e) => setAvailability({ busy: busy.map((b, i) => (i === index ? { ...b, end: e.target.value } : b)) })} />
            <input className="input" placeholder="reason (class, work…)" value={block.reason} onChange={(e) => setAvailability({ busy: busy.map((b, i) => (i === index ? { ...b, reason: e.target.value } : b)) })} />
            <button className="btn ghost sm" onClick={() => setAvailability({ busy: busy.filter((_, i) => i !== index) })}>remove</button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => setAvailability({ busy: [...busy, { start: "09:00", end: "12:00", reason: "" }] })}>+ busy block</button>
        </div>
      </div>
    </>
  );
}

/** Direct messages (spec 9.1, Living cast §4.5). */
export function WaifuDmFields({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const dm = draft.dm ?? DEFAULT_DM;
  const set = (next: Partial<typeof dm>) => onChange({ dm: { ...dm, ...next } });
  const limited = dm.rateLimit !== null;
  return (
    <>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr 1fr" }}>
        <div className="fcell">
          <label className="field-label">Direct messages</label>
          <label className="checkbox-chip">
            <input type="checkbox" checked={dm.allowDms} onChange={(e) => set({ allowDms: e.target.checked })} />
            {dm.allowDms ? "She answers DMs to her bot" : "DMs off"}
          </label>
          <span className="field-hint">Needs her own bot, used by no other enabled waifu, and a model.</span>
        </div>
        <div className="fcell">
          <label className="field-label">Replies per person</label>
          <label className="checkbox-chip">
            <input type="checkbox" checked={!limited} onChange={(e) => set({ rateLimit: e.target.checked ? null : { maxReplies: 30, windowMinutes: 60 } })} />
            {limited ? "Limited" : "Unlimited"}
          </label>
          {dm.rateLimit && (
            <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
              <input className="input" type="number" min={1} max={1000} style={{ width: 90 }} value={dm.rateLimit.maxReplies} onChange={(e) => set({ rateLimit: { ...dm.rateLimit!, maxReplies: Number(e.target.value) } })} />
              <span className="t-small">per</span>
              <input className="input" type="number" min={1} max={10080} style={{ width: 90 }} value={dm.rateLimit.windowMinutes} onChange={(e) => set({ rateLimit: { ...dm.rateLimit!, windowMinutes: Number(e.target.value) } })} />
              <span className="t-small">minutes</span>
            </div>
          )}
        </div>
        <div className="fcell">
          <label className="field-label">When limited</label>
          <label className="checkbox-chip">
            <input type="checkbox" checked={dm.notifyWhenLimited} onChange={(e) => set({ notifyWhenLimited: e.target.checked })} />
            {dm.notifyWhenLimited ? "Send one notice" : "Stay silent"}
          </label>
        </div>
      </div>
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr" }}>
        <div className="fcell">
          <label className="field-label">Limit notice</label>
          <input className="input" maxLength={300} placeholder="built-in notice" value={dm.limitNotice} onChange={(e) => set({ limitNotice: e.target.value })} />
          <span className="field-hint">Tokens: {"{name}"}, {"{user}"}, {"{retryInMinutes}"}. Empty = the built-in notice.</span>
        </div>
        <div className="fcell">
          <label className="field-label">Sleep notice</label>
          <input className="input" maxLength={300} placeholder="no notice" value={dm.sleepNotice} onChange={(e) => set({ sleepNotice: e.target.value })} />
          <span className="field-hint">Sent once per night when a DM waits for her morning. Empty = none.</span>
        </div>
      </div>
    </>
  );
}
