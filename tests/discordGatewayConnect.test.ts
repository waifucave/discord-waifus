import {
  Client,
  Events,
  GatewayIntentBits,
  GuildMessageManager,
  IntentsBitField,
  LimitedCollection,
  Message,
  MessageFlags,
  MessageManager,
  PermissionFlagsBits
} from "discord.js";
import type { ClientOptions } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordJsGateway, buildHouseCommandPayloads } from "../src/discord/client.js";
import type {
  DiscordBotConnectionStatus,
  DiscordJsGatewayOptions,
  DiscordRuntimeIssue,
  DiscordRuntimeStatus
} from "../src/discord/client.js";
import type { DiscordBotConfig } from "../src/shared/schemas/domain.js";

// Login outcomes for the fake client factory: "ok" emits ClientReady, an Error rejects login, and a
// Deferred holds login open until the test settles it.
type LoginOutcome = "ok" | Error | Deferred;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type FakeClients = {
  factory: NonNullable<DiscordJsGatewayOptions["createClient"]>;
  created: Map<string, Client>;
  createdOptions: Map<string, ClientOptions>;
  destroyed: string[];
  loginAttempts: Map<string, number>;
};

function fakeClients(outcomes: Record<string, LoginOutcome | LoginOutcome[]>): FakeClients {
  const created = new Map<string, Client>();
  const createdOptions = new Map<string, ClientOptions>();
  const destroyed: string[] = [];
  const loginAttempts = new Map<string, number>();
  const factory: FakeClients["factory"] = ({ bot, options }) => {
    const client = new Client(options);
    created.set(bot.id, client);
    createdOptions.set(bot.id, options);
    const mutable = client as unknown as {
      login: (token?: string) => Promise<string>;
      destroy: () => Promise<void>;
    };
    mutable.login = async (token = "") => {
      const attempt = loginAttempts.get(bot.id) ?? 0;
      loginAttempts.set(bot.id, attempt + 1);
      const configured = outcomes[bot.id] ?? "ok";
      const outcome = Array.isArray(configured)
        ? configured[Math.min(attempt, configured.length - 1)]
        : configured;
      if (outcome instanceof Error) throw outcome;
      if (outcome !== "ok") await outcome.promise;
      queueMicrotask(() => client.emit(Events.ClientReady, client as Client<true>));
      return token;
    };
    const realDestroy = client.destroy.bind(client);
    mutable.destroy = async () => {
      destroyed.push(bot.id);
      await realDestroy();
    };
    return client;
  };
  return { factory, created, createdOptions, destroyed, loginAttempts };
}

function bot(id: string, overrides: Partial<DiscordBotConfig> = {}): DiscordBotConfig {
  return { id, displayName: id, token: `${id}-token`, enabled: true, ...overrides };
}

function invalidTokenError(): Error {
  return Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" });
}

function botStatus(status: DiscordRuntimeStatus, botId: string): DiscordBotConnectionStatus | undefined {
  return status.bots?.find((entry) => entry.botId === botId);
}

function connectedBotIds(gateway: DiscordJsGateway): string[] {
  return [...(gateway as unknown as { clients: Map<string, Client> }).clients.keys()].sort();
}

const gateways: DiscordJsGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.disconnect()));
});

function makeGateway(options: Omit<DiscordJsGatewayOptions, "logger">): DiscordJsGateway {
  const gateway = new DiscordJsGateway({ ...options, logger: quietLogger() });
  gateways.push(gateway);
  return gateway;
}

