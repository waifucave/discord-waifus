// DM transport in DiscordJsGateway (spec 9.1): intents per bot, intent reconcile re-logs only the
// changed bot, and the DM intake/feed filters.

import { ChannelType, Client, Events, IntentsBitField, Partials } from "discord.js";
import type { ClientOptions } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordJsGateway, buildDmCommandPayloads, buildOrchestratorCommandPayloads } from "../src/discord/client.js";
import type { DiscordDirectMessageEvent, DiscordJsGatewayOptions } from "../src/discord/client.js";
import type { DiscordConversationEvent } from "../src/discord/gatewayEvents.js";
import type { DiscordBotConfig } from "../src/shared/schemas/domain.js";
import { quietLogger } from "./contextFixtures.js";

type Fakes = {
  factory: NonNullable<DiscordJsGatewayOptions["createClient"]>;
  clients: Map<string, Client>;
  options: Map<string, ClientOptions>;
  destroyed: string[];
  logins: Map<string, number>;
};

function fakeClients(): Fakes {
  const clients = new Map<string, Client>();
  const options = new Map<string, ClientOptions>();
  const destroyed: string[] = [];
  const logins = new Map<string, number>();
  const factory: Fakes["factory"] = ({ bot, options: clientOptions }) => {
    const client = new Client(clientOptions);
    clients.set(bot.id, client);
    options.set(bot.id, clientOptions);
    const mutable = client as unknown as { login: (token?: string) => Promise<string>; destroy: () => Promise<void> };
    mutable.login = async (token = "") => {
      logins.set(bot.id, (logins.get(bot.id) ?? 0) + 1);
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
  return { factory, clients, options, destroyed, logins };
}

function bot(id: string): DiscordBotConfig {
  return { id, displayName: id, token: `${id}-token`, enabled: true };
}

function intentsOf(options: ClientOptions | undefined): string[] {
  return new IntentsBitField(options?.intents).toArray().sort();
}

const gateways: DiscordJsGateway[] = [];
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.disconnect()));
});

function makeGateway(fakes: Fakes, pairs: () => Array<{ botId: string; waifuId: string }>) {
  const gateway = new DiscordJsGateway({
    orchestrator: bot("orchestrator"),
    waifus: [bot("aria-bot"), bot("mina-bot")],
    createClient: fakes.factory,
    dmBots: async () => pairs(),
    logger: quietLogger()
  });
  gateways.push(gateway);
  return gateway;
}

describe("DM intents", () => {
  it("allowDms off: waifu bots log in with [Guilds] only", async () => {
    const fakes = fakeClients();
    const gateway = makeGateway(fakes, () => []);
    await gateway.connect();
    for (const id of ["aria-bot", "mina-bot"]) {
      expect(intentsOf(fakes.options.get(id))).toEqual(["Guilds"]);
      expect(fakes.options.get(id)?.partials).toBeUndefined();
    }
    expect(gateway.dmIntentStatus().every((status) => !status.intentActive)).toBe(true);
  });

  it("a DM-eligible bot adds the DM intents and partials; the others keep [Guilds]", async () => {
    const fakes = fakeClients();
    const gateway = makeGateway(fakes, () => [{ botId: "aria-bot", waifuId: "aria" }]);
    await gateway.connect();
    expect(intentsOf(fakes.options.get("aria-bot"))).toEqual(["DirectMessageReactions", "DirectMessages", "Guilds"]);
    expect(fakes.options.get("aria-bot")?.partials).toEqual([Partials.Channel, Partials.Message, Partials.Reaction]);
    expect(intentsOf(fakes.options.get("mina-bot"))).toEqual(["Guilds"]);
    expect(gateway.dmIntentStatus()).toEqual([
      { botId: "aria-bot", waifuId: "aria", intentActive: true, connected: true },
      { botId: "mina-bot", intentActive: false, connected: true }
    ]);
  });

  it("reconcileDmIntents re-logs only the bot whose intents changed", async () => {
    const fakes = fakeClients();
    let pairs: Array<{ botId: string; waifuId: string }> = [];
    const gateway = makeGateway(fakes, () => pairs);
    await gateway.connect();
    expect(await gateway.reconcileDmIntents()).toEqual({ relogged: [] });

    pairs = [{ botId: "mina-bot", waifuId: "mina" }];
    expect(await gateway.reconcileDmIntents()).toEqual({ relogged: ["mina-bot"] });
    expect(fakes.destroyed).toEqual(["mina-bot"]);
    expect(fakes.logins.get("mina-bot")).toBe(2);
    expect(fakes.logins.get("aria-bot")).toBe(1);
    expect(fakes.logins.get("orchestrator")).toBe(1);
    expect(intentsOf(fakes.options.get("mina-bot"))).toContain("DirectMessages");
    expect(gateway.dmIntentStatus().find((s) => s.botId === "mina-bot")).toMatchObject({ intentActive: true, connected: true });

    pairs = [];
    expect(await gateway.reconcileDmIntents()).toEqual({ relogged: ["mina-bot"] });
    expect(intentsOf(fakes.options.get("mina-bot"))).toEqual(["Guilds"]);
    expect(fakes.logins.get("aria-bot")).toBe(1);
  });
});

