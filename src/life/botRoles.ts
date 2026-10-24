// The roles each waifu bot holds per guild (Living cast spec §4.1 `role`, §10.2): fetched once per
// guild with a single-member REST fetch of the bot's own member (no privileged intent), refreshed
// every `discord.memberListRefreshHours`, replaced from the bot's own member updates (Discord sends
// those to every bot without the members intent) and dropped on role update/delete events, so the
// next lookup fetches again. A fetch that fails is remembered for a minute (review M10): a bot that
// cannot read its member is not refetched for every message.

import type { DiscordGatewayFacade } from "../discord/client.js";

type Entry = { roles: ReadonlySet<string>; at: number; failed?: boolean };

/** How long a failed fetch is remembered before the next lookup tries again. */
export const FAILED_FETCH_RETRY_MS = 60_000;

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

  private stale(entry: Entry): boolean {
    const age = this.now() - entry.at;
    if (entry.failed) return age > FAILED_FETCH_RETRY_MS;
    const hours = this.o.refreshHours();
    return hours > 0 && age > hours * 3_600_000;
  }

  /** The bot's role ids in the guild (fetching when unknown or stale; empty when it cannot be read). */
  async roles(guildId: string, botId: string): Promise<ReadonlySet<string>> {
    const key = this.key(guildId, botId);
    const entry = this.entries.get(key);
    if (entry && !this.stale(entry)) return entry.roles;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const failed = () => {
      const roles = entry?.roles ?? new Set<string>();
      this.entries.set(key, { roles, at: this.now(), failed: true });
      return roles;
    };
    const load = (async () => {
      try {
        const roles = await this.o.discord()?.fetchBotMemberRoles?.({ botId, guildId });
        if (roles === undefined) return failed();
        const set = new Set(roles);
        this.entries.set(key, { roles: set, at: this.now() });
        return set;
      } catch {
        return failed();
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, load);
    return load;
  }

  /** The bot's own member changed (a role added or removed): take its roles as they are now. */
  set(guildId: string, botId: string, roleIds: readonly string[]): void {
    this.entries.set(this.key(guildId, botId), { roles: new Set(roleIds.filter((roleId) => roleId !== guildId)), at: this.now() });
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
