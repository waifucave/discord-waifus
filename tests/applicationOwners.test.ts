// Who owns the House bot's application (Living cast §10.4, owner decision D-a): the owner user, or
// the accepted members of the owning team; refreshed periodically and re-fetched at run time when
// the list is stale; a failed fetch keeps the last list; no list means nobody.
import { describe, expect, it } from "vitest";
import { ApplicationOwners, ownerIdsOf } from "../src/discord/applicationOwners.js";

describe("ownerIdsOf", () => {
  it("reads a user owner and a team's accepted members (and its owner)", () => {
    expect(ownerIdsOf({ id: "111", username: "me" })).toEqual(["111"]);
    expect(
      ownerIdsOf({
        ownerId: "222",
        members: new Map([
          ["333", { user: { id: "333" }, membershipState: 2 }],
          ["444", { user: { id: "444" }, membershipState: 1 }],
          ["555", { id: "555" }]
        ])
      }).sort()
    ).toEqual(["222", "333", "555"]);
    expect(ownerIdsOf(null)).toEqual([]);
  });
});

describe("ApplicationOwners", () => {
  it("re-fetches a stale list at run time, keeps the last list when a fetch fails, and denies with none", async () => {
    let now = 0;
    let answer: string[] | Error = ["owner-1"];
    let fetches = 0;
    const owners = new ApplicationOwners({
      now: () => now,
      recheckMs: 60_000,
      fetch: async () => {
        fetches += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      }
    });
    expect(await owners.isOwner("owner-1")).toBe(true);
    expect(await owners.isOwner("someone")).toBe(false);
    expect(fetches).toBe(1);
    // The owner changed on Discord: picked up once the list is stale.
    answer = ["owner-2"];
    now = 30_000;
    expect(await owners.isOwner("owner-2")).toBe(false);
    now = 61_000;
    expect(await owners.isOwner("owner-2")).toBe(true);
    expect(fetches).toBe(2);
    // Discord is unreachable: the last list stands.
    answer = new Error("network down");
    now = 200_000;
    expect(await owners.isOwner("owner-2")).toBe(true);

    const blind = new ApplicationOwners({ fetch: async () => Promise.reject(new Error("no application")) });
    expect(await blind.isOwner("anyone")).toBe(false);
  });
});
