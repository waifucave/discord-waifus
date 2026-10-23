import {
  ApplicationCommandOptionType,
  Client,
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
import { buildNormalizedDiscordContext } from "./contextBuilder.js";
import { unresolvedMentionIdsByType } from "./memberCache.js";
import { denormalizeModelContentForDiscord } from "./normalization.js";

export type DiscordRuntimeStatus = {
  connected: boolean;
  orchestratorConnected: boolean;
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

export type DiscordBotKind = "orchestrator" | "waifu";
export type DiscordBotConnectionState = "connected" | "connecting" | "error" | "disabled" | "missing_token";
export type DiscordBotConnectionErrorCode =
  | "invalid_token"
  | "disallowed_intents"
  | "invalid_intents"
  | "gateway_rejected"
  | "network"
  | "orchestrator_unavailable"
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
 * Thrown by `connect()` when the orchestrator bot cannot come online. The orchestrator owns message
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
  onReviewCommand?(listener: DiscordReviewCommandListener): () => void;
  onClearCommand?(listener: DiscordClearCommandListener): () => void;
  onRunCommand?(listener: DiscordRunCommandListener): () => void;
  onRunWaifuAutocomplete?(listener: DiscordRunWaifuAutocompleteListener): () => void;
  onStopCommand?(listener: DiscordStopCommandListener): () => void;
  onMemoriesCommand?(listener: DiscordMemoriesCommandListener): () => void;
  onPrintCommand?(listener: DiscordPrintCommandListener): () => void;
  onPrintWaifuAutocomplete?(listener: DiscordPrintWaifuAutocompleteListener): () => void;
  onDebugCommand?(listener: DiscordDebugCommandListener): () => void;
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
  sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
  }): Promise<{ messageId: string }>;
  sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void>;
  validateDebugChannel?(input: {
    channelId: string;
    requireMessages?: boolean;
    requireSend?: boolean;
  }): Promise<DiscordDebugChannelInfo>;
  sendDebugMessage?(input: {
    channelId: string;
    content: string;
  }): Promise<{ messageId: string }>;
  deleteMessages?(input: {
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
    authorIdByMessageId?: Record<string, string>;
  }): Promise<DiscordDeleteMessagesResult>;
  deleteAllMessages?(input: {
    guildId: string;
    channelId: string;
  }): Promise<DiscordDeleteChannelMessagesResult>;
}

export type DiscordMessageEvent = {
  guildId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorDisplayName?: string;
  authorBot: boolean;
};

export type DiscordMessageListener = (event: DiscordMessageEvent) => void | Promise<void>;

export type DiscordSlashCommandEvent = {
  guildId: string;
  channelId: string;
  userId: string;
  commandMessageId?: string;
  respond: (content: string) => Promise<void>;
};

export type DiscordReviewCommandEvent = DiscordSlashCommandEvent;
export type DiscordClearCommandEvent = DiscordSlashCommandEvent & {
  count?: number;
  type?: DiscordClearType;
};
export type DiscordRunCommandEvent = DiscordSlashCommandEvent & {
  waifuId?: string;
  sceneDirection?: string;
};
export type DiscordAutocompleteChoice = {
  name: string;
  value: string;
};
export type DiscordRunWaifuAutocompleteEvent = {
  guildId?: string;
  channelId?: string;
  focusedValue: string;
  respond: (choices: DiscordAutocompleteChoice[]) => Promise<void>;
};
export type DiscordStopCommandEvent = DiscordSlashCommandEvent;
export type DiscordMemoriesCommandEvent = DiscordSlashCommandEvent;
export type DiscordPrintCommandEvent = DiscordSlashCommandEvent & {
  type?: DiscordPrintCommandType;
  waifuId?: string;
};
export type DiscordPrintWaifuAutocompleteEvent = {
  guildId?: string;
  channelId?: string;
  focusedValue: string;
  respond: (choices: DiscordAutocompleteChoice[]) => Promise<void>;
};
export type DiscordDebugCommandEvent = DiscordSlashCommandEvent & {
  type?: DiscordDebugCommandType;
  sourceChannelId?: string;
};
export type DiscordReviewCommandListener = (event: DiscordReviewCommandEvent) => void | Promise<void>;
export type DiscordClearCommandListener = (event: DiscordClearCommandEvent) => void | Promise<void>;
export type DiscordRunCommandListener = (event: DiscordRunCommandEvent) => void | Promise<void>;
export type DiscordRunWaifuAutocompleteListener = (event: DiscordRunWaifuAutocompleteEvent) => void | Promise<void>;
export type DiscordStopCommandListener = (event: DiscordStopCommandEvent) => void | Promise<void>;
export type DiscordMemoriesCommandListener = (event: DiscordMemoriesCommandEvent) => void | Promise<void>;
export type DiscordPrintCommandListener = (event: DiscordPrintCommandEvent) => void | Promise<void>;
export type DiscordPrintWaifuAutocompleteListener = (
  event: DiscordPrintWaifuAutocompleteEvent
) => void | Promise<void>;
export type DiscordDebugCommandListener = (event: DiscordDebugCommandEvent) => void | Promise<void>;

