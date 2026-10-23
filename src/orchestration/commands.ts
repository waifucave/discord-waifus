// Discord slash-command handlers: /review, /clear, /run (+ autocomplete), /stop, /memories,
// /print (+ autocomplete) and /console debug routing.

import {
  DiscordAutocompleteChoice,
  DiscordClearCommandEvent,
  DiscordClearType,
  DiscordDebugCommandEvent,
  DiscordMemoriesCommandEvent,
  DiscordPrintCommandEvent,
  DiscordPrintWaifuAutocompleteEvent,
  DiscordReviewCommandEvent,
  DiscordRunCommandEvent,
  DiscordRunWaifuAutocompleteEvent,
  DiscordStopCommandEvent
} from "../discord/client.js";
import { ServerConfig, WaifuConfig } from "../shared/schemas/domain.js";
import { loadPlaceResolver, renderMemoryLine } from "./memorySnapshot.js";
import { loadSubjectDirectory, subjectNameResolver } from "./memorySubjects.js";
import type { ContextMessage } from "./contextMessages.js";
import { formatPrintDebugBlock, formatWaifuPromptDebugMessages } from "./debugFormat.js";
import { conversationKey } from "./context/keys.js";
import { ResponderExecutor, waifuPromptCaptureKey } from "./responderExecutor.js";
import { ReviewerRunner } from "./reviewerRunner.js";
import { type ChannelRunOptions, type RuntimeServices, type StageManagerRunResult, isHumanUserMessage } from "./runtimeShared.js";
import {
  channelHasWaifus,
  ensureServer,
  listAvailableWaifusForChannel,
  listAvailableWaifusForGuild,
  listWaifus
} from "./stores/config.js";
import { setDebugRoute, unsetDebugRoute } from "./stores/debugRoutes.js";
import { readMemoryStore } from "./stores/memories.js";
import { legacyServerContextWindow } from "./contextWindows.js";

/** What the command handlers need from the runtime facade. */
export type CommandHost = {
  runtimeBusyReason(guildId: string, channelId: string): string | undefined;
  startChannelRunBackground(guildId: string, channelId: string, reason: string, options?: ChannelRunOptions): void;
  stopChannel(guildId: string, channelId: string, reason?: string): Promise<{
    stoppedRun: boolean;
    clearedRetrigger: boolean;
    activeInAnotherChannel: boolean;
  }>;
  triggerStageManager(guildId: string, channelId: string): Promise<StageManagerRunResult>;
  runReviewer: ReviewerRunner["runReviewer"];
  lastSentWaifuPrompts: ResponderExecutor["lastSentWaifuPrompts"];
  renderWaifuSystemPrompt: ResponderExecutor["renderWaifuSystemPrompt"];
};

export class RuntimeCommands {
  constructor(
    private readonly options: RuntimeServices,
    private readonly host: CommandHost
  ) {}

  async handleReviewCommand(event: DiscordReviewCommandEvent): Promise<void> {
    try {
      const result = await this.host.runReviewer({
        guildId: event.guildId,
        channelId: event.channelId,
        userId: event.userId,
        commandMessageId: event.commandMessageId
      });
      if (result.messageIds.length === 0) {
        await event.respond("No waifu message found to review.");
      } else if (result.hallucination && result.deleted) {
        await event.respond(`Removed ${result.messageIds.length} hallucinated waifu message chunk${result.messageIds.length === 1 ? "" : "s"}.`);
      } else if (result.hallucination) {
        await event.respond("Reviewer flagged the message, but deletion failed. Check bot message permissions.");
      } else {
        await event.respond("Reviewer found no hallucination in the latest waifu message.");
      }
    } catch (error) {
      this.options.logger.error("Reviewer command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Reviewer failed.");
    }
  }

