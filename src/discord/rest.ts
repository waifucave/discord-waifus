import { REST, Routes } from "discord.js";
import type { RESTOptions } from "discord.js";

// Member/role cache refreshes run outside the discord.js clients, so they use the same REST client
// discord.js does: it queues per rate-limit bucket, waits out 429s, retries 5xx and sends the
// required `DiscordBot (url, version)` User-Agent.

export type DiscordGuildMemberPayload = {
  nick?: string | null;
  user: {
    id: string;
    username?: string;
    global_name?: string | null;
    bot?: boolean;
  };
};

export type DiscordGuildRolePayload = {
  id: string;
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  managed?: boolean;
};

const MEMBER_PAGE_SIZE = 1000;

export function createDiscordRest(token: string, options: Partial<RESTOptions> = {}): REST {
  return new REST({ version: "10", ...options }).setToken(token.replace(/^Bot\s+/i, ""));
}

let cachedRest: { token: string; rest: REST } | undefined;

/** One shared client per token so rate-limit state survives between refreshes. */
export function discordRestForToken(token: string): REST {
  if (cachedRest?.token !== token) {
    cachedRest?.rest.clearHashSweeper();
    cachedRest?.rest.clearHandlerSweeper();
    cachedRest = { token, rest: createDiscordRest(token) };
  }
  return cachedRest.rest;
}

/** GET an API path such as `/guilds/1/emojis?limit=5`; throws DiscordAPIError/HTTPError on failure. */
export async function discordRestGet(rest: REST, pathAndQuery: string): Promise<unknown> {
  const queryStart = pathAndQuery.indexOf("?");
  const route = (queryStart === -1 ? pathAndQuery : pathAndQuery.slice(0, queryStart)) as `/${string}`;
  const query = queryStart === -1 ? undefined : new URLSearchParams(pathAndQuery.slice(queryStart + 1));
  return rest.get(route, query ? { query } : {});
}

export async function fetchAllDiscordGuildMembers(rest: REST, guildId: string): Promise<DiscordGuildMemberPayload[]> {
  const members: DiscordGuildMemberPayload[] = [];
  let after = "0";
  for (;;) {
    const page = await rest.get(Routes.guildMembers(guildId), {
      query: new URLSearchParams({ limit: String(MEMBER_PAGE_SIZE), after })
    }) as DiscordGuildMemberPayload[];
    members.push(...page);
    const last = page[page.length - 1]?.user.id;
    if (page.length < MEMBER_PAGE_SIZE || !last) {
      return members;
    }
    after = last;
  }
}

export async function fetchDiscordGuildRoles(rest: REST, guildId: string): Promise<DiscordGuildRolePayload[]> {
  return await rest.get(Routes.guildRoles(guildId)) as DiscordGuildRolePayload[];
}
