// Her daily budget (Living cast spec §4.4 guard 5): her cost for the local day, from the usage
// ledger (`user/usage/YYYY-MM-DD.jsonl`, files by UTC day). Unpriced lines count as 0. Cached briefly
// per waifu so a busy room does not re-read the ledger for every message.

import { readFile } from "node:fs/promises";
import { usageLedgerPath } from "../orchestration/usageLedger.js";
import { instantOfLocal, localParts, nextLocalMidnight } from "./clock.js";

const CACHE_MS = 30_000;

type Cached = { at: number; day: string; cost: number };

export class DailyCost {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly dataRoot: string, private readonly timeZone: string) {}

  invalidate(waifuId?: string): void {
    if (waifuId) this.cache.delete(waifuId);
    else this.cache.clear();
  }

  /**
   * A call she just made (its ledger line is written in the background): the cached figure for the
   * day includes it at once, so the next check does not wait for the cache to expire.
   */
  add(waifuId: string, usd: number, now: Date): void {
    const cached = this.cache.get(waifuId);
    if (!cached || usd <= 0) return;
    const p = localParts(now, this.timeZone);
    const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    if (cached.day === day) cached.cost += usd;
  }

  /** USD spent by `waifuId` in the local day containing `now`. */
  async today(waifuId: string, now: Date): Promise<number> {
    const p = localParts(now, this.timeZone);
    const day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
    const cached = this.cache.get(waifuId);
    if (cached && cached.day === day && now.getTime() - cached.at < CACHE_MS) return cached.cost;
    const start = instantOfLocal(this.timeZone, p.year, p.month, p.day, 0, 0).getTime();
    const end = nextLocalMidnight(now, this.timeZone).getTime();
    const utcDays = new Set<string>();
    for (let t = start; t < end; t += 6 * 3_600_000) utcDays.add(new Date(t).toISOString().slice(0, 10));
    utcDays.add(new Date(end - 1).toISOString().slice(0, 10));
    let cost = 0;
    for (const utcDay of utcDays) {
      let raw: string;
      try {
        raw = await readFile(usageLedgerPath(this.dataRoot, utcDay), "utf8");
      } catch {
        continue;
      }
      for (const line of raw.split("\n")) {
        if (!line.includes(`"waifuId":"${waifuId}"`)) continue;
        try {
          const entry = JSON.parse(line) as { at?: string; waifuId?: string; costUsd?: number };
          const at = Date.parse(entry.at ?? "");
          if (entry.waifuId === waifuId && at >= start && at < end && typeof entry.costUsd === "number") cost += entry.costUsd;
        } catch {
          // a torn line
        }
      }
    }
    this.cache.set(waifuId, { at: now.getTime(), day, cost });
    return cost;
  }
}
