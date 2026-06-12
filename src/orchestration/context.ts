import { z } from "zod";

export const ReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  users: z.array(z.string()).optional()
});

export const AttachmentImageSchema = z.object({
  url: z.string(),
  contentType: z.string().optional(),
  contentLengthBytes: z.number().int().nonnegative().optional(),
  ocrText: z.string().optional()
});
export type AttachmentImage = z.infer<typeof AttachmentImageSchema>;

export const ContextMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  guildId: z.string().optional(),
  authorKind: z.enum(["user", "waifu"]),
  authorId: z.string(),
  authorBot: z.boolean().optional(),
  name: z.string(),
  displayName: z.string(),
  content: z.string(),
  timestamp: z.string(),
  sourceMessageIds: z.array(z.string()).optional(),
  images: z.array(AttachmentImageSchema).optional(),
  replyTo: z
    .object({
      messageId: z.string(),
      authorName: z.string().optional(),
      contentPreview: z.string().optional()
    })
    .optional(),
  reactions: z.array(ReactionSummarySchema)
});

export type ContextMessage = z.infer<typeof ContextMessageSchema>;

export const OrchestratorWakeMarkerSchema = z.object({
  kind: z.literal("wake"),
  timestamp: z.string(),
  scheduledSeconds: z.number().int(),
  wakePlan: z.string().optional()
});
export type OrchestratorWakeMarker = z.infer<typeof OrchestratorWakeMarkerSchema>;

export type MessageLikeForContext = {
  id: string;
  channelId: string;
  guildId?: string;
  authorId: string;
  authorName: string;
  authorDisplayName?: string;
  authorBot?: boolean;
  content: string;
  createdAt: Date;
  sourceMessageIds?: string[];
  images?: AttachmentImage[];
  replyTo?: {
    messageId: string;
    authorName?: string;
    contentPreview?: string;
  };
  reactions?: Array<{
    emoji: string;
    count: number;
    users?: string[];
  }>;
};

export const WAIFU_CHUNK_COALESCE_WINDOW_MS = 30_000;

/**
 * Formats the observer context window as a lean human-readable block.
 * Header: Window: <first date+time>–<last time> UTC (today: YYYY-MM-DD)
 * Per message: optional "replying to > Author" line, "DisplayName: body", "[image_text: ...]" lines.
 * No [index:], no per-message timestamps, no [reactions:].
 * Midnight-crossing messages get a [— next day: YYYY-MM-DD —] separator.
 */
export function formatObserverContext(messages: ContextMessage[], now: Date): string {
  const todayStr = formatDateOnly(now);

  if (messages.length === 0) {
    return `Window: (today: ${todayStr})`;
  }

  const firstTs = messages[0].timestamp;
  const lastTs = messages[messages.length - 1].timestamp;
  const firstDate = firstTs.slice(0, 10);
  const firstTime = firstTs.slice(11, 19);
  const lastTime = lastTs.slice(11, 19);

  const header =
    firstDate === lastTs.slice(0, 10)
      ? `Window: ${firstDate}T${firstTime}–${lastTime} UTC (today: ${todayStr})`
      : `Window: ${firstDate}T${firstTime}–${lastTs.slice(0, 10)}T${lastTime} UTC (today: ${todayStr})`;

  const lines: string[] = [header];
  let prevDate = firstDate;

  for (const message of messages) {
    const msgDate = message.timestamp.slice(0, 10);
    if (msgDate > prevDate) {
      lines.push(`[— next day: ${msgDate} —]`);
      prevDate = msgDate;
    }

    if (message.replyTo) {
      const authorName = message.replyTo.authorName?.trim();
      if (authorName) {
        lines.push(`replying to > ${authorName}`);
      } else {
        lines.push(`replying to >`);
      }
    }

    const body = message.content.length > 0 ? `${message.displayName}: ${message.content}` : `${message.displayName}:`;
    lines.push(body);

    for (const image of message.images ?? []) {
      const ocr = image.ocrText?.replace(/\s+/g, " ").trim();
      if (ocr) {
        lines.push(`[image_text: ${ocr}]`);
      }
    }
  }

  return lines.join("\n");
}

