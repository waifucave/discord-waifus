// Message line formatting for lives (Living cast spec §15 keep table: moved from the retired
// context engine's transcript renderer, rewritten over the conversation cache's messages).
// `ReadMessages` and her `/transcripts` render the same line (§22.1):
//
//   `[14:02 #k3] Kevin: text`            a message with its ref
//   `[14:02 #k4] Kevin ↩#k3: text`       a reply to a message she can see by ref
//   `[14:02 #k5] Kevin ↩you: text`       a reply to one of her own messages
//   `[14:02 #k6] Kevin ↩Mina: text`      a reply to an older message by Mina (no ref)

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

/** What a reply points at: `you`, `#k3`, the author's name, or nothing known. */
export function replyMark(message: Pick<LineMessage, "replyToId">, view: LineView): string | undefined {
  if (!message.replyToId) return undefined;
  const target = view.lookup(message.replyToId);
  if (target && view.selfAuthorIds.includes(target.authorId)) return "you";
  if (view.refs.has(message.replyToId)) return `#${view.refs.get(message.replyToId)}`;
  if (target && target.authorName) return target.authorName;
  return undefined;
}

/** `[14:02 #k3]` (`[14:02]` without a ref). */
export function entryHeader(message: Pick<LineMessage, "id" | "at">, view: Pick<LineView, "refs" | "timeZone">): string {
  const ref = view.refs.get(message.id);
  return `[${formatClock(message.at, view.timeZone)}${ref ? ` #${ref}` : ""}]`;
}

/** One chat line: `[14:02 #k4] Kevin ↩#k3: text` (the name and a colon when there is no body). */
export function chatLine(o: { clock: string; ref?: string | undefined; name: string; reply?: string | undefined; body: string }): string {
  const head = `[${o.clock}${o.ref ? ` #${o.ref}` : ""}] ${o.name}${o.reply ? ` ↩${o.reply}` : ""}:`;
  return o.body ? `${head} ${o.body}` : head;
}

/** `[14:02 #k3] Kevin: text` for a message (`Unknown` when it has no author name). */
export function entryLine(message: LineMessage, view: LineView): string {
  return chatLine({ clock: formatClock(message.at, view.timeZone), ref: view.refs.get(message.id), name: message.authorName || "Unknown", reply: replyMark(message, view), body: message.body });
}
