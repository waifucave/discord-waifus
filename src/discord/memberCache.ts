import { DiscordBotConfig, GuildMemberCacheEntry, GuildRoleCacheEntry } from "../shared/schemas/domain.js";

const USER_MENTION_ID_RE = /<@!?(\d+)>/g;
const ROLE_MENTION_ID_RE = /<@&(\d+)>/g;
const SNOWFLAKE_RE = /^\d{17,20}$/;

export function unresolvedMentionIds(
  contents: string[],
  members: GuildMemberCacheEntry[],
  options: { roleIds?: string[] } = {}
): string[] {
  const missing = unresolvedMentionIdsByType(contents, members, roleIdsToEntries(options.roleIds ?? []));
  return [...missing.userIds, ...missing.roleIds];
}

export function unresolvedMentionIdsByType(
  contents: string[],
  members: GuildMemberCacheEntry[],
  roles: Array<Pick<GuildRoleCacheEntry, "id">>
): { userIds: string[]; roleIds: string[] } {
  const knownIds = new Set(members.map((member) => member.userId));
  const knownRoleIds = new Set(roles.map((role) => role.id));
  const missingUserIds = new Set<string>();
  const missingRoleIds = new Set<string>();
  for (const content of contents) {
    collectMissingIds(content, USER_MENTION_ID_RE, knownIds, missingUserIds);
    collectMissingIds(content, ROLE_MENTION_ID_RE, knownRoleIds, missingRoleIds);
  }
  return {
    userIds: [...missingUserIds],
    roleIds: [...missingRoleIds]
  };
}

export function mergeConfiguredBotsIntoMembers(
  members: GuildMemberCacheEntry[],
  bots: {
    orchestrator?: DiscordBotConfig | null;
    waifus?: DiscordBotConfig[];
  }
): GuildMemberCacheEntry[] {
  const byId = new Map(members.map((member) => [member.userId, member]));
  for (const bot of [bots.orchestrator, ...(bots.waifus ?? [])]) {
    if (!bot) continue;
    const ids = [bot.applicationId, bot.id].filter((id): id is string => Boolean(id && SNOWFLAKE_RE.test(id)));
    for (const id of ids) {
      if (byId.has(id)) continue;
      byId.set(id, {
        userId: id,
        username: bot.id,
        globalDisplayName: bot.displayName,
        guildDisplayName: bot.displayName,
        bot: true,
        perChannelLastSeenAt: {}
      });
    }
  }
  return [...byId.values()];
}

function roleIdsToEntries(roleIds: string[]): Array<Pick<GuildRoleCacheEntry, "id">> {
  return roleIds.map((id) => ({ id }));
}

function collectMissingIds(
  content: string,
  pattern: RegExp,
  knownIds: Set<string>,
  missing: Set<string>
): void {
  pattern.lastIndex = 0;
  for (const match of content.matchAll(pattern)) {
    const id = match[1];
    if (id && !knownIds.has(id)) {
      missing.add(id);
    }
  }
}
