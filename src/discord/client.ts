import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationIntegrationType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  InteractionContextType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Options,
  Partials,
  PermissionFlagsBits
} from "discord.js";
import type { AutocompleteInteraction, ChatInputCommandInteraction, ClientOptions } from "discord.js";
import { Logger } from "../backend/logger.js";
import { ContextMessage } from "../orchestration/contextMessages.js";
import {
  DiscordBotConfig,
  GuildEmojiCacheEntry,
  GuildMemberCacheEntry,
  GuildRoleCacheEntry
} from "../shared/schemas/domain.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { ThreadKind } from "../shared/schemas/threads.js";
import { buildNormalizedDiscordContext } from "./contextBuilder.js";
import { unresolvedMentionIdsByType } from "./memberCache.js";
import { denormalizeModelContentForDiscord } from "./normalization.js";
import { compareIds, pageMessagesSince, toRawDiscordMessage, withoutAuthors, type DiscordMessageLike } from "./rawMessage.js";
import type { ConversationRef } from "../orchestration/context/keys.js";
import { attachGatewayFeed, guildSnapshotEvent } from "./gatewayFeed.js";
import { ApplicationOwners, ownerIdsOf, type ApplicationOwnerLike, type OwnerCheck } from "./applicationOwners.js";
import type {
  DiscordConnectionScope,
  DiscordConversationEvent,
  DiscordConversationEventListener,
  DiscordDirectoryEvent,
  DiscordDirectoryEventListener
} from "./gatewayEvents.js";

export type DiscordRuntimeStatus = {
  connected: boolean;
  houseConnected: boolean;
  waifuBotCount: number;
  warnings: string[];
  connecting?: boolean;
  retrying?: boolean;
  retryAttempt?: number;
  nextRetryAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  /** Per-bot connection outcome, so one bad token is visible without taking the others down. */
  bots?: DiscordBotConnectionStatus[];
};

export type DiscordBotKind = "house" | "waifu";
export type DiscordBotConnectionState = "connected" | "connecting" | "error" | "disabled" | "missing_token";
export type DiscordBotConnectionErrorCode =
  | "invalid_token"
  | "disallowed_intents"
  | "invalid_intents"
  | "gateway_rejected"
  | "network"
  | "house_unavailable"
  | "unknown";

export type DiscordBotConnectionStatus = {
  botId: string;
  displayName: string;
  kind: DiscordBotKind;
  state: DiscordBotConnectionState;
  errorCode?: DiscordBotConnectionErrorCode;
  error?: string;
  /** Gateway close code when Discord ended the session for good (e.g. 4004, 4014). */
  closeCode?: number;
  nextRetryAt?: string;
  updatedAt: string;
};

/**
 * Thrown by `connect()` when the House bot cannot come online. The House bot owns message
 * intake, slash commands and context fetches, so waifu clients are torn down too; `status` still
 * carries every bot's outcome for the status API.
 */
export class DiscordConnectError extends Error {
  readonly code?: string;

  constructor(message: string, readonly status: DiscordRuntimeStatus, cause?: unknown) {
    super(message, { cause });
    this.name = "DiscordConnectError";
    const causeCode = cause && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
    if (typeof causeCode === "string") this.code = causeCode;
  }
}

export type DiscordRuntimeIssue = {
  source: "client-error" | "shard-error" | "shard-disconnect" | "invalidated" | "warn";
  message: string;
  botId?: string;
  shardId?: number;
  code?: string | number;
  wasClean?: boolean;
  error?: unknown;
};

export interface DiscordGatewayFacade {
  connect(): Promise<DiscordRuntimeStatus>;
  disconnect(): Promise<void>;
  onMessage?(listener: DiscordMessageListener): () => void;
  /** Spec 9.5: a thread or forum post was created, changed (archived, locked, renamed) or deleted. */
  onThreadChange?(listener: DiscordThreadListener): () => void;
  /** Best-effort: join a (public) thread so its messages are delivered. */
  joinThread?(input: { guildId: string; threadId: string }): Promise<void>;
  /** Living cast §10.4: the owner's `/wake <waifu> [note]` (House bot, guild). */
  onWakeCommand?(listener: DiscordWakeCommandListener): () => void;
  /** Living cast §10.4: the owner's `/print system_prompt|notes|life <waifu>` (ephemeral). */
  onPrintCommand?(listener: DiscordPrintCommandListener): () => void;
  /** The `waifu` option of `/wake` and `/print`. */
  onWaifuAutocomplete?(listener: DiscordWaifuAutocompleteListener): () => void;
  /**
   * Phase 5 caches (spec 9.4): gateway events as plain data. Conversation events carry messages,
   * reactions and connection state (trust); own sends are published before sendWaifuMessage returns.
   * Fakes without them leave the ConversationMessageCache permanently untrusted (always REST).
   */
  onConversationEvent?(listener: DiscordConversationEventListener): () => void;
  /**
   * Roles, emojis, channels, threads and (opt-in intent) members, for the GuildDirectory. A late
   * subscriber is replayed a snapshot of every guild the connected House bot already sees.
   */
  onDirectoryEvent?(listener: DiscordDirectoryEventListener): () => void;
  /** Discord user ids of our own bots (the House bot and waifus): their messages are "own" sends. */
  ownAuthorIds?(): string[];
  /**
   * DM transport (spec 9.1): a waifu bot's DM channel with one user, same contract as
   * fetchContextSince. Fakes without it make the cache return an empty, fully-reached result.
   */
  fetchDmContextSince?(input: {
    waifuId: string;
    userId: string;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }>;
  /** Spec 9.1: a human's DM to a DM-eligible waifu bot (group DMs, bots and self are dropped). */
  onDirectMessage?(listener: DiscordDirectMessageListener): () => void;
  /** Spec 9.1.5: a confirmed DM `/forget`; the listener returns the text shown to the user. */
  onDmForgetCommand?(listener: DiscordDmForgetCommandListener): () => void;
  sendDirectMessage?(input: {
    waifuId: string;
    userId: string;
    content: string;
    replyToMessageId?: string;
    /** Called with the final content just before it is sent. */
    onFinalContent?: (content: string) => void | Promise<void>;
  }): Promise<{ messageId: string }>;
  sendDirectTyping?(input: { waifuId: string; userId: string }): Promise<void>;
  /**
   * Living cast §6.2: up to `limit` messages older than `beforeId` (oldest first), read with the House
   * bot (guild channels) or the waifu's own bot (DMs). The conversation cache's `readPage` uses it for
   * older pages.
   */
  fetchMessagesBefore?(input: { conversation: ConversationRef; beforeId: string; limit: number; signal?: AbortSignal }): Promise<RawDiscordMessage[]>;
  /** Living cast §6.4: a reaction from the waifu's own bot (guild channel or her DM with the user). */
  addReaction?(input: { waifuId: string; botId: string; conversation: ConversationRef; messageId: string; emoji: string }): Promise<void>;
  /** Living cast §10.2: the role ids of a waifu bot's own member in a guild (single-member fetch). */
  fetchBotMemberRoles?(input: { botId: string; guildId: string }): Promise<string[] | undefined>;
  /**
   * Living cast §10.2: a bot's own guild member changed (Discord sends the current user's member
   * updates without the members intent); `roleIds` excludes `@everyone`.
   */
  onBotRolesChange?(listener: (event: { botId: string; guildId: string; roleIds: string[] }) => void): () => void;
  /**
   * Intents are fixed at login: after a waifu write that changes `dm.allowDms`, `botId` or
   * `enabled`, re-log only the bots whose DM intents changed (spec 9.1).
   */
  reconcileDmIntents?(): Promise<{ relogged: string[] }>;
  /** Per waifu bot: the waifu whose DMs it carries and whether its live session has DM intents. */
  dmIntentStatus?(): DiscordDmIntentStatus[];
  listGuilds?(): Promise<Array<{ guildId: string; name: string }>>;
  fetchChannelMetadata?(input: {
    guildId: string;
    channelId: string;
  }): Promise<DiscordChannelMetadata>;
  fetchFreshContext(input: {
    guildId: string;
    channelId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ContextMessage[]>;
  /**
   * Phase 4 context engine (spec 8.3): raw messages newer than `afterMessageId` (null = newest
   * `maxMessages`), one record per Discord message, oldest-first; pages `before` in batches of
   * 100. Fakes without it fall back to fetchFreshContext + cursor filter (conversationSource.ts).
   */
  fetchContextSince?(input: {
    guildId: string;
    channelId: string;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }>;
  sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
    /** Called with the final content (mentions and emoji resolved) just before it is sent. */
    onFinalContent?: (content: string) => void | Promise<void>;
  }): Promise<{ messageId: string }>;
  sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void>;
}

/** What the gateway knows about a thread or forum post a message lives in (spec 9.5). */
export type DiscordThreadInfo = {
  parentId: string;
  name: string;
  kind: ThreadKind;
  archived: boolean;
  locked: boolean;
};

export type DiscordMessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorDisplayName?: string;
  authorBot: boolean;
  /** Set when `channelId` is a thread or forum post (its parent is `thread.parentId`). */
  thread?: DiscordThreadInfo;
};

export type DiscordMessageListener = (event: DiscordMessageEvent) => void | Promise<void>;

export type DiscordDirectMessageEvent = {
  waifuId: string;
  botId: string;
  userId: string;
  userDisplayName?: string;
  channelId: string;
  messageId: string;
  createdAt: string;
};
export type DiscordDirectMessageListener = (event: DiscordDirectMessageEvent) => void | Promise<void>;

export type DiscordDmForgetScope = "conversation" | "everything";
export type DiscordDmForgetCommandEvent = { waifuId: string; botId: string; userId: string; scope: DiscordDmForgetScope };
export type DiscordDmForgetCommandListener = (event: DiscordDmForgetCommandEvent) => Promise<string>;

export type DiscordDmIntentStatus = {
  botId: string;
  /** The waifu this bot should carry DMs for (eligibility), if any. */
  waifuId?: string;
  /** The live session was logged in with the DM intents. */
  intentActive: boolean;
  connected: boolean;
};

export type DiscordThreadEvent = {
  change: "create" | "update" | "delete";
  guildId: string;
  threadId: string;
  thread: DiscordThreadInfo;
  /** For `update`: the state before (when Discord had it cached). */
  previous?: Pick<DiscordThreadInfo, "archived" | "locked" | "name">;
};
export type DiscordThreadListener = (event: DiscordThreadEvent) => void | Promise<void>;

export type DiscordSlashCommandEvent = {
  guildId: string;
  channelId: string;
  userId: string;
  respond: (content: string) => Promise<void>;
};

export type DiscordAutocompleteChoice = {
  name: string;
  value: string;
};
export type DiscordWakeCommandEvent = DiscordSlashCommandEvent & {
  waifuId?: string;
  note?: string;
};
export type DiscordPrintCommandEvent = DiscordSlashCommandEvent & {
  type?: DiscordPrintCommandType;
  waifuId?: string;
  /** `private: true`: show DM content too (it is redacted by default, §10.4, D14). */
  private?: boolean;
};
export type DiscordWaifuAutocompleteEvent = {
  /** `wake` offers this server's cast only; `print` offers every waifu. */
  commandName?: string;
  guildId?: string;
  channelId?: string;
  focusedValue: string;
  respond: (choices: DiscordAutocompleteChoice[]) => Promise<void>;
};
export type DiscordWakeCommandListener = (event: DiscordWakeCommandEvent) => void | Promise<void>;
export type DiscordPrintCommandListener = (event: DiscordPrintCommandEvent) => void | Promise<void>;
export type DiscordWaifuAutocompleteListener = (event: DiscordWaifuAutocompleteEvent) => void | Promise<void>;

export type DiscordPrintCommandType = "system_prompt" | "notes" | "life";

export type DiscordChannelMetadata = {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  /** Set when the channel is a thread or forum post (spec 9.5). */
  thread?: DiscordThreadInfo;
};

type DiscordCache = {
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  roles?: GuildRoleCacheEntry[];
};

export type DiscordJsGatewayOptions = {
  house: DiscordBotConfig;
  waifus?: DiscordBotConfig[];
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  /**
   * Opt-in privileged GuildMembers intent (`discord.guildMembersIntent`, O7): member events keep
   * the directory fresh. Needs the toggle in the Discord developer portal, else login is
   * rejected with `disallowed_intents`.
   */
  guildMembersIntent?: boolean;
  cacheForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshMembersForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshRolesForGuild?: (guildId: string) => Promise<DiscordCache>;
  onRuntimeIssue?: (issue: DiscordRuntimeIssue) => void | Promise<void>;
  /** Called with the full status whenever a bot's connection changes after `connect()` returned. */
  onStatusChange?: (status: DiscordRuntimeStatus) => void | Promise<void>;
  /** Backoff for re-logging a waifu bot whose login failed on a network error. */
  botRetryDelaysMs?: number[];
  /**
   * DM-eligible (bot, waifu) pairs (spec 9.1), read at connect and by reconcileDmIntents. Bots in
   * this list log in with the DM intents; every other waifu bot keeps `[Guilds]`.
   */
  dmBots?: () => Promise<Array<{ botId: string; waifuId: string }>>;
  /** Test seam: build the discord.js client for a bot. */
  createClient?: (input: { bot: DiscordBotConfig; kind: DiscordBotKind; options: ClientOptions }) => Client;
  /** Test seam: who owns the application (default: fetched from Discord by the House bot). */
  applicationOwners?: OwnerCheck & { start?(): void; stop?(): void };
  logger?: Logger;
};

type ConnectableBot = {
  bot: DiscordBotConfig;
  kind: DiscordBotKind;
  token: string;
};

export const GUILD_MEMBERS_INTENT_REJECTED = "guild_members_intent_rejected";
const GUILD_MEMBERS_INTENT_REJECTED_MESSAGE =
  "Discord rejected the Server Members intent, so the bot connected without it. Enable it in the Developer Portal or turn off discord.guildMembersIntent.";

export class DiscordJsGateway implements DiscordGatewayFacade {
  private readonly clients = new Map<string, Client>();
  private readonly pendingClients = new Set<Client>();
  private readonly botStatuses = new Map<string, DiscordBotConnectionStatus>();
  private readonly botRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly botRetryAttempts = new Map<string, number>();
  // Bumped by every disconnect so logins that finish afterwards are destroyed instead of adopted.
  private generation = 0;
  private connectAbort = new AbortController();
  // Discord refused the privileged GuildMembers intent: connected without it (M6).
  private membersIntentRejected = false;
  private readonly listeners = new Set<DiscordMessageListener>();
  private readonly threadListeners = new Set<DiscordThreadListener>();
  private readonly conversationListeners = new Set<DiscordConversationEventListener>();
  private readonly directoryListeners = new Set<DiscordDirectoryEventListener>();
  private readonly botRolesListeners = new Set<(event: { botId: string; guildId: string; roleIds: string[] }) => void>();
  private readonly wakeListeners = new Set<DiscordWakeCommandListener>();
  private readonly printListeners = new Set<DiscordPrintCommandListener>();
  private readonly waifuAutocompleteListeners = new Set<DiscordWaifuAutocompleteListener>();
  private readonly recentMentionRefreshes = new Map<string, number>();
  // Living cast §10.4 (D-a): the application's owner or team members run /wake and /print.
  private readonly owners: OwnerCheck & { start?(): void; stop?(): void };
  // DMs (spec 9.1): wanted (bot → waifu, from eligibility) and what each live client was built with.
  private dmWaifuByBot = new Map<string, string>();
  private readonly clientDmWaifu = new Map<string, string>();
  private readonly dmChannels = new Map<string, string>(); // `${botId}:${userId}` → DM channel id
  private readonly dmListeners = new Set<DiscordDirectMessageListener>();
  private readonly dmForgetListeners = new Set<DiscordDmForgetCommandListener>();

