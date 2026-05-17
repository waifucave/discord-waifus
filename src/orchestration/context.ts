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
  const coalesced = coalesceWaifuChunks(filtered, waifuIds);

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

function coalesceWaifuChunks(
  messages: MessageLikeForContext[],
  waifuAuthorIds: Set<string>
): MessageLikeForContext[] {
  const result: MessageLikeForContext[] = [];
  for (const message of messages) {
    const prev = result[result.length - 1];
    const sameWaifu =
      prev &&
      waifuAuthorIds.has(message.authorId) &&
      prev.authorId === message.authorId;
    const withinWindow =
      sameWaifu &&
      message.createdAt.getTime() - prev.createdAt.getTime() <= WAIFU_CHUNK_COALESCE_WINDOW_MS;
    if (sameWaifu && withinWindow) {
      result[result.length - 1] = mergeChunk(prev, message);
    } else {
      result.push(message);
    }
  }
  return result;
}

function mergeChunk(
  first: MessageLikeForContext,
  next: MessageLikeForContext
): MessageLikeForContext {
  return {
    ...first,
    content: `${first.content} ${next.content}`.trim(),
    createdAt: next.createdAt,
    sourceMessageIds: [...(first.sourceMessageIds ?? [first.id]), ...(next.sourceMessageIds ?? [next.id])],
    reactions: mergeReactions(first.reactions, next.reactions)
  };
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
