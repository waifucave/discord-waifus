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
