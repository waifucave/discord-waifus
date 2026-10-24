// GuildDirectory (spec 9.4): the in-memory, event-maintained directory of a guild's members, roles,
// channels/threads and emojis. It replaces the Phase 4 `loadGuildDirectoryView` adapter, which
// re-read members/emojis/roles.json on every pass.
//
//   Roles      GUILD_CREATE snapshot, then roleCreate/Update/Delete
//   Emojis     GUILD_CREATE snapshot, then emoji events (non-privileged GuildExpressions intent)
//   Channels   GUILD_CREATE snapshot, then channel*/thread* events
//   Members    members.json + the author/mentions of every message the cache ingests; an unresolved
//              `<@id>` mention triggers one member fetch (10 min negative cache, <= 5 per call,
//              <= 1.5 s wait); the full list is refreshed every `discord.memberListRefreshHours`
//              while the list endpoint works (403 -> `member_list_unavailable`); the privileged
//              GuildMembers intent (`discord.guildMembersIntent`, opt-in) adds member events.
//
// State is lazily loaded from the three JSON files and written through (debounced, 5 s). All
// REST goes through a `DirectoryTransport`, by default the discord.js REST client with the bot
// token from `user/discord-bots.json`, so the same code serves the live runtime and the
// dashboard's manual refresh buttons (`GuildDirectory.refresh`).

import { DiscordAPIError, HTTPError, Routes } from "discord.js";
import type { Logger } from "../backend/logger.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import {
  createEmptyRevisionedFile,
  DiscordBotsFileSchema,
  GuildEmojisFileSchema,
  GuildMembersFileSchema,
  GuildRolesFileSchema,
  type DiscordBotConfig,
  type GuildEmojiCacheEntry,
  type GuildMemberCacheEntry,
  type GuildRoleCacheEntry
} from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import { memberDisplayName } from "./directoryView.js";
import type { DiscordChannelEntry, DiscordDirectoryEvent } from "./gatewayEvents.js";
import { mergeConfiguredBotsIntoMembers } from "./memberCache.js";
import { discordRestForToken, fetchAllDiscordGuildMembers, fetchDiscordGuildRoles, type DiscordGuildMemberPayload, type DiscordGuildRolePayload } from "./rest.js";
import type { CacheDirectoryHooks } from "./conversationCache.js";

export type DirectoryKind = "members" | "roles" | "emojis";

/** REST access the directory needs; one implementation over discord.js REST, fakes in tests. */
export interface DirectoryTransport {
  /** null = the user is not a member of the guild (Unknown Member / Unknown User). */
  fetchMember(guildId: string, userId: string): Promise<GuildMemberCacheEntry | null>;
  /** Throws MemberListUnavailableError when Discord answers 403 (privileged intent not granted). */
  listMembers(guildId: string): Promise<GuildMemberCacheEntry[]>;
  listRoles(guildId: string): Promise<GuildRoleCacheEntry[]>;
  listEmojis(guildId: string): Promise<GuildEmojiCacheEntry[]>;
}

export class DirectoryTransportError extends Error {
  constructor(message: string, readonly status: number | undefined, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectoryTransportError";
  }
}

/** `GET /guilds/:id/members` answered 403: the application lacks the Server Members intent. */
export class MemberListUnavailableError extends DirectoryTransportError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 403, options);
    this.name = "MemberListUnavailableError";
  }
}

export const MEMBER_LIST_UNAVAILABLE = "member_list_unavailable";

export type DirectoryStatus = {
  /** true when some guild's member list endpoint works, false when every attempt got a 403, null = not attempted yet. */
  memberListAvailable: boolean | null;
  /** ISO time of the last successful member list refresh, null when none happened since boot. */
  lastRefreshAt: string | null;
  /** Machine-readable warnings (`member_list_unavailable`). */
  warnings: string[];
};

export type DirectoryRefreshResult = { accepted: boolean; message: string; count?: number };

