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
import { DiscordJsGateway, buildOrchestratorCommandPayloads } from "../src/discord/client.js";
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
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-good"), bot("waifu-bad")],
      createClient: clients.factory
    });

    const status = await gateway.connect();

    expect(status).toMatchObject({ connected: true, orchestratorConnected: true, waifuBotCount: 1 });
    expect(connectedBotIds(gateway)).toEqual(["orchestrator", "waifu-good"]);
    expect(clients.destroyed).toEqual(["waifu-bad"]);
    expect(botStatus(status, "waifu-bad")).toMatchObject({
      kind: "waifu",
      state: "error",
      errorCode: "invalid_token",
      error: "An invalid token was provided."
    });
    expect(botStatus(status, "waifu-good")).toMatchObject({ kind: "waifu", state: "connected" });
    expect(botStatus(status, "orchestrator")).toMatchObject({ kind: "orchestrator", state: "connected" });
    expect(status.warnings.some((warning) => warning.includes("waifu-bad"))).toBe(true);
  });

  it("never logs in bots that are disabled or have no token", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-off", { enabled: false }), bot("waifu-tokenless", { token: undefined })],
      createClient: clients.factory
    });

    const status = await gateway.connect();

    expect([...clients.created.keys()]).toEqual(["orchestrator"]);
    expect(status.waifuBotCount).toBe(0);
    expect(botStatus(status, "waifu-off")).toMatchObject({ state: "disabled" });
    expect(botStatus(status, "waifu-tokenless")).toMatchObject({ state: "missing_token" });
  });

  it("fails the whole connect when the orchestrator cannot log in and leaves no client online", async () => {
    const clients = fakeClients({ orchestrator: invalidTokenError() });
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory
    });

    const failure = await gateway.connect().then(
      () => undefined,
      (error: unknown) => error as Error & { status?: DiscordRuntimeStatus; code?: string }
    );

    expect(failure?.message).toBe("An invalid token was provided.");
    expect(failure?.code).toBe("TokenInvalid");
    expect(failure?.status && botStatus(failure.status, "orchestrator")).toMatchObject({
      state: "error",
      errorCode: "invalid_token"
    });
    expect(connectedBotIds(gateway)).toEqual([]);
    expect(clients.destroyed.sort()).toEqual(["orchestrator", "waifu-a"]);
  });

  it("destroys clients that are still logging in when disconnect runs, instead of adopting them later", async () => {
    const pending = deferred();
    const clients = fakeClients({ "waifu-slow": pending });
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
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
    expect(clients.destroyed).toContain("orchestrator");
  });

  it("retries a waifu whose login failed on a network error and reports the recovery", async () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" });
    const clients = fakeClients({ "waifu-a": [networkError, "ok"] });
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
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

    await vi.waitFor(() => expect(connectedBotIds(gateway)).toEqual(["orchestrator", "waifu-a"]));
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
      orchestrator: bot("orchestrator"),
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
      orchestrator: bot("orchestrator"),
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

    const orchestrator = clients.createdOptions.get("orchestrator")!;
    const orchestratorIntents = new IntentsBitField(orchestrator.intents);
    for (const intent of [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ]) {
      expect(orchestratorIntents.has(intent)).toBe(true);
    }
    expect(orchestrator.makeCache).toBeUndefined();
  });
});

