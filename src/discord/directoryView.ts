// A static GuildDirectoryView over plain arrays (spec 8.1), for tests and tools. The runtime uses
// the event-maintained GuildDirectory (guildDirectory.ts, spec 9.4), which replaced the Phase 4
// `loadGuildDirectoryView` file adapter that lived here.

import type { GuildEmojiCacheEntry, GuildMemberCacheEntry, GuildRoleCacheEntry } from "../shared/schemas/domain.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";

export type DirectoryCaches = {
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  roles?: GuildRoleCacheEntry[];
};

export function memberDisplayName(member: GuildMemberCacheEntry): string | undefined {
  return member.guildDisplayName || member.globalDisplayName || member.username || undefined;
}

export class CachedGuildDirectoryView implements GuildDirectoryView {
  private readonly members: Map<string, GuildMemberCacheEntry>;
  private readonly roles: Map<string, GuildRoleCacheEntry>;
  private readonly emojis: Map<string, GuildEmojiCacheEntry>;

  constructor(
    caches: DirectoryCaches,
    private readonly channelLookup?: (channelId: string) => string | undefined
  ) {
    this.members = new Map((caches.members ?? []).map((m) => [m.userId, m]));
    this.roles = new Map((caches.roles ?? []).map((r) => [r.id, r]));
    this.emojis = new Map((caches.emojis ?? []).map((e) => [e.id, e]));
  }

  memberName(userId: string): string | undefined {
    const member = this.members.get(userId);
    return member ? memberDisplayName(member) : undefined;
  }

  roleName(id: string): string | undefined {
    return this.roles.get(id)?.name;
  }

  channelName(id: string): string | undefined {
    return this.channelLookup?.(id);
  }

  /** The emoji's current name when it is known and usable; unknown → caller renders `:name:`. */
  emoji(id: string): string | undefined {
    const emoji = this.emojis.get(id);
    return emoji && emoji.available ? emoji.name : undefined;
  }
}
