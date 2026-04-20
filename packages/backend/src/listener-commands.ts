import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client
} from "discord.js";
import type { ConfigManager } from "./config-manager.js";
import { Logger } from "./utils/logger.js";

const commandBuilders = [
  new SlashCommandBuilder()
    .setName("context_anchor_here")
    .setDescription("Use only messages sent after this point as orchestration context.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("context_anchor_clear")
    .setDescription("Clear the context anchor and allow older channel history again.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder()
    .setName("orchestrator_now")
    .setDescription("Force an immediate orchestrator check for this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
];

export class ListenerCommandManager {
  private readonly logger = new Logger("ListenerCommands");

  constructor(
    private readonly configManager: ConfigManager,
    private readonly triggerOrchestrator: (channelId: string) => Promise<void>,
    private readonly onDebugEvent?: (type: string, payload: Record<string, unknown>) => void
  ) {}

  async register(client: Client): Promise<void> {
    if (!client.application) {
      return;
    }

    const guildIds = [...new Set(this.configManager.channels.map((channel) => channel.guildId))];
    const commandPayload = commandBuilders.map((command) => command.toJSON());

    await Promise.all(
      guildIds.map(async (guildId) => {
        await client.application?.commands.set(commandPayload, guildId);
      })
    );

    this.logger.info("Listener bot commands synced", { guildIds });
  }

  async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({
        content: "This command only works inside a configured server channel.",
        ephemeral: true
      });
      return;
    }

    switch (interaction.commandName) {
      case "context_anchor_here":
        await this.handleContextAnchorHere(interaction);
        return;
      case "context_anchor_clear":
        await this.handleContextAnchorClear(interaction);
        return;
      case "orchestrator_now":
        await this.handleOrchestratorNow(interaction);
        return;
      default:
        return;
    }
  }

  private async handleContextAnchorHere(interaction: ChatInputCommandInteraction): Promise<void> {
    const channelConfig = this.findChannelConfig(interaction);
    if (!channelConfig) {
      await interaction.reply({
        content: "This channel is not configured in the orchestrator dashboard.",
        ephemeral: true
      });
      return;
    }

    const previousAnchorMessageId = channelConfig.contextAnchorMessageId;
    if (previousAnchorMessageId && interaction.channel?.isTextBased()) {
      try {
        if ("messages" in interaction.channel && interaction.channel.messages) {
          const previousAnchorMessage = await interaction.channel.messages.fetch(
            previousAnchorMessageId
          );
          await previousAnchorMessage.delete();
        }
      } catch (error) {
        this.logger.warn("Failed to delete previous context anchor message", {
          channelId: interaction.channelId,
          anchorMessageId: previousAnchorMessageId,
          error
        });
      }
    }

    const reply = await interaction.reply({
      content:
        "Context anchor set. The orchestrator will only pull messages sent after this marker.",
      withResponse: true
    });
    const replyMessageId = reply.resource?.message?.id;
    if (!replyMessageId) {
      throw new Error("Failed to resolve context anchor reply message ID");
    }

    await this.configManager.saveChannels(
      this.configManager.channels.map((entry) =>
        entry.channelId === channelConfig.channelId
          ? { ...entry, contextAnchorMessageId: replyMessageId }
          : entry
      )
    );

    this.onDebugEvent?.("command.context_anchor_here", {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      previousAnchorMessageId,
      anchorMessageId: replyMessageId
    });
  }

  private async handleContextAnchorClear(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const channelConfig = this.findChannelConfig(interaction);
    if (!channelConfig) {
      await interaction.reply({
        content: "This channel is not configured in the orchestrator dashboard.",
        ephemeral: true
      });
      return;
    }

    if (channelConfig.contextAnchorMessageId && interaction.channel?.isTextBased()) {
      try {
        if ("messages" in interaction.channel && interaction.channel.messages) {
          const anchorMessage = await interaction.channel.messages.fetch(
            channelConfig.contextAnchorMessageId
          );
          await anchorMessage.delete();
        }
      } catch (error) {
        this.logger.warn("Failed to delete context anchor message", {
          channelId: interaction.channelId,
          anchorMessageId: channelConfig.contextAnchorMessageId,
          error
        });
      }
    }

    await this.configManager.saveChannels(
      this.configManager.channels.map((entry) =>
        entry.channelId === channelConfig.channelId
          ? { ...entry, contextAnchorMessageId: null }
          : entry
      )
    );

    await interaction.reply({
      content: "Context anchor cleared. Older history can be used again.",
      ephemeral: true
    });

    this.onDebugEvent?.("command.context_anchor_clear", {
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });
  }

  private async handleOrchestratorNow(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    const channelConfig = this.findChannelConfig(interaction);
    if (!channelConfig) {
      await interaction.reply({
        content: "This channel is not configured in the orchestrator dashboard.",
        ephemeral: true
      });
      return;
    }

    await interaction.reply({
      content: "Forcing an orchestrator check now.",
      ephemeral: true
    });

    this.onDebugEvent?.("command.orchestrator_now", {
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });

    await this.triggerOrchestrator(channelConfig.channelId);
  }

  private findChannelConfig(interaction: ChatInputCommandInteraction) {
    return this.configManager.channels.find(
      (channel) =>
        channel.guildId === interaction.guildId && channel.channelId === interaction.channelId
    );
  }
}