  constructor(private readonly options: DiscordJsGatewayOptions) {
    this.owners =
      options.applicationOwners ??
      new ApplicationOwners({
        fetch: async () => {
          const application = await this.houseClient().application?.fetch();
          return ownerIdsOf(application?.owner as ApplicationOwnerLike);
        },
        ...(options.logger ? { logger: options.logger } : {})
      });
  }

  private async refreshDmBots(): Promise<void> {
    if (!this.options.dmBots) return;
    try {
      const pairs = await this.options.dmBots();
      this.dmWaifuByBot = new Map(pairs.map((pair) => [pair.botId, pair.waifuId]));
    } catch (error) {
      this.options.logger?.warn("Could not resolve DM-eligible bots; keeping the previous set", {
        message: errorMessage(error)
      });
    }
  }

  async connect(): Promise<DiscordRuntimeStatus> {
    this.membersIntentRejected = false; // the portal setting may have changed since the last attempt
    await this.refreshDmBots();
    const generation = this.generation;
    const signal = this.connectAbort.signal;
    this.botStatuses.clear();
    const connectable: ConnectableBot[] = [];
    for (const { bot, kind } of this.configuredBots()) {
      if (bot.enabled === false) {
        this.setBotStatus(bot, kind, { state: "disabled" });
      } else if (!bot.token) {
        this.setBotStatus(bot, kind, { state: "missing_token" });
      } else {
        connectable.push({ bot, kind, token: bot.token });
      }
    }
    // Each bot logs in on its own: one bad token must not take the healthy bots offline.
    const results = await Promise.allSettled(
      connectable.map((entry) => this.connectBot(entry, generation, signal))
    );
    if (generation !== this.generation) {
      throw new DiscordConnectError("Discord connection was cancelled by a disconnect.", this.status());
    }
    const houseId = this.options.house.id;
    if (!this.clients.has(houseId)) {
      // Without the House bot nothing reads channels or answers commands, so connected waifus
      // would only be idle sessions. Take everything down and let the caller decide on a retry.
      const index = connectable.findIndex((entry) => entry.bot.id === houseId);
      const result = index >= 0 ? results[index] : undefined;
      const cause = result?.status === "rejected" ? result.reason : undefined;
      const houseStatus = this.botStatuses.get(houseId);
      const message = cause !== undefined
        ? errorMessage(cause)
        : houseStatus?.state === "disabled"
          ? "The House bot is disabled."
          : "No House bot token is configured.";
      for (const [botId, status] of this.botStatuses) {
        if (botId !== houseId && status.state === "connected") {
          this.botStatuses.set(botId, {
            ...status,
            state: "error",
            errorCode: "house_unavailable",
            error: "Disconnected because the House bot is offline.",
            updatedAt: new Date().toISOString()
          });
        }
      }
      const status = this.status();
      await this.disconnect();
      throw new DiscordConnectError(message, status, cause);
    }
    return this.status();
  }

  async disconnect(): Promise<void> {
    if (this.clients.size > 0) this.emitConversationEvent({ type: "connection", scope: "guild", state: "disconnected" });
    this.generation += 1;
    this.connectAbort.abort();
    this.connectAbort = new AbortController();
    this.owners.stop?.();
    for (const timer of this.botRetryTimers.values()) clearTimeout(timer);
    this.botRetryTimers.clear();
    this.botRetryAttempts.clear();
    const clients = [...this.clients.values(), ...this.pendingClients];
    this.clients.clear();
    this.pendingClients.clear();
    this.clientDmWaifu.clear();
    await Promise.all(clients.map((client) => destroyClientQuietly(client)));
  }

