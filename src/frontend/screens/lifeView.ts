// Pure presentation helpers for the Life screen and Home (Living cast §14.3). The timeline is
// generic over tool names: a call shows the name and arguments it was given, so renamed or new
// tools need no change here. Content from private chats arrives already left out by the server
// (D14); a redacted block only says so.

import type { HerFileEntry, HerFilesList, LifeLogBlock, LifeLogLineView, LifeStatus, LogsResponse, WatchView } from "../api/types";

export const PRIVATE_HIDDEN = "From a private chat: hidden";

/** One-line form of a tool call's arguments (compact JSON, cut at `max`). */
export function formatArgs(input: unknown, max = 220): string {
  if (input === undefined || input === null) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A block of a life-log line as one row of the timeline. */
export function blockRow(block: LifeLogBlock): { tone: "text" | "call" | "result" | "error" | "muted"; label: string; text: string } {
  if (block.redacted) {
    const label = block.type === "tool_use" ? `${block.name ?? "tool"}` : block.type === "tool_result" ? "result" : "text";
    return { tone: "muted", label, text: PRIVATE_HIDDEN };
  }
  switch (block.type) {
    case "text":
      return { tone: "text", label: "", text: block.text ?? "" };
    case "tool_use":
      return { tone: "call", label: block.name ?? "tool", text: formatArgs(block.input) };
    case "tool_result":
      return { tone: block.isError ? "error" : "result", label: block.isError ? "error" : "result", text: block.text ?? "" };
    case "image":
      return { tone: "muted", label: "image", text: block.text ?? "" };
    case "reasoning":
      return { tone: "muted", label: "thinking", text: "(not shown)" };
    default:
      return { tone: "muted", label: block.type, text: block.text ?? "" };
  }
}

const KIND_LABELS: Record<LifeLogLineView["kind"], string> = {
  notifications: "Woken",
  assistant: "She",
  tool_results: "Results",
  system_note: "Note",
  compaction_boundary: "New epoch"
};

export function lineLabel(line: LifeLogLineView): string {
  return KIND_LABELS[line.kind] ?? line.kind;
}

/** Lines grouped by turn (a line without a turn stands alone), oldest first. */
export function groupByTurn(lines: readonly LifeLogLineView[]): Array<{ turnId: string | undefined; lines: LifeLogLineView[] }> {
  const groups: Array<{ turnId: string | undefined; lines: LifeLogLineView[] }> = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last && line.turnId !== undefined && last.turnId === line.turnId) last.lines.push(line);
    else groups.push({ turnId: line.turnId, lines: [line] });
  }
  return groups;
}

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return "—";
  return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(digits)}`;
}

/** awake · asleep until 07:00 · busy (exam) until 12:00 — plus mid-turn. */
export function stateLabel(status: Pick<LifeStatus, "availability" | "status" | "runtime" | "enabled" | "model" | "hasBot">): { word: string; detail: string; hue: "mint" | "sky" | "butter" | "lavender" | "peach" } {
  if (!status.enabled) return { word: "Benched", detail: "disabled", hue: "butter" };
  if (!status.hasBot) return { word: "No bot", detail: "she needs her own Discord bot to post", hue: "butter" };
  if (!status.model) return { word: "No model", detail: "she stays quiet until she has one", hue: "butter" };
  if (status.status === "turn") return { word: "Mid-turn", detail: "thinking and acting now", hue: "lavender" };
  const availability = status.availability;
  if (availability.bed === "up_late") return { word: "Up late", detail: "bed time", hue: "lavender" };
  if (availability.bed === "dozing") return { word: "Dozing", detail: availability.until ? `bed time until ${availability.until}` : "bed time", hue: "sky" };
  if (availability.state === "asleep") return { word: "Asleep", detail: availability.until ? `until ${clock(availability.until)}` : "", hue: "sky" };
  if (availability.state === "busy") return { word: "Busy", detail: [availability.reason, availability.until ? `until ${clock(availability.until)}` : ""].filter(Boolean).join(" · "), hue: "peach" };
  return { word: status.runtime.paused ? "Paused" : "Awake", detail: status.runtime.running ? "" : "Discord offline", hue: "mint" };
}

/** "07:00" stays; an ISO time becomes a local hh:mm. */
export function clock(value: string): string {
  if (/^\d{1,2}:\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A place as people read it: her handle for a room (`bake-club/#general`, logged with the event),
 * "a DM" for a private chat (never who it is with), "a channel" when only a raw key is known.
 */
export function placeLabel(placeKey: string | undefined, handle?: string): string {
  if (!placeKey && !handle) return "";
  if (placeKey?.startsWith("dm_") || placeKey?.startsWith("dm/") || handle?.toLowerCase().startsWith("dm/")) return "a DM";
  if (handle) return handle;
  return placeKey && /^(g|t)_/u.test(placeKey) ? "a channel" : (placeKey ?? "");
}

/**
 * A response that answers the reveal toggle as it is now: a page fetched with private content is
 * never shown once the toggle is off (and a stale one stays hidden if the refetch fails).
 */
export function matchingReveal<T extends { includePrivate: boolean }>(data: T | undefined, includePrivate: boolean): T | undefined {
  return data && data.includePrivate === includePrivate ? data : undefined;
}

/**
 * Older pages and the live page as one timeline by `seq`, with no line twice. `gap`: the live page
 * no longer reaches the older lines (more lines arrived than one page holds), so the older ones
 * should be dropped rather than shown with a hole.
 */
