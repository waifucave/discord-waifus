// Shared helpers for the tests that run a life over the REAL winter anthropic-messages adapter
// against the loopback Anthropic server (tests/eval/fakeAnthropic.ts). Not a test file.
import { ModelClient } from "../../src/models/client.js";
import { createWinterRuntime } from "../../src/models/winter.js";
import { ProviderAlerts } from "../../src/orchestration/providerAlerts.js";
import { ARIA_BOT, CHANNEL, dmOf, GUILD, KEVIN, lifeWorld, ROOM, type LifeWorld } from "../lifeFixtures.js";
import { FakeAnthropic, type ServerTurn } from "./fakeAnthropic.js";
import type { WireBlock, WireBody } from "./anthropicCacheSim.js";

export function blocksOf(message: WireBody["messages"][number]): WireBlock[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/** A wire message without its cache markers (they move from request to request by design). */
export function unmarked(message: WireBody["messages"][number]): string {
  return JSON.stringify({ role: message.role, content: blocksOf(message).map(({ cache_control: _drop, ...block }) => block) });
}

export const isCompaction = (body: WireBody) => JSON.stringify(body.messages[body.messages.length - 1]).includes("Time to summarise");
export const isMaintenance = (body: WireBody) => JSON.stringify(body.system).includes("<maintenance>");

/** Her side of a wake: read the place, answer, end (thinking on every reply). */
export function lifeTurn(place: () => string, o: { answer?: string } = {}) {
  return (body: WireBody): ServerTurn => {
    if (isMaintenance(body)) return { text: "nothing to tidy" };
    if (isCompaction(body)) return { text: "Earlier: a lively afternoon in Bake Club; Kevin passed his exam." };
    const last = body.messages[body.messages.length - 1]!;
    const results = blocksOf(last).filter((block) => block.type === "tool_result");
    if (results.length === 0) return { thinking: "Someone needs me; let me read.", toolCalls: [{ name: "read_messages", input: { place: place(), limit: 15 } }] };
    if (JSON.stringify(results).includes("sent #")) return { thinking: "That's said.", text: "(done)" };
    return { thinking: "I'll answer them.", toolCalls: [{ name: "send_message", input: { place: place(), text: o.answer ?? "on it!" } }] };
  };
}

export async function realAnthropicWorld(roots: string[], servers: FakeAnthropic[], o: Parameters<typeof lifeWorld>[1] = {}): Promise<{ w: LifeWorld; server: FakeAnthropic }> {
  let now = () => Date.parse("2026-10-24T14:00:00.000Z");
  const server = new FakeAnthropic(() => now());
  servers.push(server);
  const baseUrl = await server.start();
  const w = await lifeWorld(roots, {
    ...o,
    models: ({ ledger, clock }) =>
      new ModelClient({
        winter: createWinterRuntime(),
        credentials: () => "sk-test",
        usageLedger: ledger,
        providerAlerts: new ProviderAlerts(),
        connection: () => ({ baseUrl, local: true }),
        now: () => clock.ms
      })
  });
  now = () => w.clock.ms;
  return { w, server };
}

/** Kevin pings her in #general (a few other messages first), then her life runs. */
export async function roomWake(w: LifeWorld, text: string, chatter = 3): Promise<void> {
  for (let index = 0; index < chatter; index += 1) w.discord.post(ROOM, `chatter ${index}: the oven is preheating`, { authorId: "300000000000000077", authorName: "Mina" });
  const message = w.discord.post(ROOM, `<@${ARIA_BOT}> ${text}`, { mentions: { [ARIA_BOT]: "Aria" } });
  await w.cast.onGuildMessage({ guildId: GUILD, channelId: CHANNEL, messageId: message.id, castWaifuIds: ["aria"], authorIsWaifu: false, raw: message });
  await w.cast.settle();
  await w.cast.life("aria").runNow();
}

export async function dmWake(w: LifeWorld, text: string): Promise<void> {
  const message = w.discord.post(dmOf("aria"), text);
  await w.cast.onDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: KEVIN, userDisplayName: "Kevin", channelId: "dm", messageId: message.id, createdAt: message.createdAt });
  w.cast.intake.flushDms();
  await w.cast.settle();
  await w.cast.life("aria").runNow();
}