export type DiscordClearType = "waifus" | "users" | "both" | "everything";
export type DiscordDebugCommandType = "set" | "unset";
export type DiscordPrintCommandType = "system_prompt" | "memories" | "personality";

export type DiscordDeleteMessagesResult = {
  deletedMessageIds: string[];
  failedMessageIds: Array<{ messageId: string; message: string }>;
};

export type DiscordDeleteChannelMessagesResult = {
  scannedMessageCount: number;
  deletedCount: number;
  failedCount: number;
  failedMessageIds: Array<{ messageId: string; message: string }>;
};

export type DiscordDebugChannelInfo = {
  channelId: string;
  guildId?: string;
  name?: string;
};

export type DiscordChannelMetadata = {
  guildId: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
};

type DiscordCache = {
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  roles?: GuildRoleCacheEntry[];
};

type DiscordFetchedMessageForDelete = {
  id: string;
  createdTimestamp?: number;
};

type DiscordMessageManageableChannel = {
  messages: {
    fetch(options: { limit?: number; before?: string }): Promise<{ values(): Iterable<DiscordFetchedMessageForDelete> }>;
    delete(messageId: string): Promise<unknown>;
  };
  bulkDelete?(messages: string[], filterOld?: boolean): Promise<{ keys(): IterableIterator<string> }>;
};

export type DiscordJsGatewayOptions = {
  orchestrator: DiscordBotConfig;
  waifus?: DiscordBotConfig[];
  members?: GuildMemberCacheEntry[];
  emojis?: GuildEmojiCacheEntry[];
  cacheForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshMembersForGuild?: (guildId: string) => Promise<DiscordCache>;
  refreshRolesForGuild?: (guildId: string) => Promise<DiscordCache>;
  onRuntimeIssue?: (issue: DiscordRuntimeIssue) => void | Promise<void>;
  /** Called with the full status whenever a bot's connection changes after `connect()` returned. */
  onStatusChange?: (status: DiscordRuntimeStatus) => void | Promise<void>;
  /** Backoff for re-logging a waifu bot whose login failed on a network error. */
  botRetryDelaysMs?: number[];
  /** Test seam: build the discord.js client for a bot. */
  createClient?: (input: { bot: DiscordBotConfig; kind: DiscordBotKind; options: ClientOptions }) => Client;
  logger?: Logger;
};

type ConnectableBot = {
  bot: DiscordBotConfig;
  kind: DiscordBotKind;
  token: string;
};

export class DiscordJsGateway implements DiscordGatewayFacade {
  private readonly clients = new Map<string, Client>();
  private readonly pendingClients = new Set<Client>();
  private readonly botStatuses = new Map<string, DiscordBotConnectionStatus>();
  private readonly botRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly botRetryAttempts = new Map<string, number>();
  // Bumped by every disconnect so logins that finish afterwards are destroyed instead of adopted.
  private generation = 0;
  private connectAbort = new AbortController();
  private readonly listeners = new Set<DiscordMessageListener>();
  private readonly reviewListeners = new Set<DiscordReviewCommandListener>();
  private readonly clearListeners = new Set<DiscordClearCommandListener>();
  private readonly runListeners = new Set<DiscordRunCommandListener>();
  private readonly runWaifuAutocompleteListeners = new Set<DiscordRunWaifuAutocompleteListener>();
  private readonly stopListeners = new Set<DiscordStopCommandListener>();
  private readonly memoriesListeners = new Set<DiscordMemoriesCommandListener>();
  private readonly printListeners = new Set<DiscordPrintCommandListener>();
  private readonly printWaifuAutocompleteListeners = new Set<DiscordPrintWaifuAutocompleteListener>();
  private readonly debugListeners = new Set<DiscordDebugCommandListener>();
  private readonly recentMentionRefreshes = new Map<string, number>();
  private readonly runCooldowns = new Map<string, number>();

  constructor(private readonly options: DiscordJsGatewayOptions) {}

