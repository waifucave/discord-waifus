// The waifu role (Living cast spec §37, owner request 2026-10-30): the House bot gives every waifu
// bot a role (`discord.waifuRole`, default "waifu") in each server they share, creating it when the
// server has none. It runs when the bots connect and when a bot joins a server; it never removes the
// role, never touches the House bot or anyone else, and a failure (no Manage Roles, the role above the
// House bot's own) is logged and tried again at the next connect or join, or when a role changes there
// (the gateway's `retryWaifuRole`). A role change reaches the
// app as the bot's member update, so an @-mention of the role wakes every waifu there (§10.2).
//
// §41 (owner request 2026-11-01): the role carries what a waifu bot needs to talk (her invite's
// permissions), so a bot invited without permissions (no role of its own) still can. A new role is
// created with them; a role the House bot made without them (3.9.1, 3.9.2) gets them added, but only
// while nobody else has edited it, so it never fights a server's own choices.

import { AuditLogEvent, PermissionFlagsBits } from "discord.js";

/** A waifu bot's invite permissions (`src/frontend/utils/discord.ts`, pinned by tests/waifuRole.test.ts). */
export const WAIFU_ROLE_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ReadMessageHistory |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.UseExternalEmojis |
  PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.ChangeNickname;

type Role = { id: string; name: string; permissions?: { bitfield: bigint } };

/** The slice of a discord.js `Guild` this needs (tests pass a fake). */
export type WaifuRoleGuild = {
  id: string;
  roles: {
    fetch(): Promise<ReadonlyMap<string, Role>>;
    create(options: { name: string; mentionable: boolean; permissions: bigint; reason: string }): Promise<Role>;
    edit(roleId: string, options: { permissions: bigint; reason: string }): Promise<unknown>;
  };
  members: {
    /** The House bot's own member: a role can only carry permissions it has itself. */
    me?: { permissions: { bitfield: bigint } } | null;
    fetch(userId: string): Promise<{ roles: { cache: ReadonlyMap<string, unknown>; add(roleId: string, reason: string): Promise<unknown> } }>;
  };
  fetchAuditLogs?(options: { type: AuditLogEvent; limit: number }): Promise<{ entries: ReadonlyMap<string, { targetId: string | null; executorId: string | null }> }>;
};

export const WAIFU_ROLE_REASON = "Discord Waifus: the waifu role for every waifu bot";

/** The server's role with this name (case-insensitive; the first one Discord lists), if any. */
export function findRole<R extends { id: string; name: string }>(roles: ReadonlyMap<string, R>, name: string): R | undefined {
  const wanted = name.toLowerCase();
  return [...roles.values()].find((role) => role.name.toLowerCase() === wanted);
}

/** The waifu permissions the House bot can give: all of them with Administrator, else those it has. */
function grantable(guild: WaifuRoleGuild): bigint {
  const own = guild.members.me?.permissions.bitfield ?? 0n;
  return (own & PermissionFlagsBits.Administrator) !== 0n ? WAIFU_ROLE_PERMISSIONS : WAIFU_ROLE_PERMISSIONS & own;
}

/**
 * Whether the audit log shows `userId` (the House bot) created the role and nobody else has edited
 * it since. No View Audit Log, or the entry older than Discord keeps (45 days): no.
 */
export async function madeOnlyBy(guild: WaifuRoleGuild, roleId: string, userId: string): Promise<boolean> {
  if (!guild.fetchAuditLogs) return false;
  try {
    const [created, updated] = await Promise.all([
      guild.fetchAuditLogs({ type: AuditLogEvent.RoleCreate, limit: 100 }),
      guild.fetchAuditLogs({ type: AuditLogEvent.RoleUpdate, limit: 100 })
    ]);
    const about = (entry: { targetId: string | null }) => entry.targetId === roleId;
    return [...created.entries.values()].some((entry) => about(entry) && entry.executorId === userId) &&
      ![...updated.entries.values()].some((entry) => about(entry) && entry.executorId !== userId);
  } catch {
    return false;
  }
}

/**
 * Gives `botUserIds` the role named `roleName` in `guild`, creating it (mentionable, with the waifu
 * permissions) when missing. An existing role missing some of them gets them added when `ours` says
 * the House bot made it and nobody else changed it. A bot that already has it is left alone.
 */
export async function ensureWaifuRole(
  guild: WaifuRoleGuild,
  botUserIds: readonly string[],
  roleName: string,
  o: { ours?: (roleId: string) => Promise<boolean> } = {}
): Promise<{ created: boolean; added: string[]; granted: boolean }> {
  if (!roleName || botUserIds.length === 0) return { created: false, added: [], granted: false };
  const permissions = grantable(guild);
  let role = findRole(await guild.roles.fetch(), roleName);
  const created = role === undefined;
  role ??= await guild.roles.create({ name: roleName, mentionable: true, permissions, reason: WAIFU_ROLE_REASON });
  let granted = false;
  const held = role.permissions?.bitfield;
  if (!created && held !== undefined && (held & permissions) !== permissions && (await o.ours?.(role.id))) {
    await guild.roles.edit(role.id, { permissions: held | permissions, reason: WAIFU_ROLE_REASON });
    granted = true;
  }
  const added: string[] = [];
  for (const userId of botUserIds) {
    const member = await guild.members.fetch(userId);
    if (member.roles.cache.has(role.id)) continue;
    await member.roles.add(role.id, WAIFU_ROLE_REASON);
    added.push(userId);
  }
  return { created, added, granted };
}