export type GuildDirectoryOptions = {
  storage: StorageService;
  logger: Logger;
  /** Defaults to the discord.js REST client with the stored bot token; undefined = no token. */
  transport?: () => Promise<DirectoryTransport | undefined>;
  /** Live settings (the dashboard can change them without a restart). */
  settings?: () => { memberListRefreshHours: number };
  /** Configured bots, merged into the member list so their names always resolve. */
  bots?: () => Promise<{ orchestrator?: DiscordBotConfig | null; waifus?: DiscordBotConfig[] } | undefined>;
  now?: () => number;
  /** Write-through debounce (default 5 s). */
  flushDelayMs?: number;
  /** Maintenance tick that drives the periodic member list refresh (default 15 min). */
  maintenanceIntervalMs?: number;
  mentionFetchLimit?: number;
  mentionWaitMs?: number;
  negativeCacheMs?: number;
};

const DEFAULT_FLUSH_DELAY_MS = 5_000;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_MENTION_FETCH_LIMIT = 5;
const DEFAULT_MENTION_WAIT_MS = 1_500;
const DEFAULT_NEGATIVE_CACHE_MS = 10 * 60 * 1000;
/** A failed (not "unknown member") fetch is retried sooner than a definitive 404. */
const TRANSIENT_NEGATIVE_CACHE_MS = 60 * 1000;
const USER_MENTION_RE = /<@!?(\d+)>/g;

type GuildState = {
  guildId: string;
  name?: string;
  members: Map<string, GuildMemberCacheEntry>;
  /** Member ids that exist only because a configured bot was merged in (never persisted). */
  syntheticMembers: Set<string>;
  roles: Map<string, GuildRoleCacheEntry>;
  emojis: Map<string, GuildEmojiCacheEntry>;
  channels: Map<string, DiscordChannelEntry>;
  negative: Map<string, number>;
  pendingMemberFetches: Map<string, Promise<void>>;
  dirty: Set<DirectoryKind>;
  flushTimer: NodeJS.Timeout | undefined;
  ready: boolean;
  loading: Promise<void> | undefined;
  /** Events that arrived before the files were loaded; applied in order afterwards. */
  pendingEvents: DiscordDirectoryEvent[];
  memberListAvailable: boolean | null;
  lastMemberRefreshAt: number | undefined;
  refreshing: Promise<unknown> | undefined;
};

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---- default REST transport ------------------------------------------------------------------

function mapMember(payload: DiscordGuildMemberPayload, nowMs: number): GuildMemberCacheEntry {
  return {
    userId: payload.user.id,
    ...(payload.user.username ? { username: payload.user.username } : {}),
    ...(payload.user.global_name ? { globalDisplayName: payload.user.global_name } : {}),
    guildDisplayName: payload.nick ?? payload.user.global_name ?? payload.user.username,
    bot: payload.user.bot ?? false,
    lastSeenAt: nowIso(nowMs),
    perChannelLastSeenAt: {}
  };
}

export function mapRolePayloads(rawRoles: DiscordGuildRolePayload[], nowMs: number): GuildRoleCacheEntry[] {
  return rawRoles
    .filter((role) => role.name !== "@everyone")
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color ?? 0,
      hoist: role.hoist ?? false,
      mentionable: role.mentionable ?? false,
      managed: role.managed ?? false,
      fetchedAt: nowIso(nowMs)
    }));
}

function wrapRestError(error: unknown): never {
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    throw new DirectoryTransportError(
      `Discord API request failed (${error.status}): ${error.message || "unknown error"}`,
      error.status,
      { cause: error }
    );
  }
  throw error;
}

