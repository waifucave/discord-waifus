// Message line formatting for lives (Living cast spec §15 keep table: moved from the retired
// context engine's transcript renderer, `entryHeader` / `entryLine`, and rewritten over the
// conversation cache's messages). `read_messages`, previews and the detector state build on it
// in L2.
//
//   `[14:02 #k3] Kevin: text`            a message with its ref
//   `[14:02 #k4 ↩#k3]`                   a reply to a message she can see by ref
//   `[14:02 #k5 ↩you]`                   a reply to one of her own messages
//   `[14:02 #k6 ↩Kevin]`                 a reply to an older message by Kevin (no ref)

import { formatClock } from "../orchestration/context/timeFormat.js";

/** The fields a line needs: a cache message reduced to who, when, what and what it replies to. */
export type LineMessage = {
  id: string;
  authorId: string;
  authorName: string;
  /** ISO time of the message. */
  at: string;
  /** The rendered body (empty for a message with nothing to show). */
  body: string;
  replyToId?: string;
};

export type LineView = {
  /** messageId → ref (`k3`), from the conversation's ref store. */
  refs: ReadonlyMap<string, string>;
  /** Any message of the conversation the line may point at (a reply target). */
  lookup: (id: string) => Pick<LineMessage, "authorId" | "authorName"> | undefined;
  /** Her own author ids (her bot), so replies to her read `↩you`. */
  selfAuthorIds: readonly string[];
  timeZone: string;
};

/** `[14:02 #k3]`, `[14:03 #k4 ↩#a1]`, `[14:03 #k4 ↩you]`, `[14:03 #k4 ↩Kevin]`. */
export function entryHeader(message: LineMessage, view: LineView): string {
  const ref = view.refs.get(message.id);
  const parts = [formatClock(message.at, view.timeZone)];
  if (ref) parts.push(`#${ref}`);
  if (message.replyToId) {
    const target = view.lookup(message.replyToId);
    if (target && view.selfAuthorIds.includes(target.authorId)) parts.push("↩you");
    else if (view.refs.has(message.replyToId)) parts.push(`↩#${view.refs.get(message.replyToId)}`);
    else if (target && target.authorName) parts.push(`↩${target.authorName}`);
  }
  return `[${parts.join(" ")}]`;
}

/** `[14:02 #k3] Kevin: text` (just the header and name when the body is empty). */
export function entryLine(message: LineMessage, view: LineView): string {
  const head = `${entryHeader(message, view)} ${message.authorName || "Unknown"}:`;
  return message.body ? `${head} ${message.body}` : head;
}
