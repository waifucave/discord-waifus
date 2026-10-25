// Usage reports over the usage ledger (Living cast spec §14.1 `GET /api/usage`): one line per model
// call in `user/usage/<UTC day>.jsonl`, grouped by local days of one IANA time zone (the host's,
// unless the caller names another). Ledger files are read one UTC day beyond each edge, so a local
// day that straddles two UTC files is complete; malformed lines are skipped and counted.
//
// Memory stays bounded whatever the range: each file is streamed line by line and every line is
// filtered and added up at once (nothing is kept per line), at most MAX_USAGE_GROUPS groups are
// kept (the rest are added to one "(other)" group and `groupsCapped` says so), and `groupBy=turn`
// covers at most MAX_TURN_RANGE_DAYS days.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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
  /** More than MAX_USAGE_GROUPS groups: the rest are added up in one `(other)` group. */
  groupsCapped?: true;
};

export const MAX_USAGE_RANGE_DAYS = 366;
/** The most groups one report keeps; further keys are added to one `(other)` group. */
export const MAX_USAGE_GROUPS = 1000;
/** `groupBy=turn` makes a group per turn: it covers at most this many days. */
export const MAX_TURN_RANGE_DAYS = 31;
/** A ledger line longer than this is malformed (skipped and counted), never parsed. */
const MAX_LINE_CHARS = 64 * 1024;
const OTHER = "(other)";
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
export function localRange(from: string, to: string, timeZone: string): { start: number; end: number; days: number } {
  const a = parseDay(from, "from");
  const b = parseDay(to, "to");
  const start = instantOfLocal(timeZone, a.year, a.month, a.day, 0, 0).getTime();
  const last = instantOfLocal(timeZone, b.year, b.month, b.day, 12, 0);
  const end = nextLocalMidnight(last, timeZone).getTime();
  if (end <= start) throw new UsageQueryError("to must not be before from.");
  const days = Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000) + 1;
  if (days > MAX_USAGE_RANGE_DAYS) throw new UsageQueryError(`A usage range covers at most ${MAX_USAGE_RANGE_DAYS} days.`);
  return { start, end, days };
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

/**
 * Streams every ledger line in the local range to `visit`, parsed (malformed lines counted, not
 * thrown). One line at a time: no file and no list of entries is held in memory.
 */
async function scanRange(dataRoot: string, start: number, end: number, visit: (entry: UsageLedgerEntry) => void): Promise<number> {
  let skipped = 0;
  const firstDay = new Date(start - 86_400_000).toISOString().slice(0, 10);
  const lastDay = new Date(end + 86_400_000).toISOString().slice(0, 10);
  for (let day = firstDay; day <= lastDay; day = shiftDay(day, 1)) {
    const stream = createReadStream(usageLedgerPath(dataRoot, day), { encoding: "utf8" });
    const opened = await new Promise<boolean>((resolve) => {
      stream.once("open", () => resolve(true));
      stream.once("error", () => resolve(false));
    });
    if (!opened) continue;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        if (line.length > MAX_LINE_CHARS) {
          skipped += 1;
          continue;
        }
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
        if (at >= start && at < end) visit(parsed.data);
      }
    } catch {
      // A file that fails mid-read (removed, unreadable) counts what was read.
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return skipped;
}

export async function usageReport(dataRoot: string, query: UsageQuery): Promise<UsageReport> {
  const timeZone = assertTimeZone(query.timeZone);
  const { start, end, days } = localRange(query.from, query.to, timeZone);
  if (query.groupBy.includes("turn") && days > MAX_TURN_RANGE_DAYS) {
    throw new UsageQueryError(`groupBy=turn covers at most ${MAX_TURN_RANGE_DAYS} days; pick a shorter range.`);
  }
  const totals = emptyTotals();
  const groups = new Map<string, UsageTotals & { key: string[] }>();
  let capped = false;
  const otherKey = query.groupBy.map(() => OTHER);
  const skipped = await scanRange(dataRoot, start, end, (entry) => {
    if (query.waifuId && entry.waifuId !== query.waifuId) return;
    if (query.purpose && entry.purpose !== query.purpose) return;
    if (query.guildId && entry.guildId !== query.guildId) return;
    add(totals, entry);
    let key = query.groupBy.map((group) => keyOf(entry, group, timeZone));
    let id = JSON.stringify(key);
    let group = groups.get(id);
    if (!group && groups.size >= MAX_USAGE_GROUPS) {
      capped = true;
      key = otherKey;
      id = JSON.stringify(key);
      group = groups.get(id);
    }
    if (!group) {
      group = { key, ...emptyTotals() };
      groups.set(id, group);
    }
    add(group, entry);
  });
  return {
    from: query.from,
    to: query.to,
    timeZone,
    groupBy: query.groupBy,
    totals,
    groups: [...groups.values()].sort((a, b) => a.key.join("\u0000").localeCompare(b.key.join("\u0000"))),
    skippedLines: skipped,
    ...(capped ? { groupsCapped: true as const } : {})
  };
}

/** Today's spend and calls for one waifu (her local day), for the life status. */
export async function todayUsage(dataRoot: string, waifuId: string, now: Date, timeZone: string): Promise<{ day: string; costUsd: number; calls: number }> {
  const day = localDayKey(now, timeZone);
  const report = await usageReport(dataRoot, { from: day, to: day, timeZone, groupBy: ["day"], waifuId });
  return { day, costUsd: report.totals.costUsd, calls: report.totals.calls };
}