  async connect(): Promise<DiscordRuntimeStatus> {
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
    const orchestratorId = this.options.orchestrator.id;
    if (!this.clients.has(orchestratorId)) {
      // Without the orchestrator nothing reads channels or answers commands, so connected waifus
      // would only be idle sessions. Take everything down and let the caller decide on a retry.
      const index = connectable.findIndex((entry) => entry.bot.id === orchestratorId);
      const result = index >= 0 ? results[index] : undefined;
      const cause = result?.status === "rejected" ? result.reason : undefined;
      const orchestratorStatus = this.botStatuses.get(orchestratorId);
      const message = cause !== undefined
        ? errorMessage(cause)
        : orchestratorStatus?.state === "disabled"
          ? "The orchestrator Discord bot is disabled."
          : "No orchestrator Discord bot token is configured.";
      for (const [botId, status] of this.botStatuses) {
        if (botId !== orchestratorId && status.state === "connected") {
          this.botStatuses.set(botId, {
            ...status,
            state: "error",
            errorCode: "orchestrator_unavailable",
            error: "Disconnected because the orchestrator bot is offline.",
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
    this.generation += 1;
    this.connectAbort.abort();
    this.connectAbort = new AbortController();
    for (const timer of this.botRetryTimers.values()) clearTimeout(timer);
    this.botRetryTimers.clear();
    this.botRetryAttempts.clear();
    const clients = [...this.clients.values(), ...this.pendingClients];
    this.clients.clear();
    this.pendingClients.clear();
    await Promise.all(clients.map((client) => destroyClientQuietly(client)));
  }

  /** Current connection status, including every configured bot's outcome. */
  status(): DiscordRuntimeStatus {
    const bots = [...this.botStatuses.values()].map((status) => ({ ...status }));
    const warnings: string[] = [];
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
      .filter((status) => status.state === "error" && status.errorCode !== "orchestrator_unavailable")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    return {
      connected: this.clients.size > 0,
      orchestratorConnected: this.clients.has(this.options.orchestrator.id),
      waifuBotCount: (this.options.waifus ?? []).filter((bot) => this.clients.has(bot.id)).length,
      warnings,
      ...(latestError ? { lastError: latestError.error, lastErrorAt: latestError.updatedAt } : {}),
      bots
    };
  }

  private configuredBots(): Array<{ bot: DiscordBotConfig; kind: DiscordBotKind }> {
    return [
      { bot: this.options.orchestrator, kind: "orchestrator" as const },
      ...(this.options.waifus ?? [])
        .filter((bot) => bot.id !== this.options.orchestrator.id)
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
        // The orchestrator's retry is owned by the backend (it reconnects everything); a waifu on
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
    if (kind === "orchestrator") {
      await registerOrchestratorCommands(client, this.options.logger);
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
    const options = discordClientOptions(kind);
    const client = this.options.createClient?.({ bot, kind, options }) ?? new Client(options);
    this.attachClientRuntimeHandlers(client, bot.id);
    if (kind === "orchestrator") {
      this.attachOrchestratorListeners(client);
    }
    return client;
  }

  private attachOrchestratorListeners(client: Client): void {
    client.on("messageCreate", (message) => {
      if (!message.guildId) return;
      const event: DiscordMessageEvent = {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        authorId: message.author.id,
        authorDisplayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        authorBot: message.author.bot
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
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        if (interaction.commandName === RUN_COMMAND_NAME) {
          this.runBackground("Discord run autocomplete interaction failed", {
            commandName: interaction.commandName,
            guildId: interaction.guildId,
            channelId: interaction.channelId
          }, () => this.handleRunAutocompleteInteraction(interaction));
        } else if (interaction.commandName === PRINT_COMMAND_NAME) {
          this.runBackground("Discord print autocomplete interaction failed", {
            commandName: interaction.commandName,
            guildId: interaction.guildId,
            channelId: interaction.channelId
          }, () => this.handlePrintAutocompleteInteraction(interaction));
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === REVIEW_COMMAND_NAME) {
        this.runBackground("Discord review interaction failed", interactionLogContext(interaction), () =>
          this.handleReviewInteraction(interaction)
        );
      } else if (interaction.commandName === CLEAR_COMMAND_NAME) {
        this.runBackground("Discord clear interaction failed", interactionLogContext(interaction), () =>
          this.handleClearInteraction(interaction)
        );
      } else if (interaction.commandName === RUN_COMMAND_NAME) {
        this.runBackground("Discord run interaction failed", interactionLogContext(interaction), () =>
          this.handleRunInteraction(interaction)
        );
      } else if (interaction.commandName === STOP_COMMAND_NAME) {
        this.runBackground("Discord stop interaction failed", interactionLogContext(interaction), () =>
          this.handleStopInteraction(interaction)
        );
      } else if (interaction.commandName === MEMORIES_COMMAND_NAME) {
        this.runBackground("Discord memories interaction failed", interactionLogContext(interaction), () =>
          this.handleMemoriesInteraction(interaction)
        );
      } else if (interaction.commandName === PRINT_COMMAND_NAME) {
        this.runBackground("Discord print interaction failed", interactionLogContext(interaction), () =>
          this.handlePrintInteraction(interaction)
        );
      } else if (interaction.commandName === DEBUG_COMMAND_NAME) {
        this.runBackground("Discord debug interaction failed", interactionLogContext(interaction), () =>
          this.handleDebugInteraction(interaction)
        );
      }
    });
  }

  onMessage(listener: DiscordMessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onReviewCommand(listener: DiscordReviewCommandListener): () => void {
    this.reviewListeners.add(listener);
    return () => this.reviewListeners.delete(listener);
  }

  onClearCommand(listener: DiscordClearCommandListener): () => void {
    this.clearListeners.add(listener);
    return () => this.clearListeners.delete(listener);
  }

  onRunCommand(listener: DiscordRunCommandListener): () => void {
    this.runListeners.add(listener);
    return () => this.runListeners.delete(listener);
  }

  onRunWaifuAutocomplete(listener: DiscordRunWaifuAutocompleteListener): () => void {
    this.runWaifuAutocompleteListeners.add(listener);
    return () => this.runWaifuAutocompleteListeners.delete(listener);
  }

  onStopCommand(listener: DiscordStopCommandListener): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  onMemoriesCommand(listener: DiscordMemoriesCommandListener): () => void {
    this.memoriesListeners.add(listener);
    return () => this.memoriesListeners.delete(listener);
  }

  onPrintCommand(listener: DiscordPrintCommandListener): () => void {
    this.printListeners.add(listener);
    return () => this.printListeners.delete(listener);
  }

  onPrintWaifuAutocomplete(listener: DiscordPrintWaifuAutocompleteListener): () => void {
    this.printWaifuAutocompleteListeners.add(listener);
    return () => this.printWaifuAutocompleteListeners.delete(listener);
  }

  onDebugCommand(listener: DiscordDebugCommandListener): () => void {
    this.debugListeners.add(listener);
    return () => this.debugListeners.delete(listener);
  }

  async listGuilds(): Promise<Array<{ guildId: string; name: string }>> {
    const client = this.orchestratorClient();
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
    const client = this.orchestratorClient();
    const [guild, channel] = await Promise.all([
      client.guilds.fetch(input.guildId),
      client.channels.fetch(input.channelId)
    ]);
    if (!channel) {
      throw new Error(`Discord channel ${input.channelId} is not accessible to the orchestrator bot.`);
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
      channelName: "name" in channel && typeof channel.name === "string" ? channel.name : undefined
    };
  }

  async fetchFreshContext(input: {
    guildId: string;
    channelId: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<ContextMessage[]> {
    throwIfAborted(input.signal);
    const client = this.orchestratorClient();
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
        orchestratorAuthorIds: botAuthorIds([this.options.orchestrator]),
        waifuAuthorIds: botAuthorIds(this.options.waifus ?? [])
      }
    ).messages;
  }

  async sendWaifuMessage(input: {
    guildId: string;
    channelId: string;
    content: string;
    senderBotId?: string;
    replyToMessageId?: string;
    allowedUserMentionIds: string[];
  }): Promise<{ messageId: string }> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.orchestratorClient();
    if (!client) {
      throw new Error(input.senderBotId
        ? `Waifu Discord bot ${input.senderBotId} is not connected.`
        : "Orchestrator Discord client is not connected.");
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
    const sent = await channel.send({
      content: denormalized.content,
      allowedMentions: denormalized.allowedMentions,
      // The user may delete their message while the waifu is generating; send as a normal message
      // then instead of letting Discord reject the whole reply.
      reply: replyToMessageId ? { messageReference: replyToMessageId, failIfNotExists: false } : undefined
    });
    return { messageId: sent.id };
  }

  async sendTyping(input: {
    guildId: string;
    channelId: string;
    senderBotId?: string;
  }): Promise<void> {
    const client = input.senderBotId ? this.clients.get(input.senderBotId) : this.orchestratorClient();
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

  async validateDebugChannel(input: {
    channelId: string;
    requireMessages?: boolean;
    requireSend?: boolean;
  }): Promise<DiscordDebugChannelInfo> {
    const channel = await this.orchestratorClient().channels.fetch(input.channelId);
    if (!channel) {
      throw new Error(`Discord channel ${input.channelId} is not accessible to the orchestrator bot.`);
    }
    if (input.requireMessages && !("messages" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not readable by the orchestrator bot.`);
    }
    if (input.requireSend && !("send" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not sendable by the orchestrator bot.`);
    }
    return {
      channelId: input.channelId,
      guildId: "guildId" in channel && typeof channel.guildId === "string" ? channel.guildId : undefined,
      name: "name" in channel && typeof channel.name === "string" ? channel.name : undefined
    };
  }

  async sendDebugMessage(input: {
    channelId: string;
    content: string;
  }): Promise<{ messageId: string }> {
    const channel = await this.orchestratorClient().channels.fetch(input.channelId);
    if (!channel || !("send" in channel)) {
      throw new Error(`Discord channel ${input.channelId} is not sendable by the orchestrator bot.`);
    }
    const sent = await channel.send({
      content: input.content,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }
    });
    return { messageId: sent.id };
  }

  async deleteMessages(input: {
    guildId: string;
    channelId: string;
    messageIds: string[];
    authorId?: string;
    authorIdByMessageId?: Record<string, string>;
  }): Promise<DiscordDeleteMessagesResult> {
    const result: DiscordDeleteMessagesResult = {
      deletedMessageIds: [],
      failedMessageIds: []
    };
    if (input.messageIds.length === 0) return result;

    const orchestrator = this.orchestratorClient();
    const orchestratorChannel = await orchestrator.channels.fetch(input.channelId);
    if (!orchestratorChannel || !("messages" in orchestratorChannel)) {
      throw new Error(`Discord channel ${input.channelId} is not message-manageable.`);
    }

    const remaining = new Set(input.messageIds);
    const supportsBulkDelete =
      "bulkDelete" in orchestratorChannel &&
      typeof (orchestratorChannel as { bulkDelete?: unknown }).bulkDelete === "function";
    if (input.messageIds.length >= 2 && supportsBulkDelete) {
      try {
        const bulkChannel = orchestratorChannel as unknown as {
          bulkDelete(messages: string[], filterOld?: boolean): Promise<{ keys(): IterableIterator<string> }>;
        };
        const bulkDeleted = await bulkChannel.bulkDelete(input.messageIds, true);
        for (const id of bulkDeleted.keys()) {
          if (remaining.has(id)) {
            result.deletedMessageIds.push(id);
            remaining.delete(id);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger?.warn(
          "Discord bulk delete failed, falling back to per-message deletes",
          {
            guildId: input.guildId,
            channelId: input.channelId,
            messageCount: input.messageIds.length,
            message
          }
        );
      }
    }

    if (remaining.size === 0) return result;

    const channelByBotId = new Map<string, typeof orchestratorChannel>();
    channelByBotId.set(this.options.orchestrator.id, orchestratorChannel);
    for (const messageId of input.messageIds) {
      if (!remaining.has(messageId)) continue;
      const messageAuthorId = input.authorIdByMessageId?.[messageId] ?? input.authorId;
      const client = this.clientForAuthor(messageAuthorId);
      const botId = this.botIdForClient(client);
      let channel = botId ? channelByBotId.get(botId) : undefined;
      try {
        if (!channel) {
          const fetched = await client.channels.fetch(input.channelId);
          if (!fetched || !("messages" in fetched)) {
            throw new Error(`Discord channel ${input.channelId} is not message-manageable from this bot.`);
          }
          channel = fetched;
          if (botId) channelByBotId.set(botId, fetched);
        }
        await channel.messages.delete(messageId);
        result.deletedMessageIds.push(messageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.failedMessageIds.push({ messageId, message });
        this.options.logger?.warn("Failed to delete Discord message", {
          guildId: input.guildId,
          channelId: input.channelId,
          messageId,
          authorId: messageAuthorId,
          deletingBotId: botId,
          message
        });
      }
    }
    return result;
  }

  async deleteAllMessages(input: {
    guildId: string;
    channelId: string;
  }): Promise<DiscordDeleteChannelMessagesResult> {
    const result: DiscordDeleteChannelMessagesResult = {
      scannedMessageCount: 0,
      deletedCount: 0,
      failedCount: 0,
      failedMessageIds: []
    };

    const orchestrator = this.orchestratorClient();
    const fetchedChannel = await orchestrator.channels.fetch(input.channelId);
    if (!fetchedChannel || !("messages" in fetchedChannel)) {
      throw new Error(`Discord channel ${input.channelId} is not message-manageable.`);
    }
    const channel = fetchedChannel as unknown as DiscordMessageManageableChannel;

    let before: string | undefined;
    while (true) {
      const page = await channel.messages.fetch(before ? { limit: 100, before } : { limit: 100 });
      const messages = [...page.values()];
      if (messages.length === 0) break;
      result.scannedMessageCount += messages.length;

      await this.deleteFetchedMessages({
        guildId: input.guildId,
        channelId: input.channelId,
        channel,
        messages,
        result
      });

      const nextBefore = oldestMessageId(messages);
      if (!nextBefore || nextBefore === before) break;
      before = nextBefore;
    }

    return result;
  }

  private async deleteFetchedMessages(input: {
    guildId: string;
    channelId: string;
    channel: DiscordMessageManageableChannel;
    messages: DiscordFetchedMessageForDelete[];
    result: DiscordDeleteChannelMessagesResult;
  }): Promise<void> {
    const remaining = new Set(input.messages.map((message) => message.id));
    const bulkIds = input.messages
      .filter((message) => isBulkDeletableMessage(message))
      .map((message) => message.id);

    if (bulkIds.length >= 2 && input.channel.bulkDelete) {
      for (const chunk of chunks(bulkIds, DISCORD_BULK_DELETE_MAX_MESSAGES)) {
        if (chunk.length < 2) continue;
        try {
          const bulkDeleted = await input.channel.bulkDelete(chunk, true);
          for (const id of bulkDeleted.keys()) {
            if (remaining.delete(id)) {
              input.result.deletedCount += 1;
            }
          }
        } catch (error) {
          this.options.logger?.warn("Discord bulk delete failed during full channel clear", {
            guildId: input.guildId,
            channelId: input.channelId,
            messageCount: chunk.length,
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    for (const message of input.messages) {
      if (!remaining.has(message.id)) continue;
      try {
        await input.channel.messages.delete(message.id);
        remaining.delete(message.id);
        input.result.deletedCount += 1;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        remaining.delete(message.id);
        input.result.failedCount += 1;
        input.result.failedMessageIds.push({ messageId: message.id, message: errorMessage });
        this.options.logger?.warn("Failed to delete Discord message during full channel clear", {
          guildId: input.guildId,
          channelId: input.channelId,
          messageId: message.id,
          message: errorMessage
        });
      }
    }
  }

  private async cacheForGuild(guildId: string): Promise<DiscordCache> {
    return this.options.cacheForGuild?.(guildId) ?? {
      members: this.options.members,
      emojis: this.options.emojis
    };
  }

  private orchestratorClient(): Client {
    const client = this.clients.get(this.options.orchestrator.id);
    if (!client) {
      throw new Error("Orchestrator Discord client is not connected.");
    }
    return client;
  }

  private clientForAuthor(authorId?: string): Client {
    if (authorId) {
      const bots = [this.options.orchestrator, ...(this.options.waifus ?? [])];
      const bot = bots.find((candidate) => candidate.id === authorId || candidate.applicationId === authorId);
      const client = bot ? this.clients.get(bot.id) : undefined;
      if (client) {
        return client;
      }
    }
    return this.orchestratorClient();
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
    if (entry.kind === "orchestrator") {
      // Same policy as connect(): waifus cannot be cast without the orchestrator. End this session
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
          errorCode: "orchestrator_unavailable",
          error: "Disconnected because the orchestrator bot is offline.",
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

  private async handleReviewInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.reviewListeners, REVIEW_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/review can only be used in a server channel.");
      return;
    }
    const event: DiscordReviewCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.reviewListeners) {
      this.dispatchListener("Discord review command listener failed", listener, event, slashCommandLogContext(event));
    }
  }

  private async handleClearInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.clearListeners, CLEAR_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/clear can only be used in a server channel.");
      return;
    }
    const event: DiscordClearCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      count: interaction.options.getInteger(CLEAR_COUNT_OPTION_NAME) ?? undefined,
      type: parseClearType(interaction.options.getString(CLEAR_TYPE_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.clearListeners) {
      this.dispatchListener("Discord clear command listener failed", listener, event, slashCommandLogContext(event));
    }
  }

  private async handleRunInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.runListeners, RUN_COMMAND_NAME)) return;
    if (!interaction.guildId || !interaction.channelId) {
      await replyEphemeral(interaction, "/run can only be used in a server channel.");
      return;
    }
    // Default member permissions can be overridden per server, and /run carries a private scene
    // direction straight into the prompt, so the permission is enforced here too.
    if (!interaction.memberPermissions?.has(RUN_COMMAND_PERMISSIONS)) {
      await replyEphemeral(interaction, "You need the Manage Messages permission to use /run.");
      return;
    }
    const cooldownMs = this.takeRunCooldown(interaction.guildId, interaction.user.id);
    if (cooldownMs > 0) {
      await replyEphemeral(interaction, `/run is cooling down; try again in ${Math.ceil(cooldownMs / 1000)}s.`);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const event: DiscordRunCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      waifuId: sanitizeRunString(interaction.options.getString(RUN_WAIFU_OPTION_NAME)),
      sceneDirection: sanitizeRunString(interaction.options.getString(RUN_SCENE_DIRECTION_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.runListeners) {
      this.dispatchListener("Discord run command listener failed", listener, event, slashCommandLogContext(event));
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

  /** Returns the remaining cooldown, or 0 after recording this use. */
  private takeRunCooldown(guildId: string, userId: string): number {
    const now = Date.now();
    const key = `${guildId}:${userId}`;
    const last = this.runCooldowns.get(key);
    if (last !== undefined && now - last < RUN_COMMAND_COOLDOWN_MS) {
      return RUN_COMMAND_COOLDOWN_MS - (now - last);
    }
    if (this.runCooldowns.size >= MAX_RUN_COOLDOWN_ENTRIES) {
      for (const [entryKey, at] of this.runCooldowns) {
        if (now - at >= RUN_COMMAND_COOLDOWN_MS) this.runCooldowns.delete(entryKey);
      }
    }
    this.runCooldowns.set(key, now);
    return 0;
  }

  private async handleRunAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== RUN_WAIFU_OPTION_NAME) {
      await interaction.respond([]);
      return;
    }
    const event: DiscordRunWaifuAutocompleteEvent = {
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId ?? undefined,
      focusedValue: typeof focused.value === "string" ? focused.value : String(focused.value ?? ""),
      respond: async (choices) => {
        await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE_CHOICES));
      }
    };
    if (this.runWaifuAutocompleteListeners.size === 0) {
      await interaction.respond([]);
      return;
    }
    await Promise.all([...this.runWaifuAutocompleteListeners].map((listener) =>
      this.callListener("Discord run autocomplete listener failed", listener, event, {
        guildId: event.guildId,
        channelId: event.channelId,
        focusedValue: event.focusedValue
      })
    ));
  }

  private async handleStopInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.stopListeners, STOP_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/stop can only be used in a server channel.");
      return;
    }
    const event: DiscordStopCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.stopListeners) {
      this.dispatchListener("Discord stop command listener failed", listener, event, slashCommandLogContext(event));
    }
  }

  private async handleMemoriesInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.memoriesListeners, MEMORIES_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/memories can only be used in a server channel.");
      return;
    }
    const event: DiscordMemoriesCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.memoriesListeners) {
      this.dispatchListener("Discord memories command listener failed", listener, event, slashCommandLogContext(event));
    }
  }

  private async handlePrintInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.printListeners, PRINT_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/print can only be used in a server channel.");
      return;
    }
    const event: DiscordPrintCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      type: parsePrintCommandType(interaction.options.getString(PRINT_TYPE_OPTION_NAME)),
      waifuId: sanitizeRunString(interaction.options.getString(PRINT_WAIFU_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
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

  private async handlePrintAutocompleteInteraction(interaction: AutocompleteInteraction): Promise<void> {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== PRINT_WAIFU_OPTION_NAME) {
      await interaction.respond([]);
      return;
    }
    const event: DiscordPrintWaifuAutocompleteEvent = {
      guildId: interaction.guildId ?? undefined,
      channelId: interaction.channelId ?? undefined,
      focusedValue: typeof focused.value === "string" ? focused.value : String(focused.value ?? ""),
      respond: async (choices) => {
        await interaction.respond(choices.slice(0, MAX_AUTOCOMPLETE_CHOICES));
      }
    };
    if (this.printWaifuAutocompleteListeners.size === 0) {
      await interaction.respond([]);
      return;
    }
    await Promise.all([...this.printWaifuAutocompleteListeners].map((listener) =>
      this.callListener("Discord print autocomplete listener failed", listener, event, {
        guildId: event.guildId,
        channelId: event.channelId,
        focusedValue: event.focusedValue
      })
    ));
  }

  private async handleDebugInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (await this.replyIfNotReady(interaction, this.debugListeners, DEBUG_COMMAND_NAME)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.guildId || !interaction.channelId) {
      await interaction.editReply("/console can only be used in a server channel.");
      return;
    }
    const event: DiscordDebugCommandEvent = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      type: parseDebugCommandType(interaction.options.getString(DEBUG_TYPE_OPTION_NAME)),
      sourceChannelId: sanitizeRunString(interaction.options.getString(DEBUG_CHANNEL_ID_OPTION_NAME)),
      respond: async (content) => {
        await interaction.editReply(content);
      }
    };
    for (const listener of this.debugListeners) {
      this.dispatchListener("Discord debug command listener failed", listener, event, {
        ...slashCommandLogContext(event),
        type: event.type,
        sourceChannelId: event.sourceChannelId
      });
    }
  }
}

/**
 * The orchestrator reads every channel (messages, reactions, content) and owns slash commands.
 * Waifu clients never listen: they only fetch a channel, send, type and delete their own messages,
 * all over REST, so they need just `Guilds` (channel cache) and keep no message/member caches.
 */
function discordClientOptions(kind: DiscordBotKind): ClientOptions {
  if (kind === "orchestrator") {
    return {
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction]
    };
  }
  return {
    intents: [GatewayIntentBits.Guilds],
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
const REVIEW_COMMAND_NAME = "review";
const CLEAR_COMMAND_NAME = "clear";
const RUN_COMMAND_NAME = "run";
const STOP_COMMAND_NAME = "stop";
const MEMORIES_COMMAND_NAME = "memories";
const PRINT_COMMAND_NAME = "print";
const DEBUG_COMMAND_NAME = "console";
const LEGACY_DEBUG_COMMAND_NAMES = ["debug"];
const CLEAR_COUNT_OPTION_NAME = "count";
const CLEAR_TYPE_OPTION_NAME = "type";
const PRINT_TYPE_OPTION_NAME = "type";
const PRINT_WAIFU_OPTION_NAME = "waifu";
const DEBUG_TYPE_OPTION_NAME = "type";
const DEBUG_CHANNEL_ID_OPTION_NAME = "channel_id";
const RUN_WAIFU_OPTION_NAME = "waifu";
const RUN_SCENE_DIRECTION_OPTION_NAME = "scene_direction";
const MAX_CLEAR_COUNT = 100;
const MAX_AUTOCOMPLETE_CHOICES = 25;
const DISCORD_BULK_DELETE_MAX_MESSAGES = 100;
const DISCORD_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const ADMIN_COMMAND_PERMISSIONS = PermissionFlagsBits.Administrator;
// /run only nudges the scene (with an optional private direction), so moderators may use it.
const RUN_COMMAND_PERMISSIONS = PermissionFlagsBits.ManageMessages;
const RUN_COMMAND_COOLDOWN_MS = 15_000;
const MAX_RUN_COOLDOWN_ENTRIES = 1_000;

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

function sanitizeReplyTarget(value?: string): string | undefined {
  return value && SNOWFLAKE_PATTERN.test(value) ? value : undefined;
}

function sanitizeRunString(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function parseDebugCommandType(value: string | null): DiscordDebugCommandType | undefined {
  // /console only registers set/unset choices; Discord rejects anything else.
  return value === "set" || value === "unset" ? value : undefined;
}

function parsePrintCommandType(value: string | null): DiscordPrintCommandType | undefined {
  return value === "system_prompt" || value === "memories" || value === "personality" ? value : undefined;
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
    userId: event.userId,
    commandMessageId: event.commandMessageId
  };
}

function isBulkDeletableMessage(message: DiscordFetchedMessageForDelete): boolean {
  return message.createdTimestamp === undefined || Date.now() - message.createdTimestamp < DISCORD_BULK_DELETE_MAX_AGE_MS;
}

function oldestMessageId(messages: DiscordFetchedMessageForDelete[]): string | undefined {
  if (messages.length === 0) return undefined;
  if (messages.some((message) => typeof message.createdTimestamp !== "number")) {
    return messages[messages.length - 1]?.id;
  }
  let oldest = messages[0];
  for (const message of messages.slice(1)) {
    if ((message.createdTimestamp ?? 0) < (oldest.createdTimestamp ?? 0)) {
      oldest = message;
    }
  }
  return oldest.id;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function registerOrchestratorCommands(client: Client, logger?: Logger): Promise<void> {
  try {
    const manager = client.application?.commands;
    if (!manager) return;
    const payloads = buildOrchestratorCommandPayloads();
    const commands = await manager.fetch();
    for (const payload of payloads) {
      const existing = commands.find((command) => command.name === payload.name);
      if (existing) {
        await manager.edit(existing.id, payload);
      } else {
        await manager.create(payload);
      }
    }
    const payloadNames = new Set(payloads.map((payload) => payload.name));
    for (const legacyName of LEGACY_DEBUG_COMMAND_NAMES) {
      if (payloadNames.has(legacyName)) continue;
      const existing = commands.find((command) => command.name === legacyName);
      if (existing) {
        await manager.delete(existing.id);
      }
    }
  } catch (error) {
    logger?.warn("Failed to register orchestrator slash commands", {
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

export function buildOrchestratorCommandPayloads() {
  return [
    {
      name: REVIEW_COMMAND_NAME,
      description: "Review and remove the latest waifu message if it leaked hallucinated internals.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS
    },
    {
      name: CLEAR_COMMAND_NAME,
      description: "Delete channel messages without running reviewer judgment.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: CLEAR_TYPE_OPTION_NAME,
          description: "Which messages to clear.",
          required: true,
          choices: [
            { name: "waifus", value: "waifus" },
            { name: "users", value: "users" },
            { name: "both", value: "both" },
            { name: "everything", value: "everything" }
          ]
        },
        {
          type: ApplicationCommandOptionType.Integer as ApplicationCommandOptionType.Integer,
          name: CLEAR_COUNT_OPTION_NAME,
          description: "How many latest messages to delete for waifus, users, or both.",
          required: false,
          min_value: 1,
          max_value: MAX_CLEAR_COUNT
        }
      ]
    },
    {
      name: RUN_COMMAND_NAME,
      description: "Run the orchestrator in this channel immediately if the runtime is idle.",
      defaultMemberPermissions: RUN_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: RUN_WAIFU_OPTION_NAME,
          description: "Optional waifu id or display name to speak first.",
          required: false,
          autocomplete: true
        },
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: RUN_SCENE_DIRECTION_OPTION_NAME,
          description: "Optional private scene direction for the selected waifu.",
          required: false
        }
      ]
    },
    {
      name: STOP_COMMAND_NAME,
      description: "Stop the current orchestrator and waifu work in this channel.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS
    },
    {
      name: MEMORIES_COMMAND_NAME,
      description: "Run the stage manager for this channel and update guild memories.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS
    },
    {
      name: PRINT_COMMAND_NAME,
      description: "Print a configured waifu field for this server.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: PRINT_TYPE_OPTION_NAME,
          description: "Which waifu field to print.",
          required: true,
          choices: [
            { name: "system prompt", value: "system_prompt" },
            { name: "memories", value: "memories" },
            { name: "personality", value: "personality" }
          ]
        },
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: PRINT_WAIFU_OPTION_NAME,
          description: "Waifu to inspect from this server.",
          required: true,
          autocomplete: true
        }
      ]
    },
    {
      name: DEBUG_COMMAND_NAME,
      description: "Route debug logs for a source channel.",
      defaultMemberPermissions: ADMIN_COMMAND_PERMISSIONS,
      options: [
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: DEBUG_TYPE_OPTION_NAME,
          description: "Whether to set or unset debug output.",
          required: true,
          choices: [
            { name: "set", value: "set" },
            { name: "unset", value: "unset" }
          ]
        },
        {
          type: ApplicationCommandOptionType.String as ApplicationCommandOptionType.String,
          name: DEBUG_CHANNEL_ID_OPTION_NAME,
          description: "Source channel ID for set/unset.",
          required: false
        }
      ]
    }
  ];
}

function parseClearType(value: string | null): DiscordClearType | undefined {
  if (value === "waifus" || value === "users" || value === "both" || value === "everything") {
    return value;
  }
  if (value === "all") {
    return "both";
  }
  return undefined;
}