  async handleClearCommand(event: DiscordClearCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Clear type is required. Choose waifus, users, both, or everything.");
        return;
      }
      if (event.type === "everything") {
        const result = await this.clearAllChannelMessages(event.guildId, event.channelId);
        if (result.deletedCount === 0 && result.failedCount === 0) {
          await event.respond("No messages found to clear.");
        } else if (result.failedCount > 0) {
          const deletedLabel = clearMessageLabel("everything", result.deletedCount);
          const failedLabel = clearMessageLabel("everything", result.failedCount);
          await event.respond(
            `Cleared ${result.deletedCount} ${deletedLabel}. Failed to delete ${result.failedCount} ${failedLabel}. Check bot message permissions.`
          );
        } else {
          await event.respond(`Cleared ${result.deletedCount} ${clearMessageLabel("everything", result.deletedCount)}.`);
        }
        return;
      }
      if (event.count === undefined) {
        await event.respond("Count is required for this clear type.");
        return;
      }
      const result = await this.clearLatestMessages(event.guildId, event.channelId, event.count, event.type);
      if (result.messageIds.length === 0) {
        await event.respond(noClearTargetsMessage(event.type));
      } else if (result.deleted) {
        const messageLabel = clearMessageLabel(event.type, result.logicalMessageCount);
        const chunkSuffix = result.messageIds.length === result.logicalMessageCount
          ? ""
          : ` (${result.messageIds.length} Discord chunks)`;
        await event.respond(`Cleared ${result.logicalMessageCount} ${messageLabel}${chunkSuffix}.`);
      } else {
        await event.respond("Clear failed. Check bot message permissions.");
      }
    } catch (error) {
      this.options.logger.error("Clear command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Clear failed.");
    }
  }

  async handleRunCommand(event: DiscordRunCommandEvent): Promise<void> {
    try {
      const busyReason = this.host.runtimeBusyReason(event.guildId, event.channelId);
      if (busyReason) {
        await event.respond(busyReason);
        return;
      }
      if (this.options.isPaused?.()) {
        await event.respond("Runtime is paused; /run did not start.");
        return;
      }
      if (event.waifuId) {
        const resolved = await this.resolveRunWaifu(event.guildId, event.channelId, event.waifuId);
        if (typeof resolved === "string") {
          await event.respond(resolved);
          return;
        }
        await event.respond(`Started directed run for ${resolved.displayName}.`);
        this.host.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}:${resolved.id}`, {
          initialResponders: [
            {
              waifuId: resolved.id,
              delaySeconds: 0,
              directive: event.sceneDirection
                ? { intent: "manual" as const, goal: event.sceneDirection }
                : undefined
            }
          ],
          initialReason: `Manual /run selected ${resolved.id}.`
        });
        return;
      }
      await event.respond(event.sceneDirection ? "Started orchestrator run with scene direction." : "Started orchestrator run.");
      this.host.startChannelRunBackground(event.guildId, event.channelId, `slash-run:${event.userId}`, {
        firstOrchestratorMustReply: true,
        firstResponderSceneDirectionOverride: event.sceneDirection
      });
    } catch (error) {
      this.options.logger.error("Run command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Run failed.");
    }
  }

  async handleRunWaifuAutocomplete(event: DiscordRunWaifuAutocompleteEvent): Promise<void> {
    try {
      if (!event.guildId || !event.channelId) {
        await event.respond([]);
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const channel = server.channels[event.channelId];
      if (!channelHasWaifus(channel)) {
        await event.respond([]);
        return;
      }
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await listAvailableWaifusForChannel(this.options.storage, channel))
        .filter((waifu) => waifu.botId && waifu.modelId)
        .filter((waifu) => {
          if (!query) return true;
          return [waifu.id, waifu.name, waifu.displayName].some((value) =>
            normalizeRunWaifuName(value).includes(query)
          );
        })
        .map((waifu): DiscordAutocompleteChoice => ({
          name: autocompleteWaifuName(waifu),
          value: waifu.id
        }))
        .slice(0, 25);
      await event.respond(choices);
    } catch (error) {
      this.options.logger.warn("Run waifu autocomplete failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond([]);
    }
  }

  async handleStopCommand(event: DiscordStopCommandEvent): Promise<void> {
    try {
      const result = await this.host.stopChannel(event.guildId, event.channelId, `slash-stop:${event.userId}`);
      if (result.stoppedRun || result.clearedRetrigger) {
        await event.respond("Stopped orchestrator and waifu work in this channel.");
      } else if (result.activeInAnotherChannel) {
        await event.respond("No work was running in this channel. Another channel in this server is active.");
      } else {
        await event.respond("No orchestrator or waifu work was running in this channel.");
      }
    } catch (error) {
      this.options.logger.error("Stop command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Stop failed.");
    }
  }

  async handlePrintWaifuAutocomplete(event: DiscordPrintWaifuAutocompleteEvent): Promise<void> {
    try {
      if (!event.guildId) {
        await event.respond([]);
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const query = normalizeRunWaifuName(event.focusedValue);
      const choices = (await listAvailableWaifusForGuild(this.options.storage, server))
        .filter((waifu) => {
          if (!query) return true;
          return [waifu.id, waifu.name, waifu.displayName].some((value) =>
            normalizeRunWaifuName(value).includes(query)
          );
        })
        .map((waifu): DiscordAutocompleteChoice => ({
          name: autocompleteWaifuName(waifu),
          value: waifu.id
        }))
        .slice(0, 25);
      await event.respond(choices);
    } catch (error) {
      this.options.logger.warn("Print waifu autocomplete failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond([]);
    }
  }

  async handleMemoriesCommand(event: DiscordMemoriesCommandEvent): Promise<void> {
    try {
      const result = await this.host.triggerStageManager(event.guildId, event.channelId);
      if (result.status === "updated") {
        await event.respond(result.message ?? "Observer and dream pass updated memories.");
      } else if (result.status === "no_change") {
        await event.respond(result.message ?? "Observer and dream pass found no memory changes.");
      } else if (result.status === "already_running") {
        await event.respond("Memory work is already running in this channel.");
      } else if (result.status === "disabled") {
        await event.respond("Memory work is disabled or missing a model.");
      } else {
        await event.respond(result.message ?? "Memory work failed. Check logs.");
      }
    } catch (error) {
      this.options.logger.error("Memories command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Stage manager failed.");
    }
  }

  async handlePrintCommand(event: DiscordPrintCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Print type is required. Choose system prompt, memories, or personality.");
        return;
      }
      const waifuId = event.waifuId?.trim();
      if (!waifuId) {
        await event.respond("Waifu is required.");
        return;
      }
      const server = await ensureServer(this.options.storage, event.guildId);
      const availableWaifus = await listAvailableWaifusForGuild(this.options.storage, server);
      if (availableWaifus.length === 0) {
        await event.respond("No waifus are enabled in this server.");
        return;
      }
      const resolved = this.resolvePrintWaifu(availableWaifus, waifuId);
      if (typeof resolved === "string") {
        await event.respond(resolved);
        return;
      }
      if (!event.followUp && !this.options.discord.sendDebugMessage) {
        throw new Error("Discord debug message sending is not available.");
      }

      // The roster of the prompt is the channel's cast (not every waifu enabled in the guild).
      const channelCast = server.channels[event.channelId]
        ? await listAvailableWaifusForChannel(this.options.storage, server.channels[event.channelId]!)
        : [];
      const messages = await this.formatPrintCommandMessages({
        guildId: event.guildId,
        channelId: event.channelId,
        server,
        waifu: resolved,
        availableWaifus: channelCast.length > 0 ? channelCast : availableWaifus,
        type: event.type
      });
      // Prefer the invoker-only (ephemeral) follow-up: prompts are not for the whole channel.
      for (const content of messages) {
        if (event.followUp) await event.followUp(content);
        else await this.options.discord.sendDebugMessage!({ channelId: event.channelId, content });
      }
      await event.respond(printCommandConfirmation(event.type, resolved.displayName));
    } catch (error) {
      this.options.logger.error("Print command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        type: event.type,
        waifuId: event.waifuId,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Print command failed.");
    }
  }

  private async formatPrintCommandMessages(input: {
    guildId: string;
    channelId: string;
    server: ServerConfig;
    waifu: WaifuConfig;
    availableWaifus: WaifuConfig[];
    type: Exclude<DiscordPrintCommandEvent["type"], undefined>;
  }): Promise<string[]> {
    if (input.type === "system_prompt") {
      const key = conversationKey({ kind: "guild", guildId: input.guildId, channelId: input.channelId });
      const captured = this.host.lastSentWaifuPrompts.get(waifuPromptCaptureKey(key, input.waifu.id));
      if (captured) {
        return [
          `Captured from ${input.waifu.displayName}'s last reply at ${captured.at} in <#${captured.channelId}> — exactly what the model received.`,
          ...formatWaifuPromptDebugMessages({ waifuDisplayName: input.waifu.displayName, debug: redactPrivateMemories(captured.debug) })
        ];
      }
      if (!input.waifu.modelId) {
        return [`${input.waifu.displayName} has no model configured, so she has no prompt yet.`];
      }
      const system = await this.host.renderWaifuSystemPrompt({
        guildId: input.guildId,
        channelId: input.channelId,
        server: input.server,
        waifu: { ...input.waifu, modelId: input.waifu.modelId },
        availableWaifus: input.availableWaifus
      });
      return [
        `${input.waifu.displayName} has not replied in this channel since the backend started — showing her static system prompt; the epoch header, transcript and tail are built on her next reply.`,
        ...formatPrintDebugBlock(`System prompt (${input.waifu.displayName})`, system)
      ];
    }
    if (input.type === "memories") {
      const content = await this.allMemoriesBlockForPrint(input.guildId, input.waifu);
      return formatPrintDebugBlock(`Memories (${input.waifu.displayName})`, content);
    }
    const digest = input.waifu.personaDigest;
    const digestText = digest
      ? `Voice: ${digest.voice}\nDrives: ${digest.role}`
      : "(no digest generated yet — her style block uses only the verbosity rule)";
    return [
      ...formatPrintDebugBlock(
        `Personality block 1 — raw persona (${input.waifu.displayName})`,
        input.waifu.persona.trim() || "(no personality configured)"
      ),
      ...formatPrintDebugBlock(
        `Personality block 2 — persona digest (${input.waifu.displayName})`,
        digestText
      )
    ];
  }

  /**
   * Every memory of this waifu — active AND archived — newest first, with flags and provenance.
   * Memories are global (spec 8.8), so this is not filtered by guild; it is printed into a guild
   * channel, so DM-origin memories are never included (only counted).
   */
  private async allMemoriesBlockForPrint(guildId: string, waifu: WaifuConfig): Promise<string> {
    const now = new Date();
    const store = await readMemoryStore(this.options.storage);
    const own = store.memories.filter((record) => record.waifuId === waifu.id);
    const privateCount = own.filter((record) => record.origin.dm).length;
    const records = own
      .filter((record) => !record.origin.dm)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const privateNote = privateCount > 0 ? `\n(${privateCount} memor${privateCount === 1 ? "y" : "ies"} from private chats not shown)` : "";
    if (records.length === 0) return `(none)${privateNote}`;
    const [directory, placeFor] = await Promise.all([
      loadSubjectDirectory(this.options.storage, guildId),
      loadPlaceResolver(this.options.storage, records.map((record) => record.origin.guildId).filter((id): id is string => Boolean(id)))
    ]);
    const nameFor = subjectNameResolver([directory]);
    const active = records.filter((record) => record.status === "active").length;
    const lines = records.map((record) => {
      const expired = record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime();
      const flags = [record.status, record.archivedReason, expired ? "expired" : undefined, record.pinned ? "pinned" : undefined, `s${record.strength}`]
        .filter(Boolean)
        .join("|");
      return `[${flags}] ${renderMemoryLine(record, { now, nameFor, placeFor }).replace(/^- /, "")}`;
    });
    return `${records.length} total (${active} active, ${records.length - active} archived)\n${lines.join("\n")}${privateNote}`;
  }

  async handleDebugCommand(event: DiscordDebugCommandEvent): Promise<void> {
    try {
      if (!event.type) {
        await event.respond("Debug type is required. Choose set or unset.");
        return;
      }
      const sourceChannelId = event.sourceChannelId?.trim();
      if (!sourceChannelId) {
        await event.respond("Source channel ID is required for set and unset.");
        return;
      }
      if (event.type === "unset") {
        const removed = await unsetDebugRoute(this.options.storage, sourceChannelId);
        await event.respond(
          removed
            ? `Debug logs disabled for channel ${sourceChannelId}.`
            : `No debug route is set for channel ${sourceChannelId}.`
        );
        return;
      }
      if (!this.options.discord.validateDebugChannel) {
        throw new Error("Discord debug channel validation is not available.");
      }
      const [source, destination] = await Promise.all([
        this.options.discord.validateDebugChannel({ channelId: sourceChannelId, requireMessages: true }),
        this.options.discord.validateDebugChannel({ channelId: event.channelId, requireSend: true })
      ]);
      await setDebugRoute(this.options.storage, {
        sourceGuildId: source.guildId,
        sourceChannelId,
        destinationGuildId: destination.guildId ?? event.guildId,
        destinationChannelId: event.channelId,
        userId: event.userId
      });
      await event.respond(`Debug logs for channel ${sourceChannelId} will be posted in this channel.`);
    } catch (error) {
      this.options.logger.error("Debug command failed", {
        guildId: event.guildId,
        channelId: event.channelId,
        sourceChannelId: event.sourceChannelId,
        type: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      await event.respond(error instanceof Error ? error.message : "Debug command failed.");
    }
  }

  private async clearLatestMessages(guildId: string, channelId: string, count: number, type: DiscordClearType): Promise<{
    deleted: boolean;
    logicalMessageCount: number;
    messageIds: string[];
  }> {
    const clearCount = normalizeClearCount(count);
    const server = await ensureServer(this.options.storage, guildId);
    const messages = await this.options.discord.fetchFreshContext({
      guildId,
      channelId,
      limit: Math.max(legacyServerContextWindow("waifu", server), clearCount)
    });
    const targets = [...messages]
      .reverse()
      .filter((message) => isClearTarget(message, type))
      .slice(0, clearCount);
    const seenMessageIds = new Set<string>();
    const messageIds: string[] = [];
    const authorIdByMessageId: Record<string, string> = {};
    for (const target of targets) {
      const targetMessageIds = target.sourceMessageIds ?? [target.id];
      for (const messageId of targetMessageIds) {
        if (seenMessageIds.has(messageId)) continue;
        seenMessageIds.add(messageId);
        messageIds.push(messageId);
        authorIdByMessageId[messageId] = target.authorId;
      }
    }
    if (targets.length === 0 || messageIds.length === 0) {
      return { deleted: false, logicalMessageCount: 0, messageIds: [] };
    }
    if (!this.options.discord.deleteMessages) {
      throw new Error("Discord message deletion is not available.");
    }
    const deletion = await this.options.discord.deleteMessages({
      guildId,
      channelId,
      messageIds,
      authorIdByMessageId
    });
    const deletedMessageIds = new Set(deletion.deletedMessageIds);
    return {
      deleted: messageIds.every((messageId) => deletedMessageIds.has(messageId)),
      logicalMessageCount: targets.length,
      messageIds
    };
  }

  private async clearAllChannelMessages(guildId: string, channelId: string): Promise<{
    deletedCount: number;
    failedCount: number;
  }> {
    if (!this.options.discord.deleteAllMessages) {
      throw new Error("Discord full-channel message deletion is not available.");
    }
    const deletion = await this.options.discord.deleteAllMessages({ guildId, channelId });
    return {
      deletedCount: deletion.deletedCount,
      failedCount: deletion.failedCount
    };
  }

  private async resolveRunWaifu(guildId: string, channelId: string, value: string): Promise<WaifuConfig | string> {
    const server = await ensureServer(this.options.storage, guildId);
    const channel = server.channels[channelId];
    if (!channelHasWaifus(channel)) {
      return "No waifus are enabled in this channel.";
    }
    const waifus = await listWaifus(this.options.storage);
    const waifusById = new Map(waifus.map((waifu) => [waifu.id, waifu]));
    const channelWaifus = (channel.enabledWaifuIds ?? [])
      .map((waifuId) => waifusById.get(waifuId))
      .filter((waifu): waifu is WaifuConfig => Boolean(waifu));

    const exactId = channelWaifus.find((waifu) => waifu.id === value);
    if (exactId) {
      return this.validateRunWaifuTarget(exactId);
    }

    const query = normalizeRunWaifuName(value);
    const matches = channelWaifus.filter((waifu) =>
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (matches.length === 1) {
      return this.validateRunWaifuTarget(matches[0]);
    }
    if (matches.length > 1) {
      return `Waifu "${value}" is ambiguous; use the exact waifu id.`;
    }

    const anyWaifuMatch = waifus.find((waifu) =>
      waifu.id === value ||
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (anyWaifuMatch) {
      return `${anyWaifuMatch.displayName} is not enabled in this channel.`;
    }
    return `Waifu "${value}" was not found.`;
  }

  private validateRunWaifuTarget(waifu: WaifuConfig): WaifuConfig | string {
    if (!waifu.botId) {
      return `${waifu.displayName} does not have a linked Discord bot.`;
    }
    if (!waifu.modelId) {
      return `${waifu.displayName} does not have a configured model.`;
    }
    return waifu;
  }

  private resolvePrintWaifu(availableWaifus: WaifuConfig[], value: string): WaifuConfig | string {
    const exactId = availableWaifus.find((waifu) => waifu.id === value);
    if (exactId) {
      return exactId;
    }

    const query = normalizeRunWaifuName(value);
    const matches = availableWaifus.filter((waifu) =>
      [waifu.name, waifu.displayName].some((candidate) => normalizeRunWaifuName(candidate) === query)
    );
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return `Waifu "${value}" is ambiguous; use the exact waifu id.`;
    }
    return `Waifu "${value}" is not enabled in this server.`;
  }
}

function normalizeRunWaifuName(value: string): string {
  return value.trim().toLowerCase();
}

function autocompleteWaifuName(waifu: WaifuConfig): string {
  return waifu.displayName === waifu.id ? waifu.id : `${waifu.displayName} (${waifu.id})`;
}

function printCommandConfirmation(type: Exclude<DiscordPrintCommandEvent["type"], undefined>, displayName: string): string {
  if (type === "system_prompt") return `Printed system prompt for ${displayName}.`;
  if (type === "memories") return `Printed memories for ${displayName}.`;
  return `Printed personality for ${displayName}.`;
}

function normalizeClearCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(MAX_CLEAR_COUNT, Math.trunc(count)));
}

