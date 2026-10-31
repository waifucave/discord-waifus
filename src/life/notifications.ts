// The notification block (Living cast spec §4.7, §10.3, §20): one `<notifications>` text block in
// a user turn, followed by the time line. Wakes for one place show one line per message, in message
// order (each with its own reasons, sender, ref and preview; at most `life.notificationLinesPerPlace`,
// the newest); previews are about 60 characters of the message rendered as a transcript body.
// Places are named by her handles (§6.1), the names her tools take.

import { renderDiscordMessage } from "../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { FiredWakeupRecord, Wake, WakeQueue, WakeReason } from "../shared/schemas/life.js";
import { compareIds } from "../discord/rawMessage.js";
import { snowflakeTime } from "../discord/refStore.js";
import { clockText, dayText, dayTimeText, localDayKey } from "./clock.js";
import { messagesOf } from "./wakeMessages.js";

export const PREVIEW_CHARS = 60;
/** At most this many lines per place in one notification block (§20; `life.notificationLinesPerPlace`). */
export const NOTIFICATION_LINES_PER_PLACE = 8;

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
  plan: "plan",
  morning: "morning",
  owner: "nudge",
  followup: "follow-up",
  wakeup_error: "wakeup stopped"
};

/** A `detector` wake for the whole cast (`all`, §4.3) reads differently from a single pick. */
export const DETECTOR_ALL_LABEL = "for all of you";
/** A `detector` chime-in wake (§4.3 `chime_in`): the burst was for someone else. */
export const DETECTOR_CHIME_IN_LABEL = "for someone else, you could chime in";

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
  /** A message's ref in a place (`a1`), assigned when the notification is rendered (§4.7). */
  ref?(placeKey: string, messageId: string): string | undefined;
  timeZone: string;
  /** Lines per place (§20); `NOTIFICATION_LINES_PER_PLACE` when absent. */
  linesPerPlace?: number;
  /**
   * Her unanswered streak in a place (§34), already worded ("you've written in bake-club/#general 3
   * times since anyone answered (since Tue 21:00)"), when it is long enough to show; looked up for the
   * places her own ended watches named.
   */
  unanswered?(placeKey: string): string | undefined;
};

/** The ` · you've written in … since anyone answered (…)` parts of an ended watch, one per place that has one. */
function unansweredParts(wake: Wake, view: NotificationView): string {
  return (wake.watchedPlaces ?? []).flatMap((key) => {
    const text = view.unanswered?.(key);
    return text ? [` · ${text}`] : [];
  }).join("");
}

/**
 * A quoted part on one line: its own double quotes become single ones and line breaks become spaces,
 * so a quote always closes on its line (the owner's views redact a DM line from its first quote, D14).
 */
const quote = (text: string) => `"${text.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, " ")}"`;