export function mergeTimeline(older: readonly LifeLogLineView[], page: readonly LifeLogLineView[]): { lines: LifeLogLineView[]; gap: boolean } {
  if (older.length === 0) return { lines: [...page], gap: false };
  const firstLive = page[0]?.seq;
  const lastOlder = older[older.length - 1]!.seq;
  if (firstLive !== undefined && firstLive > lastOlder + 1) return { lines: [...page], gap: true };
  const bySeq = new Map<number, LifeLogLineView>();
  for (const line of older) bySeq.set(line.seq, line);
  for (const line of page) bySeq.set(line.seq, line);
  return { lines: [...bySeq.values()].sort((a, b) => a.seq - b.seq), gap: false };
}

/**
 * Every waifu's status that answered: one failing life never blanks the others, and one that
 * failed to refresh keeps its last answer (`previous[i]` for `work[i]`). When every request fails
 * (the host restarting, Remote Access reconnecting) the refresh fails as a whole, so the screen
 * keeps what it showed instead of an empty cast.
 */
export async function settledAll<T>(work: ReadonlyArray<Promise<T>>, previous: ReadonlyArray<T | undefined> = []): Promise<T[]> {
  const results = await Promise.allSettled(work);
  const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (firstFailure && results.every((result) => result.status === "rejected")) throw firstFailure.reason;
  return results.flatMap((result, index): T[] => {
    if (result.status === "fulfilled") return [result.value as T];
    const kept = previous[index];
    return kept === undefined ? [] : [kept];
  });
}

export type CastEvent = { at: string; waifuId: string; kind: "sent" | "woke" | "reacted" | "turn"; text: string };

/** Recent sends and wakes from the host log (`Life message sent`, `Life turn started`, …), newest first. */
export function castEvents(logs: LogsResponse | undefined, limit = 12): CastEvent[] {
  const out: CastEvent[] = [];
  for (const entry of logs?.entries ?? []) {
    const context = (entry.context && typeof entry.context === "object" ? entry.context : {}) as Record<string, unknown>;
    if (context["category"] !== "life" || typeof context["waifuId"] !== "string") continue;
    const waifuId = context["waifuId"];
    const place = placeLabel(typeof context["placeKey"] === "string" ? context["placeKey"] : undefined, typeof context["place"] === "string" ? context["place"] : undefined);
    if (entry.message === "Life message sent") out.push({ at: entry.time, waifuId, kind: "sent", text: `sent a message${place ? ` in ${place}` : ""}` });
    else if (entry.message === "Life reaction added") out.push({ at: entry.time, waifuId, kind: "reacted", text: `reacted${place ? ` in ${place}` : ""}` });
    else if (entry.message === "Life turn started") {
      const reasons = Array.isArray(context["reasons"]) ? (context["reasons"] as unknown[]).map(String) : [];
      out.push({ at: entry.time, waifuId, kind: "woke", text: `woke${reasons.length ? ` (${reasons.join(", ")})` : ""}` });
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** Waits the owner asked for: a wake outcome in words. */
export function wakeOutcomeText(outcome: string): string {
  switch (outcome) {
    case "queued":
      return "Woken: her turn starts shortly.";
    case "deferred":
      return "Queued for later: she is asleep or over her budget.";
    case "quiet":
      return "Merged into a wake already waiting.";
    case "dropped":
      return "Not woken: the cast is paused or she is disabled.";
    case "queued_offline":
      return "Queued: Discord is offline; the wake runs when the cast connects.";
    default:
      return outcome;
  }
}

/* ---- her files, reminders and watches (§16.11) ---- */

/** "1.2 KB" — sizes as her own tools show them. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The folders from the root to the listed one, each with the path to list it (`~` › `people`). */
/** A new epoch's reason as the Life screen says it (§19.4: "rest" is her own summary; §25: "cache_rest" her quiet-time one). */
export function boundaryReasonLabel(reason: string): string {
  if (reason === "rest") return "rested (her own summary)";
  if (reason === "cache_rest") return "rested (her own summary, before her cache went cold)";
  return reason === "self" ? "rested (her choice)" : reason;
}

/** The epoch reasons where she wrote her own summary (§19, §21.6b, §25). */
export function restedReason(reason: string | undefined): boolean {
  return reason === "rest" || reason === "cache_rest" || reason === "self";
}

export function breadcrumbs(list: Pick<HerFilesList, "root" | "dir" | "display">): Array<{ label: string; dir: string }> {
  const rootLabel = list.root === "home" ? "~" : list.root === "tmp" ? "/tmp" : "/transcripts";
  const rel = list.display === rootLabel ? "" : list.display.slice(rootLabel.length + 1);
  const segments = rel ? rel.split("/") : [];
  const rootDir = segments.length === 0 ? list.dir : list.dir.slice(0, list.dir.length - rel.length - 1);
  const out = [{ label: rootLabel, dir: rootDir }];
  segments.forEach((segment, index) => out.push({ label: segment, dir: `${rootDir}/${segments.slice(0, index + 1).join("/")}` }));
  return out;
}

/** One entry's second column: a folder, or its size. */
export function entryDetail(entry: Pick<HerFileEntry, "kind" | "size">): string {
  return entry.kind === "dir" ? "folder" : fileSize(entry.size);
}

/** What a watch waits for, in words: a timer, or each binding's place, person and words. */
export function watchWhenText(watch: Pick<WatchView, "when">): string {
  if (watch.when.length === 0) return "timer";
  return watch.when
    .map((binding) =>
      [binding.place && `in ${binding.place}`, binding.from && `from ${binding.from}`, binding.words?.length ? `words: ${binding.words.join(", ")}` : "", binding.any_message ? "any message" : ""]
        .filter(Boolean)
        .join(" · ")
    )
    .join(" or ");
}
