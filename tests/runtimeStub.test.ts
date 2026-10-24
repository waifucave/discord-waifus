// The runtime facade between Living cast L1 and L2: Discord intake keeps its bookkeeping (server
// and channel entries, threads, participants) but nobody replies; accepted messages are logged.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { LIVING_CAST_NOT_WIRED, RuntimeOrchestrator } from "../src/orchestration/runtime.js";
import { readThreads } from "../src/orchestration/stores/threads.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ServerConfigSchema } from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const GUILD = "100000000000000001";
const CHANNEL = "200000000000000002";
const THREAD = "300000000000000003";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function setup() {
  const root = await makeTempRoot();
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  await storage.writeJson(`server:${GUILD}`, `user/servers/${GUILD}/server.json`, ServerConfigSchema, ServerConfigSchema.parse({
    ...createRevisionedBase(),
    guildId: GUILD,
    channels: { [CHANNEL]: { channelId: CHANNEL, enabledWaifuIds: ["aria"] } }
  }));
  const sent: unknown[] = [];
  const discord = {
    connect: async () => ({ connected: true, orchestratorConnected: true, waifuBotCount: 0, warnings: [] }),
    disconnect: async () => undefined,
    fetchFreshContext: async () => [],
    sendWaifuMessage: async (input: unknown) => {
      sent.push(input);
      return { messageId: "1" };
    },
    sendTyping: async () => undefined,
    joinThread: vi.fn(async () => undefined)
  } as unknown as DiscordGatewayFacade;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const runtime = new RuntimeOrchestrator({ storage, discord, logger });
  return { root, storage, runtime, logger, sent, discord };
}

const stubLogs = (logger: { info: ReturnType<typeof vi.fn> }) => logger.info.mock.calls.filter(([message]) => message === LIVING_CAST_NOT_WIRED);

describe("runtime facade before L2", () => {
  it("logs an accepted guild message instead of replying; channels without a cast are ignored", async () => {
    const { runtime, logger, sent } = await setup();
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m1", authorId: "kevin", authorDisplayName: "Kevin", authorBot: false });
    expect(stubLogs(logger)).toEqual([[LIVING_CAST_NOT_WIRED, expect.objectContaining({ guildId: GUILD, channelId: CHANNEL, messageId: "m1" })]]);
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: "200000000000000099", messageId: "m2", authorId: "kevin", authorBot: false });
    expect(stubLogs(logger)).toHaveLength(1);
    // A bot that is not one of our waifus is never a wake.
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m3", authorId: "other-bot", authorBot: true });
    expect(stubLogs(logger)).toHaveLength(1);
    expect(sent).toEqual([]);
    await runtime.stop();
  });

  it("logs DMs, and a paused runtime accepts nothing", async () => {
    const { storage, discord, logger } = await setup();
    let paused = false;
    const runtime = new RuntimeOrchestrator({ storage, discord, logger, isPaused: () => paused });
    await runtime.handleDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: "500000000000000005", channelId: "7", messageId: "d1", createdAt: new Date().toISOString() });
    expect(stubLogs(logger)).toEqual([[LIVING_CAST_NOT_WIRED, { waifuId: "aria", messageId: "d1", dm: true }]]);
    paused = true;
    await runtime.handleDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: "500000000000000005", channelId: "7", messageId: "d2", createdAt: new Date().toISOString() });
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m1", authorId: "kevin", authorBot: false });
    expect(stubLogs(logger)).toHaveLength(1);
    await runtime.stop();
  });

  it("tracks a thread that inherits its parent's cast, joins it, and forgets it (conversation included) on delete", async () => {
    const { root, storage, runtime, discord } = await setup();
    const thread = { parentId: CHANNEL, name: "plans", kind: "public_thread" as const, archived: false, locked: false };
    await runtime.handleDiscordThreadChange({ change: "create", guildId: GUILD, threadId: THREAD, thread });
    expect((await readThreads(storage, GUILD)).threads[THREAD]).toMatchObject({ parentId: CHANNEL });
    expect(discord.joinThread).toHaveBeenCalledWith({ guildId: GUILD, threadId: THREAD });

    const dir = path.join(root, "user", "conversations", conversationKey({ kind: "guild", guildId: GUILD, channelId: THREAD }));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "refs.json"), "{}");
    await runtime.handleDiscordThreadChange({ change: "delete", guildId: GUILD, threadId: THREAD, thread });
    expect((await readThreads(storage, GUILD)).threads[THREAD]).toBeUndefined();
    await expect(access(dir)).rejects.toMatchObject({ code: "ENOENT" });
    await runtime.stop();
  });
});
