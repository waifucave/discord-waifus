// Zod-free Discord profile rules (Living cast spec §17): her bot's username, bio (the application
// description) and per-server nicknames. Shared by the schema, the profile sync and the dashboard
// (which may import this module at runtime).

export const DISCORD_USERNAME_MIN = 2;
export const DISCORD_USERNAME_MAX = 32;
/** Discord's application description limit; her bio is synced there. */
export const DISCORD_BIO_MAX = 400;
/** Roughly what a profile's About Me shows before "View full profile" in some Discord views. */
export const DISCORD_BIO_VISIBLE = 190;
export const DISCORD_NICKNAME_MAX = 32;

/** Substrings Discord refuses in a bot username (checked case-insensitively). */
export const DISCORD_USERNAME_FORBIDDEN = ["@", "#", ":", "```", "discord", "clyde"] as const;
/** Whole usernames Discord refuses. */
const DISCORD_USERNAME_RESERVED = ["everyone", "here"] as const;

/** Why `value` cannot be a Discord bot username (trimmed first), or undefined when it can. */
export function discordUsernameProblem(value: string): string | undefined {
  const name = value.trim();
  if (name.length < DISCORD_USERNAME_MIN || name.length > DISCORD_USERNAME_MAX) {
    return `A Discord username is ${DISCORD_USERNAME_MIN} to ${DISCORD_USERNAME_MAX} characters (this one has ${name.length}).`;
  }
  const lower = name.toLowerCase();
  const forbidden = DISCORD_USERNAME_FORBIDDEN.find((part) => lower.includes(part));
  if (forbidden) return `A Discord username cannot contain "${forbidden}".`;
  if ((DISCORD_USERNAME_RESERVED as readonly string[]).includes(lower)) return `"${name}" is reserved by Discord.`;
  return undefined;
}

/** Why `value` cannot be a server nickname, or undefined when it can. */
export function discordNicknameProblem(value: string): string | undefined {
  const nick = value.trim();
  if (nick.length < 1 || nick.length > DISCORD_NICKNAME_MAX) return `A server nickname is 1 to ${DISCORD_NICKNAME_MAX} characters.`;
  return undefined;
}

/** The fields the profile sync manages. */
export const DISCORD_PROFILE_FIELDS = ["username", "avatar", "banner", "bio", "nickname"] as const;
export type DiscordProfileField = (typeof DISCORD_PROFILE_FIELDS)[number];
