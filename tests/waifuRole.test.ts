// The waifu role (Living cast spec §37): the House bot gives every waifu bot the role, creating it
// when the server has none; a bot that has it is left alone.
import { describe, expect, it } from "vitest";
import { ensureWaifuRole, findRole, WAIFU_ROLE_REASON, type WaifuRoleGuild } from "../src/discord/waifuRole.js";

function fakeRoleGuild(o: { roles?: Array<{ id: string; name: string }>; memberRoles?: Record<string, string[]> } = {}) {
  const roles = new Map((o.roles ?? []).map((role) => [role.id, role]));
  const memberRoles = new Map(Object.entries(o.memberRoles ?? {}).map(([id, list]) => [id, new Set(list)]));
  const created: Array<{ name: string; mentionable: boolean; reason: string }> = [];
  const added: Array<{ userId: string; roleId: string; reason: string }> = [];
  const guild: WaifuRoleGuild = {
    id: "100",
    roles: {
      fetch: async () => roles,
      create: async (options) => {
        created.push(options);
        const role = { id: `r${roles.size + 1}`, name: options.name };
        roles.set(role.id, role);
        return role;
      }
    },
    members: {
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
    }
  };
  return { guild, roles, created, added };
}

describe("the waifu role (§37)", () => {
  it("creates a mentionable role when the server has none and gives it to each bot", async () => {
    const f = fakeRoleGuild({ roles: [{ id: "r1", name: "Bakers" }] });
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: true, added: ["b1", "b2"] });
    expect(f.created).toEqual([{ name: "waifu", mentionable: true, reason: WAIFU_ROLE_REASON }]);
    expect(f.added.map((entry) => [entry.userId, entry.roleId])).toEqual([["b1", "r2"], ["b2", "r2"]]);
    // Again: nothing to do.
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: false, added: [] });
  });

  it("uses the server's own role whatever its case, and leaves a bot that has it alone", async () => {
    const f = fakeRoleGuild({ roles: [{ id: "r7", name: "Waifu" }], memberRoles: { b1: ["r7"] } });
    expect(await ensureWaifuRole(f.guild, ["b1", "b2"], "waifu")).toEqual({ created: false, added: ["b2"] });
    expect(f.created).toEqual([]);
    expect(findRole(f.roles, "WAIFU")?.id).toBe("r7");
  });

  it("does nothing with no role name or no bots", async () => {
    const f = fakeRoleGuild();
    expect(await ensureWaifuRole(f.guild, ["b1"], "")).toEqual({ created: false, added: [] });
    expect(await ensureWaifuRole(f.guild, [], "waifu")).toEqual({ created: false, added: [] });
    expect(f.created).toEqual([]);
  });
});
