// Discord permission and intent helpers.
// Numeric values verified against https://docs.discord.com/developers/topics/permissions
// and https://docs.discord.com/developers/events/gateway (intents), and pinned to discord.js'
// PermissionFlagsBits by tests/frontendDiscordBots.test.ts.
//
// What each bot kind really does in 3.0 (src/discord/client.ts, `discordClientOptions`):
// - The House bot is the one that READS: it logs in with Guilds, Guild Messages, Guild Message
//   Reactions, Guild Message Typing, Guild Expressions and the privileged Message Content intent (plus the privileged
//   Server Members intent only when `discord.guildMembersIntent` is on). It fetches message
//   history over REST, runs the owner slash commands and joins threads. It never posts. Its invite
//   asks for Administrator (owner request, 2026-10-30), plus View Channels and Read Message History.
// - A waifu bot only WRITES: it posts (including in threads), attaches files, reacts and shows
//   typing. It logs in with Guilds alone (plus the three non-privileged Direct Message intents when
//   she takes DMs). It needs no privileged intent.

const PERMISSIONS = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  ADD_REACTIONS: 1n << 6n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  CHANGE_NICKNAME: 1n << 26n
} as const;

export type BotKind = "house" | "waifu";

type PermissionName = keyof typeof PERMISSIONS;

const PERMISSIONS_BY_KIND: Record<BotKind, Array<{ flag: PermissionName; label: string }>> = {
  // Administrator (owner request, 2026-10-30), so the House bot sees every channel the cast is
  // in without per-channel overrides. View Channels and Read Message History stay listed, so an
  // invite with Administrator unticked still covers what it reads.
  house: [
    { flag: "ADMINISTRATOR", label: "Administrator" },
    { flag: "VIEW_CHANNEL", label: "View Channels" },
    { flag: "READ_MESSAGE_HISTORY", label: "Read Message History" }
  ],
  waifu: [
    { flag: "VIEW_CHANNEL", label: "View Channels" },
    { flag: "SEND_MESSAGES", label: "Send Messages" },
    { flag: "SEND_MESSAGES_IN_THREADS", label: "Send Messages in Threads" },
    { flag: "READ_MESSAGE_HISTORY", label: "Read Message History" },
    { flag: "ADD_REACTIONS", label: "Add Reactions" },
    { flag: "ATTACH_FILES", label: "Attach Files" },
    { flag: "USE_EXTERNAL_EMOJIS", label: "Use External Emojis" },
    { flag: "EMBED_LINKS", label: "Embed Links" },
    // Her per-server nickname overrides (Living cast §17); without it the dashboard warns.
    { flag: "CHANGE_NICKNAME", label: "Change Nickname" }
  ]
};

/** The OAuth2 `permissions` integer. BigInt: Send Messages in Threads is bit 38. */
export function permissionBitsFor(kind: BotKind): string {
  return PERMISSIONS_BY_KIND[kind].reduce((bits, entry) => bits | PERMISSIONS[entry.flag], 0n).toString();
}

export function permissionListFor(kind: BotKind): string[] {
  return PERMISSIONS_BY_KIND[kind].map((entry) => entry.label);
}

/** Flag names and bit values, exported for the test that pins them to discord.js. */
export function permissionFlagsFor(kind: BotKind): Array<{ flag: string; bit: bigint }> {
  return PERMISSIONS_BY_KIND[kind].map((entry) => ({ flag: entry.flag, bit: PERMISSIONS[entry.flag] }));
}

export type IntentInfo = {
  /** What the Developer Portal calls it (a toggle), or the gateway flag for automatic ones. */
  name: string;
  /** Needs the Developer Portal toggle (privileged intents only). */
  portalToggle: boolean;
  privileged: boolean;
  required: boolean;
  note?: string;
};

/**
 * The intents a bot of this kind uses. `portalToggle` entries are the ones the owner has to
 * switch on in the Developer Portal; the rest are requested by the app at login and need nothing.
 */
export function intentListFor(kind: BotKind): IntentInfo[] {
  if (kind === "house") {
    return [
      {
        name: "MESSAGE CONTENT INTENT",
        portalToggle: true,
        privileged: true,
        required: true,
        note: "The House bot reads every message in the rooms and hands it to the waifus. Without this, Discord sends it empty messages and nobody replies."
      },
      {
        name: "SERVER MEMBERS INTENT",
        portalToggle: true,
        privileged: true,
        required: false,
        note: "Only if you turn on discord.guildMembersIntent (Settings) for full member lists and live join/leave events. Otherwise leave it off: names are learned from messages. If the app asks for it and the portal toggle is off, Discord refuses the login and the House bot reconnects without it, with a warning."
      },
      { name: "GUILDS", portalToggle: false, privileged: false, required: true, note: "Requested automatically." },
      { name: "GUILD_MESSAGES", portalToggle: false, privileged: false, required: true, note: "Requested automatically." },
      { name: "GUILD_MESSAGE_REACTIONS", portalToggle: false, privileged: false, required: true, note: "Requested automatically." },
      { name: "GUILD_MESSAGE_TYPING", portalToggle: false, privileged: false, required: true, note: "Requested automatically (a waifu waits while the person she is about to answer is still typing)." },
      { name: "GUILD_EXPRESSIONS", portalToggle: false, privileged: false, required: true, note: "Requested automatically (server emoji and stickers)." }
    ];
  }
  return [
    { name: "GUILDS", portalToggle: false, privileged: false, required: true, note: "Requested automatically." },
    {
      name: "DIRECT_MESSAGES + DIRECT_MESSAGE_REACTIONS + DIRECT_MESSAGE_TYPING",
      portalToggle: false,
      privileged: false,
      required: false,
      note: "Requested automatically, only when she takes DMs (her dm.allowDms setting). Not privileged: there is no portal toggle."
    }
  ];
}

/**
 * Build an OAuth2 invite URL.
 * https://docs.discord.com/developers/topics/oauth2
 * - bot scope is required for the bot to join.
 * - applications.commands is required to register slash commands (the House bot's /wake, /print).
 */
export function buildInviteUrl(applicationId: string, kind: BotKind, guildId?: string): string {
  const params = new URLSearchParams();
  params.set("client_id", applicationId.trim());
  params.set("scope", kind === "house" ? "bot applications.commands" : "bot");
  params.set("permissions", permissionBitsFor(kind));
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
