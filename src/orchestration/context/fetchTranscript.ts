// Phase 4 ConversationMessageSource (spec 8.3): a thin REST adapter over the Discord gateway
// facade. Uses `fetchContextSince` when the facade has it; fakes without it fall back to
// `fetchFreshContext` + a cursor filter. Phase 5 replaces this with ConversationMessageCache.

import type { DiscordGatewayFacade } from "../../discord/client.js";
import { attachmentKey } from "../../discord/attachments.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { ContextMessage } from "../contextMessages.js";
import { compareMessageOrder } from "./ledger.js";
import type { ConversationMessageSource } from "./types.js";

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
