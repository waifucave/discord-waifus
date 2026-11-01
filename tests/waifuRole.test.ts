// The waifu role (Living cast spec §37): the House bot gives every waifu bot the role, creating it
// when the server has none; a bot that has it is left alone. §41: the role carries the waifu
// permissions, added to an existing one only while the House bot made it and nobody else edited it.
import { AuditLogEvent, PermissionFlagsBits } from "discord.js";
import { describe, expect, it } from "vitest";
import { permissionBitsFor } from "../src/frontend/utils/discord.js";
import { ensureWaifuRole, findRole, madeOnlyBy, WAIFU_ROLE_PERMISSIONS, WAIFU_ROLE_REASON, type WaifuRoleGuild } from "../src/discord/waifuRole.js";

type FakeRole = { id: string; name: string; permissions?: { bitfield: bigint } };

function fakeRoleGuild(o: { roles?: FakeRole[]; memberRoles?: Record<string, string[]>; me?: bigint | null; audit?: Partial<Record<AuditLogEvent, Array<{ targetId: string; executorId: string }>>> } = {}) {
  const roles = new Map((o.roles ?? []).map((role) => [role.id, role]));
  const memberRoles = new Map(Object.entries(o.memberRoles ?? {}).map(([id, list]) => [id, new Set(list)]));
  const created: Array<{ name: string; mentionable: boolean; permissions: bigint; reason: string }> = [];
  const added: Array<{ userId: string; roleId: string; reason: string }> = [];
  const edited: Array<{ roleId: string; permissions: bigint; reason: string }> = [];
  const guild: WaifuRoleGuild = {
    id: "100",
    roles: {
      fetch: async () => roles,
      create: async (options) => {
        created.push(options);
        const role = { id: `r${roles.size + 1}`, name: options.name, permissions: { bitfield: options.permissions } };
        roles.set(role.id, role);
        return role;
      },
      edit: async (roleId, options) => {
        edited.push({ roleId, ...options });
        roles.set(roleId, { ...roles.get(roleId)!, permissions: { bitfield: options.permissions } });
      }
    },
    members: {
      me: o.me === null ? null : { permissions: { bitfield: o.me ?? PermissionFlagsBits.Administrator } },
      fetch: async (userId) => {
        const held = memberRoles.get(userId) ?? new Set<string>();
        memberRoles.set(userId, held);
        return {
          roles: {
            cache: new Map([...held].map((id) => [id, {}])),
            add: async (roleId: string, reason: string) => {
              added.push({ userId, roleId, reason });
              held.add(roleId);
            }
          }
        };
      }
    },
    ...(o.audit
      ? { fetchAuditLogs: async ({ type }: { type: AuditLogEvent }) => ({ entries: new Map((o.audit![type] ?? []).map((entry, i) => [String(i), entry])) }) }
      : {})
  };
  return { guild, roles, created, added, edited };
}

describe("the waifu role (§37)", () => {
  it("creates a mentionable role when the server has none and gives it to each bot", async () => {
    const f = fakeRoleGuild({ roles: [{ id: "r1", name: "Bakers" }] });
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: true, added: ["b1", "b2"], granted: false });
    expect(f.created).toEqual([{ name: "waifu", mentionable: true, permissions: WAIFU_ROLE_PERMISSIONS, reason: WAIFU_ROLE_REASON }]);
    expect(f.added.map((entry) => [entry.userId, entry.roleId])).toEqual([["b1", "r2"], ["b2", "r2"]]);
    // Again: nothing to do.
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: false, added: [], granted: false });
  });

  it("uses the server's own role whatever its case, and leaves a bot that has it alone", async () => {
    const f = fakeRoleGuild({ roles: [{ id: "r7", name: "Waifu" }], memberRoles: { b1: ["r7"] } });
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: false, added: ["b2"], granted: false });
    expect(f.created).toEqual([]);
    expect(findRole(f.roles, "WAIFU")?.id).toBe("r7");
  });

  it("does nothing with no role name or no bots", async () => {
    const f = fakeRoleGuild();
    expect(await ensureWaifuRole(f.guild, ["b1"], "")).toEqual({ created: false, added: [], granted: false });
    expect(await ensureWaifuRole(f.guild, [], "waifu")).toEqual({ created: false, added: [], granted: false });
    expect(f.created).toEqual([]);
  });
});

describe("the waifu role's permissions (§41)", () => {
  const bare = PermissionFlagsBits.ViewChannel;

  it("are a waifu bot's invite permissions", () => {
    expect(WAIFU_ROLE_PERMISSIONS.toString()).toBe(permissionBitsFor("waifu"));
  });

  it("a new role carries only those the House bot has itself, unless it is Administrator", async () => {
    const own = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.ManageRoles;
    const f = fakeRoleGuild({ me: own });
    await ensureWaifuRole(f.guild, ["b1"], "waifu");
    expect(f.created[0]!.permissions).toBe(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages);
    const unknown = fakeRoleGuild({ me: null });
    await ensureWaifuRole(unknown.guild, ["b1"], "waifu");
    expect(unknown.created[0]!.permissions).toBe(0n);
  });

  it("an existing role gets the missing ones, added to its own, only when ours says so", async () => {
    const f = fakeRoleGuild({ roles: [{ id: "r1", name: "waifu", permissions: { bitfield: bare | PermissionFlagsBits.Speak } }] });
    expect((await ensureWaifuRole(f.guild, ["b1"], "waifu", { ours: async () => false })).granted).toBe(false);
    expect((await ensureWaifuRole(f.guild, ["b1"], "waifu")).granted).toBe(false);
    expect(f.edited).toEqual([]);
    expect(await ensureWaifuRole(f.guild, ["b1"], "waifu", { ours: async () => true })).toEqual({ created: false, added: [], granted: true });
    expect(f.edited).toEqual([{ roleId: "r1", permissions: WAIFU_ROLE_PERMISSIONS | PermissionFlagsBits.Speak, reason: WAIFU_ROLE_REASON }]);
    // It has them all now: ours isn't asked again.
    let asked = 0;
    await ensureWaifuRole(f.guild, ["b1"], "waifu", { ours: async () => (asked += 1, true) });
    expect(asked).toBe(0);
  });

  it("madeOnlyBy: the House bot created it and nobody else edited it since; no audit log, no", async () => {
    const created = [{ targetId: "r1", executorId: "house" }, { targetId: "r2", executorId: "owner" }];
    const f = fakeRoleGuild({ audit: { [AuditLogEvent.RoleCreate]: created, [AuditLogEvent.RoleUpdate]: [{ targetId: "r1", executorId: "house" }] } });
    expect(await madeOnlyBy(f.guild, "r1", "house")).toBe(true);
    expect(await madeOnlyBy(f.guild, "r2", "house")).toBe(false);
    expect(await madeOnlyBy(f.guild, "r9", "house")).toBe(false);
    const edited = fakeRoleGuild({ audit: { [AuditLogEvent.RoleCreate]: created, [AuditLogEvent.RoleUpdate]: [{ targetId: "r1", executorId: "owner" }] } });
    expect(await madeOnlyBy(edited.guild, "r1", "house")).toBe(false);
    expect(await madeOnlyBy(fakeRoleGuild().guild, "r1", "house")).toBe(false);
    const failing = { ...f.guild, fetchAuditLogs: async () => { throw new Error("Missing Permissions"); } };
    expect(await madeOnlyBy(failing, "r1", "house")).toBe(false);
  });
});