function formatDateOnly(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

export function buildContextMessages(
  messages: MessageLikeForContext[],
  options: {
    orchestratorAuthorIds?: string[];
    waifuAuthorIds?: string[];
    now?: Date;
  } = {}
): ContextMessage[] {
  const orchestratorIds = new Set(options.orchestratorAuthorIds ?? []);
  const waifuIds = new Set(options.waifuAuthorIds ?? []);

  const filtered = messages.filter((message) => !orchestratorIds.has(message.authorId));
  const coalesced = coalesceAdjacentChunks(filtered, waifuIds);

  return coalesced.map((message) =>
    ContextMessageSchema.parse({
      id: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorKind: waifuIds.has(message.authorId) ? "waifu" : "user",
      authorId: message.authorId,
      authorBot: message.authorBot,
      name: message.authorName,
      displayName: message.authorDisplayName ?? message.authorName,
      content: message.content,
      timestamp: formatTimestamp(message.createdAt),
      sourceMessageIds: message.sourceMessageIds,
      images: message.images,
      replyTo: message.replyTo,
      reactions: message.reactions ?? []
    })
  );
}

export function formatTimestamp(then: Date): string {
  return then.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const COMPACT_REPLY_PREVIEW_LIMIT = 80;

function clipReplyPreview(preview: string): string {
  return preview.length > COMPACT_REPLY_PREVIEW_LIMIT
    ? `${preview.slice(0, COMPACT_REPLY_PREVIEW_LIMIT - 1)}…`
    : preview;
}

function replyQuoteLine(message: ContextMessage): string | null {
  if (!message.replyTo) return null;
  const authorName = message.replyTo.authorName?.trim();
  const preview = message.replyTo.contentPreview?.trim();
  if (authorName && preview) {
    return `replying to > ${authorName}: ${clipReplyPreview(preview)}`;
  }
  if (authorName) {
    return `replying to > ${authorName}`;
  }
  if (preview) {
    return `replying to > ${clipReplyPreview(preview)}`;
  }
  return null;
}

export function formatOrchestratorMessageBlock(message: ContextMessage): string {
  const lines: string[] = [];
  const quote = replyQuoteLine(message);
  if (quote) lines.push(quote);
  lines.push(senderPrefixedContent(message.displayName, message.content));
  const imageCount = message.images?.length ?? 0;
  if (imageCount > 0) {
    lines.push(`[attachments: ${imageCount}x image]`);
    appendImageTextLines(lines, message.images);
  }
  return lines.join("\n");
}

// The waifu's own history is rendered as raw message bodies: no name prefix, no reply-quote
// line, no attachment/image tags — replyTo and images are intentionally omitted for self turns. The context itself then demonstrates the output contract —
// "my turns are plain message text" — which holds format on far smaller models than rules do.
export function formatSelfWaifuContent(message: ContextMessage): string {
  return message.content;
}

export function formatWaifuContextBlock(message: ContextMessage): string {
  const lines: string[] = [];
  const quote = replyQuoteLine(message);
  if (quote) lines.push(quote);
  lines.push(senderPrefixedContent(message.displayName, message.content));
  const imageCount = message.images?.length ?? 0;
  if (imageCount > 0) {
    lines.push(`[attachments: ${imageCount}x image]`);
    appendImageTextLines(lines, message.images);
  }
  return lines.join("\n");
}

function senderPrefixedContent(displayName: string, content: string): string {
  return content.length > 0 ? `${displayName}: ${content}` : `${displayName}:`;
}

function appendImageTextLines(lines: string[], images: AttachmentImage[] | undefined): void {
  for (const image of images ?? []) {
    const ocr = image.ocrText?.replace(/\s+/g, " ").trim();
    if (ocr) {
      lines.push(`[image_text: ${ocr}]`);
    }
  }
}

function coalesceAdjacentChunks(
  messages: MessageLikeForContext[],
  waifuAuthorIds: Set<string>
): MessageLikeForContext[] {
  const replyTargetIds = new Set(messages.flatMap((message) => message.replyTo?.messageId ? [message.replyTo.messageId] : []));
  const result: MessageLikeForContext[] = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    const sameAuthor = prev && prev.authorId === message.authorId;
    const withinWindow =
      sameAuthor &&
      message.createdAt.getTime() - prev.createdAt.getTime() <= WAIFU_CHUNK_COALESCE_WINDOW_MS;
    if (
      sameAuthor &&
      withinWindow &&
      !replyTargetIds.has(prev.id) &&
      !replyTargetIds.has(message.id) &&
      compatibleReplyTargets(prev, message)
    ) {
      result[result.length - 1] = mergeChunk(prev, message, {
        authorKind: waifuAuthorIds.has(message.authorId) ? "waifu" : "user"
      });
    } else {
      result.push(message);
    }
  }
  return result;
}

function mergeChunk(
  first: MessageLikeForContext,
  next: MessageLikeForContext,
  options: { authorKind: "user" | "waifu" }
): MessageLikeForContext {
  return {
    ...first,
    content: joinChunkContent(first.content, next.content, options.authorKind),
    createdAt: next.createdAt,
    sourceMessageIds: [...(first.sourceMessageIds ?? [first.id]), ...(next.sourceMessageIds ?? [next.id])],
    images: mergeImages(first.images, next.images),
    reactions: mergeReactions(first.reactions, next.reactions)
  };
}

function mergeImages(
  a: AttachmentImage[] | undefined,
  b: AttachmentImage[] | undefined
): AttachmentImage[] | undefined {
  const merged = [...(a ?? []), ...(b ?? [])];
  return merged.length ? merged : undefined;
}

function compatibleReplyTargets(
  first: MessageLikeForContext,
  next: MessageLikeForContext
): boolean {
  const firstReplyId = first.replyTo?.messageId;
  const nextReplyId = next.replyTo?.messageId;
  return nextReplyId === undefined || firstReplyId === nextReplyId;
}

function joinChunkContent(first: string, next: string, authorKind: "user" | "waifu"): string {
  const firstTrimmed = first.trim();
  const nextTrimmed = next.trim();
  if (!firstTrimmed) return nextTrimmed;
  if (!nextTrimmed) return firstTrimmed;
  const separator = authorKind === "user" && !endsWithPunctuation(firstTrimmed) ? ", " : " ";
  return `${firstTrimmed}${separator}${nextTrimmed}`;
}

function endsWithPunctuation(value: string): boolean {
  return /[.!?,:;…]$/u.test(value);
}

function mergeReactions(
  a: MessageLikeForContext["reactions"],
  b: MessageLikeForContext["reactions"]
): MessageLikeForContext["reactions"] {
  if (!a?.length) return b ?? [];
  if (!b?.length) return a;
  const byEmoji = new Map<string, { emoji: string; count: number; users?: string[] }>();
  for (const reaction of [...a, ...b]) {
    const existing = byEmoji.get(reaction.emoji);
    if (existing) {
      existing.count += reaction.count;
      if (reaction.users) existing.users = [...(existing.users ?? []), ...reaction.users];
    } else {
      byEmoji.set(reaction.emoji, { ...reaction });
    }
  }
  return [...byEmoji.values()];
}