  /** Current connection status, including every configured bot's outcome. */
  status(): DiscordRuntimeStatus {
    const bots = [...this.botStatuses.values()].map((status) => ({ ...status }));
    const warnings: string[] = [];
    if (this.membersIntentRejected) warnings.push(`${GUILD_MEMBERS_INTENT_REJECTED}: ${GUILD_MEMBERS_INTENT_REJECTED_MESSAGE}`);
    if (this.clients.size === 0 && !bots.some((status) => status.state === "error" || status.state === "connecting")) {
      warnings.push("No enabled Discord bot tokens are configured.");
    }
    for (const status of bots) {
      if (status.state === "error") {
        warnings.push(`Discord ${status.kind} bot "${status.displayName}" is offline: ${status.error ?? "unknown error"}`);
      } else if (status.state === "disabled") {
        warnings.push(`Discord ${status.kind} bot "${status.displayName}" is disabled and was not connected.`);
      }
    }
    const latestError = bots
      .filter((status) => status.state === "error" && status.errorCode !== "house_unavailable")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return {
      connected: this.clients.size > 0,
      houseConnected: this.clients.has(this.options.house.id),
      waifuBotCount: (this.options.waifus ?? []).filter((bot) => this.clients.has(bot.id)).length,
      warnings,
      ...(latestError ? { lastError: latestError.error, lastErrorAt: latestError.updatedAt } : {}),
      bots
    };
  }

  private configuredBots(): Array<{ bot: DiscordBotConfig; kind: DiscordBotKind }> {
    return [
      { bot: this.options.house, kind: "house" as const },
      ...(this.options.waifus ?? [])
        .filter((bot) => bot.id !== this.options.house.id)
        .map((bot) => ({ bot, kind: "waifu" as const }))
    ];
  }

  private async connectBot(entry: ConnectableBot, generation: number, signal: AbortSignal): Promise<void> {
    const { bot, kind, token } = entry;
    this.setBotStatus(bot, kind, { state: "connecting" });
    const client = this.createClient(bot, kind);
    this.pendingClients.add(client);
    try {
      await loginAndWaitUntilReady(client, token, signal);
    } catch (error) {
      this.pendingClients.delete(client);
      await destroyClientQuietly(client);
      if (
        generation === this.generation &&
        kind === "house" &&
        this.options.guildMembersIntent === true &&
        !this.membersIntentRejected &&
        classifyDiscordConnectionError(error) === "disallowed_intents"
      ) {
        // The opt-in privileged intent is not enabled for this application: Discord would
        // otherwise stay offline. Connect without it once and tell the user.
        this.membersIntentRejected = true;
        this.reportRuntimeIssue({
          source: "warn",
          botId: bot.id,
          code: GUILD_MEMBERS_INTENT_REJECTED,
          message: GUILD_MEMBERS_INTENT_REJECTED_MESSAGE
        });
        return this.connectBot(entry, generation, signal);
      }
      if (generation === this.generation) {
        const errorCode = classifyDiscordConnectionError(error);
        this.setBotStatus(bot, kind, { state: "error", errorCode, error: errorMessage(error) });
        this.options.logger?.error("Discord bot failed to connect", {
          botId: bot.id,
          displayName: bot.displayName,
          kind,
          errorCode,
          message: errorMessage(error)
        });
        // The House bot's retry is owned by the backend (it reconnects everything); a waifu on
        // a flaky network retries alone so the rest of the cast stays online.
        if (kind === "waifu" && errorCode === "network") {
          this.scheduleBotRetry(entry, generation);
        }
      }
      throw error;
    }
    this.pendingClients.delete(client);
    if (generation !== this.generation) {
      await destroyClientQuietly(client);
      throw new Error("Discord connection was cancelled by a disconnect.");
    }
    this.clients.set(bot.id, client);
    this.botRetryAttempts.delete(bot.id);
    this.setBotStatus(bot, kind, { state: "connected" });
    if (kind === "house") {
      await registerHouseCommands(client, this.options.logger);
      this.owners.start?.();
    } else {
      await registerDmCommands(client, this.clientDmWaifu.has(bot.id), this.options.logger);
    }
    this.options.logger?.info("Discord bot connected", {
      botId: bot.id,
      displayName: bot.displayName,
      kind
    });
  }

  private scheduleBotRetry(entry: ConnectableBot, generation: number): void {
    const attempt = (this.botRetryAttempts.get(entry.bot.id) ?? 0) + 1;
    this.botRetryAttempts.set(entry.bot.id, attempt);
    const delays = this.options.botRetryDelaysMs?.length ? this.options.botRetryDelaysMs : DEFAULT_BOT_RETRY_DELAYS_MS;
    const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? DEFAULT_BOT_RETRY_DELAYS_MS[0];
    const current = this.botStatuses.get(entry.bot.id);
    if (current) {
      this.botStatuses.set(entry.bot.id, { ...current, nextRetryAt: new Date(Date.now() + delayMs).toISOString() });
    }
    const timer = setTimeout(() => {
      this.botRetryTimers.delete(entry.bot.id);
      if (generation !== this.generation) return;
      void this.connectBot(entry, generation, this.connectAbort.signal)
        .catch(() => undefined)
        .then(() => this.emitStatusChange(generation));
    }, delayMs);
    timer.unref?.();
    this.botRetryTimers.set(entry.bot.id, timer);
  }

  private setBotStatus(
    bot: DiscordBotConfig,
    kind: DiscordBotKind,
    update: Pick<DiscordBotConnectionStatus, "state"> & Partial<DiscordBotConnectionStatus>
  ): void {
    this.botStatuses.set(bot.id, {
      botId: bot.id,
      displayName: bot.displayName,
      kind,
      updatedAt: new Date().toISOString(),
      ...update
    });
  }

  private emitStatusChange(generation: number): void {
    if (generation !== this.generation || !this.options.onStatusChange) return;
    const status = this.status();
    this.runBackground("Discord status change callback failed", {}, () => this.options.onStatusChange?.(status));
  }

  private createClient(bot: DiscordBotConfig, kind: DiscordBotKind): Client {
    const dmWaifu = kind === "waifu" ? this.dmWaifuByBot.get(bot.id) : undefined;
    const options = discordClientOptions(kind, {
      guildMembersIntent: this.options.guildMembersIntent === true && !this.membersIntentRejected,
      dm: dmWaifu !== undefined
    });
    const client = this.options.createClient?.({ bot, kind, options }) ?? new Client(options);
    this.attachClientRuntimeHandlers(client, bot.id);
    if (kind === "house") {
      this.attachHouseListeners(client);
    }
    if (dmWaifu !== undefined) {
      this.clientDmWaifu.set(bot.id, dmWaifu);
      this.attachDmListeners(client, bot.id, dmWaifu);
    } else if (kind === "waifu") {
      this.clientDmWaifu.delete(bot.id);
    }
    return client;
  }

  // ---- DMs (spec 9.1) --------------------------------------------------------------------------

