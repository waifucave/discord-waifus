import { describe, expect, it } from "vitest";
import { DiscordAPIError } from "discord.js";
import {
  createDiscordRest,
  discordRestGet,
  fetchAllDiscordGuildMembers,
  fetchDiscordGuildRoles
} from "../src/discord/rest.js";

type RecordedRequest = { url: string; headers: Record<string, string> };

// Real @discordjs/rest request handling (buckets, 429 backoff, headers) over a fake transport.
function fakeDiscordApi(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const requests: RecordedRequest[] = [];
  const makeRequest = async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected Discord request: ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers }
    });
  };
  return { requests, makeRequest };
}

function member(id: string) {
  return { nick: null, user: { id, username: `user-${id}`, global_name: null, bot: false } };
}

describe("Discord REST refresh helpers", () => {
  it("waits out a 429 and retries instead of failing the member refresh", async () => {
    const api = fakeDiscordApi([
      {
        status: 429,
        body: { message: "You are being rate limited.", retry_after: 0.02, global: false },
        headers: { "retry-after": "0.02", "x-ratelimit-scope": "user" }
      },
      { status: 200, body: [member("1"), member("2")] }
    ]);
    const rest = createDiscordRest("secret-token", { makeRequest: api.makeRequest, offset: 0 });

    const members = await fetchAllDiscordGuildMembers(rest, "guild-1");

    expect(members.map((entry) => entry.user.id)).toEqual(["1", "2"]);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.url).toContain("/guilds/guild-1/members?limit=1000&after=0");
  });

  it("sends a Discord-compliant User-Agent and bot authorization", async () => {
    const api = fakeDiscordApi([{ status: 200, body: [{ id: "role-1", name: "Mods" }] }]);
    const rest = createDiscordRest("Bot secret-token", { makeRequest: api.makeRequest });

    const roles = await fetchDiscordGuildRoles(rest, "guild-1");

    expect(roles).toEqual([{ id: "role-1", name: "Mods" }]);
    expect(api.requests[0]?.headers["user-agent"]).toMatch(/^DiscordBot \(https?:\/\/[^,]+, [\w.-]+\)/);
    expect(api.requests[0]?.headers.authorization).toBe("Bot secret-token");
  });

  it("pages through members 1000 at a time", async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => member(String(index + 1)));
    const api = fakeDiscordApi([
      { status: 200, body: firstPage },
      { status: 200, body: [member("1001")] }
    ]);
    const rest = createDiscordRest("secret-token", { makeRequest: api.makeRequest });

    const members = await fetchAllDiscordGuildMembers(rest, "guild-1");

    expect(members).toHaveLength(1001);
    expect(api.requests[1]?.url).toContain("after=1000");
  });

  it("gets an arbitrary API path with its query string through the rate-limited client", async () => {
    const api = fakeDiscordApi([
      { status: 429, body: { message: "slow down", retry_after: 0.01, global: false }, headers: { "retry-after": "0.01" } },
      { status: 200, body: [{ id: "emoji-1", name: "wave" }] }
    ]);
    const rest = createDiscordRest("secret-token", { makeRequest: api.makeRequest, offset: 0 });

    await expect(discordRestGet(rest, "/guilds/guild-1/emojis?limit=5")).resolves.toEqual([{ id: "emoji-1", name: "wave" }]);
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1]?.url).toMatch(/\/api\/v10\/guilds\/guild-1\/emojis\?limit=5$/);
  });

  it("surfaces Discord API errors with their status", async () => {
    const api = fakeDiscordApi([{ status: 403, body: { message: "Missing Access", code: 50001 } }]);
    const rest = createDiscordRest("secret-token", { makeRequest: api.makeRequest });

    const error = await discordRestGet(rest, "/guilds/guild-1/members?limit=1000&after=0").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DiscordAPIError);
    expect(error).toMatchObject({ status: 403, message: "Missing Access" });
  });
});