describe("DiscordJsGateway intents (spec 9.4: GuildExpressions, opt-in GuildMembers)", () => {
  it("requests the non-privileged GuildExpressions intent and never GuildMembers unless asked", async () => {
    // discord.js 14.27 / discord-api-types: GuildExpressions replaced GuildEmojisAndStickers (same bit).
    expect(GatewayIntentBits.GuildExpressions).toBe(1 << 3);
    expect(IntentsBitField.Flags.GuildExpressions).toBe(GatewayIntentBits.GuildExpressions);

    const defaults = fakeClients({});
    const plain = makeGateway({ orchestrator: bot("orchestrator"), waifus: [bot("waifu-a")], createClient: defaults.factory });
    await plain.connect();
    const plainIntents = new IntentsBitField(defaults.createdOptions.get("orchestrator")!.intents);
    expect(plainIntents.has(GatewayIntentBits.GuildExpressions)).toBe(true);
    expect(plainIntents.has(GatewayIntentBits.GuildMembers)).toBe(false);
    // Waifu bots never listen: they keep the single Guilds intent.
    expect(new IntentsBitField(defaults.createdOptions.get("waifu-a")!.intents).bitfield).toBe(GatewayIntentBits.Guilds);

    const optIn = fakeClients({});
    const privileged = makeGateway({
      orchestrator: bot("orchestrator"),
      guildMembersIntent: true,
      createClient: optIn.factory
    });
    await privileged.connect();
    const privilegedIntents = new IntentsBitField(optIn.createdOptions.get("orchestrator")!.intents);
    expect(privilegedIntents.has(GatewayIntentBits.GuildMembers)).toBe(true);
    expect(privilegedIntents.has(GatewayIntentBits.GuildExpressions)).toBe(true);
  });

  it("reports invalid_intents when Discord closes the orchestrator session with 4013", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    // discord.js 14.27 gives up (ShardDisconnect) on 4013 "invalid intents" like it does on 4014.
    clients.created.get("orchestrator")?.emit(Events.ShardDisconnect, { code: 4013, reason: "Invalid intent(s)", wasClean: true } as never, 0);

    await vi.waitFor(() => expect(statusChanges).toHaveLength(1));
    expect(botStatus(statusChanges[0]!, "orchestrator")).toMatchObject({
      state: "error",
      errorCode: "invalid_intents",
      closeCode: 4013
    });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({ errorCode: "orchestrator_unavailable" });
  });

  it("classifies a login rejected for invalid or disallowed intents", async () => {
    for (const [message, errorCode] of [
      ["Invalid intents", "invalid_intents"],
      ["Used disallowed intents", "disallowed_intents"]
    ] as const) {
      const clients = fakeClients({ orchestrator: new Error(message) });
      const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: clients.factory });
      const error = await gateway.connect().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: "DiscordConnectError" });
      expect(botStatus((error as { status: DiscordRuntimeStatus }).status, "orchestrator")).toMatchObject({ state: "error", errorCode });
    }
  });
});

describe("DiscordJsGateway unrecoverable gateway closes", () => {
  it("marks a waifu errored and destroys its client when Discord rejects its token mid-session", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const issues: DiscordRuntimeIssue[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
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
    expect(connectedBotIds(gateway)).toEqual(["orchestrator"]);
    expect(clients.destroyed).toEqual(["waifu-a"]);
    expect(statusChanges[0]).toMatchObject({ connected: true, orchestratorConnected: true, waifuBotCount: 0 });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({
      state: "error",
      errorCode: "invalid_token",
      closeCode: 4004
    });
    expect(issues).toEqual([expect.objectContaining({ source: "shard-disconnect", botId: "waifu-a", code: 4004 })]);
  });

  it("takes the cast offline when the orchestrator loses its session to disallowed intents", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    clients.created.get("orchestrator")?.emit(Events.ShardDisconnect, { code: 4014, reason: "", wasClean: true } as never, 0);

    await vi.waitFor(() => expect(statusChanges).toHaveLength(1));
    expect(connectedBotIds(gateway)).toEqual([]);
    expect(clients.destroyed.sort()).toEqual(["orchestrator", "waifu-a"]);
    expect(statusChanges[0]).toMatchObject({ connected: false, orchestratorConnected: false });
    expect(botStatus(statusChanges[0]!, "orchestrator")).toMatchObject({
      state: "error",
      errorCode: "disallowed_intents",
      closeCode: 4014
    });
    expect(botStatus(statusChanges[0]!, "waifu-a")).toMatchObject({ errorCode: "orchestrator_unavailable" });
  });

  it("does not adopt a waifu retry login that finishes after the orchestrator session was lost", async () => {
    const networkError = Object.assign(new Error("getaddrinfo ENOTFOUND discord.com"), { code: "ENOTFOUND" });
    const retryLogin = deferred();
    const clients = fakeClients({ "waifu-a": [networkError, retryLogin] });
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      waifus: [bot("waifu-a")],
      createClient: clients.factory,
      botRetryDelaysMs: [5],
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();
    const orchestratorClient = clients.created.get("orchestrator")!;
    await vi.waitFor(() => expect(clients.loginAttempts.get("waifu-a")).toBe(2));

    orchestratorClient.emit(Events.ShardDisconnect, { code: 4004, reason: "", wasClean: true } as never, 0);
    retryLogin.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(connectedBotIds(gateway)).toEqual([]);
    // Both waifu clients (failed first attempt, abandoned retry) were destroyed.
    expect(clients.destroyed.filter((id) => id === "waifu-a")).toHaveLength(2);
    const latest = statusChanges.at(-1)!;
    expect(latest).toMatchObject({ connected: false, orchestratorConnected: false, waifuBotCount: 0 });
    expect(botStatus(latest, "waifu-a")).toMatchObject({ state: "error", errorCode: "orchestrator_unavailable" });
    expect(botStatus(latest, "waifu-a")?.nextRetryAt).toBeUndefined();
  });

  it("leaves resumable shard errors to discord.js", async () => {
    const clients = fakeClients({});
    const statusChanges: DiscordRuntimeStatus[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      createClient: clients.factory,
      onStatusChange: (status) => {
        statusChanges.push(status);
      }
    });
    await gateway.connect();

    clients.created.get("orchestrator")?.emit(Events.ShardError, new Error("socket hang up"), 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(connectedBotIds(gateway)).toEqual(["orchestrator"]);
    expect(clients.destroyed).toEqual([]);
    expect(statusChanges).toEqual([]);
  });
});

