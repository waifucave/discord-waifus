import type { DiscordBotsFile } from "./schemas/domain.js";

/**
 * A waifu's `botId` references a discord-bots entry by its config id (e.g. "riko"), while
 * Discord message authorIds and guild-member userIds carry the bot user's snowflake (=== the
 * entry's applicationId). Resolve a bot reference to every id that can stand for that bot, so
 * self-recognition and member lookups work regardless of which id space a caller compares
 * against. Unknown refs fall back to the bare ref.
 */
export function resolveBotAuthorIds(
  botIdRef: string | undefined,
  bots: Pick<DiscordBotsFile, "waifus"> | undefined
): string[] {
  if (!botIdRef) return [];
  const entry = bots?.waifus.find((bot) => bot.id === botIdRef || bot.applicationId === botIdRef);
  const ids = [botIdRef, entry?.id, entry?.applicationId].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