  private attachDmListeners(client: Client, botId: string, waifuId: string): void {
    // Before the intake listener: the cache holds the message when the DM runner reads it.
    attachGatewayFeed(client, `dm:${waifuId}`, {
      conversation: (event) => this.emitConversationEvent(event),
      directory: () => undefined,
      ignoredAuthorIds: () => new Set<string>(),
      dm: {
        waifuId,
        userForChannel: (channelId) => {
          for (const [key, id] of this.dmChannels) {
            if (id === channelId && key.startsWith(`${botId}:`)) return key.slice(botId.length + 1);
          }
          return undefined;
        },
        noteChannel: (channelId, userId) => {
          this.dmChannels.set(`${botId}:${userId}`, channelId);
        }
      }
    });
    client.on(Events.MessageCreate, (message) => {
      if (message.guildId || message.channel?.type !== ChannelType.DM) return;
      if (message.author.bot || message.author.id === client.user?.id) return;
      if (this.clients.get(botId) !== client) return;
      this.dmChannels.set(`${botId}:${message.author.id}`, message.channelId);
      const event: DiscordDirectMessageEvent = {
        waifuId,
        botId,
        userId: message.author.id,
        userDisplayName: message.author.globalName ?? message.author.username,
        channelId: message.channelId,
        messageId: message.id,
        createdAt: new Date(message.createdTimestamp).toISOString()
      };
      // Ids only: DM content is never logged (spec 9.1.3).
      this.options.logger?.info("Discord gateway received DM", { botId, waifuId, messageId: event.messageId });
      for (const listener of this.dmListeners) {
        this.dispatchListener("Discord DM listener failed", listener, event, { botId, waifuId, messageId: event.messageId });
      }
    });
    client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand() || interaction.commandName !== DM_FORGET_COMMAND_NAME || interaction.guildId) return;
      this.runBackground("Discord DM forget interaction failed", { botId, waifuId }, () =>
        this.handleDmForgetInteraction(interaction, botId)
      );
    });
  }

  private async handleDmForgetInteraction(interaction: ChatInputCommandInteraction, botId: string): Promise<void> {
    const waifuId = this.clientDmWaifu.get(botId);
    if (!waifuId || this.dmForgetListeners.size === 0) {
      await replyEphemeral(interaction, `/${DM_FORGET_COMMAND_NAME} is not ready yet: Discord Waifus is still starting up. Try again in a moment.`);
      return;
    }
    const scope: DiscordDmForgetScope =
      interaction.options.getString(DM_FORGET_WHAT_OPTION_NAME) === "everything" ? "everything" : "conversation";
    const confirmId = `dm-forget:${interaction.id}:confirm`;
    const cancelId = `dm-forget:${interaction.id}:cancel`;
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(confirmId).setLabel("Confirm").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(cancelId).setLabel("Cancel").setStyle(ButtonStyle.Secondary)
    );
    const question =
      scope === "everything"
        ? "Forget everything about you: our private chat and every memory I have of you? This can't be undone."
        : "Forget our private chat? This can't be undone.";
    const response = await interaction.reply({
      content: question,
      components: [row],
      flags: MessageFlags.Ephemeral,
      withResponse: true
    });
    const message = response.resource?.message;
    if (!message) return;
    let click;
    try {
      click = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: DM_FORGET_CONFIRM_MS,
        filter: (candidate) =>
          candidate.user.id === interaction.user.id && (candidate.customId === confirmId || candidate.customId === cancelId)
      });
    } catch {
      await interaction.editReply({ content: "Timed out: nothing was forgotten.", components: [] }).catch(() => undefined);
      return;
    }
    if (click.customId === cancelId) {
      await click.update({ content: "Cancelled: nothing was forgotten.", components: [] });
      return;
    }
    const [listener] = this.dmForgetListeners;
    let text: string;
    try {
      text = await listener!({ waifuId, botId, userId: interaction.user.id, scope });
    } catch (error) {
      this.options.logger?.error("DM forget failed", { botId, waifuId, message: errorMessage(error) });
      text = "Something went wrong, so nothing may have been forgotten. Try again later.";
    }
    await click.update({ content: text, components: [] });
  }

  onDirectMessage(listener: DiscordDirectMessageListener): () => void {
    this.dmListeners.add(listener);
    return () => this.dmListeners.delete(listener);
  }

  onDmForgetCommand(listener: DiscordDmForgetCommandListener): () => void {
    this.dmForgetListeners.add(listener);
    return () => this.dmForgetListeners.delete(listener);
  }

  dmIntentStatus(): DiscordDmIntentStatus[] {
    return (this.options.waifus ?? [])
      .filter((bot) => bot.id !== this.options.house.id)
      .map((bot) => {
        const connected = this.clients.has(bot.id);
        const waifuId = this.dmWaifuByBot.get(bot.id);
        return {
          botId: bot.id,
          ...(waifuId ? { waifuId } : {}),
          intentActive: connected && this.clientDmWaifu.has(bot.id),
          connected
        };
      });
  }

  async reconcileDmIntents(): Promise<{ relogged: string[] }> {
    await this.refreshDmBots();
    const relogged: string[] = [];
    const generation = this.generation;
    for (const { bot, kind } of this.configuredBots()) {
      if (kind !== "waifu" || !bot.token) continue;
      const client = this.clients.get(bot.id);
      if (!client) continue; // not online: its next login uses the new intents
      const want = this.dmWaifuByBot.get(bot.id);
      const have = this.clientDmWaifu.get(bot.id);
      if (want === have) continue;
      relogged.push(bot.id);
      this.options.logger?.info("Re-logging waifu bot for a DM intent change", { botId: bot.id, dm: want !== undefined });
      this.clients.delete(bot.id);
      this.clientDmWaifu.delete(bot.id);
      if (have) this.emitConversationEvent({ type: "connection", scope: `dm:${have}`, state: "disconnected" });
      await destroyClientQuietly(client);
      if (generation !== this.generation) break;
      await this.connectBot({ bot, kind, token: bot.token }, generation, this.connectAbort.signal).catch(() => undefined);
    }
    if (relogged.length > 0) this.emitStatusChange(generation);
    return { relogged };
  }

  private dmClient(waifuId: string): { client: Client; botId: string } {
    for (const [botId, candidate] of this.clientDmWaifu) {
      if (candidate !== waifuId) continue;
      const client = this.clients.get(botId);
      if (client) return { client, botId };
    }
    throw new Error(`No connected bot carries DMs for waifu ${waifuId}.`);
  }

  private async dmChannel(client: Client, botId: string, userId: string) {
    const known = this.dmChannels.get(`${botId}:${userId}`);
    if (known) {
      const channel = await client.channels.fetch(known).catch(() => null);
      if (channel && channel.type === ChannelType.DM) return channel;
    }
    const channel = await client.users.createDM(userId);
    this.dmChannels.set(`${botId}:${userId}`, channel.id);
    return channel;
  }

  async fetchDmContextSince(input: {
    waifuId: string;
    userId: string;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }> {
    throwIfAborted(input.signal);
    const { client, botId } = this.dmClient(input.waifuId);
    const channel = await this.dmChannel(client, botId, input.userId);
    const result = await pageMessagesSince(
      async (before) => (await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 })).values(),
      { afterMessageId: input.afterMessageId, maxMessages: input.maxMessages, signal: input.signal }
    );
    return {
      messages: (result.messages as unknown as DiscordMessageLike[]).map((message) => toRawDiscordMessage(message)),
      reachedCursor: result.reachedCursor
    };
  }

  async sendDirectMessage(input: {
    waifuId: string;
    userId: string;
    content: string;
    replyToMessageId?: string;
    onFinalContent?: (content: string) => void | Promise<void>;
  }): Promise<{ messageId: string }> {
    const { client, botId } = this.dmClient(input.waifuId);
    const channel = await this.dmChannel(client, botId, input.userId);
    const denormalized = denormalizeModelContentForDiscord(input.content, { activeAuthorIds: [input.userId] });
    const replyToMessageId = sanitizeReplyTarget(input.replyToMessageId);
    await input.onFinalContent?.(denormalized.content);
    const sent = await channel.send({
      content: denormalized.content,
      allowedMentions: denormalized.allowedMentions,
      reply: replyToMessageId ? { messageReference: replyToMessageId, failIfNotExists: false } : undefined
    });
    // Visible to the next read before this returns, like a guild send.
    try {
      const message = toRawDiscordMessage(sent as unknown as DiscordMessageLike);
      this.emitConversationEvent({
        type: "create",
        own: true,
        conversation: { kind: "dm", waifuId: input.waifuId, userId: input.userId },
        message
      });
    } catch (error) {
      this.options.logger?.warn("Could not publish an own DM send to the conversation cache", {
        messageId: sent.id,
        message: errorMessage(error)
      });
    }
    return { messageId: sent.id };
  }

  async sendDirectTyping(input: { waifuId: string; userId: string }): Promise<void> {
    try {
      const { client, botId } = this.dmClient(input.waifuId);
      const channel = await this.dmChannel(client, botId, input.userId);
      await channel.sendTyping();
    } catch (error) {
      this.options.logger?.warn("Failed to send DM typing indicator", { waifuId: input.waifuId, message: errorMessage(error) });
    }
  }

  async fetchMessagesBefore(input: { conversation: ConversationRef; beforeId: string; limit: number; signal?: AbortSignal }): Promise<RawDiscordMessage[]> {
    throwIfAborted(input.signal);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit)));
    if (input.conversation.kind === "dm") {
      const { client, botId } = this.dmClient(input.conversation.waifuId);
      const channel = await this.dmChannel(client, botId, input.conversation.userId);
      const page = await channel.messages.fetch({ limit, before: input.beforeId });
      return [...page.values()]
        .map((message) => toRawDiscordMessage(message as unknown as DiscordMessageLike))
        .sort((a, b) => compareIds(a.id, b.id));
    }
    const client = this.houseClient();
    const channel = await client.channels.fetch(input.conversation.channelId);
    if (!channel || !("messages" in channel)) return [];
    const page = await channel.messages.fetch({ limit, before: input.beforeId });
    const houseIds = [...botAuthorIds([this.options.house]), client.user?.id];
    const guildId = input.conversation.guildId;
    return withoutAuthors([...page.values()] as unknown as DiscordMessageLike[], houseIds)
      .map((message) => toRawDiscordMessage(message, guildId))
      .sort((a, b) => compareIds(a.id, b.id));
  }

  async addReaction(input: { waifuId: string; botId: string; conversation: ConversationRef; messageId: string; emoji: string }): Promise<void> {
    if (input.conversation.kind === "dm") {
      const { client, botId } = this.dmClient(input.conversation.waifuId);
      const channel = await this.dmChannel(client, botId, input.conversation.userId);
      const message = await channel.messages.fetch(input.messageId);
      await message.react(input.emoji);
      return;
    }
    const client = this.clients.get(input.botId);
    if (!client) throw new Error(`Waifu Discord bot ${input.botId} is not connected.`);
    const channel = await client.channels.fetch(input.conversation.channelId);
    if (!channel || !("messages" in channel)) throw new Error("That channel has no messages.");
    const message = await channel.messages.fetch(input.messageId);
    await message.react(input.emoji);
  }

  async fetchBotMemberRoles(input: { botId: string; guildId: string }): Promise<string[] | undefined> {
    const client = this.clients.get(input.botId);
    if (!client) return undefined;
    const guild = client.guilds.cache.get(input.guildId) ?? (await client.guilds.fetch(input.guildId).catch(() => undefined));
    if (!guild) return undefined;
    const me = await guild.members.fetchMe().catch(() => undefined);
    if (!me) return undefined;
    return [...me.roles.cache.keys()].filter((roleId) => roleId !== input.guildId);
  }

  private emitConversationEvent(event: DiscordConversationEvent): void {
    for (const listener of this.conversationListeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.error("Discord conversation event listener failed", {
          type: event.type,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private emitDirectoryEvent(event: DiscordDirectoryEvent): void {
    for (const listener of this.directoryListeners) {
      try {
        listener(event);
      } catch (error) {
        this.options.logger?.error("Discord directory event listener failed", {
          type: event.type,
          guildId: event.guildId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  onConversationEvent(listener: DiscordConversationEventListener): () => void {
    this.conversationListeners.add(listener);
    // A subscriber that arrives after the House bot connected missed its `ready`: replay it,
    // otherwise its buffers could never be trusted.
    if (this.clients.has(this.options.house.id)) {
      this.dispatchTo(listener, { type: "connection", scope: "guild", state: "ready" });
    }
    // Same for every DM transport that is already online (its scope must turn live to be trusted).
    for (const [botId, waifuId] of this.clientDmWaifu) {
      if (this.clients.has(botId)) {
        this.dispatchTo(listener, { type: "connection", scope: `dm:${waifuId}` as DiscordConnectionScope, state: "ready" });
      }
    }
    return () => this.conversationListeners.delete(listener);
  }

  onDirectoryEvent(listener: DiscordDirectoryEventListener): () => void {
    this.directoryListeners.add(listener);
    // discord.js emits GuildCreate only for guilds joined later; replay what is already there.
    const client = this.clients.get(this.options.house.id);
    if (client) {
      for (const guild of client.guilds.cache.values()) this.dispatchTo(listener, guildSnapshotEvent(guild));
    }
    return () => this.directoryListeners.delete(listener);
  }

  onBotRolesChange(listener: (event: { botId: string; guildId: string; roleIds: string[] }) => void): () => void {
    this.botRolesListeners.add(listener);
    return () => this.botRolesListeners.delete(listener);
  }

  ownAuthorIds(): string[] {
    const ids = new Set<string>();
    for (const client of this.clients.values()) if (client.user?.id) ids.add(client.user.id);
    return [...ids];
  }

  private dispatchTo<E>(listener: (event: E) => void, event: E): void {
    try {
      listener(event);
    } catch (error) {
      this.options.logger?.error("Discord event listener failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private attachHouseListeners(client: Client): void {
    // Registered before the intake listener below: when a handler reads the conversation, the
    // cache has already seen the message that woke it (trusted reads make no REST calls).
    attachGatewayFeed(client, "guild", {
      conversation: (event) => this.emitConversationEvent(event),
      directory: (event) => this.emitDirectoryEvent(event),
      ignoredAuthorIds: () =>
        new Set([...botAuthorIds([this.options.house]), ...(client.user?.id ? [client.user.id] : [])])
    });
    client.on("messageCreate", (message) => {
      if (!message.guildId) return;
      const thread = threadInfoOf(message.channel);
      const event: DiscordMessageEvent = {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        authorBot: message.author.bot,
        ...(thread ? { thread } : {})
      };
      this.options.logger?.info("Discord gateway received message", {
        guildId: event.guildId,
        channelId: event.channelId,
        messageId: event.messageId,
        authorBot: event.authorBot
      });
      for (const listener of this.listeners) {
        this.dispatchListener("Discord message listener failed", listener, event, {
          guildId: event.guildId,
          channelId: event.channelId,
          messageId: event.messageId
        });
      }
    });
    // Spec 9.5: edits and deletes reach the ledger through the conversation feed above; only thread
    // lifecycle is emitted here.
    const emitThread = (change: DiscordThreadEvent["change"], thread: unknown, previous?: unknown) => {
      const info = threadInfoOf(thread);
      const threadId = (thread as { id?: string } | undefined)?.id;
      const guildId = (thread as { guildId?: string | null } | undefined)?.guildId;
      if (!info || !threadId || !guildId) return;
      const before = previous ? threadInfoOf(previous) : undefined;
      const event: DiscordThreadEvent = {
        change,
        guildId,
        threadId,
        thread: info,
        ...(before ? { previous: { archived: before.archived, locked: before.locked, name: before.name } } : {})
      };
      for (const listener of this.threadListeners) {
        this.dispatchListener("Discord thread listener failed", listener, event, { guildId, threadId, change });
      }
    };
    client.on(Events.ThreadCreate, (thread) => emitThread("create", thread));
    client.on(Events.ThreadUpdate, (oldThread, newThread) => emitThread("update", newThread, oldThread));
    client.on(Events.ThreadDelete, (thread) => emitThread("delete", thread));
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === WAKE_COMMAND_NAME || interaction.commandName === PRINT_COMMAND_NAME) {
          this.runBackground("Discord waifu autocomplete interaction failed", {
            commandName: interaction.commandName,
            guildId: interaction.guildId,
            channelId: interaction.channelId
          }, () => this.handleWaifuAutocompleteInteraction(interaction));
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === WAKE_COMMAND_NAME) {
        this.runBackground("Discord wake interaction failed", interactionLogContext(interaction), () =>
          this.handleWakeInteraction(interaction)
        );
      } else if (interaction.commandName === PRINT_COMMAND_NAME) {
        this.runBackground("Discord print interaction failed", interactionLogContext(interaction), () =>
          this.handlePrintInteraction(interaction)
        );
      }
    });
  }

  onMessage(listener: DiscordMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onThreadChange(listener: DiscordThreadListener): () => void {
    this.threadListeners.add(listener);
    return () => this.threadListeners.delete(listener);
  }

  async joinThread(input: { guildId: string; threadId: string }): Promise<void> {
    const channel = await this.houseClient().channels.fetch(input.threadId);
    if (channel && channel.isThread() && channel.joinable && !channel.archived) await channel.join();
  }

  onWakeCommand(listener: DiscordWakeCommandListener): () => void {
    this.wakeListeners.add(listener);
    return () => this.wakeListeners.delete(listener);
  }

  onPrintCommand(listener: DiscordPrintCommandListener): () => void {
    this.printListeners.add(listener);
    return () => this.printListeners.delete(listener);
  }

  onWaifuAutocomplete(listener: DiscordWaifuAutocompleteListener): () => void {
    this.waifuAutocompleteListeners.add(listener);
    return () => this.waifuAutocompleteListeners.delete(listener);
  }

  async listGuilds(): Promise<Array<{ guildId: string; name: string }>> {
    const client = this.houseClient();
    await client.guilds.fetch();
    return client.guilds.cache.map((guild) => ({
      guildId: guild.id,
      name: guild.name
    }));
  }

  async fetchChannelMetadata(input: {
    guildId: string;
    channelId: string;
  }): Promise<DiscordChannelMetadata> {
    const client = this.houseClient();
    const [guild, channel] = await Promise.all([
      client.guilds.fetch(input.guildId),
      client.channels.fetch(input.channelId)
    ]);
    if (!channel) {
      throw new Error(`Discord channel ${input.channelId} is not accessible to the House bot.`);
    }
    const channelGuildId =
      "guildId" in channel && typeof channel.guildId === "string" ? channel.guildId : undefined;
    if (channelGuildId && channelGuildId !== input.guildId) {
      throw new Error(`Discord channel ${input.channelId} does not belong to guild ${input.guildId}.`);
    }
    return {
      guildId: guild.id,
      guildName: guild.name,
      channelId: channel.id,
      channelName: "name" in channel && typeof channel.name === "string" ? channel.name : undefined,
      ...(threadInfoOf(channel) ? { thread: threadInfoOf(channel)! } : {})
    };
  }

  async fetchFreshContext(input: {
    guildId: string;
    channelId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ContextMessage[]> {
    throwIfAborted(input.signal);
    const client = this.houseClient();
    let cache = await this.cacheForGuild(input.guildId);
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("messages" in channel)) {
      return [];
    }
    const collection = await channel.messages.fetch({ limit: input.limit });
    const rawMessages = [...collection.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const mentionedRoles = uniqueMentionedRoles(rawMessages, cache.roles ?? []);
    const roleCacheForResolution = mergeRoleCaches(cache.roles ?? [], mentionedRoles);
    const missingMentionIds = unresolvedMentionIdsByType(
      rawMessages.map((message) => message.content),
      cache.members ?? [],
      roleCacheForResolution
    );
    if ((missingMentionIds.userIds.length > 0 || missingMentionIds.roleIds.length > 0) && this.shouldRefreshMentions(input.guildId)) {
      this.options.logger?.info("Refreshing Discord mention caches for unresolved mentions", {
        guildId: input.guildId,
        channelId: input.channelId,
        userMentionCount: missingMentionIds.userIds.length,
        roleMentionCount: missingMentionIds.roleIds.length,
        mentionIds: [...missingMentionIds.userIds, ...missingMentionIds.roleIds].slice(0, 5)
      });
      try {
        const [refreshedMembers, refreshedRoles] = await Promise.all([
          missingMentionIds.userIds.length > 0 ? this.options.refreshMembersForGuild?.(input.guildId) : undefined,
          missingMentionIds.roleIds.length > 0 ? this.options.refreshRolesForGuild?.(input.guildId) : undefined
        ]);
        cache = {
          ...cache,
          ...refreshedMembers,
          ...refreshedRoles
        };
      } catch (error) {
        this.options.logger?.warn("Discord mention cache refresh for unresolved mentions failed", {
          guildId: input.guildId,
          channelId: input.channelId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const messages = await Promise.all(
      rawMessages.map(async (message) => {
        const [replyTo, reactions] = await Promise.all([
          message.reference?.messageId
            ? resolveReplyReference(message).catch(() => ({ messageId: message.reference?.messageId ?? "" }))
            : undefined,
          summarizeReactions(message.reactions.cache.values(), cache)
        ]);
        return {
          id: message.id,
          channelId: message.channelId,
          guildId: message.guildId ?? input.guildId,
          authorId: message.author.id,
          authorName: message.author.username,
          authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
          authorBot: message.author.bot,
          content: message.content,
          createdAt: message.createdAt,
          images: collectImageAttachments(message),
          replyTo,
          reactions
        };
      })
    );
    return buildNormalizedDiscordContext(
      messages,
      { ...cache, roles: mergeRoleCaches(cache.roles ?? [], mentionedRoles) },
      {
        houseAuthorIds: botAuthorIds([this.options.house]),
        waifuAuthorIds: botAuthorIds(this.options.waifus ?? [])
      }
    ).messages;
  }

  async fetchContextSince(input: {
    guildId: string;
    channelId: string;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }> {
    throwIfAborted(input.signal);
    const client = this.houseClient();
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("messages" in channel)) {
      return { messages: [], reachedCursor: true };
    }
    const result = await pageMessagesSince(
      async (before) => (await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 })).values(),
      { afterMessageId: input.afterMessageId, maxMessages: input.maxMessages, signal: input.signal }
    );
    // The House bot's own posts (debug logs) are never conversation.
    const houseIds = [...botAuthorIds(this.options.house ? [this.options.house] : []), client.user?.id];
    return {
      messages: withoutAuthors(result.messages as unknown as DiscordMessageLike[], houseIds).map((message) =>
        toRawDiscordMessage(message, input.guildId)
      ),
      reachedCursor: result.reachedCursor
    };
  }

  async sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
    onFinalContent?: (content: string) => void | Promise<void>;
  }): Promise<{ messageId: string }> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.houseClient();
    if (!client) {
      throw new Error(input.senderBotId
        ? `Waifu Discord bot ${input.senderBotId} is not connected.`
        : "The House bot is not connected.");
    }
    const cache = await this.cacheForGuild(input.guildId);
    const channel = await client.channels.fetch(input.channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not sendable.`);
    }
    const denormalized = denormalizeModelContentForDiscord(input.content, {
      ...cache,
      activeAuthorIds: input.allowedUserMentionIds
    });
    const replyToMessageId = sanitizeReplyTarget(input.replyToMessageId);
    if (input.replyToMessageId && !replyToMessageId) {
      this.options.logger?.warn("Dropping non-snowflake replyToMessageId", {
        guildId: input.guildId,
        channelId: input.channelId,
        value: input.replyToMessageId
      });
    }
    await input.onFinalContent?.(denormalized.content);
    const sent = await channel.send({
      content: denormalized.content,
      allowedMentions: denormalized.allowedMentions,
      // The user may delete their message while the waifu is generating; send as a normal message
      // then instead of letting Discord reject the whole reply.
      reply: replyToMessageId ? { messageReference: replyToMessageId, failIfNotExists: false } : undefined
    });
    // Visible to the next reader before this call returns (responder i+1 sees responder i).
    if (input.guildId) {
      try {
        const message = ownSentMessage(sent, { guildId: input.guildId, channelId: input.channelId });
        if (message) {
          this.emitConversationEvent({
            type: "create",
            own: true,
            conversation: { kind: "guild", guildId: input.guildId, channelId: input.channelId },
            message
          });
        }
      } catch (error) {
        // The send already succeeded; a cache that misses it re-syncs on its next catch-up.
        this.options.logger?.warn("Could not publish an own send to the conversation cache", {
          messageId: sent.id,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { messageId: sent.id };
  }

  async sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.houseClient();
    if (!client) return;
    try {
      const channel = await client.channels.fetch(input.channelId);
      if (channel && "sendTyping" in channel) {
        await channel.sendTyping();
      }
    } catch (error) {
      this.options.logger?.warn("Failed to send typing indicator", {
        guildId: input.guildId,
        channelId: input.channelId,
        senderBotId: input.senderBotId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async cacheForGuild(guildId: string): Promise<DiscordCache> {
    return this.options.cacheForGuild?.(guildId) ?? {
      members: this.options.members,
      emojis: this.options.emojis
    };
  }

  private houseClient(): Client {
    const client = this.clients.get(this.options.house.id);
    if (!client) {
      throw new Error("The House bot is not connected.");
    }
    return client;
  }

  private clientForAuthor(authorId?: string): Client {
    if (authorId) {
      const bots = [this.options.house, ...(this.options.waifus ?? [])];
      const bot = bots.find((candidate) => candidate.id === authorId || candidate.applicationId === authorId);
      const client = bot ? this.clients.get(bot.id) : undefined;
      if (client) {
        return client;
      }
    }
    return this.houseClient();
  }

  private botIdForClient(client: Client): string | undefined {
    for (const [botId, candidate] of this.clients) {
      if (candidate === client) return botId;
    }
    return undefined;
  }

  private shouldRefreshMentions(guildId: string): boolean {
    if (!this.options.refreshMembersForGuild) return false;
    const now = Date.now();
    const previous = this.recentMentionRefreshes.get(guildId) ?? 0;
    if (now - previous < MENTION_REFRESH_COOLDOWN_MS) {
      return false;
    }
    this.recentMentionRefreshes.set(guildId, now);
    return true;
  }

  private attachClientRuntimeHandlers(client: Client, botId: string): void {
    // The bot's own member (roles for the Living cast `role` wake, §10.2). Discord sends the current
    // user's member updates on every bot, with or without the members intent.
    client.on(Events.GuildMemberUpdate, (_old, member) => {
      if (!client.user || member.id !== client.user.id) return;
      const event = { botId, guildId: member.guild.id, roleIds: [...member.roles.cache.keys()].filter((roleId) => roleId !== member.guild.id) };
      for (const listener of this.botRolesListeners) this.dispatchTo(listener, event);
    });
    client.on(Events.Error, (error) => {
      this.reportRuntimeIssue({
        source: "client-error",
        botId,
        message: errorMessage(error),
        error
      });
    });
    client.on(Events.ShardError, (error, shardId) => {
      this.reportRuntimeIssue({
        source: "shard-error",
        botId,
        shardId,
        message: errorMessage(error),
        error
      });
    });
    // discord.js (14.27, @discordjs/ws) resumes or re-identifies on its own after network errors and
    // recoverable close codes; ShardError is informational. It emits ShardDisconnect only for close
    // codes it gives up on (4004, 4010-4014), so that bot is dead until its config is fixed.
    client.on(Events.ShardDisconnect, (event, shardId) => {
      const code = closeEventCode(event);
      const reason = closeEventReason(event);
      const description = typeof code === "number" ? UNRECOVERABLE_CLOSE_CODE_DESCRIPTIONS[code] : undefined;
      const message = `Discord shard disconnected${code === undefined ? "" : ` with code ${code}`}${
        description ? ` (${description})` : ""
      }${reason ? `: ${reason}` : "."}`;
      this.reportRuntimeIssue({
        source: "shard-disconnect",
        botId,
        shardId,
        code,
        wasClean: closeEventWasClean(event),
        message
      });
      this.handleUnrecoverableDisconnect(client, botId, typeof code === "number" ? code : undefined, message);
    });
    client.on(Events.Invalidated, () => {
      this.reportRuntimeIssue({
        source: "invalidated",
        botId,
        message: "Discord gateway session was invalidated."
      });
    });
    client.on(Events.Warn, (message) => {
      this.reportRuntimeIssue({
        source: "warn",
        botId,
        message
      });
    });
  }

  private handleUnrecoverableDisconnect(client: Client, botId: string, closeCode: number | undefined, message: string): void {
    // A client that is still logging in fails its login instead; only adopted clients are handled here.
    if (this.clients.get(botId) !== client) return;
    const entry = this.configuredBots().find((candidate) => candidate.bot.id === botId);
    if (!entry) return;
    this.clients.delete(botId);
    void destroyClientQuietly(client);
    this.setBotStatus(entry.bot, entry.kind, {
      state: "error",
      errorCode: classifyDiscordConnectionError(message, closeCode),
      error: message,
      ...(closeCode === undefined ? {} : { closeCode })
    });
    if (entry.kind === "house") {
      // Same policy as connect(): waifus cannot be cast without the House bot. End this session
      // like a disconnect (new generation, aborted logins, no retries) so an in-flight waifu retry
      // is destroyed instead of adopted, but keep the statuses for the status API.
      this.generation += 1;
      this.connectAbort.abort();
      this.connectAbort = new AbortController();
      for (const timer of this.botRetryTimers.values()) clearTimeout(timer);
      this.botRetryTimers.clear();
      this.botRetryAttempts.clear();
      for (const [waifuBotId, waifuClient] of [...this.clients]) {
        this.clients.delete(waifuBotId);
        void destroyClientQuietly(waifuClient);
      }
      for (const [waifuBotId, status] of this.botStatuses) {
        const wasActive = status.state === "connected" || status.state === "connecting" || status.nextRetryAt !== undefined;
        if (waifuBotId === botId || !wasActive) continue;
        const { nextRetryAt: _cancelled, ...rest } = status;
        this.botStatuses.set(waifuBotId, {
          ...rest,
          state: "error",
          errorCode: "house_unavailable",
          error: "Disconnected because the House bot is offline.",
          updatedAt: new Date().toISOString()
        });
      }
    }
    this.emitStatusChange(this.generation);
  }

  private reportRuntimeIssue(issue: DiscordRuntimeIssue): void {
    const context = runtimeIssueLogContext(issue);
    if (issue.source === "warn") {
      this.options.logger?.warn("Discord gateway warning", context);
    } else {
      this.options.logger?.error("Discord gateway runtime issue", context);
    }
    if (!this.options.onRuntimeIssue) return;
    this.runBackground("Discord runtime issue callback failed", context, () =>
      this.options.onRuntimeIssue?.(issue)
    );
  }

  private async callListener<T>(
    label: string,
    listener: (event: T) => void | Promise<void>,
    event: T,
    context: Record<string, unknown>
  ): Promise<void> {
    try {
      await listener(event);
    } catch (error) {
      this.options.logger?.error(label, {
        ...context,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private dispatchListener<T>(
    label: string,
    listener: (event: T) => void | Promise<void>,
    event: T,
    context: Record<string, unknown>
  ): void {
    void this.callListener(label, listener, event, context);
  }

  private runBackground(
    label: string,
    context: Record<string, unknown>,
    task: () => void | Promise<void>
  ): void {
    void Promise.resolve()
      .then(task)
      .catch((error) => {
        this.options.logger?.error(label, {
          ...context,
          message: error instanceof Error ? error.message : String(error)
        });
      });
  }

  /**
   * Living cast §10.4 (D-a): `/wake` and `/print` belong to the Discord application's owner (or its
   * team members), checked here at run time. The Administrator default member permission only hides
   * the commands in the Discord UI. Defers first: the owner list may need a fetch.
   */
  private async deferIfOwner(interaction: ChatInputCommandInteraction, commandName: string): Promise<boolean> {
    if (!interaction.guildId || !interaction.channelId) {
      await replyEphemeral(interaction, `/${commandName} can only be used in a server channel.`);
      return false;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await this.owners.isOwner(interaction.user.id))) {
      await interaction.editReply(`Only the owner of this bot's Discord application can use /${commandName}.`);
      return false;
    }
    return true;
  }

  private async handleWakeInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.wakeListeners, WAKE_COMMAND_NAME)) return;
    if (!(await this.deferIfOwner(interaction, WAKE_COMMAND_NAME))) return;
    const note = sanitizeOptionString(interaction.options.getString(WAKE_NOTE_OPTION_NAME));
    const event: DiscordWakeCommandEvent = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      waifuId: sanitizeOptionString(interaction.options.getString(WAIFU_OPTION_NAME)),
      ...(note ? { note } : {}),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.wakeListeners) {
      this.dispatchListener("Discord wake command listener failed", listener, event, slashCommandLogContext(event));
    }
  }

  private async handlePrintInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.printListeners, PRINT_COMMAND_NAME)) return;
    if (!(await this.deferIfOwner(interaction, PRINT_COMMAND_NAME))) return;
    const event: DiscordPrintCommandEvent = {
      guildId: interaction.guildId!,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      type: parsePrintCommandType(interaction.options.getString(PRINT_TYPE_OPTION_NAME)),
      waifuId: sanitizeOptionString(interaction.options.getString(WAIFU_OPTION_NAME)),
      private: interaction.options.getBoolean(PRINT_PRIVATE_OPTION_NAME) === true,
      // A print longer than one message goes as a text file on the same ephemeral reply.
      respond: async (content) => {
        if (content.length <= PRINT_INLINE_MAX_CHARS) {
          await interaction.editReply(content);
          return;
        }
        const name = `${parsePrintCommandType(interaction.options.getString(PRINT_TYPE_OPTION_NAME)) ?? "print"}.md`;
        await interaction.editReply({ content: `Attached as ${name}.`, files: [{ attachment: Buffer.from(content, "utf8"), name }] });
      }
    };
    for (const listener of this.printListeners) {
      this.dispatchListener("Discord print command listener failed", listener, event, {
        ...slashCommandLogContext(event),
        type: event.type,
        waifuId: event.waifuId
      });
    }
  }

  /** Slash commands are registered before the runtime attaches its listeners; never leave one "thinking". */
  private async replyIfNotReady(
    interaction: ChatInputCommandInteraction,
    listeners: ReadonlySet<unknown>,
    commandName: string
  ): Promise<boolean> {
    if (listeners.size > 0) return false;
    await replyEphemeral(interaction, `/${commandName} is not ready yet: Discord Waifus is still starting up. Try again in a moment.`);
    return true;
  }

  private async handleWaifuAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== WAIFU_OPTION_NAME || this.waifuAutocompleteListeners.size === 0) {
      await interaction.respond([]);
      return;
    }
    const event: DiscordWaifuAutocompleteEvent = {
      commandName: interaction.commandName,
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId ?? undefined,
      focusedValue: typeof focused.value === "string" ? focused.value : String(focused.value ?? ""),
      respond: async (choices) => {
        await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE_CHOICES));
      }
    };
    await Promise.all([...this.waifuAutocompleteListeners].map((listener) =>
      this.callListener("Discord waifu autocomplete listener failed", listener, event, {
        guildId: event.guildId,
        channelId: event.channelId,
        focusedValue: event.focusedValue
      })
    ));
  }
}

