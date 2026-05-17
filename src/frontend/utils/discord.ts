// Discord permission and intent helpers.
// Numeric values verified against https://docs.discord.com/developers/topics/permissions
// and https://docs.discord.com/developers/events/gateway (intents).

export const PERMISSIONS = {
  VIEW_CHANNEL: 1024,
  SEND_MESSAGES: 2048,
  READ_MESSAGE_HISTORY: 65536,
  ADD_REACTIONS: 64,
  USE_EXTERNAL_EMOJIS: 262144,
  EMBED_LINKS: 16384,
  ATTACH_FILES: 32768,
  USE_APPLICATION_COMMANDS: 2147483648
} as const;

export const INTENTS = {
  GUILDS: 1,
  GUILD_MEMBERS: 2, // privileged
  GUILD_MESSAGES: 512,
  GUILD_MESSAGE_REACTIONS: 1024,
  MESSAGE_CONTENT: 32768 // privileged
} as const;

export type BotKind = "orchestrator" | "waifu";

export function permissionBitsFor(kind: BotKind): number {
  const base =
    PERMISSIONS.VIEW_CHANNEL |
    PERMISSIONS.SEND_MESSAGES |
    PERMISSIONS.READ_MESSAGE_HISTORY |
    PERMISSIONS.ADD_REACTIONS |
    PERMISSIONS.USE_EXTERNAL_EMOJIS |
    PERMISSIONS.EMBED_LINKS |
    PERMISSIONS.ATTACH_FILES;
  if (kind === "waifu") return base;
  // Orchestrator owns slash commands too. Use string math so the high bit
  // doesn't get sign-truncated when serialized.
  return Number(BigInt(base) | BigInt(PERMISSIONS.USE_APPLICATION_COMMANDS));
}

export function permissionListFor(kind: BotKind): string[] {
  const names = [
    "View Channel",
    "Send Messages",
    "Read Message History",
    "Add Reactions",
    "Use External Emojis",
    "Embed Links",
    "Attach Files"
  ];
  if (kind === "orchestrator") names.push("Use Application Commands (slash)");
  return names;
}

export function intentListFor(_kind: BotKind): Array<{ name: string; privileged: boolean; required: boolean; note?: string }> {
  return [
    { name: "GUILDS", privileged: false, required: true },
    { name: "GUILD_MESSAGES", privileged: false, required: true },
    { name: "GUILD_MESSAGE_REACTIONS", privileged: false, required: true },
    {
      name: "MESSAGE_CONTENT",
      privileged: true,
      required: true,
      note: "Without this, the bot receives empty message content except for DMs, mentions, and message-context targets."
    },
    {
      name: "GUILD_MEMBERS",
      privileged: true,
      required: false,
      note: "Only required if you want full member list refreshes for mention resolution. Member cache also works opportunistically from recent messages."
    }
  ];
}

/**
 * Build an OAuth2 invite URL.
 * https://docs.discord.com/developers/topics/oauth2
 * - bot scope is required for the bot to join.
 * - applications.commands is required to register slash commands.
 */
export function buildInviteUrl(applicationId: string, kind: BotKind, guildId?: string): string {
  const params = new URLSearchParams();
  params.set("client_id", applicationId);
  params.set("scope", kind === "orchestrator" ? "bot applications.commands" : "bot");
  params.set("permissions", String(permissionBitsFor(kind)));
  if (guildId) {
    params.set("guild_id", guildId);
    params.set("disable_guild_select", "true");
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export const DISCORD_PORTAL_URL = "https://discord.com/developers/applications";
export const DISCORD_INTENTS_DOC = "https://docs.discord.com/developers/events/gateway#privileged-intents";
export const DISCORD_PERMISSIONS_DOC = "https://docs.discord.com/developers/topics/permissions";
export const DISCORD_OAUTH_DOC = "https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow";

export function isLikelyApplicationId(value: string): boolean {
  return /^\d{17,20}$/.test(value.trim());
}
