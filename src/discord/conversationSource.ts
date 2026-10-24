// The REST ConversationMessageSource (spec 8.3; moved here from the retired context engine,
// Living cast §6.2): a thin adapter over the Discord facade. Uses `fetchContextSince` when the
// facade has it; fakes without it fall back to `fetchFreshContext` + a cursor filter. The
// conversation cache (conversationCache.ts) uses it for the untrusted / uncovered case.

import type { DiscordGatewayFacade } from "./client.js";
import { attachmentKey } from "./attachments.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { ContextMessage } from "../orchestration/contextMessages.js";
import type { ConversationMessageSource } from "../orchestration/context/types.js";

/** Discord order: snowflake order when both ids are snowflakes, else creation time then id. */
export function compareMessageOrder(
  a: Pick<RawDiscordMessage, "id" | "createdAt">,
  b: Pick<RawDiscordMessage, "id" | "createdAt">
): number {
  if (/^\d+$/.test(a.id) && /^\d+$/.test(b.id)) {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const t = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  return t !== 0 ? t : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type FetchSinceInput = Parameters<ConversationMessageSource["fetchSince"]>[0];

/** Lossy ContextMessage → RawDiscordMessage, only for facades without fetchContextSince. */
export function contextMessageToRaw(m: ContextMessage): RawDiscordMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    ...(m.guildId ? { guildId: m.guildId } : {}),
    authorId: m.authorId,
    authorName: m.displayName || m.name,
    authorIsBot: m.authorBot ?? m.authorKind === "waifu",
    createdAt: new Date(m.timestamp).toISOString(),
    type: m.replyTo ? 19 : 0,
    content: m.content,
    attachments: (m.images ?? []).map((image, index) => {
      const key = attachmentKey(image.url);
      let filename = "image";
      try {
        filename = decodeURIComponent(new URL(image.url).pathname.split("/").pop() || "image");
      } catch {
        // keep default
      }
      return {
        id: key.startsWith("att:") ? key.slice(4) : `${m.id}-${index}`,
        url: image.url,
        filename,
        ...(image.contentType ? { contentType: image.contentType } : {}),
        size: image.contentLengthBytes ?? 0
      };
    }),
    embeds: [],
    stickers: [],
    snapshots: [],
    ...(m.replyTo?.messageId ? { referenceMessageId: m.replyTo.messageId } : {}),
    mentions: { users: {}, roles: {}, channels: {} }
  };
}

/** Keep messages strictly after `afterMessageId` (oldest-first), bounded to the newest `max`. */
export function filterSinceCursor(
  messages: RawDiscordMessage[],
  afterMessageId: string | null,
  maxMessages: number,
  limitHit: boolean
): { messages: RawDiscordMessage[]; reachedCursor: boolean } {
  const sorted = [...messages].sort(compareMessageOrder);
  let reachedCursor = !limitHit;
  let after = sorted;
  if (afterMessageId !== null) {
    const index = sorted.findIndex((m) => m.id === afterMessageId);
    if (index >= 0) {
      after = sorted.slice(index + 1);
      reachedCursor = true;
    } else if (/^\d+$/.test(afterMessageId) && sorted.every((m) => /^\d+$/.test(m.id))) {
      const cursor = BigInt(afterMessageId);
      const older = sorted.filter((m) => BigInt(m.id) <= cursor);
      after = sorted.filter((m) => BigInt(m.id) > cursor);
      if (older.length > 0) reachedCursor = true;
    }
  }
  const max = Math.max(1, maxMessages);
  if (after.length > max) {
    after = after.slice(-max);
    reachedCursor = false;
  }
  return { messages: after, reachedCursor };
}

export class DiscordConversationSource implements ConversationMessageSource {
  constructor(private readonly discord: () => DiscordGatewayFacade | undefined) {}

  async fetchSince(i: FetchSinceInput): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }> {
    const discord = this.discord();
    // DM transport (the waifu's own bot) arrives in Phase 5 (spec 9.1).
    if (!discord || i.conversation.kind !== "guild") return { messages: [], reachedCursor: true };
    const { guildId, channelId } = i.conversation;
    if (discord.fetchContextSince) {
      return discord.fetchContextSince({
        guildId,
        channelId,
        afterMessageId: i.afterMessageId,
        maxMessages: i.maxMessages,
        signal: i.signal
      });
    }
    // Over-fetch by one so "the cursor is just outside the window" is still detected.
    const limit = Math.min(100, Math.max(1, i.maxMessages) + 1);
    const fresh = await discord.fetchFreshContext({ guildId, channelId, limit, signal: i.signal });
    return filterSinceCursor(fresh.map(contextMessageToRaw), i.afterMessageId, i.maxMessages, fresh.length >= limit);
  }
}