function isClearTarget(message: ContextMessage, type: DiscordClearType): boolean {
  if (type === "waifus") {
    return message.authorKind === "waifu";
  }
  if (type === "users") {
    return isHumanUserMessage(message);
  }
  if (type === "both") {
    return message.authorKind === "waifu" || isHumanUserMessage(message);
  }
  return true;
}

function noClearTargetsMessage(type: DiscordClearType): string {
  if (type === "waifus") return "No waifu message found to clear.";
  if (type === "users") return "No user message found to clear.";
  if (type === "both") return "No waifu or user message found to clear.";
  return "No message found to clear.";
}

function clearMessageLabel(type: DiscordClearType, count: number): string {
  if (type === "users") return count === 1 ? "user message" : "user messages";
  if (type === "both" || type === "everything") return count === 1 ? "message" : "messages";
  return count === 1 ? "waifu message" : "waifu messages";
}

const MAX_CLEAR_COUNT = 100;

const PRIVATE_MEMORY_RE = /learned in a private chat/;
const PRIVATE_MEMORY_PLACEHOLDER = "- (a memory from a private chat — not shown here)";

/**
 * O4: a printed prompt never shows what someone said in a private chat. Lines carrying DM
 * provenance (header memories, inline memory notes) are replaced by a placeholder.
 */
export function redactPrivateMemories<T extends { header: string; transcript: string }>(debug: T): T {
  const redact = (text: string) =>
    text
      .split("\n")
      .map((line) => (PRIVATE_MEMORY_RE.test(line) ? PRIVATE_MEMORY_PLACEHOLDER : line))
      .join("\n");
  return { ...debug, header: redact(debug.header), transcript: redact(debug.transcript) };
}