export function createRestDirectoryTransport(token: string, now: () => number = Date.now): DirectoryTransport {
  const rest = () => discordRestForToken(token);
  return {
    async fetchMember(guildId, userId) {
      try {
        const payload = (await rest().get(Routes.guildMember(guildId, userId))) as DiscordGuildMemberPayload;
        return mapMember(payload, now());
      } catch (error) {
        if (error instanceof DiscordAPIError && error.status === 404) return null;
        return wrapRestError(error);
      }
    },
    async listMembers(guildId) {
      try {
        return (await fetchAllDiscordGuildMembers(rest(), guildId)).map((member) => mapMember(member, now()));
      } catch (error) {
        if (error instanceof DiscordAPIError && error.status === 403) {
          throw new MemberListUnavailableError(
            `Discord refused the member list (403): enable the Server Members intent for this bot (${error.message || "Missing Access"}).`,
            { cause: error }
          );
        }
        return wrapRestError(error);
      }
    },
    async listRoles(guildId) {
      try {
        return mapRolePayloads(await fetchDiscordGuildRoles(rest(), guildId), now());
      } catch (error) {
        return wrapRestError(error);
      }
    },
    async listEmojis(guildId) {
      try {
        const raw = (await rest().get(Routes.guildEmojis(guildId))) as Array<{
          id: string;
          name: string | null;
          animated?: boolean;
          available?: boolean;
          roles?: string[];
        }>;
        return raw
          .filter((emoji) => emoji.name)
          .map((emoji) => ({
            id: emoji.id,
            name: emoji.name ?? "emoji",
            animated: emoji.animated ?? false,
            available: emoji.available ?? true,
            roles: emoji.roles ?? [],
            fetchedAt: nowIso(now())
          }));
      } catch (error) {
        return wrapRestError(error);
      }
    }
  };
}

/** The token the runtime already uses for REST: orchestrator first, else the first usable waifu bot. */
export async function readDiscordBotToken(storage: StorageService): Promise<string | undefined> {
  const bots = await storage.readJson(
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(createEmptyRevisionedFile({ orchestrator: null, waifus: [] }))
  );
  return bots.orchestrator?.enabled === false
    ? bots.waifus.find((bot) => bot.enabled && bot.token)?.token
    : bots.orchestrator?.token ?? bots.waifus.find((bot) => bot.enabled && bot.token)?.token;
}

export function createStorageDirectoryTransport(storage: StorageService): () => Promise<DirectoryTransport | undefined> {
  return async () => {
    const token = await readDiscordBotToken(storage);
    return token ? createRestDirectoryTransport(token) : undefined;
  };
}

// ---- the directory ---------------------------------------------------------------------------

export class GuildDirectory implements CacheDirectoryHooks {
  private readonly guilds = new Map<string, GuildState>();
  private readonly now: () => number;
  private readonly transport: () => Promise<DirectoryTransport | undefined>;
  private readonly settings: () => { memberListRefreshHours: number };
  private maintenanceTimer: NodeJS.Timeout | undefined;
  private detach: (() => void) | undefined;
  private closed = false;

  constructor(private readonly d: GuildDirectoryOptions) {
    this.now = d.now ?? (() => Date.now());
    this.transport = d.transport ?? createStorageDirectoryTransport(d.storage);
    this.settings = d.settings ?? (() => ({ memberListRefreshHours: 24 }));
  }

  // ---- lifecycle ---------------------------------------------------------------------------------

  /**
   * Subscribe to gateway directory events and start the periodic member list refresh. `subscribe`
   * is the facade's `onDirectoryEvent` (absent on fakes: the directory then only knows its files
   * and what messages teach it).
   */
  start(subscribe?: (listener: (event: DiscordDirectoryEvent) => void) => () => void): void {
    this.closed = false;
    if (subscribe && !this.detach) this.detach = subscribe((event) => this.handle(event));
    if (!this.maintenanceTimer) {
      const timer = setInterval(() => {
        void this.runMaintenance().catch((error: unknown) => {
          this.d.logger.warn("Guild directory maintenance failed", { message: error instanceof Error ? error.message : String(error) });
        });
      }, this.d.maintenanceIntervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS);
      timer.unref?.();
      this.maintenanceTimer = timer;
    }
  }