describe("DiscordJsGateway per-bot connection", () => {
  it("keeps healthy bots online when one waifu token is invalid and destroys the failed client", async () => {
    const clients = fakeClients({ "waifu-bad": invalidTokenError() });
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-good"), bot("waifu-bad")],
      createClient: clients.factory
    });

    const status = await gateway.connect();

    expect(status).toMatchObject({ connected: true, houseConnected: true, waifuBotCount: 1 });
    expect(connectedBotIds(gateway)).toEqual(["house", "waifu-good"]);
    expect(clients.destroyed).toEqual(["waifu-bad"]);
    expect(botStatus(status, "waifu-bad")).toMatchObject({
      kind: "waifu",
      state: "error",
      errorCode: "invalid_token",
      error: "An invalid token was provided."
    });
    expect(botStatus(status, "waifu-good")).toMatchObject({ kind: "waifu", state: "connected" });
    expect(botStatus(status, "house")).toMatchObject({ kind: "house", state: "connected" });
    expect(status.warnings.some((warning) => warning.includes("waifu-bad"))).toBe(true);
  });

  it("never logs in bots that are disabled or have no token", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-off", { enabled: false }), bot("waifu-tokenless", { token: undefined })],
      createClient: clients.factory
    });

    const status = await gateway.connect();

    expect([...clients.created.keys()]).toEqual(["house"]);
    expect(status.waifuBotCount).toBe(0);
    expect(botStatus(status, "waifu-off")).toMatchObject({ state: "disabled" });
    expect(botStatus(status, "waifu-tokenless")).toMatchObject({ state: "missing_token" });
  });

  it("fails the whole connect when the House bot cannot log in and leaves no client online", async () => {
    const clients = fakeClients({ house: invalidTokenError() });
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory
    });

    const failure = await gateway.connect().then(
      () => undefined,
      (error: unknown) => error as Error & { status?: DiscordRuntimeStatus; code?: string }
    );

    expect(failure?.message).toBe("An invalid token was provided.");
    expect(failure?.code).toBe("TokenInvalid");
    expect(failure?.status && botStatus(failure.status, "house")).toMatchObject({
      state: "error",
      errorCode: "invalid_token"
    });
    expect(connectedBotIds(gateway)).toEqual([]);
    expect(clients.destroyed.sort()).toEqual(["house", "waifu-a"]);
  });

  it("destroys clients that are still logging in when disconnect runs, instead of adopting them later", async () => {
    const pending = deferred();
    const clients = fakeClients({ "waifu-slow": pending });
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-slow")],
      createClient: clients.factory
    });

    const connecting = gateway.connect().catch((error: unknown) => error);
    await vi.waitFor(() => expect(clients.loginAttempts.get("waifu-slow")).toBe(1));
    await gateway.disconnect();
    pending.resolve();
    await connecting;
    // Let any late ready/adoption callbacks run.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(connectedBotIds(gateway)).toEqual([]);
    expect(clients.destroyed).toContain("waifu-slow");
    expect(clients.destroyed).toContain("house");
  });

  it("retries a waifu whose login failed on a network error and reports the recovery", async () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" });
    const clients = fakeClients({ "waifu-a": [networkError, "ok"] });
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      botRetryDelaysMs: [5],
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });

    const initial = await gateway.connect();
    expect(botStatus(initial, "waifu-a")).toMatchObject({ state: "error", errorCode: "network" });
    expect(botStatus(initial, "waifu-a")?.nextRetryAt).toBeDefined();

    await vi.waitFor(() => expect(connectedBotIds(gateway)).toEqual(["house", "waifu-a"]));
    const latest = statusChanges.at(-1);
    expect(latest).toMatchObject({ connected: true, waifuBotCount: 1 });
    expect(latest && botStatus(latest, "waifu-a")).toMatchObject({ state: "connected" });
    // Only the client from the failed first attempt was destroyed; the retry's client is live.
    expect(clients.destroyed).toEqual(["waifu-a"]);
    expect(clients.loginAttempts.get("waifu-a")).toBe(2);
  });

  it("does not retry waifu logins that failed for a permanent reason", async () => {
    const clients = fakeClients({ "waifu-a": invalidTokenError() });
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      botRetryDelaysMs: [5]
    });

    const status = await gateway.connect();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(botStatus(status, "waifu-a")?.nextRetryAt).toBeUndefined();
    expect(clients.loginAttempts.get("waifu-a")).toBe(1);
  });
});

describe("DiscordJsGateway client options", () => {
  it("connects waifu-only clients with the Guilds intent and no message caches", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory
    });
    await gateway.connect();

    const waifu = clients.createdOptions.get("waifu-a")!;
    expect(new IntentsBitField(waifu.intents).bitfield).toBe(GatewayIntentBits.Guilds);
    expect(waifu.partials ?? []).toEqual([]);
    const messageCache = waifu.makeCache?.(MessageManager as never, Message as never, GuildMessageManager as never);
    expect(messageCache).toBeInstanceOf(LimitedCollection);
    expect((messageCache as LimitedCollection<string, unknown>).maxSize).toBe(0);

    const house = clients.createdOptions.get("house")!;
    const houseIntents = new IntentsBitField(house.intents);
    for (const intent of [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ]) {
      expect(houseIntents.has(intent)).toBe(true);
    }
    expect(house.makeCache).toBeUndefined();
  });
});

