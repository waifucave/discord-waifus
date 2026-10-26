import type { WaifuConfig } from "../api/types";

type Draft = Partial<WaifuConfig>;
type Patch = (patch: Draft) => void;

const DEFAULT_SLEEP = { enabled: false, start: "23:00", end: "07:00" };
const DEFAULT_DM = { allowDms: false, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" };
const DEFAULT_RATE_LIMIT = { maxReplies: 30, windowMinutes: 60 };

function availabilityOf(draft: Draft) {
  const availability = draft.availability ?? { sleep: DEFAULT_SLEEP, busy: [] };
  return { availability, sleep: availability.sleep ?? DEFAULT_SLEEP, busy: availability.busy ?? [] };
}

/** Her name in a message wakes her (Living cast §4.1). */
export function WakeOnNameField({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const on = draft.wakeOnName ?? true;
  return (
    <div className="fcell">
      <span className="field-label">Wake on her name</span>
      <label className="checkbox-chip">
        <input type="checkbox" checked={on} onChange={(e) => onChange({ wakeOnName: e.target.checked })} />
        {on ? "Her name in a message wakes her" : "Only mentions, replies and DMs wake her"}
      </label>
      <span className="field-hint">Turn off for names that are common words.</span>
    </div>
  );
}

/** Her spending limit per local day (§4.4). */
export function DailyBudgetField({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const budget = draft.life?.dailyBudgetUsd ?? null;
  return (
    <div className="fcell">
      <label className="field-label" htmlFor="waifu-daily-budget">Daily budget (USD)</label>
      <input
        id="waifu-daily-budget"
        className="input"
        type="number"
        inputMode="decimal"
        min={0.01}
        max={10000}
        step={0.5}
        placeholder="no budget"
        value={budget ?? ""}
        onChange={(e) => onChange({ life: { ...(draft.life ?? { dailyBudgetUsd: null }), dailyBudgetUsd: e.target.value === "" ? null : Number(e.target.value) } })}
      />
      <span className="field-hint">When she reaches it, her wakes wait for the next local day; yours still go through. Empty = no budget.</span>
    </div>
  );
}

/** Her nightly sleep window (§4.5): the switch, then from and until. */
export function SleepFields({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const { availability, sleep } = availabilityOf(draft);
  const setSleep = (next: Partial<typeof sleep>) => onChange({ availability: { ...availability, sleep: { ...sleep, ...next } } });
  return (
    <div className="fgrid sleep-row">
      <div className="fcell">
        <span className="field-label">Sleep</span>
        <label className="checkbox-chip">
          <input type="checkbox" checked={sleep.enabled} onChange={(e) => setSleep({ enabled: e.target.checked })} />
          {sleep.enabled ? "She sleeps every night" : "She never sleeps"}
        </label>
        <span className="field-hint">While she sleeps, wakes wait and she gets a morning summary; your own wakes still reach her.</span>
      </div>
      <div className="fcell">
        <label className="field-label" htmlFor="waifu-sleep-start">From</label>
        <input id="waifu-sleep-start" className="input" type="time" value={sleep.start} disabled={!sleep.enabled} onChange={(e) => setSleep({ start: e.target.value })} />
      </div>
      <div className="fcell">
        <label className="field-label" htmlFor="waifu-sleep-end">Until</label>
        <input id="waifu-sleep-end" className="input" type="time" value={sleep.end} disabled={!sleep.enabled} onChange={(e) => setSleep({ end: e.target.value })} />
      </div>
    </div>
  );
}

/** Daily busy blocks (§4.5): from, until and a reason each. */
export function BusyBlocksField({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const { availability, busy } = availabilityOf(draft);
  const setBusy = (next: typeof busy) => onChange({ availability: { ...availability, busy: next } });
  const update = (index: number, patch: Partial<(typeof busy)[number]>) => setBusy(busy.map((block, i) => (i === index ? { ...block, ...patch } : block)));
  return (
    <div className="cell fcell">
      <span className="field-label">Busy blocks (daily)</span>
      {busy.length === 0 && <span className="field-hint">None. A busy block tells her (and the people she talks to) she is away.</span>}
      <div className="list-rows">
        {busy.map((block, index) => (
          <div key={index} className="busy-row">
            <input className="input" type="time" aria-label={`Busy block ${index + 1} from`} value={block.start} onChange={(e) => update(index, { start: e.target.value })} />
            <input className="input" type="time" aria-label={`Busy block ${index + 1} until`} value={block.end} onChange={(e) => update(index, { end: e.target.value })} />
            <input className="input" aria-label={`Busy block ${index + 1} reason`} placeholder="reason (class, work…)" value={block.reason} onChange={(e) => update(index, { reason: e.target.value })} />
            <button type="button" className="btn quiet sm" onClick={() => setBusy(busy.filter((_, i) => i !== index))}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6 }}>
        <button type="button" className="btn sm" onClick={() => setBusy([...busy, { start: "09:00", end: "12:00", reason: "" }])}>
          Add busy block
        </button>
      </div>
    </div>
  );
}

/** Direct messages (spec 9.1, Living cast §4.5). */
export function WaifuDmFields({ draft, onChange }: { draft: Draft; onChange: Patch }) {
  const dm = draft.dm ?? DEFAULT_DM;
  const set = (next: Partial<typeof dm>) => onChange({ dm: { ...dm, ...next } });
  const limited = dm.rateLimit !== null;
  return (
    <>
      <div className="fgrid cols-3">
        <div className="fcell">
          <span className="field-label">Direct messages</span>
          <label className="checkbox-chip">
            <input type="checkbox" checked={dm.allowDms} onChange={(e) => set({ allowDms: e.target.checked })} />
            {dm.allowDms ? "She answers DMs to her bot" : "DMs off"}
          </label>
          <span className="field-hint">Needs her own bot, used by no other enabled waifu, and a model.</span>
        </div>
        <div className="fcell">
          <span className="field-label">Replies per person</span>
          <label className="checkbox-chip">
            <input type="checkbox" checked={limited} onChange={(e) => set({ rateLimit: e.target.checked ? DEFAULT_RATE_LIMIT : null })} />
            {limited ? "Limited" : "Unlimited"}
          </label>
          {dm.rateLimit && (
            <div className="fcell-row">
              <input className="input narrow" type="number" min={1} max={1000} aria-label="Replies" value={dm.rateLimit.maxReplies} onChange={(e) => set({ rateLimit: { ...dm.rateLimit!, maxReplies: Number(e.target.value) } })} />
              <span className="t-small t-mute">replies per</span>
              <input className="input narrow" type="number" min={1} max={10080} aria-label="Minutes" value={dm.rateLimit.windowMinutes} onChange={(e) => set({ rateLimit: { ...dm.rateLimit!, windowMinutes: Number(e.target.value) } })} />
              <span className="t-small t-mute">minutes</span>
            </div>
          )}
        </div>
        <div className="fcell">
          <span className="field-label">When limited</span>
          <label className="checkbox-chip">
            <input type="checkbox" checked={dm.notifyWhenLimited} onChange={(e) => set({ notifyWhenLimited: e.target.checked })} />
            {dm.notifyWhenLimited ? "Send one notice" : "Stay silent"}
          </label>
        </div>
      </div>
      <div className="fgrid cols-2">
        <div className="fcell">
          <label className="field-label" htmlFor="waifu-limit-notice">Limit notice</label>
          <input id="waifu-limit-notice" className="input" maxLength={300} placeholder="built-in notice" value={dm.limitNotice} onChange={(e) => set({ limitNotice: e.target.value })} />
          <span className="field-hint">Tokens: {"{name}"}, {"{user}"}, {"{retryInMinutes}"}. Empty = the built-in notice.</span>
        </div>
        <div className="fcell">
          <label className="field-label" htmlFor="waifu-sleep-notice">Sleep notice</label>
          <input id="waifu-sleep-notice" className="input" maxLength={300} placeholder="no notice" value={dm.sleepNotice} onChange={(e) => set({ sleepNotice: e.target.value })} />
          <span className="field-hint">Sent once per night when a DM waits for her morning. Empty = none.</span>
        </div>
      </div>
    </>
  );
}