/**
 * The House bot reads every channel (messages, reactions, content) and owns slash commands.
 * Waifu clients never listen: they only fetch a channel, send, type and delete their own messages,
 * all over REST, so they need just `Guilds` (channel cache) and keep no message/member caches.
 */
/**
 * Thread facts of a channel-like object (structural, so test doubles work): undefined when it is
 * not a thread. A thread whose parent is a forum or media channel is a "forum_post".
 */
export function threadInfoOf(channel: unknown): DiscordThreadInfo | undefined {
  const c = channel as
    | {
        isThread?: () => boolean;
        parentId?: string | null;
        parent?: { type?: number } | null;
        name?: string | null;
        type?: number;
        archived?: boolean | null;
        locked?: boolean | null;
      }
    | null
    | undefined;
  if (!c || typeof c.isThread !== "function" || !c.isThread() || !c.parentId) return undefined;
  const parentType = c.parent?.type;
  let kind: ThreadKind = "public_thread";
  if (parentType === ChannelType.GuildForum || parentType === ChannelType.GuildMedia) kind = "forum_post";
  else if (c.type === ChannelType.PrivateThread) kind = "private_thread";
  else if (c.type === ChannelType.AnnouncementThread) kind = "announcement_thread";
  return { parentId: c.parentId, name: c.name ?? "", kind, archived: c.archived === true, locked: c.locked === true };
}