type FakeInteractionCalls = {
  reply: Array<{ content?: string; flags?: unknown }>;
  deferReply: unknown[];
  editReply: unknown[];
};

function fakeInteraction(input: { commandName: string; userId?: string; canManageMessages?: boolean }) {
  const calls: FakeInteractionCalls = { reply: [], deferReply: [], editReply: [] };
  const interaction = {
    commandName: input.commandName,
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: input.userId ?? "user-1" },
    memberPermissions: {
      has: (permission: bigint) => permission === PermissionFlagsBits.ManageMessages && (input.canManageMessages ?? true)
    },
    options: {
      getString: () => null,
      getInteger: () => null
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
    ["review", "handleReviewInteraction"],
    ["clear", "handleClearInteraction"],
    ["run", "handleRunInteraction"],
    ["stop", "handleStopInteraction"],
    ["memories", "handleMemoriesInteraction"],
    ["print", "handlePrintInteraction"],
    ["console", "handleDebugInteraction"]
  ])("answers /%s with an ephemeral not-ready message when no listener is attached", async (commandName, handler) => {
    const gateway = makeGateway({ orchestrator: bot("orchestrator") });
    const { interaction, calls } = fakeInteraction({ commandName });

    await slashHandler(gateway, handler)(interaction);

    expect(calls.deferReply).toEqual([]);
    expect(calls.reply).toEqual([
      { content: expect.stringContaining("not ready"), flags: MessageFlags.Ephemeral }
    ]);
  });

  it("requires Manage Messages for /run at runtime as well as by default permissions", async () => {
    const gateway = makeGateway({ orchestrator: bot("orchestrator") });
    const runs: unknown[] = [];
    gateway.onRunCommand((event) => {
      runs.push(event);
    });
    const { interaction, calls } = fakeInteraction({ commandName: "run", canManageMessages: false });

    await slashHandler(gateway, "handleRunInteraction")(interaction);

    expect(runs).toEqual([]);
    expect(calls.deferReply).toEqual([]);
    expect(calls.reply).toEqual([
      { content: expect.stringContaining("Manage Messages"), flags: MessageFlags.Ephemeral }
    ]);
    const run = buildOrchestratorCommandPayloads().find((payload) => payload.name === "run");
    expect(run?.defaultMemberPermissions).toBe(PermissionFlagsBits.ManageMessages);
  });

  it("applies a per-user cooldown to /run", async () => {
    const gateway = makeGateway({ orchestrator: bot("orchestrator") });
    const runs: Array<{ userId: string }> = [];
    gateway.onRunCommand((event) => {
      runs.push(event);
    });

    const first = fakeInteraction({ commandName: "run", userId: "user-1" });
    const second = fakeInteraction({ commandName: "run", userId: "user-1" });
    const otherUser = fakeInteraction({ commandName: "run", userId: "user-2" });
    await slashHandler(gateway, "handleRunInteraction")(first.interaction);
    await slashHandler(gateway, "handleRunInteraction")(second.interaction);
    await slashHandler(gateway, "handleRunInteraction")(otherUser.interaction);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runs.map((run) => run.userId)).toEqual(["user-1", "user-2"]);
    expect(first.calls.deferReply).toHaveLength(1);
    expect(second.calls.deferReply).toEqual([]);
    expect(second.calls.reply).toEqual([
      { content: expect.stringContaining("try again in"), flags: MessageFlags.Ephemeral }
    ]);
  });
});

