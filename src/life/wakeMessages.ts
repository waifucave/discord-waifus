// The messages a wake is about (Living cast spec §20): a held burst, a DM burst or several queued
// wakes for one place are one wake, but her notification shows one line per message. A wake keeps
// every message (the newest `MAX_WAKE_MESSAGES`, with a count of the older ones left out).

import { compareIds } from "../discord/rawMessage.js";
import type { Wake, WakeMessage, WakeReason } from "../shared/schemas/life.js";

/** The most messages one queued wake keeps (the newest); older ones only count in `earlier`. */
export const MAX_WAKE_MESSAGES = 50;

/** A wake's reasons in arrival order. */
export function reasonsOf(wake: Pick<Wake, "reason" | "reasons">): WakeReason[] {
  return wake.reasons ?? [wake.reason];
}

/**
 * The messages a wake is about, each with its reasons resolved: its own list, else the one message
 * a single-message wake (or one queued before §20) names. A wake that names no message has none.
 */
export function messagesOf(wake: Wake): Array<WakeMessage & { reasons: WakeReason[] }> {
  const fallback = reasonsOf(wake);
  if (wake.messages && wake.messages.length > 0) return wake.messages.map((message) => ({ ...message, reasons: message.reasons ?? fallback }));
  if (!wake.messageId) return [];
  return [
    {
      id: wake.messageId,
      ...(wake.fromUserId ? { fromUserId: wake.fromUserId } : {}),
      ...(wake.fromName !== undefined ? { fromName: wake.fromName } : {}),
      preview: wake.preview ?? "",
      reasons: fallback,
      ...(wake.matched !== undefined ? { matched: wake.matched } : {}),
      ...(wake.note !== undefined && wake.reason !== "owner" ? { note: wake.note } : {}),
      ...(wake.wakeups && wake.wakeups.length > 0 ? { wakeups: wake.wakeups } : {})
    }
  ];
}

/** Two entries for one message: reasons joined, the first match and note kept. */
export function mergeMessage(a: WakeMessage, b: WakeMessage): WakeMessage {
  const reasons = a.reasons === undefined && b.reasons === undefined ? undefined : [...new Set([...(a.reasons ?? []), ...(b.reasons ?? [])])];
  return {
    ...b,
    ...a,
    ...(reasons ? { reasons } : {}),
    ...(a.matched ?? b.matched ? { matched: (a.matched ?? b.matched)! } : {}),
    ...(a.note ?? b.note ? { note: (a.note ?? b.note)! } : {}),
    ...(a.wakeups || b.wakeups ? { wakeups: [...(a.wakeups ?? []), ...(b.wakeups ?? []).filter((fired) => !(a.wakeups ?? []).some((known) => known.id === fired.id))] } : {})
  };
}

/** Messages in message order, one entry per id, the newest `max` kept; `earlier` counts the rest. */
export function joinMessages(lists: ReadonlyArray<readonly WakeMessage[]>, earlier = 0, max = MAX_WAKE_MESSAGES): { messages: WakeMessage[]; earlier: number } {
  const byId = new Map<string, WakeMessage>();
  for (const list of lists) {
    for (const message of list) {
      const existing = byId.get(message.id);
      byId.set(message.id, existing ? mergeMessage(existing, message) : message);
    }
  }
  const ordered = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  const kept = ordered.slice(-max);
  return { messages: kept, earlier: earlier + ordered.length - kept.length };
}
