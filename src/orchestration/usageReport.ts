// Usage reports over the usage ledger (Living cast spec §14.1 `GET /api/usage`): one line per model
// call in `user/usage/<UTC day>.jsonl`, grouped by local days of one IANA time zone (the host's,
// unless the caller names another). Ledger files are read one UTC day beyond each edge, so a local
// day that straddles two UTC files is complete; malformed lines are skipped and counted.

import { readFile } from "node:fs/promises";
import { instantOfLocal, localDayKey, nextLocalMidnight } from "../life/clock.js";
import { USAGE_GROUP_KEYS, type UsageGroupKey } from "../shared/schemas/api.js";
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from "../shared/schemas/usage.js";
import { usageLedgerPath } from "./usageLedger.js";

export type UsageTotals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
  costKnownCalls: number;
  unpricedCalls: number;
  failedCalls: number;
};

export type UsageQuery = {
  /** Local days, inclusive (YYYY-MM-DD). */
  from: string;
  to: string;
  timeZone: string;
  groupBy: UsageGroupKey[];
  waifuId?: string;
  purpose?: string;
  guildId?: string;
};

export type UsageReport = {
  from: string;
  to: string;
  timeZone: string;
  groupBy: UsageGroupKey[];
  totals: UsageTotals;
  groups: Array<UsageTotals & { key: string[]; label?: string }>;
  skippedLines: number;
};

export const MAX_USAGE_RANGE_DAYS = 366;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const NONE = "(none)";

export class UsageQueryError extends Error {
  override name = "UsageQueryError";
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, costKnownCalls: 0, unpricedCalls: 0, failedCalls: 0 };
}

function add(totals: UsageTotals, entry: UsageLedgerEntry): void {
  totals.calls += 1;
  totals.inputTokens += entry.inputTokens;
  totals.outputTokens += entry.outputTokens;
  totals.cacheReadTokens += entry.cacheReadTokens ?? 0;
  totals.cacheWriteTokens += entry.cacheWriteTokens ?? 0;
  totals.reasoningTokens += entry.reasoningTokens ?? 0;
  if (typeof entry.costUsd === "number") {
    totals.costUsd += entry.costUsd;
    totals.costKnownCalls += 1;
  } else totals.unpricedCalls += 1;
  if (entry.status !== "ok") totals.failedCalls += 1;
}

/** A valid IANA zone (throws otherwise). */
export function assertTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new UsageQueryError(`Unknown time zone: ${timeZone}`);
  }
  return timeZone;
}

function parseDay(value: string, name: string): { year: number; month: number; day: number } {
  const match = DAY_RE.exec(value);
  if (!match) throw new UsageQueryError(`${name} must be a day like 2026-10-24.`);
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new UsageQueryError(`${name} is not a real day: ${value}`);
  }
  return { year, month, day };
}

/** The local day `days` before `day` (YYYY-MM-DD arithmetic, no time zone involved). */
export function shiftDay(day: string, days: number): string {
  const { year, month, day: d } = parseDay(day, "day");
  return new Date(Date.UTC(year, month - 1, d + days)).toISOString().slice(0, 10);
}

/** The instant range [start, end) of the local days `from`..`to` in `timeZone`. */
export function localRange(from: string, to: string, timeZone: string): { start: number; end: number } {
  const a = parseDay(from, "from");
  const b = parseDay(to, "to");
  const start = instantOfLocal(timeZone, a.year, a.month, a.day, 0, 0).getTime();
  const last = instantOfLocal(timeZone, b.year, b.month, b.day, 12, 0);
  const end = nextLocalMidnight(last, timeZone).getTime();
  if (end <= start) throw new UsageQueryError("to must not be before from.");
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000) + 1;
  if (days > MAX_USAGE_RANGE_DAYS) throw new UsageQueryError(`A usage range covers at most ${MAX_USAGE_RANGE_DAYS} days.`);
  return { start, end };
}