describe("DiscordJsGateway replies", () => {
  it("still sends a waifu reply when the message it replies to was deleted mid-generation", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const gateway = makeGateway({ orchestrator: bot("orchestrator"), waifus: [bot("waifu-a")] });
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
      if (input.kind === "orchestrator") (client.guilds.cache as unknown as Map<string, unknown>).set("100", fakeGuild);
      return client;
    };
  }

  it("emits a snapshot for guilds the bot is already in when it becomes ready, to a subscriber registered before connect", async () => {
    const clients = fakeClients({});
    const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: withGuild(clients) });
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
    const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: withGuild(clients) });
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
      const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: withGuild(clients) });
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
    const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: clients.factory });
    const events: Array<{ type: string; guildId: string }> = [];
    gateway.onDirectoryEvent((event) => events.push(event));
    await gateway.connect();
    clients.created.get("orchestrator")!.emit(Events.GuildAvailable, fakeGuild as never);
    expect(events.map((e) => e.type)).toEqual(["snapshot"]);
  });
});

describe("DiscordJsGateway falls back when the GuildMembers intent is refused (M6)", () => {
  it("retries once without the intent, keeps Discord online and raises guild_members_intent_rejected", async () => {
    const clients = fakeClients({ orchestrator: [new Error("Used disallowed intents"), "ok"] });
    const issues: DiscordRuntimeIssue[] = [];
    const gateway = makeGateway({
      orchestrator: bot("orchestrator"),
      guildMembersIntent: true,
      createClient: clients.factory,
      onRuntimeIssue: (issue) => {
        issues.push(issue);
      }
    });
    const status = await gateway.connect();
    expect(status.orchestratorConnected).toBe(true);
    expect(clients.loginAttempts.get("orchestrator")).toBe(2);
    expect(new IntentsBitField(clients.createdOptions.get("orchestrator")!.intents).has(GatewayIntentBits.GuildMembers)).toBe(false);
    await vi.waitFor(() => expect(issues).toHaveLength(1));
    expect(issues[0]).toMatchObject({ source: "warn", code: "guild_members_intent_rejected" });
    expect(gateway.status().warnings.join(" ")).toContain("guild_members_intent_rejected");
  });

  it("does not retry when the intent was not requested, and gives up after one retry", async () => {
    const plain = fakeClients({ orchestrator: new Error("Used disallowed intents") });
    const gateway = makeGateway({ orchestrator: bot("orchestrator"), createClient: plain.factory });
    await expect(gateway.connect()).rejects.toMatchObject({ name: "DiscordConnectError" });
    expect(plain.loginAttempts.get("orchestrator")).toBe(1);

    const both = fakeClients({ orchestrator: new Error("Used disallowed intents") });
    const optIn = makeGateway({ orchestrator: bot("orchestrator"), guildMembersIntent: true, createClient: both.factory });
    const error = await optIn.connect().catch((caught: unknown) => caught);
    expect(botStatus((error as { status: DiscordRuntimeStatus }).status, "orchestrator")).toMatchObject({ errorCode: "disallowed_intents" });
    expect(both.loginAttempts.get("orchestrator")).toBe(2);
  });
});