describe("DM intake", () => {
  function dmMessage(o: { id: string; authorId: string; bot?: boolean; guildId?: string; channelType?: number }) {
    return {
      id: o.id,
      guildId: o.guildId ?? null,
      channelId: "700000000000000007",
      channel: { id: "700000000000000007", type: o.channelType ?? ChannelType.DM, recipientId: "500000000000000005" },
      author: { id: o.authorId, bot: o.bot ?? false, username: "kevin", globalName: "Kevin" },
      createdTimestamp: Date.parse("2026-10-24T14:00:00.000Z"),
      content: "hi",
      type: 0
    };
  }

  it("delivers a human DM to the listener and the conversation feed; drops bots, self, guild and group messages", async () => {
    const fakes = fakeClients();
    const gateway = makeGateway(fakes, () => [{ botId: "aria-bot", waifuId: "aria" }]);
    await gateway.connect();
    const events: DiscordDirectMessageEvent[] = [];
    const feed: DiscordConversationEvent[] = [];
    gateway.onDirectMessage((event) => void events.push(event));
    gateway.onConversationEvent((event) => void feed.push(event));
    // A late subscriber is told the DM scope is live.
    expect(feed).toContainEqual({ type: "connection", scope: "dm:aria", state: "ready" });
    const client = fakes.clients.get("aria-bot")!;
    const self = { id: "600000000000000006" };
    Object.defineProperty(client, "user", { value: self, configurable: true });

    client.emit(Events.MessageCreate, dmMessage({ id: "800000000000000001", authorId: "500000000000000005" }) as never);
    client.emit(Events.MessageCreate, dmMessage({ id: "800000000000000002", authorId: "900000000000000009", bot: true }) as never);
    client.emit(Events.MessageCreate, dmMessage({ id: "800000000000000003", authorId: self.id }) as never);
    client.emit(Events.MessageCreate, dmMessage({ id: "800000000000000004", authorId: "500000000000000005", guildId: "100000000000000001" }) as never);
    client.emit(Events.MessageCreate, dmMessage({ id: "800000000000000005", authorId: "500000000000000005", channelType: ChannelType.GroupDM }) as never);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(events).toEqual([
      {
        waifuId: "aria",
        botId: "aria-bot",
        userId: "500000000000000005",
        userDisplayName: "Kevin",
        channelId: "700000000000000007",
        messageId: "800000000000000001",
        createdAt: "2026-10-24T14:00:00.000Z"
      }
    ]);
    const creates = feed.filter((event) => event.type === "create");
    // The feed keeps her own DM messages (transcript) but never guild or group traffic.
    expect(creates.map((event) => (event.type === "create" ? event.message.id : ""))).toEqual([
      "800000000000000001",
      "800000000000000002",
      "800000000000000003"
    ]);
    expect(creates[0]).toMatchObject({ conversation: { kind: "dm", waifuId: "aria", userId: "500000000000000005" } });
  });
});

describe("slash command payloads", () => {
  it("orchestrator commands are guild-only and the DM /forget is BotDM-only", () => {
    for (const payload of buildOrchestratorCommandPayloads()) expect(payload.contexts).toEqual([0]);
    const [forget] = buildDmCommandPayloads();
    expect(forget).toMatchObject({ name: "forget", contexts: [1] });
    expect(forget!.options[0]!.choices.map((choice) => choice.value)).toEqual(["conversation", "everything"]);
  });
});
