import type { WaifuConfig } from "../api/types";

type Draft = Partial<WaifuConfig>;
type Patch = (patch: Draft) => void;

const DEFAULT_DM = { allowDms: false, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "" };
const DEFAULT_RATE_LIMIT = { maxReplies: 30, windowMinutes: 60 };

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

/** Direct messages (spec 9.1). */
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
      </div>
    </>
  );
}