/** A person's name as notifications show it: no double quotes and no line breaks (they would shift the quoting). */
const plainName = (name: string) => name.replace(/"/g, "'").replace(/\s*[\r\n]+\s*/g, " ");

/** How a place's reasons read: a detector wake for all of them, or a chime-in, says so. */
function labeller(group: readonly Wake[]): (reason: WakeReason) => string {
  const forAll = group.some((wake) => wake.forAll === true);
  // Only when every detector wake in the place is a chime-in (a pick of her is the stronger reading).
  const chimeIn = group.some((wake) => wake.chimeIn === true) && group.every((wake) => wake.reason !== "detector" || wake.chimeIn === true);
  return (reason) => (reason === "detector" && forAll ? DETECTOR_ALL_LABEL : reason === "detector" && chimeIn ? DETECTOR_CHIME_IN_LABEL : REASON_LABELS[reason]);
}

type MessageLine = { id: string; fromName?: string; preview: string; reasons: WakeReason[]; matched: string[]; notes: string[]; wakeups: FiredWakeupRecord[] };

const addUnique = <T,>(list: T[], items: readonly T[]) => {
  for (const item of items) if (!list.includes(item)) list.push(item);
};

/**
 * One line per message (§20), in message order: `- <reasons> · <place> · "<match>" · from <name> ·
 * #<ref> "<preview>" · your note: "<note>"`. The newest `linesPerPlace` are shown; the first line
 * says how many earlier ones were left out, the last one the unread count when not all are shown.
 * Reasons that came with no message (rare) go on the first line.
 */
function placeLines(group: Wake[], view: NotificationView): string[] {
  const placeKey = group[0]!.placeKey!;
  const byId = new Map<string, MessageLine>();
  const loose = { reasons: [] as WakeReason[], matched: [] as string[], notes: [] as string[] };
  let earlier = 0;
  for (const wake of group) {
    earlier += wake.earlier ?? 0;
    const messages = messagesOf(wake);
    if (messages.length === 0) {
      addUnique(loose.reasons, wake.reasons ?? [wake.reason]);
      if (wake.matched !== undefined) addUnique(loose.matched, [wake.matched]);
      if (wake.note && wake.reason !== "owner") addUnique(loose.notes, [wake.note]);
      continue;
    }
    for (const message of messages) {
      const line = byId.get(message.id) ?? { id: message.id, preview: message.preview, reasons: [], matched: [], notes: [], wakeups: [] };
      if (message.fromName && !line.fromName) line.fromName = message.fromName;
      if (!line.preview && message.preview) line.preview = message.preview;
      addUnique(line.reasons, message.reasons);
      if (message.matched !== undefined) addUnique(line.matched, [message.matched]);
      if (message.note) addUnique(line.notes, [message.note]);
      for (const fired of message.wakeups ?? []) if (!line.wakeups.some((known) => known.id === fired.id)) line.wakeups.push(fired);
      byId.set(message.id, line);
    }
  }
  if (byId.size === 0) return [placeLine(group, view)];
  const label = labeller(group);
  const ordered = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  const shown = ordered.slice(-Math.max(1, view.linesPerPlace ?? NOTIFICATION_LINES_PER_PLACE));
  const hidden = earlier + ordered.length - shown.length;
  const unread = view.unread(placeKey);
  return shown.flatMap((line, index) => {
    const first = index === 0;
    const reasons = first ? [...loose.reasons] : [];
    addUnique(reasons, line.reasons);
    const parts: string[] = [];
    if (reasons.length > 0) parts.push(reasons.map(label).join(", "));
    parts.push(view.handle(placeKey));
    if (first && hidden > 0) parts.push(`+${hidden} earlier`);
    for (const matched of first ? [...loose.matched, ...line.matched] : line.matched) parts.push(quote(matched));
    if (line.fromName) parts.push(`from ${plainName(line.fromName)}`);
    if (index === shown.length - 1 && unread !== undefined && unread > shown.length) parts.push(`${unread} unread`);
    const ref = view.ref?.(placeKey, line.id);
    if (line.preview) parts.push(ref ? `#${ref} ${quote(line.preview)}` : quote(line.preview));
    else if (ref) parts.push(`#${ref}`);
    for (const note of first ? [...new Set([...loose.notes, ...line.notes])] : line.notes) parts.push(`your note: ${quote(note)}`);
    // Several wakeups fired on this message (§30.4): the first is on its line, each other on its own.
    const more = line.wakeups.slice(1).map((fired) => `- ${[REASON_LABELS.watch, view.handle(placeKey), ref ? `#${ref}` : undefined, fired.matched !== undefined ? quote(fired.matched) : undefined, fired.note ? `your note: ${quote(fired.note)}` : undefined].filter(Boolean).join(" · ")}`);
    return [`- ${parts.join(" · ")}`, ...more];
  });
}

/** A place's wakes that name no message: one line, as before §20. */
function placeLine(group: Wake[], view: NotificationView): string {
  const first = group[0]!;
  const reasons: WakeReason[] = [];
  for (const wake of group) for (const reason of wake.reasons ?? [wake.reason]) if (!reasons.includes(reason)) reasons.push(reason);
  const latest = group[group.length - 1]!;
  const label = labeller(group);
  const parts = [reasons.map(label).join(", "), view.handle(first.placeKey!)];
  const watch = group.find((wake) => wake.reason === "watch" || wake.reasons?.includes("watch"));
  if (watch?.matched) parts.push(quote(watch.matched));
  const from = [...group].reverse().find((wake) => wake.fromName)?.fromName;
  if (from) parts.push(`from ${plainName(from)}`);
  const unread = view.unread(first.placeKey!);
  if (unread !== undefined && unread > 0) parts.push(`${unread} unread`);
  // The previewed message's ref goes in front of its quote, as in a chat line, so she can reply to it.
  const previewed = [...group].reverse().find((wake) => wake.preview !== undefined) ?? latest;
  const ref = previewed.messageId ? view.ref?.(first.placeKey!, previewed.messageId) : undefined;
  if (previewed.preview) parts.push(ref ? `#${ref} ${quote(previewed.preview)}` : quote(previewed.preview));
  else if (ref) parts.push(`#${ref}`);
  const notes = [...new Set(group.filter((wake) => wake.note && wake.reason !== "owner").map((wake) => wake.note!))];
  for (const note of notes) parts.push(`your note: ${quote(note)}`);
  return `- ${parts.join(" · ")}`;
}

function soloLine(wake: Wake, view: NotificationView): string[] {
  switch (wake.reason) {
    case "reminder":
      // §16.4: `reminder (Sat 24 Oct 14:20): "<note>"`, the time it was due (its date with its weekday, §23.2).
      return [`- reminder (${dayTimeText(new Date(wake.at), view.timeZone)}): ${quote(wake.note ?? "")}`];
    case "plan":
      // §29: `plan · 17:30 · "<what>"`, one line per plan whose time came (no place; she decides). Only
      // a plan wake queued before her day file went (§38) still comes.
      return (wake.plans ?? []).map((plan) => `- ${REASON_LABELS.plan} · ${plan.at} · ${quote(plan.what)}`);
    case "watch_timeout":
      // §16.5: a watch always ends at its timeout, so an empty one is a timer.
      // §34: and, for a place it watched, how often she has written there with no answer.
      return [`- ${REASON_LABELS.watch_timeout} · your note: ${quote(wake.note ?? "")}${unansweredParts(wake, view)}`];
    case "owner":
      return [`- ${REASON_LABELS.owner}${wake.note ? ` · ${quote(wake.note)}` : ""}`];
    case "morning":
      return wake.batch && wake.batch.length > 0 ? wake.batch : [];
    case "watch":
      // A page wakeup (§30.2) names its page.
      return [`- watch${wake.url ? ` · ${wake.url}` : ""}${wake.matched ? ` · ${quote(wake.matched)}` : ""}${wake.note ? ` · your note: ${quote(wake.note)}` : ""}`];
    case "wakeup_error":
      // §30.2: `- wakeup w4 stopped: TypeError: … (line 2)`.
      return [`- ${wake.note ?? `wakeup ${wake.watchId ?? ""} stopped`}`];
    default:
      return [`- ${REASON_LABELS[wake.reason]}${wake.note ? ` · ${quote(wake.note)}` : ""}`];
  }
}

/** The lines of one notification block: places in arrival order, one line per message within a place. */
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
  return order.flatMap((entry) => (entry.kind === "place" ? placeLines(groups.get(entry.key)!, view) : soloLine(entry.wake, view)));
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

/** One message of the batch (§23): a DM's message, or a room message that addressed her. */
export type MorningLine = { id: string; fromName?: string; preview: string; reasons: readonly WakeReason[]; at?: Date };

export type MorningPlace = {
  placeKey: string;
  kind: "room" | "thread" | "dm";
  mentions: number;
  messages: number;
  /** Oldest first: every kept DM message, a room's messages that addressed her (§23). */
  lines?: readonly MorningLine[];
  /** Lines older than `lines` that were not kept. */
  earlier?: number;
  /** When the batch's messages there came (the counts line's span). */
  span?: { from: Date; to: Date };
};

/** The batch's reasons, in label order: what addressed her in a room. */
const ADDRESSED: readonly WakeReason[] = ["mention", "name", "role", "everyone"];

/**
 * The `morning` batch lines (§4.7, §23, §38: the reason kept its name), built when her budget pause
 * ends, or at the first tick after the upgrade for what waited for her bed time's morning: DMs with
 * one line per message, then rooms by most mentions (counts with the span of their messages, then
 * one line per message that addressed her), then watch matches, watch timeouts, reminders, plans and
 * the rest. Times are her local `HH:MM`, with the day (`Tue 17 Nov 23:40`) when not on the release's
 * day; every line has its ref.
 */
export function morningBatch(
  o: {
    since: Date;
    until: Date;
    places: readonly MorningPlace[];
    items: readonly Wake[];
    /** Lines per DM or room (§23; `life.notificationLinesPerPlace`); `NOTIFICATION_LINES_PER_PLACE` when absent. */
    linesPerPlace?: number;
  },
  view: NotificationView
): string[] {
  const releaseDay = localDayKey(o.until, view.timeZone);
  const timeOf = (date: Date) => (localDayKey(date, view.timeZone) === releaseDay ? clockText(date, view.timeZone) : dayTimeText(date, view.timeZone));
  const lines = [`- while you were away (since ${timeOf(o.since)}):`];
  const cap = Math.max(1, o.linesPerPlace ?? NOTIFICATION_LINES_PER_PLACE);
  // The newest `cap` lines; the first says how many earlier ones were left out.
  const messageLines = (place: MorningPlace, line: (entry: MorningLine, head: string[]) => string): string[] => {
    const all = place.lines ?? [];
    const shown = all.slice(-cap);
    const hidden = (place.earlier ?? 0) + all.length - shown.length;
    return shown.map((entry, index) => line(entry, index === 0 && hidden > 0 ? [`+${hidden} earlier`] : []));
  };
  const stamp = (placeKey: string, entry: { id: string; at?: Date }): string => {
    const ref = view.ref?.(placeKey, entry.id);
    return [entry.at ? timeOf(entry.at) : undefined, ref ? `#${ref}` : undefined].filter(Boolean).join(" ");
  };
  const tail = (placeKey: string, entry: MorningLine, from: boolean): string =>
    [stamp(placeKey, entry), from && entry.fromName ? `from ${plainName(entry.fromName)}` : undefined, entry.preview ? quote(entry.preview) : undefined].filter(Boolean).join(" ");

  const dms = o.places.filter((entry) => entry.kind === "dm" && (entry.messages > 0 || (entry.lines?.length ?? 0) > 0));
  if (dms.length > 0) {
    lines.push("  · DMs:");
    for (const dm of dms) {
      const handle = view.handle(dm.placeKey);
      if (!dm.lines || dm.lines.length === 0) {
        lines.push(`    · ${handle}: ${dm.messages} message${dm.messages === 1 ? "" : "s"}`);
        continue;
      }
      lines.push(...messageLines(dm, (entry, head) => `    · ${[handle, ...head, tail(dm.placeKey, entry, false)].filter(Boolean).join(" · ")}`));
    }
  }
  const rooms = o.places
    .map((place, index) => ({ place, index }))
    .filter(({ place }) => place.kind !== "dm")
    .sort((a, b) => b.place.mentions - a.place.mentions || a.index - b.index)
    .map(({ place }) => place);
  for (const place of rooms) {
    const counts = [
      place.mentions > 0 ? `${place.mentions} mention${place.mentions === 1 ? "" : "s"}` : undefined,
      place.messages > 0 ? `${place.messages} message${place.messages === 1 ? "" : "s"}` : undefined
    ].filter(Boolean);
    if (counts.length === 0) continue;
    const span = !place.span ? "" : timeOf(place.span.from) === timeOf(place.span.to) ? ` (${timeOf(place.span.from)})` : ` (${timeOf(place.span.from)}–${timeOf(place.span.to)})`;
    lines.push(`  · ${view.handle(place.placeKey)}: ${counts.join(", ")}${span}`);
    lines.push(
      ...messageLines(place, (entry, head) => {
        const reasons = ADDRESSED.filter((reason) => entry.reasons.includes(reason)).map((reason) => REASON_LABELS[reason]);
        return `    · ${[reasons.join(", ") || REASON_LABELS.mention, ...head, tail(place.placeKey, entry, true)].filter(Boolean).join(" · ")}`;
      })
    );
  }
  const isWatch = (item: Wake) => item.reason === "watch" || item.reasons?.includes("watch") === true;
  for (const item of o.items.filter(isWatch)) {
    // A DM wake that carried a watch match (§16.5) shows the match here; its DM lines are above. One
    // line per matching message (§20), with the message's time and ref (§23).
    const matches = messagesOf(item).filter((message) => message.matched !== undefined || (message.reasons.includes("watch") && message.note !== undefined));
    const found = matches.length > 0 ? matches : [{ id: item.messageId, matched: item.matched, fromName: item.fromName, note: item.note, wakeups: item.wakeups }];
    // Several wakeups on one message (§30.4): a line each.
    const entries = found.flatMap((entry) =>
      entry.wakeups && entry.wakeups.length > 1 ? entry.wakeups.map((fired, index) => ({ ...entry, matched: fired.matched, note: fired.note, ...(index > 0 ? { fromName: undefined } : {}) })) : [entry]
    );
    for (const entry of entries) {
      const parts = ["watch matched"];
      if (item.placeKey) parts.push(view.handle(item.placeKey));
      if (item.url) parts.push(item.url);
      if (entry.matched) parts.push(quote(entry.matched));
      if (entry.fromName) parts.push(`from ${plainName(entry.fromName)}`);
      if (item.placeKey && entry.id) {
        const at = snowflakeTime(entry.id);
        const when = stamp(item.placeKey, { id: entry.id, ...(at !== undefined ? { at: new Date(at) } : {}) });
        if (when) parts.push(when);
      }
      if (entry.note) parts.push(`your note: ${quote(entry.note)}`);
      lines.push(`  · ${parts.join(" · ")}`);
    }
  }
  for (const item of o.items) {
    if (item.reason === "watch_timeout") lines.push(`  · watch timed out (${dayTimeText(new Date(item.at), view.timeZone)}) · your note: ${quote(item.note ?? "")}${unansweredParts(item, view)}`);
  }
  for (const item of o.items) {
    if (item.reason === "reminder") lines.push(`  · reminder (${dayTimeText(new Date(item.at), view.timeZone)}): ${quote(item.note ?? "")}`);
  }
  for (const item of o.items) {
    if (item.reason === "wakeup_error") lines.push(`  · ${item.note ?? "a wakeup stopped"}`);
  }
  for (const item of o.items) {
    // A timed plan deferred for her budget (§29): one line per plan, with its day (weekday and date).
    if (item.reason !== "plan") continue;
    const day = dayText(new Date(item.at), view.timeZone);
    for (const plan of item.plans ?? []) lines.push(`  · plan (${day} ${plan.at}): ${quote(plan.what)}`);
  }
  for (const item of o.items) {
    if (isWatch(item) || item.reason === "watch_timeout" || item.reason === "reminder" || item.reason === "plan" || item.reason === "wakeup_error") continue;
    if (item.reason === "followup") {
      lines.push(`  · ${item.note ?? "something from before still needs you"}`);
    } else if (item.reason === "morning" && item.batch) {
      // An earlier batch she never read (her budget ran out first): its lines without its header
      // (and without a morning greeting one saved before §38 may still start with).
      lines.push(...item.batch.filter((line) => !line.startsWith("[system]")).slice(1));
    }
  }
  return lines;
}