describe("DiscordJsGateway intents (spec 9.4: GuildExpressions, opt-in GuildMembers)", () => {
  it("requests the non-privileged GuildExpressions intent and never GuildMembers unless asked", async () => {
    // discord.js 14.27 / discord-api-types: GuildExpressions replaced GuildEmojisAndStickers (same bit).
    expect(GatewayIntentBits.GuildExpressions).toBe(1 << 3);
    expect(IntentsBitField.Flags.GuildExpressions).toBe(GatewayIntentBits.GuildExpressions);

    const defaults = fakeClients({});
    const plain = makeGateway({ house: bot("house"), waifus: [bot("waifu-a")], createClient: defaults.factory });
    await plain.connect();
    const plainIntents = new IntentsBitField(defaults.createdOptions.get("house")!.intents);
    expect(plainIntents.has(GatewayIntentBits.GuildExpressions)).toBe(true);
    expect(plainIntents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    // Waifu bots never listen: they keep the single Guilds intent.
    expect(new IntentsBitField(defaults.createdOptions.get("waifu-a")!.intents).bitfield).toBe(GatewayIntentBits.Guilds);

    const optIn = fakeClients({});
    const privileged = makeGateway({
      house: bot("house"),
      guildMembersIntent: true,
      createClient: optIn.factory
    });
    await privileged.connect();
    const privilegedIntents = new IntentsBitField(optIn.createdOptions.get("house")!.intents);
    expect(privilegedIntents.has(GatewayIntentBits.GuildMembers)).toBe(true);
    expect(privilegedIntents.has(GatewayIntentBits.GuildExpressions)).toBe(true);
  });

  it("reports invalid_intents when Discord closes the House bot session with 4013", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    // discord.js 14.27 gives up (ShardDisconnect) on 4013 "invalid intents" like it does on 4014.
    clients.created.get("house")?.emit(Events.ShardDisconnect, { code: 4013, reason: "Invalid intent(s)", wasClean: true } as never, 0);

    await vi.waitFor(() => expect(statusChanges).toHaveLength(1));
    expect(botStatus(statusChanges[0]!, "house")).toMatchObject({
      state: "error",
      errorCode: "invalid_intents",
      closeCode: 4013
    });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({ errorCode: "house_unavailable" });
  });

  it("classifies a login rejected for invalid or disallowed intents", async () => {
    for (const [message, errorCode] of [
      ["Invalid intents", "invalid_intents"],
      ["Used disallowed intents", "disallowed_intents"]
    ] as const) {
      const clients = fakeClients({ house: new Error(message) });
      const gateway = makeGateway({ house: bot("house"), createClient: clients.factory });
      const error = await gateway.connect().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "DiscordConnectError" });
      expect(botStatus((error as { status: DiscordRuntimeStatus }).status, "house")).toMatchObject({ state: "error", errorCode });
    }
  });
});

describe("DiscordJsGateway unrecoverable gateway closes", () => {
  it("marks a waifu errored and destroys its client when Discord rejects its token mid-session", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const issues: DiscordRuntimeIssue[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      },
      onRuntimeIssue: (issue) => {
        issues.push(issue);
      }
    });
    await gateway.connect();

    // discord.js 14.27 only emits ShardDisconnect for close codes it will not recover from.
    clients.created.get("waifu-a")?.emit(Events.ShardDisconnect, { code: 4004, reason: "", wasClean: true } as never, 0);

    await vi.waitFor(() => expect(statusChanges).toHaveLength(1));
    expect(connectedBotIds(gateway)).toEqual(["house"]);
    expect(clients.destroyed).toEqual(["waifu-a"]);
    expect(statusChanges[0]).toMatchObject({ connected: true, houseConnected: true, waifuBotCount: 0 });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({
      state: "error",
      errorCode: "invalid_token",
      closeCode: 4004
    });
    expect(issues).toEqual([expect.objectContaining({ source: "shard-disconnect", botId: "waifu-a", code: 4004 })]);
  });

  it("takes the cast offline when the House bot loses its session to disallowed intents", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    clients.created.get("house")?.emit(Events.ShardDisconnect, { code: 4014, reason: "", wasClean: true } as never, 0);

    await vi.waitFor(() => expect(statusChanges).toHaveLength(1));
    expect(connectedBotIds(gateway)).toEqual([]);
    expect(clients.destroyed.sort()).toEqual(["house", "waifu-a"]);
    expect(statusChanges[0]).toMatchObject({ connected: false, houseConnected: false });
    expect(botStatus(statusChanges[0]!, "house")).toMatchObject({
      state: "error",
      errorCode: "disallowed_intents",
      closeCode: 4014
    });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({ errorCode: "house_unavailable" });
  });

  it("does not adopt a waifu retry login that finishes after the House bot session was lost", async () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" });
    const retryLogin = deferred();
    const clients = fakeClients({ "waifu-a": [networkError, retryLogin] });
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      botRetryDelaysMs: [5],
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();
    const houseClient = clients.created.get("house")!;
    await vi.waitFor(() => expect(clients.loginAttempts.get("waifu-a")).toBe(2));

    houseClient.emit(Events.ShardDisconnect, { code: 4004, reason: "", wasClean: true } as never, 0);
    retryLogin.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(connectedBotIds(gateway)).toEqual([]);
    // Both waifu clients (failed first attempt, abandoned retry) were destroyed.
    expect(clients.destroyed.filter((id) => id === "waifu-a")).toHaveLength(2);
    const latest = statusChanges.at(-1)!;
    expect(latest).toMatchObject({ connected: false, houseConnected: false, waifuBotCount: 0 });
    expect(botStatus(latest, "waifu-a")).toMatchObject({ state: "error", errorCode: "house_unavailable" });
    expect(botStatus(latest, "waifu-a")?.nextRetryAt).toBeUndefined();
  });

  it("leaves resumable shard errors to discord.js", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    clients.created.get("house")?.emit(Events.ShardError, new Error("socket hang up"), 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(connectedBotIds(gateway)).toEqual(["house"]);
    expect(clients.destroyed).toEqual([]);
    expect(statusChanges).toEqual([]);
  });
});