  /** Stop listening and write everything pending. */
  async close(): Promise<void> {
    this.closed = true;
    this.detach?.();
    this.detach = undefined;
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
    await this.flush();
  }

  // ---- views and lookups -------------------------------------------------------------------------

  /** The live directory view of one guild (files loaded first). Cheap to call every pass. */
  async view(guildId: string, fallbackChannelName?: (channelId: string) => string | undefined): Promise<GuildDirectoryView> {
    const state = await this.ensureLoaded(guildId);
    return {
      memberName: (userId) => {
        const member = state.members.get(userId);
        return member ? memberDisplayName(member) : undefined;
      },
      roleName: (id) => state.roles.get(id)?.name,
      channelName: (id) => state.channels.get(id)?.name ?? fallbackChannelName?.(id),
      emoji: (id) => {
        const emoji = state.emojis.get(id);
        return emoji && emoji.available ? emoji.name : undefined;
      }
    };
  }

  memberName(guildId: string, userId: string): string | undefined {
    const member = this.guilds.get(guildId)?.members.get(userId);
    return member ? memberDisplayName(member) : undefined;
  }

  emojiName(guildId: string, emojiId: string): string | undefined {
    return this.guilds.get(guildId)?.emojis.get(emojiId)?.name;
  }

  /** Channel or thread metadata (`parentId`, `kind`) for task C's thread handling. */
  channel(guildId: string, channelId: string): DiscordChannelEntry | undefined {
    return this.guilds.get(guildId)?.channels.get(channelId);
  }

  /** Snapshot for `/api/runtime` `discord.directory`. */
  status(): DirectoryStatus {
    let available: boolean | null = null;
    let lastRefresh: number | undefined;
    for (const state of this.guilds.values()) {
      if (state.memberListAvailable === true) available = true;
      else if (state.memberListAvailable === false && available === null) available = false;
      if (state.lastMemberRefreshAt !== undefined && (lastRefresh === undefined || state.lastMemberRefreshAt > lastRefresh)) {
        lastRefresh = state.lastMemberRefreshAt;
      }
    }
    return {
      memberListAvailable: available,
      lastRefreshAt: lastRefresh === undefined ? null : nowIso(lastRefresh),
      warnings: [...this.guilds.values()].some((state) => state.memberListAvailable === false) ? [MEMBER_LIST_UNAVAILABLE] : []
    };
  }

  // ---- learning from messages ----------------------------------------------------------------------

  observeMessages(guildId: string, messages: readonly RawDiscordMessage[]): void {
    const state = this.state(guildId);
    if (!state.ready) return; // the files are about to load; messages re-teach us within a pass
    for (const message of messages) {
      this.learnMember(state, message.authorId, message.authorName, {
        author: true,
        bot: message.authorIsBot,
        seenAt: message.createdAt,
        channelId: message.channelId
      });
      for (const [userId, name] of Object.entries(message.mentions.users)) this.learnMember(state, userId, name, { author: false });
    }
  }

  private learnMember(
    state: GuildState,
    userId: string,
    name: string,
    o: { author: boolean; bot?: boolean; seenAt?: string; channelId?: string }
  ): void {
    const { seenAt, channelId } = o;
    const existing = state.members.get(userId);
    if (!existing) {
      if (!name) return;
      state.members.set(userId, {
        userId,
        guildDisplayName: name,
        bot: o.bot ?? false,
        ...(seenAt ? { lastSeenAt: seenAt } : {}),
        perChannelLastSeenAt: seenAt && channelId ? { [channelId]: seenAt } : {}
      });
      this.markDirty(state, "members");
      return;
    }
    // Recency stays in memory (it rides along with the next write); only a name change or a new
    // member is worth a file write.
    if (seenAt) {
      state.members.set(userId, {
        ...existing,
        lastSeenAt: seenAt,
        perChannelLastSeenAt: channelId ? { ...existing.perChannelLastSeenAt, [channelId]: seenAt } : existing.perChannelLastSeenAt
      });
    }
    // A message author's name is their current display name in this guild; a mention's is not authoritative.
    if (o.author && name && existing.guildDisplayName !== name && !state.syntheticMembers.has(userId)) {
      state.members.set(userId, { ...state.members.get(userId)!, guildDisplayName: name });
      this.markDirty(state, "members");
    }
  }