function discordClientOptions(kind: DiscordBotKind, o: { guildMembersIntent?: boolean; dm?: boolean } = {}): ClientOptions {
  if (kind === "house") {
    return {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
        // Non-privileged: emoji/sticker create/update/delete events for the GuildDirectory.
        GatewayIntentBits.GuildExpressions,
        // Privileged, opt-in (`discord.guildMembersIntent`): member add/update/remove events.
        ...(o.guildMembersIntent ? [GatewayIntentBits.GuildMembers] : [])
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    };
  }
  return {
    // DM-eligible waifu bots (spec 9.1) add the non-privileged DM intents; DM content needs no
    // Message Content intent. Partials: DM channels and uncached messages (reactions, deletes).
    intents: o.dm
      ? [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions]
      : [GatewayIntentBits.Guilds],
    ...(o.dm ? { partials: [Partials.Channel, Partials.Message, Partials.Reaction] } : {}),
    makeCache: Options.cacheWithLimits({
      MessageManager: 0,
      ReactionManager: 0,
      ReactionUserManager: 0,
      PresenceManager: 0,
      VoiceStateManager: 0,
      ThreadMemberManager: 0,
      GuildMemberManager: { maxSize: 0, keepOverLimit: (member) => member.id === member.client.user.id },
      UserManager: { maxSize: 0, keepOverLimit: (user) => user.id === user.client.user.id }
    })
  };
}