/** `groupBy=day,waifu`: one or two keys. */
export function parseGroupBy(value: string | undefined): UsageGroupKey[] {
  if (!value) return ["day"];
  const keys = value.split(",").map((key) => key.trim()).filter(Boolean);
  if (keys.length === 0 || keys.length > 2) throw new UsageQueryError("groupBy takes one or two keys, like day or waifu,day.");
  for (const key of keys) {
    if (!(USAGE_GROUP_KEYS as readonly string[]).includes(key)) throw new UsageQueryError(`Unknown groupBy key ${key}; use ${USAGE_GROUP_KEYS.join(", ")}.`);
  }
  return keys as UsageGroupKey[];
}

function keyOf(entry: UsageLedgerEntry, group: UsageGroupKey, timeZone: string): string {
  switch (group) {
    case "day":
      return localDayKey(new Date(entry.at), timeZone);
    case "waifu":
      return entry.waifuId ?? NONE;
    case "purpose":
      return entry.purpose;
    case "model":
      return `${entry.providerId}/${entry.modelId}`;
    case "provider":
      return entry.providerId;
    case "turn":
      return entry.turnId ?? NONE;
    case "place":
      return entry.conversationKey ?? (entry.guildId && entry.channelId ? `g_${entry.guildId}_${entry.channelId}` : NONE);
    case "server":
      return entry.guildId ?? NONE;
  }
}

/** Every ledger line in the local range, parsed (malformed lines counted, not thrown). */
async function readRange(dataRoot: string, start: number, end: number): Promise<{ entries: UsageLedgerEntry[]; skipped: number }> {
  const entries: UsageLedgerEntry[] = [];
  let skipped = 0;
  const firstDay = new Date(start - 86_400_000).toISOString().slice(0, 10);
  const lastDay = new Date(end + 86_400_000).toISOString().slice(0, 10);
  for (let day = firstDay; day <= lastDay; day = shiftDay(day, 1)) {
    let raw: string;
    try {
      raw = await readFile(usageLedgerPath(dataRoot, day), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = UsageLedgerEntrySchema.safeParse(JSON.parse(line));
      } catch {
        skipped += 1;
        continue;
      }
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const at = Date.parse(parsed.data.at);
      if (at >= start && at < end) entries.push(parsed.data);
    }
  }
  return { entries, skipped };
}

export async function usageReport(dataRoot: string, query: UsageQuery): Promise<UsageReport> {
  const timeZone = assertTimeZone(query.timeZone);
  const { start, end } = localRange(query.from, query.to, timeZone);
  const { entries, skipped } = await readRange(dataRoot, start, end);
  const totals = emptyTotals();
  const groups = new Map<string, UsageTotals & { key: string[] }>();
  for (const entry of entries) {
    if (query.waifuId && entry.waifuId !== query.waifuId) continue;
    if (query.purpose && entry.purpose !== query.purpose) continue;
    if (query.guildId && entry.guildId !== query.guildId) continue;
    add(totals, entry);
    const key = query.groupBy.map((group) => keyOf(entry, group, timeZone));
    const id = JSON.stringify(key);
    let group = groups.get(id);
    if (!group) {
      group = { key, ...emptyTotals() };
      groups.set(id, group);
    }
    add(group, entry);
  }
  return {
    from: query.from,
    to: query.to,
    timeZone,
    groupBy: query.groupBy,
    totals,
    groups: [...groups.values()].sort((a, b) => a.key.join("\u0000").localeCompare(b.key.join("\u0000"))),
    skippedLines: skipped
  };
}

/** Today's spend and calls for one waifu (her local day), for the life status. */
export async function todayUsage(dataRoot: string, waifuId: string, now: Date, timeZone: string): Promise<{ day: string; costUsd: number; calls: number }> {
  const day = localDayKey(now, timeZone);
  const report = await usageReport(dataRoot, { from: day, to: day, timeZone, groupBy: ["day"], waifuId });
  return { day, costUsd: report.totals.costUsd, calls: report.totals.calls };
}
