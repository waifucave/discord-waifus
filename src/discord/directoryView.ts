// Phase 4 GuildDirectoryView (spec 8.1): names for mentions/roles/channels/emojis over the
// members/emojis/roles.json caches plus a channel-name lookup (the discord.js channel cache).
// Phase 5 replaces it with the in-memory GuildDirectory (spec 9.4).

import {
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  GuildRolesFileSchema,
  type GuildEmojiCacheEntry,
  type GuildMemberCacheEntry,
  type GuildRoleCacheEntry
} from "../shared/schemas/domain.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";
import type { StorageService } from "../storage/storageService.js";

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

/** Load the three per-guild cache files (missing files → empty) into a directory view. */
export async function loadGuildDirectoryView(
  storage: StorageService,
  guildId: string,
  o: { channelName?: (channelId: string) => string | undefined; extraMembers?: GuildMemberCacheEntry[] } = {}
): Promise<GuildDirectoryView> {
  const read = async <T>(file: string, schema: { parse(v: unknown): T }, pick: (v: T) => unknown[]) => {
    try {
      return pick(await storage.readJson(`user/servers/${guildId}/${file}`, schema as never));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const [members, emojis, roles] = await Promise.all([
    read("members.json", GuildMembersFileSchema, (v) => v.members),
    read("emojis.json", GuildEmojisFileSchema, (v) => v.emojis),
    read("roles.json", GuildRolesFileSchema, (v) => v.roles)
  ]);
  return new CachedGuildDirectoryView(
    {
      members: [...(members as GuildMemberCacheEntry[]), ...(o.extraMembers ?? [])],
      emojis: emojis as GuildEmojiCacheEntry[],
      roles: roles as GuildRoleCacheEntry[]
    },
    o.channelName
  );
}
