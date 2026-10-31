// The waifu role (Living cast spec §37, owner request 2026-10-30): the House bot gives every waifu
// bot a role (`discord.waifuRole`, default "waifu") in each server they share, creating it when the
// server has none. It runs when the bots connect and when a bot joins a server; it never removes the
// role, never touches the House bot or anyone else, and a failure (no Manage Roles, the role above the
// House bot's own) is logged and tried again at the next connect or join, or when a role changes there
// (the gateway's `retryWaifuRole`). A role change reaches the
// app as the bot's member update, so an @-mention of the role wakes every waifu there (§10.2).

/** The slice of a discord.js `Guild` this needs (tests pass a fake). */
export type WaifuRoleGuild = {
  id: string;
  roles: {
    fetch(): Promise<ReadonlyMap<string, { id: string; name: string }>>;
    create(options: { name: string; mentionable: boolean; reason: string }): Promise<{ id: string; name: string }>;
  };
  members: {
    fetch(userId: string): Promise<{ roles: { cache: ReadonlyMap<string, unknown>; add(roleId: string, reason: string): Promise<unknown> } }>;
  };
};

export const WAIFU_ROLE_REASON = "Discord Waifus: the waifu role for every waifu bot";

/** The server's role with this name (case-insensitive; the first one Discord lists), if any. */
export function findRole(roles: ReadonlyMap<string, { id: string; name: string }>, name: string): { id: string; name: string } | undefined {
  const wanted = name.toLowerCase();
  return [...roles.values()].find((role) => role.name.toLowerCase() === wanted);
}

/**
 * Gives `botUserIds` the role named `roleName` in `guild`, creating it (mentionable) when missing.
 * Returns whether it was created and which bots got it. A bot that already has it is left alone.
 */
export async function ensureWaifuRole(guild: WaifuRoleGuild, botUserIds: readonly string[], roleName: string): Promise<{ created: boolean; added: string[] }> {
  if (!roleName || botUserIds.length === 0) return { created: false, added: [] };
  let role = findRole(await guild.roles.fetch(), roleName);
  const created = role === undefined;
  role ??= await guild.roles.create({ name: roleName, mentionable: true, reason: WAIFU_ROLE_REASON });
  const added: string[] = [];
  for (const userId of botUserIds) {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(role.id)) continue;
    await member.roles.add(role.id, WAIFU_ROLE_REASON);
    added.push(userId);
  }
  return { created, added };
}
