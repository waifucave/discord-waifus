import { z } from "zod";

export const ReactionSummarySchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  users: z.array(z.string()).optional()
});

export const ContextMessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  guildId: z.string().optional(),
  authorKind: z.enum(["user", "waifu"]),
  authorId: z.string(),
  name: z.string(),
  displayName: z.string(),
  content: z.string(),
  timestamp: z.string(),
  sourceMessageIds: z.array(z.string()).optional(),
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

export const OrchestratorNoReplyMarkerSchema = z.object({
  kind: z.literal("no_reply"),
  timestamp: z.string(),
  idleTrigger: z.number().int(),
  reasoning: z.string()
});
export type OrchestratorNoReplyMarker = z.infer<typeof OrchestratorNoReplyMarkerSchema>;

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
      name: message.authorName,
      displayName: message.authorDisplayName ?? message.authorName,
      content: message.content,
      timestamp: formatTimestamp(message.createdAt),
      sourceMessageIds: message.sourceMessageIds,
      replyTo: message.replyTo,
      reactions: message.reactions ?? []
    })
  );
}

export function formatTimestamp(then: Date): string {
  return then.toISOString().replace(/\.\d{3}Z$/, "Z");
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
    reactions: mergeReactions(first.reactions, next.reactions)
  };
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
