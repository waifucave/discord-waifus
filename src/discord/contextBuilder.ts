import { GuildEmojiCacheEntry, GuildMemberCacheEntry } from "../shared/schemas/domain.js";
import {
  MessageLikeForContext,
  buildContextMessages,
  ContextMessage
} from "../orchestration/context.js";
import { ModelVisibleRole, normalizeDiscordContentForModel } from "./normalization.js";

export function buildNormalizedDiscordContext(
  messages: MessageLikeForContext[],
  cache: {
    members?: GuildMemberCacheEntry[];
    emojis?: GuildEmojiCacheEntry[];
    roles?: ModelVisibleRole[];
  },
  options: {
    orchestratorAuthorIds?: string[];
    waifuAuthorIds?: string[];
    now?: Date;
  } = {}
): { messages: ContextMessage[]; warnings: string[] } {
  const warnings: string[] = [];
  const normalizedInput = messages.map((message) => {
    const normalized = normalizeDiscordContentForModel(message.content, cache);
    warnings.push(...normalized.warnings);
    return {
      ...message,
      content: normalized.content
    };
  });

  return {
    messages: buildContextMessages(normalizedInput, options),
    warnings
  };
}