type FakeInteractionCalls = {
  reply: Array<{ content?: string; flags?: unknown }>;
  deferReply: unknown[];
  editReply: unknown[];
};

function fakeInteraction(input: { commandName: string; userId?: string; admin?: boolean; strings?: Record<string, string>; booleans?: Record<string, boolean> }) {
  const calls: FakeInteractionCalls = { reply: [], deferReply: [], editReply: [] };
  const interaction = {
    commandName: input.commandName,
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: input.userId ?? "user-1" },
    memberPermissions: {
      has: (permission: bigint) => permission === PermissionFlagsBits.Administrator && (input.admin ?? true)
    },
    options: {
      getString: (name: string) => input.strings?.[name] ?? null,
      getInteger: () => null,
      getBoolean: (name: string) => input.booleans?.[name] ?? null
    },
    async reply(payload: { content?: string; flags?: unknown }) {
      calls.reply.push(payload);
    },
    async deferReply(payload: unknown) {
      calls.deferReply.push(payload);
    },
    async editReply(payload: unknown) {
      calls.editReply.push(payload);
    }
  };
  return { interaction, calls };
}

type SlashHandlers = Record<string, (interaction: unknown) => Promise<void>>;

function slashHandler(gateway: DiscordJsGateway, name: string): (interaction: unknown) => Promise<void> {
  return (gateway as unknown as SlashHandlers)[name]!.bind(gateway);
}

