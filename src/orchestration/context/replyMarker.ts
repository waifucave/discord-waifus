// The waifu's reply-target marker (spec 6.3/8.5): she may start her message with `↩#k3 ` to reply
// to message #k3 (refs are the short per-conversation refs shown in transcript headers). Parsing
// is exact — no fuzzy matching — but tolerant of the punctuation models add (`↩#k3: yeah`,
// `↩#K3, yes`). A known ref sets Discord's reply reference; an unknown ref is stripped and the
// message is sent unthreaded. A copied header target (`↩you`, `↩Kevin`) is stripped too and sent
// unthreaded: those name no message she can reply to.

export const REPLY_MARKER_RE = /^\s*↩️?\s?#([0-9a-z]{2,6})[:,]?(?:[ \t]+|\n|$)/i;
// `↩you` / `↩Name` copied from a header: the name runs to the first space/colon/comma.
const HEADER_TARGET_RE = /^\s*↩️?([^\s#:,][^\s:,]{0,39})[:,]?(?:[ \t]+|\n|$)/;

export type ParsedReplyMarker = {
  /** The message text with the marker removed (trimmed). */
  content: string;
  replyToMessageId?: string;
  /** The ref the marker named, when it resolved. */
  ref?: string;
  /** The ref the marker named, when it did not resolve (stripped, sent unthreaded). */
  unknownRef?: string;
  /** A copied `↩you` / `↩Name` header target (stripped, sent unthreaded). */
  strippedTarget?: string;
};

// A leaked transcript header at the very start (`[14:02 #k3]`, `[14:03 #k4 ↩#a1]`, `[14:05]`).
// Step 1 of the reply processing order (spec 8.5); a "Name:" after it is the self-prefix strip's job.
const LEADING_TRANSCRIPT_HEADER_RE = /^\s*\[\d{1,2}:\d{2}(?: #[0-9a-z]{2,6})?(?: ↩[^\]\n]{1,40})?\][ \t]*/;

export function stripLeadingTranscriptHeader(raw: string): string {
  let text = raw;
  for (let i = 0; i < 4; i += 1) {
    const next = text.replace(LEADING_TRANSCRIPT_HEADER_RE, "");
    if (next === text) break;
    text = next;
  }
  return text;
}

export function parseReplyMarker(raw: string, refToMessageId: ReadonlyMap<string, string>): ParsedReplyMarker {
  const match = REPLY_MARKER_RE.exec(raw);
  if (match) {
    const ref = match[1]!.toLowerCase();
    const content = raw.slice(match[0].length).trim();
    const messageId = refToMessageId.get(ref);
    return messageId ? { content, replyToMessageId: messageId, ref } : { content, unknownRef: ref };
  }
  const target = HEADER_TARGET_RE.exec(raw);
  if (target) return { content: raw.slice(target[0].length).trim(), strippedTarget: target[1]! };
  return { content: raw.trim() };
}