  /**
   * Unresolved `<@id>` mentions (not in the payload's mention map, not in the directory) get one
   * member fetch each, at most `mentionFetchLimit` per call, waiting at most `mentionWaitMs`. A
   * definitive "unknown member" is remembered for 10 minutes (negative cache) so the same stale
   * mention in an old message never costs a second request.
   */
  async resolveMentions(guildId: string, messages: readonly RawDiscordMessage[], o: { signal?: AbortSignal } = {}): Promise<void> {
    const state = await this.ensureLoaded(guildId);
    const now = this.now();
    const wanted: string[] = [];
    for (const message of messages) {
      for (const match of message.content.matchAll(USER_MENTION_RE)) {
        const id = match[1]!;
        if (message.mentions.users[id] !== undefined || state.members.has(id) || wanted.includes(id)) continue;
        const until = state.negative.get(id);
        if (until !== undefined && until > now) continue;
        wanted.push(id);
      }
    }
    if (wanted.length === 0) return;
    const transport = await this.transport();
    if (!transport) return;
    const pending = wanted.slice(0, this.d.mentionFetchLimit ?? DEFAULT_MENTION_FETCH_LIMIT).map((id) => this.fetchMember(state, transport, id));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.d.mentionWaitMs ?? DEFAULT_MENTION_WAIT_MS);
      timer.unref?.();
    });
    try {
      // The fetches themselves keep running past the wait and still warm the directory.
      await Promise.race([Promise.allSettled(pending), timeout, abortPromise(o.signal)]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private fetchMember(state: GuildState, transport: DirectoryTransport, userId: string): Promise<void> {
    const inFlight = state.pendingMemberFetches.get(userId);
    if (inFlight) return inFlight;
    const task = (async () => {
      try {
        const member = await transport.fetchMember(state.guildId, userId);
        if (member) {
          state.members.set(userId, { ...state.members.get(userId), ...member });
          state.negative.delete(userId);
          this.markDirty(state, "members");
        } else {
          state.negative.set(userId, this.now() + (this.d.negativeCacheMs ?? DEFAULT_NEGATIVE_CACHE_MS));
        }
      } catch (error) {
        state.negative.set(userId, this.now() + TRANSIENT_NEGATIVE_CACHE_MS);
        this.d.logger.warn("Guild member fetch for an unresolved mention failed", {
          guildId: state.guildId,
          userId,
          message: error instanceof Error ? error.message : String(error)
        });
      } finally {
        state.pendingMemberFetches.delete(userId);
      }
    })();
    state.pendingMemberFetches.set(userId, task);
    return task;
  }

  // ---- gateway events -----------------------------------------------------------------------------

  handle(event: DiscordDirectoryEvent): void {
    if (this.closed) return;
    const state = this.state(event.guildId);
    if (event.type === "guildDelete") {
      void this.flushGuild(state).finally(() => {
        if (this.guilds.get(event.guildId) === state) this.guilds.delete(event.guildId);
      });
      return;
    }
    if (!state.ready) {
      state.pendingEvents.push(event);
      void this.ensureLoaded(event.guildId);
      return;
    }
    this.apply(state, event);
  }

  private apply(state: GuildState, event: DiscordDirectoryEvent): void {
    switch (event.type) {
      case "snapshot": {
        if (event.name) state.name = event.name;
        if (this.replaceById(state.roles, event.roles, (r) => r.id, roleSignature)) this.markDirty(state, "roles");
        if (this.replaceById(state.emojis, event.emojis, (e) => e.id, emojiSignature)) this.markDirty(state, "emojis");
        state.channels = new Map(event.channels.map((channel) => [channel.id, channel]));
        for (const member of event.members) this.upsertMember(state, member);
        return;
      }
      case "roleUpsert":
        if (state.roles.has(event.role.id) && roleSignature(state.roles.get(event.role.id)!) === roleSignature(event.role)) return;
        state.roles.set(event.role.id, event.role);
        this.markDirty(state, "roles");
        return;
      case "roleDelete":
        if (state.roles.delete(event.roleId)) this.markDirty(state, "roles");
        return;
      case "emojiUpsert":
        if (state.emojis.has(event.emoji.id) && emojiSignature(state.emojis.get(event.emoji.id)!) === emojiSignature(event.emoji)) return;
        state.emojis.set(event.emoji.id, event.emoji);
        this.markDirty(state, "emojis");
        return;
      case "emojiDelete":
        if (state.emojis.delete(event.emojiId)) this.markDirty(state, "emojis");
        return;
      case "channelUpsert":
        state.channels.set(event.channel.id, event.channel);
        return;
      case "channelDelete":
        state.channels.delete(event.channelId);
        return;
      case "memberUpsert":
        this.upsertMember(state, event.member);
        return;
      case "memberRemove":
        if (state.members.delete(event.userId)) this.markDirty(state, "members");
        return;
      case "guildDelete":
        return;
    }
  }

  private upsertMember(state: GuildState, member: GuildMemberCacheEntry): void {
    const existing = state.members.get(member.userId);
    const merged: GuildMemberCacheEntry = {
      ...existing,
      ...member,
      perChannelLastSeenAt: { ...existing?.perChannelLastSeenAt, ...member.perChannelLastSeenAt }
    };
    const changed =
      !existing ||
      existing.guildDisplayName !== merged.guildDisplayName ||
      existing.globalDisplayName !== merged.globalDisplayName ||
      existing.username !== merged.username ||
      existing.bot !== merged.bot;
    state.members.set(member.userId, merged);
    state.syntheticMembers.delete(member.userId);
    if (changed) this.markDirty(state, "members");
  }

  private replaceById<T>(target: Map<string, T>, next: readonly T[], idOf: (item: T) => string, signature: (item: T) => string): boolean {
    const before = [...target.values()].map(signature).sort().join("|");
    const after = next.map(signature).sort().join("|");
    target.clear();
    for (const item of next) target.set(idOf(item), item);
    return before !== after;
  }

  // ---- refresh -------------------------------------------------------------------------------------

  /**
   * Replace one kind of data from Discord REST (the dashboard's refresh buttons, the periodic
   * member list refresh) and write it through immediately. The only refresh path.
   */
  async refresh(guildId: string, kind: DirectoryKind): Promise<DirectoryRefreshResult> {
    const state = await this.ensureLoaded(guildId);
    const transport = await this.transport();
    if (!transport) {
      return { accepted: false, message: "Discord bot token is not configured. Save the orchestrator bot first." };
    }
    if (kind === "members") return this.refreshMembers(state, transport);
    if (kind === "roles") {
      const roles = await transport.listRoles(guildId);
      this.replaceById(state.roles, roles, (r) => r.id, roleSignature);
      this.markDirty(state, "roles");
      await this.flushGuild(state);
      return { accepted: true, message: `Fetched ${roles.length} server roles from Discord.`, count: roles.length };
    }
    const emojis = await transport.listEmojis(guildId);
    this.replaceById(state.emojis, emojis, (e) => e.id, emojiSignature);
    this.markDirty(state, "emojis");
    await this.flushGuild(state);
    return { accepted: true, message: `Fetched ${emojis.length} server emojis from Discord.`, count: emojis.length };
  }

  private async refreshMembers(state: GuildState, transport: DirectoryTransport): Promise<DirectoryRefreshResult> {
    if (state.refreshing) await state.refreshing.catch(() => undefined);
    const run = (async () => {
      try {
        const members = await transport.listMembers(state.guildId);
        state.members.clear();
        state.syntheticMembers.clear();
        for (const member of members) state.members.set(member.userId, member);
        await this.mergeBots(state);
        state.memberListAvailable = true;
        state.lastMemberRefreshAt = this.now();
        this.markDirty(state, "members");
        await this.flushGuild(state);
        return { accepted: true, message: `Fetched ${members.length} members from Discord.`, count: members.length };
      } catch (error) {
        if (error instanceof MemberListUnavailableError) {
          if (state.memberListAvailable !== false) {
            this.d.logger.warn("Guild member list is unavailable", { guildId: state.guildId, code: MEMBER_LIST_UNAVAILABLE, message: error.message });
          }
          state.memberListAvailable = false;
        }
        throw error;
      }
    })();
    state.refreshing = run;
    try {
      return await run;
    } finally {
      if (state.refreshing === run) state.refreshing = undefined;
    }
  }

  /**
   * One tick of the periodic refresh: guilds whose member list is due (`memberListRefreshHours`,
   * 0 = off) and still works. A 403 turns the guild off until a manual refresh succeeds.
   */
  async runMaintenance(): Promise<void> {
    const hours = this.settings().memberListRefreshHours;
    if (hours <= 0 || this.closed) return;
    const dueMs = hours * 60 * 60 * 1000;
    for (const state of [...this.guilds.values()]) {
      if (!state.ready || state.memberListAvailable === false) continue;
      if (state.lastMemberRefreshAt !== undefined && this.now() - state.lastMemberRefreshAt < dueMs) continue;
      try {
        await this.refresh(state.guildId, "members");
      } catch (error) {
        if (!(error instanceof MemberListUnavailableError)) {
          this.d.logger.warn("Periodic guild member list refresh failed", {
            guildId: state.guildId,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        // Other failures are retried on the next tick; a 403 is remembered inside refreshMembers.
      }
    }
  }

  // ---- state, loading, write-through ----------------------------------------------------------------

  private state(guildId: string): GuildState {
    let state = this.guilds.get(guildId);
    if (!state) {
      state = {
        guildId,
        members: new Map(),
        syntheticMembers: new Set(),
        roles: new Map(),
        emojis: new Map(),
        channels: new Map(),
        negative: new Map(),
        pendingMemberFetches: new Map(),
        dirty: new Set(),
        flushTimer: undefined,
        ready: false,
        loading: undefined,
        pendingEvents: [],
        memberListAvailable: null,
        lastMemberRefreshAt: undefined,
        refreshing: undefined
      };
      this.guilds.set(guildId, state);
    }
    return state;
  }

  async ensureLoaded(guildId: string): Promise<GuildState> {
    const state = this.state(guildId);
    if (state.ready) return state;
    state.loading ??= this.load(state);
    await state.loading;
    return state;
  }

  private async load(state: GuildState): Promise<void> {
    const read = async <T>(file: string, schema: { parse(v: unknown): T }, pick: (v: T) => unknown[]) => {
      try {
        return pick(await this.d.storage.readJson(`user/servers/${state.guildId}/${file}`, schema as never));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.d.logger.warn("Guild directory file could not be read; starting empty", {
            guildId: state.guildId,
            file,
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return [];
      }
    };
    const [members, emojis, roles] = await Promise.all([
      read("members.json", GuildMembersFileSchema, (v) => v.members),
      read("emojis.json", GuildEmojisFileSchema, (v) => v.emojis),
      read("roles.json", GuildRolesFileSchema, (v) => v.roles)
    ]);
    for (const member of members as GuildMemberCacheEntry[]) state.members.set(member.userId, member);
    for (const emoji of emojis as GuildEmojiCacheEntry[]) state.emojis.set(emoji.id, emoji);
    for (const role of roles as GuildRoleCacheEntry[]) state.roles.set(role.id, role);
    await this.mergeBots(state);
    state.ready = true;
    const pending = state.pendingEvents.splice(0);
    for (const event of pending) this.apply(state, event);
  }

  private async mergeBots(state: GuildState): Promise<void> {
    if (!this.d.bots) return;
    try {
      const bots = await this.d.bots();
      if (!bots) return;
      const before = new Set(state.members.keys());
      for (const member of mergeConfiguredBotsIntoMembers([...state.members.values()], bots)) {
        if (before.has(member.userId)) continue;
        state.members.set(member.userId, member);
        state.syntheticMembers.add(member.userId);
      }
    } catch (error) {
      this.d.logger.warn("Could not merge configured bots into the guild directory", {
        guildId: state.guildId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private markDirty(state: GuildState, kind: DirectoryKind): void {
    state.dirty.add(kind);
    if (state.flushTimer || this.closed) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = undefined;
      void this.flushGuild(state).catch((error: unknown) => {
        this.d.logger.warn("Guild directory write failed", { guildId: state.guildId, message: error instanceof Error ? error.message : String(error) });
      });
    }, this.d.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
    state.flushTimer.unref?.();
  }

  /** Write every pending kind of one guild (or of all guilds) now. */
  async flush(guildId?: string): Promise<void> {
    const states = guildId ? [this.guilds.get(guildId)] : [...this.guilds.values()];
    await Promise.all(states.map((state) => (state ? this.flushGuild(state) : undefined)));
  }

  private async flushGuild(state: GuildState): Promise<void> {
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    const kinds = [...state.dirty];
    state.dirty.clear();
    const { storage } = this.d;
    const guildId = state.guildId;
    try {
      await Promise.all(
        kinds.map((kind) => {
          const base = { resourceKey: `${kind}:${guildId}` };
          if (kind === "members") {
            const members = [...state.members.values()].filter((m) => !state.syntheticMembers.has(m.userId));
            return storage.updateRevisionedJson({
              ...base,
              relativePath: `user/servers/${guildId}/members.json`,
              schema: GuildMembersFileSchema,
              fallback: GuildMembersFileSchema.parse(createEmptyRevisionedFile({ guildId, members: [] })),
              transform: (current) => ({ ...current, guildId, members })
            });
          }
          if (kind === "roles") {
            const roles = [...state.roles.values()];
            return storage.updateRevisionedJson({
              ...base,
              relativePath: `user/servers/${guildId}/roles.json`,
              schema: GuildRolesFileSchema,
              fallback: GuildRolesFileSchema.parse(createEmptyRevisionedFile({ guildId, roles: [] })),
              transform: (current) => ({ ...current, guildId, roles })
            });
          }
          const emojis = [...state.emojis.values()];
          return storage.updateRevisionedJson({
            ...base,
            relativePath: `user/servers/${guildId}/emojis.json`,
            schema: GuildEmojisFileSchema,
            fallback: GuildEmojisFileSchema.parse(createEmptyRevisionedFile({ guildId, emojis: [] })),
            transform: (current) => ({ ...current, guildId, emojis })
          });
        })
      );
    } catch (error) {
      for (const kind of kinds) state.dirty.add(kind); // retry on the next change
      throw error;
    }
  }
}

function roleSignature(role: GuildRoleCacheEntry): string {
  return `${role.id}:${role.name}:${role.color}:${role.hoist}:${role.mentionable}:${role.managed}`;
}

function emojiSignature(emoji: GuildEmojiCacheEntry): string {
  return `${emoji.id}:${emoji.name}:${emoji.animated}:${emoji.available}:${emoji.roles.join(",")}`;
}

function abortPromise(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}