async function loginAndWaitUntilReady(client: Client, token: string, signal: AbortSignal): Promise<void> {
  if (client.isReady()) return;
  if (signal.aborted) throw new Error("Discord connection was cancelled by a disconnect.");
  const login = Promise.all([
    new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    }),
    client.login(token)
  ]);
  // A cancelled login is abandoned (and its client destroyed); keep its late rejection handled.
  login.catch(() => undefined);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Discord connection was cancelled by a disconnect."));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([login, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function destroyClientQuietly(client: Client): Promise<void> {
  try {
    await client.destroy();
  } catch {
    // A half-initialised client can throw while tearing down; it is unreachable either way.
  }
}

const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

/** Maps a login failure or gateway close code to a stable, user-actionable status code. */
function classifyDiscordConnectionError(error: unknown, closeCode?: number): DiscordBotConnectionErrorCode {
  const message = errorMessage(error);
  const code = nestedErrorCode(error);
  if (closeCode === 4004 || code === "TokenInvalid" || /invalid token|authentication failed/i.test(message)) {
    return "invalid_token";
  }
  if (closeCode === 4014 || code === "DisallowedIntents" || /disallowed intents|privileged intent/i.test(message)) {
    return "disallowed_intents";
  }
  if (closeCode === 4013 || /invalid intents/i.test(message)) {
    return "invalid_intents";
  }
  if (
    (closeCode !== undefined && [4010, 4011, 4012].includes(closeCode)) ||
    /invalid shard|sharding is required|invalid api version/i.test(message)
  ) {
    return "gateway_rejected";
  }
  if (
    (code && NETWORK_ERROR_CODES.has(code)) ||
    /getaddrinfo|\bnetwork\b|timed out|\btimeout\b|\bsocket\b|fetch failed|connection reset|connection refused|unreachable/i.test(message)
  ) {
    return "network";
  }
  return "unknown";
}

function nestedErrorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== "object" || depth > 3) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return nestedErrorCode((error as { cause?: unknown }).cause, depth + 1);
}

/** The message we just sent as a raw record; undefined when discord.js gave back too little to build one. */
function ownSentMessage(
  sent: unknown,
  fallback: { guildId: string; channelId: string }
): RawDiscordMessage | undefined {
  const message = sent as Partial<DiscordMessageLike> | undefined;
  if (!message || typeof message.id !== "string") return undefined;
  if (message.author && typeof message.createdTimestamp === "number") {
    return toRawDiscordMessage(
      { channelId: fallback.channelId, type: 0, content: "", ...message } as DiscordMessageLike,
      fallback.guildId
    );
  }
  return undefined;
}

function botAuthorIds(bots: DiscordBotConfig[]): string[] {
  return bots.flatMap((bot) => [bot.id, bot.applicationId].filter((id): id is string => Boolean(id)));
}

function collectImageAttachments(message: {
  attachments?: { values(): Iterable<{ url: string; contentType?: string | null; name?: string | null; size?: number | null }> };
}): Array<{ url: string; contentType?: string; contentLengthBytes?: number }> | undefined {
  if (!message.attachments) return undefined;
  const images: Array<{ url: string; contentType?: string; contentLengthBytes?: number }> = [];
  for (const attachment of message.attachments.values()) {
    if (!attachment.url) continue;
    const contentType = attachment.contentType ?? undefined;
    if (isImageAttachment(contentType, attachment.name ?? undefined)) {
      images.push({
        url: attachment.url,
        contentType,
        contentLengthBytes: attachment.size ?? undefined
      });
    }
  }
  return images.length ? images : undefined;
}

function isImageAttachment(contentType: string | undefined, name: string | undefined): boolean {
  if (contentType) return contentType.startsWith("image/");
  return /\.(png|jpe?g|webp|gif)$/i.test(name ?? "");
}