describe("DiscordJsGateway slash commands", () => {
  it.each([
    ["wake", "handleWakeInteraction"],
    ["print", "handlePrintInteraction"]
  ])("answers /%s with an ephemeral not-ready message when no listener is attached", async (commandName, handler) => {
    const gateway = makeGateway({ house: bot("house") });
    const { interaction, calls } = fakeInteraction({ commandName });

    await slashHandler(gateway, handler)(interaction);

    expect(calls.deferReply).toEqual([]);
    expect(calls.reply).toEqual([
      { content: expect.stringContaining("not ready"), flags: MessageFlags.Ephemeral }
    ]);
  });

  it.each([
    ["wake", "handleWakeInteraction"],
    ["print", "handlePrintInteraction"]
  ])("only the application's owner may run /%s: a server Administrator is not enough", async (commandName, handler) => {
    const asked: string[] = [];
    const gateway = makeGateway({ house: bot("house"), applicationOwners: { isOwner: async (userId) => (asked.push(userId), userId === "owner-1") } });
    const events: unknown[] = [];
    gateway.onWakeCommand((event) => void events.push(event));
    gateway.onPrintCommand((event) => void events.push(event));
    const admin = fakeInteraction({ commandName, userId: "admin-1", admin: true, strings: { waifu: "ella", type: "notes" } });

    await slashHandler(gateway, handler)(admin.interaction);

    expect(events).toEqual([]);
    expect(admin.calls.deferReply).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(admin.calls.editReply).toEqual([expect.stringContaining("Only the owner of this bot's Discord application")]);
    // The owner gets through even without Administrator in this server.
    const owner = fakeInteraction({ commandName, userId: "owner-1", admin: false, strings: { waifu: "ella", type: "notes" } });
    await slashHandler(gateway, handler)(owner.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toHaveLength(1);
    expect(asked).toEqual(["admin-1", "owner-1"]);
  });

  it("hands /wake's waifu and note to the listener, ephemerally", async () => {
    const gateway = makeGateway({ house: bot("house"), applicationOwners: { isOwner: async () => true } });
    const wakes: Array<{ waifuId?: string; note?: string }> = [];
    gateway.onWakeCommand(async (event) => {
      wakes.push({ waifuId: event.waifuId, note: event.note });
      await event.respond("Woke Ella.");
    });
    const { interaction, calls } = fakeInteraction({ commandName: "wake", strings: { waifu: "ella", note: "  say hi to the new member  " } });

    await slashHandler(gateway, "handleWakeInteraction")(interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(wakes).toEqual([{ waifuId: "ella", note: "say hi to the new member" }]);
    expect(calls.deferReply).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(calls.editReply).toEqual(["Woke Ella."]);
  });

  it("answers /print only ephemerally: a short print inline, a long one as an attached file", async () => {
    const gateway = makeGateway({ house: bot("house"), applicationOwners: { isOwner: async () => true } });
    let size = 100;
    gateway.onPrintCommand(async (event) => {
      await event.respond("x".repeat(size));
    });
    const short = fakeInteraction({ commandName: "print", strings: { type: "notes", waifu: "ella" } });
    await slashHandler(gateway, "handlePrintInteraction")(short.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(short.calls.deferReply).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(short.calls.reply).toEqual([]);
    expect(short.calls.editReply).toEqual(["x".repeat(100)]);

    size = 5_000;
    const { interaction, calls } = fakeInteraction({ commandName: "print", strings: { type: "system_prompt", waifu: "ella" } });

    await slashHandler(gateway, "handlePrintInteraction")(interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reply was deferred as ephemeral; every later edit stays on that private reply.
    expect(calls.deferReply).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(calls.reply).toEqual([]);
    expect(calls.editReply).toEqual([{ content: "Attached as system_prompt.md.", files: [{ attachment: expect.any(Buffer), name: "system_prompt.md" }] }]);
  });
});

describe("DiscordJsGateway: the waifu role (§37)", () => {
  function roleWorld() {
    const roles = new Map<string, { id: string; name: string }>();
    const memberRoles = new Map<string, Set<string>>();
    const guild = {
      id: "100",
      roles: {
        fetch: async () => roles,
        create: async (options: { name: string }) => {
          const role = { id: `r${roles.size + 1}`, name: options.name };
          roles.set(role.id, role);
          return role;
        }
      },
      members: {
        fetch: async (userId: string) => {
          const held = memberRoles.get(userId) ?? new Set<string>();
          memberRoles.set(userId, held);
          return { roles: { cache: new Map([...held].map((id) => [id, {}])), add: async (roleId: string) => void held.add(roleId) } };
        }
      }
    };
    const clients = fakeClients({});
    const created = new Map<string, Client>();
    const cached = { id: "100", name: "Bake Club", roles: { cache: new Map() }, emojis: { cache: new Map() }, channels: { cache: new Map() }, members: { cache: new Map() } };
    const factory: FakeClients["factory"] = (input) => {
      const client = clients.factory(input);
      created.set(input.bot.id, client);
      const userId = `${input.bot.id}-user`;
      Object.defineProperty(client, "user", { value: { id: userId }, configurable: true });
      const cache = client.guilds.cache as unknown as Map<string, unknown>;
      if (input.bot.id !== "ella") cache.set("100", cached);
      if (input.kind === "house") (client.guilds as unknown as { fetch: (id: string) => Promise<unknown> }).fetch = async () => guild;
      return client;
    };
    return { roles, memberRoles, factory, created, cached };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("gives every waifu bot in a shared server the role when they connect, creating it; never the House bot", async () => {
    const w = roleWorld();
    const gateway = makeGateway({ house: bot("house"), waifus: [bot("mina"), bot("ella")], waifuRole: "waifu", createClient: w.factory });
    await gateway.connect();
    await settle();
    expect([...w.roles.values()]).toEqual([{ id: "r1", name: "waifu" }]);
    expect(w.memberRoles.get("mina-user")).toEqual(new Set(["r1"]));
    // Ella's bot isn't in that server (yet), and the House bot never gets it.
    expect(w.memberRoles.has("ella-user")).toBe(false);
    expect(w.memberRoles.has("house-user")).toBe(false);

    // Ella's bot joins the server: she gets it too.
    (w.created.get("ella")!.guilds.cache as unknown as Map<string, unknown>).set("100", w.cached);
    w.created.get("ella")!.emit(Events.GuildCreate, w.cached as never);
    await settle();
    expect(w.memberRoles.get("ella-user")).toEqual(new Set(["r1"]));
    expect(w.roles.size).toBe(1);
  });

  it("tries again by itself once the House bot may have Manage Roles: a role update or its own roles changing", async () => {
    const w = roleWorld();
    let allowed = false;
    let fetches = 0;
    const guildRoles = w.roles;
    const factory: FakeClients["factory"] = (input) => {
      const client = w.factory(input);
      if (input.kind === "house") {
        const fetchGuild = (client.guilds as unknown as { fetch: (id: string) => Promise<{ roles: { create: (o: { name: string }) => Promise<unknown>; fetch: () => Promise<unknown> } }> }).fetch;
        (client.guilds as unknown as { fetch: (id: string) => Promise<unknown> }).fetch = async (id: string) => {
          const guild = await fetchGuild(id);
          const create = guild.roles.create;
          const fetch = guild.roles.fetch;
          return {
            ...guild,
            roles: {
              fetch: async () => {
                fetches += 1;
                return fetch();
              },
              create: async (options: { name: string }) => {
                if (!allowed) throw new Error("Missing Permissions");
                return create(options);
              }
            }
          };
        };
      }
      return client;
    };
    const warn = vi.fn();
    const gateway = new DiscordJsGateway({ house: bot("house"), waifus: [bot("mina")], waifuRole: "waifu", createClient: factory, logger: { ...quietLogger(), warn } });
    gateways.push(gateway);
    await gateway.connect();
    await settle();
    expect(guildRoles.size).toBe(0);
    expect(warn).toHaveBeenCalledWith("Could not give the waifu role", expect.objectContaining({ guildId: "100", message: "Missing Permissions" }));

    // A role changes but the House bot still can't: tried again, no second warning.
    const houseClient = w.created.get("house")!;
    houseClient.emit(Events.GuildRoleUpdate, {} as never, { guild: { id: "100" } } as never);
    await settle();
    expect(guildRoles.size).toBe(0);
    expect(warn.mock.calls.filter(([message]) => message === "Could not give the waifu role")).toHaveLength(1);

    // The owner gives its role Manage Roles: the next role update gives Mina the role.
    allowed = true;
    houseClient.emit(Events.GuildRoleUpdate, {} as never, { guild: { id: "100" } } as never);
    await settle();
    expect(w.memberRoles.get("mina-user")).toEqual(new Set(["r1"]));

    // Done there: later role updates and the House bot's own member updates fetch nothing.
    const after = fetches;
    houseClient.emit(Events.GuildRoleUpdate, {} as never, { guild: { id: "100" } } as never);
    houseClient.emit(Events.GuildMemberUpdate, {} as never, { id: "house-user", user: { id: "house-user", username: "house" }, guild: { id: "100" }, roles: { cache: new Map() } } as never);
    await settle();
    expect(fetches).toBe(after);
  });

  it("a failed server is tried again when the House bot is given a new role", async () => {
    const w = roleWorld();
    let allowed = false;
    const factory: FakeClients["factory"] = (input) => {
      const client = w.factory(input);
      if (input.kind === "house") {
        const fetchGuild = (client.guilds as unknown as { fetch: (id: string) => Promise<{ roles: { create: (o: { name: string }) => Promise<unknown> } }> }).fetch;
        (client.guilds as unknown as { fetch: (id: string) => Promise<unknown> }).fetch = async (id: string) => {
          const guild = await fetchGuild(id);
          const create = guild.roles.create;
          return {
            ...guild,
            roles: {
              ...guild.roles,
              create: async (options: { name: string }) => {
                if (!allowed) throw new Error("Missing Permissions");
                return create(options);
              }
            }
          };
        };
      }
      return client;
    };
    const gateway = makeGateway({ house: bot("house"), waifus: [bot("mina")], waifuRole: "waifu", createClient: factory });
    await gateway.connect();
    await settle();
    expect(w.memberRoles.has("mina-user")).toBe(false);
    allowed = true;
    // Another bot's member update is not the House bot's: nothing yet.
    w.created.get("house")!.emit(Events.GuildMemberUpdate, {} as never, { id: "someone", user: { id: "someone", username: "someone" }, guild: { id: "100" }, roles: { cache: new Map() } } as never);
    await settle();
    expect(w.memberRoles.has("mina-user")).toBe(false);
    w.created.get("house")!.emit(Events.GuildMemberUpdate, {} as never, { id: "house-user", user: { id: "house-user", username: "house" }, guild: { id: "100" }, roles: { cache: new Map([["admin", {}]]) } } as never);
    await settle();
    expect(w.memberRoles.get("mina-user")).toEqual(new Set(["r1"]));
  });

  it("does nothing when discord.waifuRole is empty", async () => {
    const w = roleWorld();
    const gateway = makeGateway({ house: bot("house"), waifus: [bot("mina")], waifuRole: "", createClient: w.factory });
    await gateway.connect();
    await settle();
    expect(w.roles.size).toBe(0);
    expect(w.memberRoles.size).toBe(0);
  });
});

describe("DiscordJsGateway /norma (§36)", () => {
  it("is not an owner command: anyone's /norma reaches the listener (which checks permissions.norma), ephemerally; a long answer is a file", async () => {
    const asked: string[] = [];
    const gateway = makeGateway({ house: bot("house"), applicationOwners: { isOwner: async (userId) => (asked.push(userId), false) } });
    let answer = "Hi!";
    const events: Array<{ userId: string; text: string }> = [];
    gateway.onNormaCommand(async (event) => {
      events.push({ userId: event.userId, text: event.text });
      await event.respond(answer);
    });
    const plain = fakeInteraction({ commandName: "norma", userId: "user-9", admin: false, strings: { text: "  what's my setup?  " } });
    await slashHandler(gateway, "handleNormaInteraction")(plain.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toEqual([]);
    expect(events).toEqual([{ userId: "user-9", text: "what's my setup?" }]);
    expect(plain.calls.deferReply).toEqual([{ flags: MessageFlags.Ephemeral }]);
    expect(plain.calls.reply).toEqual([]);
    expect(plain.calls.editReply).toEqual(["Hi!"]);

    answer = "y".repeat(5_000);
    const long = fakeInteraction({ commandName: "norma", strings: { text: "explain everything" } });
    await slashHandler(gateway, "handleNormaInteraction")(long.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(long.calls.editReply).toEqual([{ content: "Attached as norma.md.", files: [{ attachment: expect.any(Buffer), name: "norma.md" }] }]);
  });

  it("answers not-ready when no listener is attached", async () => {
    const gateway = makeGateway({ house: bot("house") });
    const { interaction, calls } = fakeInteraction({ commandName: "norma", strings: { text: "hi" } });
    await slashHandler(gateway, "handleNormaInteraction")(interaction);
    expect(calls.deferReply).toEqual([]);
    expect(calls.reply).toEqual([{ content: expect.stringContaining("not ready"), flags: MessageFlags.Ephemeral }]);
  });
});

describe("DiscordJsGateway /print private option", () => {
  it("passes private:true through and defaults to redacted output", async () => {
    const gateway = makeGateway({ house: bot("house"), applicationOwners: { isOwner: async () => true } });
    const seen: Array<boolean | undefined> = [];
    gateway.onPrintCommand(async (event) => {
      seen.push(event.private);
      await event.respond("ok");
    });
    for (const booleans of [{ private: true }, {}]) {
      const { interaction } = fakeInteraction({ commandName: "print", strings: { type: "life", waifu: "ella" }, booleans });
      await slashHandler(gateway, "handlePrintInteraction")(interaction);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(seen).toEqual([true, false]);
  });
});

describe("DiscordJsGateway replies", () => {
  it("still sends a waifu reply when the message it replies to was deleted mid-generation", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const gateway = makeGateway({ house: bot("house"), waifus: [bot("waifu-a")] });
    (gateway as unknown as { clients: Map<string, unknown> }).clients.set("waifu-a", {
      channels: {
        async fetch() {
          return {
            async send(payload: Record<string, unknown>) {
              sent.push(payload);
              return { id: "sent-1" };
            }
          };
        }
      }
    });

    await gateway.sendWaifuMessage({
      guildId: "guild-1",
      channelId: "channel-1",
      content: "hello",
      senderBotId: "waifu-a",
      replyToMessageId: "123456789012345678",
      allowedUserMentionIds: []
    });

    expect(sent[0]?.reply).toEqual({ messageReference: "123456789012345678", failIfNotExists: false });
  });
});

function quietLogger() {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };
}

describe("DiscordJsGateway seeds the guild directory and trust (I2)", () => {
  const fakeGuild = {
    id: "100",
    name: "Bake Club",
    roles: { cache: new Map([["r1", { id: "r1", name: "Bakers", color: 1 }]]) },
    emojis: { cache: new Map() },
    channels: {
      cache: new Map([
        ["c1", { id: "c1", name: "general", guildId: "100" }],
        ["t1", { id: "t1", name: "Best brownies", parentId: "c1", isThread: () => true }]
      ])
    },
    members: { cache: new Map() }
  };

  function withGuild(clients: FakeClients): FakeClients["factory"] {
    return (input) => {
      const client = clients.factory(input);
      if (input.kind === "house") (client.guilds.cache as unknown as Map<string, unknown>).set("100", fakeGuild);
      return client;
    };
  }

  it("emits a snapshot for guilds the bot is already in when it becomes ready, to a subscriber registered before connect", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({ house: bot("house"), createClient: withGuild(clients) });
    const events: Array<{ type: string; guildId: string }> = [];
    gateway.onDirectoryEvent((event) => events.push(event));
    await gateway.connect();
    expect(events.filter((e) => e.type === "snapshot")).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "snapshot",
      guildId: "100",
      roles: [{ id: "r1", name: "Bakers" }],
      channels: [{ id: "c1", kind: "channel" }, { id: "t1", kind: "thread", parentId: "c1" }]
    });
  });

  it("replays the snapshots and the live connection state to a subscriber that arrives after connect", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({ house: bot("house"), createClient: withGuild(clients) });
    await gateway.connect();
    const directory: Array<{ type: string; guildId: string }> = [];
    const conversation: Array<{ type: string; state?: string }> = [];
    gateway.onDirectoryEvent((event) => directory.push(event));
    gateway.onConversationEvent((event) => conversation.push(event));
    expect(directory.map((e) => e.type)).toEqual(["snapshot"]);
    expect(conversation).toEqual([{ type: "connection", scope: "guild", state: "ready" }]);
  });

  it("feeds a real GuildDirectory so Task C can look up an existing thread", async () => {
    const { GuildDirectory } = await import("../src/discord/guildDirectory.js");
    const { StorageService } = await import("../src/storage/storageService.js");
    const { makeTempRoot, removeTempRoot } = await import("./testUtils.js");
    const root = await makeTempRoot();
    try {
      const clients = fakeClients({});
      const gateway = makeGateway({ house: bot("house"), createClient: withGuild(clients) });
      await gateway.connect();
      const directory = new GuildDirectory({ storage: new StorageService(root), logger: quietLogger() });
      directory.start((listener) => gateway.onDirectoryEvent(listener));
      const view = await directory.view("100");
      expect(view.roleName("r1")).toBe("Bakers");
      expect(directory.channel("100", "t1")).toMatchObject({ kind: "thread", parentId: "c1" });
      await directory.close();
    } finally {
      await removeTempRoot(root);
    }
  });

  it("also snapshots a guild that becomes available later", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({ house: bot("house"), createClient: clients.factory });
    const events: Array<{ type: string; guildId: string }> = [];
    gateway.onDirectoryEvent((event) => events.push(event));
    await gateway.connect();
    clients.created.get("house")!.emit(Events.GuildAvailable, fakeGuild as never);
    expect(events.map((e) => e.type)).toEqual(["snapshot"]);
  });
});

describe("DiscordJsGateway falls back when the GuildMembers intent is refused (M6)", () => {
  it("retries once without the intent, keeps Discord online and raises guild_members_intent_rejected", async () => {
    const clients = fakeClients({ house: [new Error("Used disallowed intents"), "ok"] });
    const issues: DiscordRuntimeIssue[] = [];
    const gateway = makeGateway({
      house: bot("house"),
      guildMembersIntent: true,
      createClient: clients.factory,
      onRuntimeIssue: (issue) => {
        issues.push(issue);
      }
    });
    const status = await gateway.connect();
    expect(status.houseConnected).toBe(true);
    expect(clients.loginAttempts.get("house")).toBe(2);
    expect(new IntentsBitField(clients.createdOptions.get("house")!.intents).has(GatewayIntentBits.GuildMembers)).toBe(false);
    await vi.waitFor(() => expect(issues).toHaveLength(1));
    expect(issues[0]).toMatchObject({ source: "warn", code: "guild_members_intent_rejected" });
    expect(gateway.status().warnings.join(" ")).toContain("guild_members_intent_rejected");
  });

  it("does not retry when the intent was not requested, and gives up after one retry", async () => {
    const plain = fakeClients({ house: new Error("Used disallowed intents") });
    const gateway = makeGateway({ house: bot("house"), createClient: plain.factory });
    await expect(gateway.connect()).rejects.toMatchObject({ name: "DiscordConnectError" });
    expect(plain.loginAttempts.get("house")).toBe(1);

    const both = fakeClients({ house: new Error("Used disallowed intents") });
    const optIn = makeGateway({ house: bot("house"), guildMembersIntent: true, createClient: both.factory });
    const error = await optIn.connect().catch((caught: unknown) => caught);
    expect(botStatus((error as { status: DiscordRuntimeStatus }).status, "house")).toMatchObject({ errorCode: "disallowed_intents" });
    expect(both.loginAttempts.get("house")).toBe(2);
  });
});
