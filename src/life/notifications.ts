// The notification block (Living cast spec §4.7, §10.3): one `<notifications>` text block in a
// user turn, followed by the time line. Wakes for one place merge into one line with their reasons
// joined; previews are about 60 characters of the triggering message rendered as a transcript body.
// Places are named by her handles (§6.1), the names her tools take.

import { renderDiscordMessage } from "../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { Wake, WakeQueue, WakeReason } from "../shared/schemas/life.js";
import { clockText, weekdayTimeText } from "./clock.js";

export const PREVIEW_CHARS = 60;

/** How each wake reason reads in her notifications (owner-reviewed through the goldens). */
export const REASON_LABELS: Record<WakeReason, string> = {
  mention: "mention",
  name: "your name",
  role: "role mention",
  everyone: "@everyone",
  watch: "watch",
  watch_timeout: "watch timed out",
  dm: "dm",
  detector: "maybe for you",
  reminder: "reminder",
  morning: "morning",
  owner: "nudge",
  followup: "follow-up"
};

/** `"aria are you coming saturday? we need someo…"` (no quotes): the body, then attachments as `[image]`. */
export function previewText(body: string, imageCount = 0, max = PREVIEW_CHARS): string {
  const parts = [body.replace(/\s+/g, " ").trim(), ...Array.from({ length: imageCount }, () => "[image]")].filter(Boolean);
  const text = parts.join(" ");
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** The preview of a Discord message (forgotten authors' old messages pass `removed`). */
export function messagePreview(raw: RawDiscordMessage, dir: GuildDirectoryView, timeZone: string, o: { removed?: boolean } = {}): string {
  if (o.removed) return "(removed)";
  const rendered = renderDiscordMessage(raw, dir, timeZone);
  if (!rendered) return "";
  return previewText(rendered.body, rendered.images.length);
}

export type NotificationView = {
  /** Her handle for a place (§6.1). */
  handle(placeKey: string): string;
  /** Unread messages in a place (newer than her read cursor and the forget floor), when known. */
  unread(placeKey: string): number | undefined;
  timeZone: string;
};

/**
 * A quoted part on one line: its own double quotes become single ones and line breaks become spaces,
 * so a quote always closes on its line (the owner's views redact a DM line from its first quote, D14).
 */
const quote = (text: string) => `"${text.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, " ")}"`;

/** A person's name as notifications show it: no double quotes and no line breaks (they would shift the quoting). */
const plainName = (name: string) => name.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, " ");

function placeLine(group: Wake[], view: NotificationView): string {
  const first = group[0]!;
  const reasons: WakeReason[] = [];
  for (const wake of group) for (const reason of wake.reasons ?? [wake.reason]) if (!reasons.includes(reason)) reasons.push(reason);
  const latest = group[group.length - 1]!;
  const parts = [reasons.map((reason) => REASON_LABELS[reason]).join(", "), view.handle(first.placeKey!)];
  const watch = group.find((wake) => wake.reason === "watch" || wake.reasons?.includes("watch"));
  if (watch?.matched) parts.push(quote(watch.matched));
  const from = [...group].reverse().find((wake) => wake.fromName)?.fromName;
  if (from) parts.push(`from ${plainName(from)}`);
  const unread = view.unread(first.placeKey!);
  if (unread !== undefined && unread > 0) parts.push(`${unread} unread`);
  const preview = [...group].reverse().find((wake) => wake.preview !== undefined)?.preview ?? latest.preview;
  if (preview) parts.push(quote(preview));
  const notes = [...new Set(group.filter((wake) => wake.note && wake.reason !== "owner").map((wake) => wake.note!))];
  for (const note of notes) parts.push(`your note: ${quote(note)}`);
  return `- ${parts.join(" · ")}`;
}

function soloLine(wake: Wake, view: NotificationView): string[] {
  switch (wake.reason) {
    case "reminder":
      // §16.4: `reminder (Sat 14:20): "<note>"`, the time it was due.
      return [`- reminder (${weekdayTimeText(new Date(wake.at), view.timeZone)}): ${quote(wake.note ?? "")}`];
    case "watch_timeout":
      // §16.5: a watch always ends at its timeout, so an empty one is a timer.
      return [`- ${REASON_LABELS.watch_timeout} · your note: ${quote(wake.note ?? "")}`];
    case "owner":
      return [`- ${REASON_LABELS.owner}${wake.note ? ` · ${quote(wake.note)}` : ""}`];
    case "morning":
      return wake.batch && wake.batch.length > 0 ? wake.batch : [];
    case "watch":
      return [`- watch${wake.matched ? ` · ${quote(wake.matched)}` : ""}${wake.note ? ` · your note: ${quote(wake.note)}` : ""}`];
    default:
      return [`- ${REASON_LABELS[wake.reason]}${wake.note ? ` · ${quote(wake.note)}` : ""}`];
  }
}

/** The lines of one notification block, in arrival order (place wakes merged per place). */
export function notificationLines(wakes: readonly Wake[], view: NotificationView): string[] {
  const groups = new Map<string, Wake[]>();
  const order: Array<{ kind: "place"; key: string } | { kind: "solo"; wake: Wake }> = [];
  for (const wake of wakes) {
    const placeBound = wake.placeKey !== undefined && wake.reason !== "reminder" && wake.reason !== "morning" && wake.reason !== "owner" && wake.reason !== "followup";
    if (!placeBound) {
      order.push({ kind: "solo", wake });
      continue;
    }
    const group = groups.get(wake.placeKey!);
    if (group) group.push(wake);
    else {
      groups.set(wake.placeKey!, [wake]);
      order.push({ kind: "place", key: wake.placeKey! });
    }
  }
  return order.flatMap((entry) => (entry.kind === "place" ? [placeLine(groups.get(entry.key)!, view)] : soloLine(entry.wake, view)));
}

export function quietLines(quiet: WakeQueue["quiet"], view: NotificationView): string[] {
  return quiet.map((line) => `- +${line.count} more from ${plainName(line.name)}${line.placeKey ? ` (${view.handle(line.placeKey)})` : ""}`);
}

/** The whole block; undefined when there is nothing to say. */
export function renderNotifications(
  o: { wakes: readonly Wake[]; quiet?: WakeQueue["quiet"]; notices?: readonly string[] },
  view: NotificationView
): string | undefined {
  const lines = [
    ...notificationLines(o.wakes, view),
    ...quietLines(o.quiet ?? [], view),
    ...(o.notices ?? []).map((notice) => `- ${notice}`)
  ];
  if (lines.length === 0) return undefined;
  return `<notifications>\n${lines.join("\n")}\n</notifications>`;
}

export type MorningPlace = { placeKey: string; kind: "room" | "thread" | "dm"; name?: string; mentions: number; messages: number };

/** The `morning` batch lines (§4.7), built when her sleep (or budget pause) ends. */
export function morningBatch(
  o: {
    reason: "sleep" | "budget";
    since: Date;
    until: Date;
    places: readonly MorningPlace[];
    items: readonly Wake[];
  },
  view: NotificationView
): string[] {
  const header =
    o.reason === "sleep"
      ? `- while you were asleep (${clockText(o.since, view.timeZone)}–${clockText(o.until, view.timeZone)}):`
      : `- while you were away (since ${clockText(o.since, view.timeZone)}):`;
  const lines = [header];
  for (const place of o.places.filter((entry) => entry.kind !== "dm")) {
    const counts = [
      place.mentions > 0 ? `${place.mentions} mention${place.mentions === 1 ? "" : "s"}` : undefined,
      place.messages > 0 ? `${place.messages} message${place.messages === 1 ? "" : "s"}` : undefined
    ].filter(Boolean);
    if (counts.length > 0) lines.push(`  · ${view.handle(place.placeKey)}: ${counts.join(", ")}`);
  }
  const dms = o.places.filter((entry) => entry.kind === "dm" && entry.messages > 0);
  if (dms.length > 0) {
    lines.push(
      `  · DMs: ${dms
        .map((dm, index) => `${dm.name ? plainName(dm.name) : view.handle(dm.placeKey)} (${dm.messages}${index === 0 ? ` message${dm.messages === 1 ? "" : "s"}` : ""})`)
        .join(", ")}`
    );
  }
  for (const item of o.items) {
    if (item.reason === "reminder") {
      lines.push(`  · reminder (${weekdayTimeText(new Date(item.at), view.timeZone)}): ${quote(item.note ?? "")}`);
    } else if (item.reason === "watch") {
      const parts = ["watch matched"];
      if (item.placeKey) parts.push(view.handle(item.placeKey));
      if (item.matched) parts.push(quote(item.matched));
      if (item.fromName) parts.push(`from ${plainName(item.fromName)}`);
      if (item.note) parts.push(`your note: ${quote(item.note)}`);
      lines.push(`  · ${parts.join(" · ")}`);
    } else if (item.reason === "watch_timeout") {
      lines.push(`  · watch timed out (${weekdayTimeText(new Date(item.at), view.timeZone)}) · your note: ${quote(item.note ?? "")}`);
    } else if (item.reason === "followup") {
      lines.push(`  · ${item.note ?? "something from before still needs you"}`);
    } else if (item.reason === "morning" && item.batch) {
      // An earlier batch she never read (her budget ran out first): its lines without its header.
      lines.push(...item.batch.slice(1));
    }
  }
  return lines;
}