async function resolveReplyReference(message: {
  reference?: { messageId?: string } | null;
  fetchReference?: () => Promise<{
    author: { username: string; globalName?: string | null };
    member?: { displayName?: string | null } | null;
    content: string;
  }>;
}): Promise<{ messageId: string; authorName?: string; contentPreview?: string } | undefined> {
  if (!message.reference?.messageId) return undefined;
  if (!message.fetchReference) {
    return { messageId: message.reference.messageId };
  }
  const referenced = await message.fetchReference();
  return {
    messageId: message.reference.messageId,
    authorName: referenced.member?.displayName ?? referenced.author.globalName ?? referenced.author.username,
    contentPreview: referenced.content.slice(0, 160)
  };
}

async function summarizeReactions(
  reactions: Iterable<{
    emoji: { name: string | null; identifier: string; id?: string | null; animated?: boolean | null };
    count: number | null;
    users?: {
      fetch: (options?: { limit?: number }) => Promise<
        { values(): Iterable<{ id: string; username: string; globalName?: string | null }> }
      >;
    };
  }>,
  cache: DiscordCache
) {
  const membersById = new Map((cache.members ?? []).map((member) => [member.userId, member]));
  const emojisById = new Map((cache.emojis ?? []).map((emoji) => [emoji.id, emoji]));
  return Promise.all(
    [...reactions].map(async (reaction) => {
      let users: string[] | undefined;
      if (reaction.users) {
        try {
          const fetched = await reaction.users.fetch({ limit: 20 });
          users = [...fetched.values()].map((user) => {
            const member = membersById.get(user.id);
            return member?.guildDisplayName ?? member?.globalDisplayName ?? user.globalName ?? user.username;
          });
        } catch {
          users = undefined;
        }
      }
      return {
        emoji: modelVisibleReactionEmoji(reaction.emoji, emojisById),
        count: reaction.count ?? 0,
        users
      };
    })
  );
}

function modelVisibleReactionEmoji(
  emoji: { name: string | null; identifier: string; id?: string | null; animated?: boolean | null },
  emojisById: Map<string, GuildEmojiCacheEntry>
): string {
  if (emoji.id) {
    const cached = emojisById.get(emoji.id);
    if (cached) {
      return `<${cached.animated ? "a" : ""}:${cached.name}:>`;
    }
    return emoji.name ? `:${emoji.name}:` : emoji.identifier;
  }
  return emoji.name ?? emoji.identifier;
}

function uniqueMentionedRoles(
  messages: Array<{ mentions?: { roles?: { values: () => Iterable<{ id: string; name: string }> } } }>,
  cachedRoles: GuildRoleCacheEntry[]
): GuildRoleCacheEntry[] {
  const cachedById = new Map(cachedRoles.map((role) => [role.id, role]));
  const rolesById = new Map<string, GuildRoleCacheEntry>();
  for (const message of messages) {
    for (const role of message.mentions?.roles?.values() ?? []) {
      rolesById.set(role.id, cachedById.get(role.id) ?? {
        id: role.id,
        name: role.name,
        color: 0,
        hoist: false,
        mentionable: false,
        managed: false,
        fetchedAt: new Date().toISOString()
      });
    }
  }
  return [...rolesById.values()];
}

function mergeRoleCaches(primary: GuildRoleCacheEntry[], fallback: GuildRoleCacheEntry[]): GuildRoleCacheEntry[] {
  const rolesById = new Map(fallback.map((role) => [role.id, role]));
  for (const role of primary) {
    rolesById.set(role.id, role);
  }
  return [...rolesById.values()];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Discord request aborted.");
  }
}

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MENTION_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_BOT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];
const UNRECOVERABLE_CLOSE_CODE_DESCRIPTIONS: Record<number, string> = {
  4004: "authentication failed: the bot token is invalid or was reset",
  4010: "invalid shard",
  4011: "sharding required",
  4012: "invalid API version",
  4013: "invalid intents",
  4014: "disallowed intents: enable Message Content for this bot in the Discord Developer Portal"
};
const DM_FORGET_COMMAND_NAME = "forget";
const DM_FORGET_WHAT_OPTION_NAME = "what";
const DM_FORGET_CONFIRM_MS = 30_000;
const WAKE_COMMAND_NAME = "wake";
const PRINT_COMMAND_NAME = "print";
const WAIFU_OPTION_NAME = "waifu";
const WAKE_NOTE_OPTION_NAME = "note";
const PRINT_TYPE_OPTION_NAME = "type";
const PRINT_PRIVATE_OPTION_NAME = "private";
/** Commands earlier releases registered on the House bot; removed at registration (§10.4). */
const RETIRED_COMMAND_NAMES = ["run", "stop", "review", "memories", "console", "clear", "debug"];
const MAX_AUTOCOMPLETE_CHOICES = 25;
const MAX_WAKE_NOTE_LENGTH = 500;
const PRINT_INLINE_MAX_CHARS = 1_900;
const OWNER_COMMAND_PERMISSIONS = PermissionFlagsBits.Administrator;

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function sanitizeReplyTarget(value?: string): string | undefined {
  return value && SNOWFLAKE_PATTERN.test(value) ? value : undefined;
}

function sanitizeOptionString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parsePrintCommandType(value: string | null): DiscordPrintCommandType | undefined {
  return value === "system_prompt" || value === "notes" || value === "life" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function closeEventCode(event: { code?: unknown }): string | number | undefined {
  return typeof event.code === "string" || typeof event.code === "number" ? event.code : undefined;
}

function closeEventReason(event: { reason?: unknown }): string | undefined {
  return typeof event.reason === "string" && event.reason.trim() ? event.reason.trim() : undefined;
}

function closeEventWasClean(event: { wasClean?: unknown }): boolean | undefined {
  return typeof event.wasClean === "boolean" ? event.wasClean : undefined;
}

function runtimeIssueLogContext(issue: DiscordRuntimeIssue): Record<string, unknown> {
  return {
    source: issue.source,
    botId: issue.botId,
    shardId: issue.shardId,
    code: issue.code,
    wasClean: issue.wasClean,
    message: issue.message
  };
}

function interactionLogContext(interaction: ChatInputCommandInteraction): Record<string, unknown> {
  return {
    commandName: interaction.commandName,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id
  };
}

function slashCommandLogContext(event: DiscordSlashCommandEvent): Record<string, unknown> {
  return {
    guildId: event.guildId,
    channelId: event.channelId,
    userId: event.userId
  };
}

async function registerHouseCommands(client: Client, logger?: Logger): Promise<void> {
  try {
    const manager = client.application?.commands;
    if (!manager) return;
    const payloads = buildHouseCommandPayloads();
    const commands = await manager.fetch();
    for (const payload of payloads) {
      const existing = commands.find((command) => command.name === payload.name);
      if (existing) {
        await manager.edit(existing.id, payload);
      } else {
        await manager.create(payload);
      }
    }
    for (const retiredName of RETIRED_COMMAND_NAMES) {
      const existing = commands.find((command) => command.name === retiredName);
      if (existing) await manager.delete(existing.id);
    }
  } catch (error) {
    logger?.warn("Failed to register the House bot's slash commands", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

/** DM-eligible waifu bots register one global `/forget` usable only in DMs with the bot (spec 9.1.5). */
export function buildDmCommandPayloads() {
  return [
    {
      name: DM_FORGET_COMMAND_NAME,
      description: "Make her forget our private chat (or everything about you).",
      contexts: [InteractionContextType.BotDM],
      integrationTypes: [ApplicationIntegrationType.GuildInstall],
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: DM_FORGET_WHAT_OPTION_NAME,
          description: "What to forget.",
          required: true,
          choices: [
            { name: "this conversation", value: "conversation" },
            { name: "everything about me", value: "everything" }
          ]
        }
      ]
    }
  ];
}

/** Register `/forget` on a DM-eligible bot; remove a stale one from a bot that lost DMs. */
async function registerDmCommands(client: Client, dm: boolean, logger?: Logger): Promise<void> {
  try {
    const manager = client.application?.commands;
    if (!manager) return;
    const commands = await manager.fetch();
    const existing = commands.find((command) => command.name === DM_FORGET_COMMAND_NAME);
    if (dm) {
      const [payload] = buildDmCommandPayloads();
      if (existing) await manager.edit(existing.id, payload!);
      else await manager.create(payload!);
    } else if (existing) {
      await manager.delete(existing.id);
    }
  } catch (error) {
    logger?.warn("Failed to register waifu DM slash commands", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function buildHouseCommandPayloads() {
  return withGuildContext([
    {
      name: WAKE_COMMAND_NAME,
      description: "Wake a waifu now, with an optional note from you.",
      defaultMemberPermissions: OWNER_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: WAIFU_OPTION_NAME,
          description: "Which waifu to wake.",
          required: true,
          autocomplete: true
        },
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: WAKE_NOTE_OPTION_NAME,
          description: "A note she sees with the wake.",
          required: false,
          max_length: MAX_WAKE_NOTE_LENGTH
        }
      ]
    },
    {
      name: PRINT_COMMAND_NAME,
      description: "Show a waifu's system prompt, notes or recent life (only to you).",
      defaultMemberPermissions: OWNER_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: PRINT_TYPE_OPTION_NAME,
          description: "What to show.",
          required: true,
          choices: [
            { name: "system prompt", value: "system_prompt" },
            { name: "notes (MEMORY.md)", value: "notes" },
            { name: "life (last 20 lines)", value: "life" }
          ]
        },
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: WAIFU_OPTION_NAME,
          description: "Which waifu.",
          required: true,
          autocomplete: true
        },
        {
          type: ApplicationCommandOptionType.Boolean as ApplicationCommandOptionType.Boolean,
          name: PRINT_PRIVATE_OPTION_NAME,
          description: "Also show what came from private chats (hidden by default; only you see the reply).",
          required: false
        }
      ]
    }
  ]);
}

/** The House bot's commands exist only in servers (spec 9.1.5). */
function withGuildContext<T extends object>(payloads: T[]): Array<T & { contexts: InteractionContextType[] }> {
  return payloads.map((payload) => ({ ...payload, contexts: [InteractionContextType.Guild] }));
}

