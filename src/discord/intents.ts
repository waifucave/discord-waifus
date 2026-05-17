import { GatewayIntentBits, PermissionFlagsBits } from "discord.js";

export const REQUIRED_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions
] as const;

export const PRIVILEGED_GATEWAY_INTENTS = [
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers
] as const;

export const REQUIRED_DISCORD_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages
] as const;

export const DISCORD_SETUP_NOTES = [
  "MESSAGE_CONTENT is required for complete user-authored channel context.",
  "GUILD_MEMBERS is optional for full member-cache refreshes; opportunistic caches still work without it.",
  "Use application commands for setup/status, channel enablement, pause/resume, stage-manager triggers, waifu triggers, and config reloads."
] as const;
