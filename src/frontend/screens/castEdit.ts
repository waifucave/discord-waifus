// The Cast editor's save (overhaul spec §11.0 "writes send only what changed"): the top-level keys
// whose value differs from the stored waifu, plus her revision. `model` and `botId` send `null` to
// unset (a missing field keeps the stored value).

import type { UpdateWaifuBody, WaifuConfig } from "../api/types";

const EDITABLE = [
  "name",
  "displayName",
  "persona",
  "enabled",
  "model",
  "botId",
  "availability",
  "verbosity",
  "customInstructions",
  "scheduleInPrompt",
  "wakeOnName",
  "life",
  "dm"
] as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function waifuPatch(remote: WaifuConfig, draft: Partial<WaifuConfig>): UpdateWaifuBody {
  const body: Record<string, unknown> = { revision: remote.revision };
  for (const key of EDITABLE) {
    if (!(key in draft)) continue;
    const next = draft[key];
    if (same(next, remote[key])) continue;
    body[key] = (key === "model" || key === "botId") && next === undefined ? null : next;
  }
  return body as UpdateWaifuBody;
}

/** Whether anything would be sent besides the revision. */
export function waifuDirty(remote: WaifuConfig | undefined, draft: Partial<WaifuConfig>): boolean {
  return remote !== undefined && Object.keys(waifuPatch(remote, draft)).length > 1;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/u;

/** Client-side checks that mirror the schema, so Save says what is wrong before the server does. */
export function waifuProblems(draft: Partial<WaifuConfig>): string[] {
  const problems: string[] = [];
  const sleep = draft.availability?.sleep;
  if (sleep?.enabled && (!TIME.test(sleep.start) || !TIME.test(sleep.end))) problems.push("Sleep times use 24-hour HH:mm.");
  if (sleep?.enabled && sleep.start === sleep.end) problems.push("Sleep must end at a different time than it starts.");
  for (const busy of draft.availability?.busy ?? []) {
    if (!TIME.test(busy.start) || !TIME.test(busy.end)) problems.push("Busy times use 24-hour HH:mm.");
    else if (busy.start === busy.end) problems.push("A busy block must end at a different time than it starts.");
    if (!busy.reason.trim()) problems.push("Every busy block needs a reason.");
  }
  const budget = draft.life?.dailyBudgetUsd;
  if (budget !== undefined && budget !== null && !(budget > 0 && budget <= 10_000)) problems.push("The daily budget is more than $0 and at most $10,000 (empty = no budget).");
  const limit = draft.dm?.rateLimit;
  if (limit && (!Number.isInteger(limit.maxReplies) || limit.maxReplies < 1 || limit.maxReplies > 1000)) problems.push("DM replies per window: 1 to 1000.");
  if (limit && (!Number.isInteger(limit.windowMinutes) || limit.windowMinutes < 1 || limit.windowMinutes > 10080)) problems.push("DM window: 1 to 10080 minutes.");
  if ((draft.dm?.limitNotice ?? "").length > 300) problems.push("The limit notice is at most 300 characters.");
  if ((draft.dm?.sleepNotice ?? "").length > 300) problems.push("The sleep notice is at most 300 characters.");
  return [...new Set(problems)];
}
