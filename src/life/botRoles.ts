// The roles each waifu bot holds per guild (Living cast spec §4.1 `role`, §10.2): fetched once per
// guild with a single-member REST fetch of the bot's own member (no privileged intent), refreshed
// every `discord.memberListRefreshHours` and dropped on role update/delete events (and when one of
// our bots' members changes), so the next lookup fetches again.

import type { DiscordGatewayFacade } from "../discord/client.js";

type Entry = { roles: ReadonlySet<string>; at: number };

export class BotRoles {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<ReadonlySet<string>>>();

  constructor(
    private readonly o: { discord: () => DiscordGatewayFacade | undefined; refreshHours: () => number; now?: () => number }
  ) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private key(guildId: string, botId: string): string {
    return `${guildId}:${botId}`;
  }

  /** The bot's role ids in the guild (fetching when unknown or stale; empty when it cannot be read). */
  async roles(guildId: string, botId: string): Promise<ReadonlySet<string>> {
    const key = this.key(guildId, botId);
    const entry = this.entries.get(key);
    const hours = this.o.refreshHours();
    const stale = entry && hours > 0 && this.now() - entry.at > hours * 3_600_000;
    if (entry && !stale) return entry.roles;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const load = (async () => {
      try {
        const roles = await this.o.discord()?.fetchBotMemberRoles?.({ botId, guildId });
        if (roles === undefined) return entry?.roles ?? new Set<string>();
        const set = new Set(roles);
        this.entries.set(key, { roles: set, at: this.now() });
        return set;
      } catch {
        return entry?.roles ?? new Set<string>();
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, load);
    return load;
  }

  /** Drop what is known for a guild (role update/delete) or everything. */
  invalidate(guildId?: string): void {
    if (!guildId) {
      this.entries.clear();
      return;
    }
    for (const key of [...this.entries.keys()]) if (key.startsWith(`${guildId}:`)) this.entries.delete(key);
  }
}
