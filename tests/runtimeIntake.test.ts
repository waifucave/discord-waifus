// The runtime facade (Living cast §4.2): Discord intake keeps its bookkeeping (server and channel
// entries, threads, participants) and hands accepted messages and DMs to the life intake.
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureDataLayout } from "../src/config/layout.js";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { conversationKey } from "../src/orchestration/context/keys.js";
import { CastRuntime } from "../src/orchestration/runtime.js";
import { readThreads } from "../src/orchestration/stores/threads.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { ServerConfigSchema, WaifuConfigSchema } from "../src/shared/schemas/domain.js";
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
    connect: async () => ({ connected: true, houseConnected: true, waifuBotCount: 0, warnings: [] }),
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
  const runtime = new CastRuntime({ storage, discord, logger });
  return { root, storage, runtime, logger, sent, discord };
}

describe("runtime facade", () => {
  it("hands an accepted guild message to the life intake; channels without a cast and foreign bots are ignored", async () => {
    const { runtime, sent } = await setup();
    const intake = vi.spyOn(runtime.cast, "onGuildMessage").mockResolvedValue(undefined);
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m1", authorId: "kevin", authorDisplayName: "Kevin", authorBot: false });
    expect(intake.mock.calls).toEqual([[{ guildId: GUILD, channelId: CHANNEL, messageId: "m1", castWaifuIds: ["aria"], authorIsWaifu: false }]]);
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: "200000000000000099", messageId: "m2", authorId: "kevin", authorBot: false });
    expect(intake).toHaveBeenCalledTimes(1);
    // A bot that is not one of our waifus is never a wake.
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m3", authorId: "other-bot", authorBot: true });
    expect(intake).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    await runtime.stop();
  });

  it("hands DMs to the intake (which keeps DM state while paused); a paused runtime takes no guild messages", async () => {
    const { storage, discord, logger } = await setup();
    let paused = false;
    const runtime = new CastRuntime({ storage, discord, logger, isPaused: () => paused });
    const dms = vi.spyOn(runtime.cast, "onDirectMessage").mockResolvedValue(undefined);
    const guild = vi.spyOn(runtime.cast, "onGuildMessage").mockResolvedValue(undefined);
    await runtime.handleDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: "500000000000000005", channelId: "7", messageId: "d1", createdAt: new Date().toISOString() });
    expect(dms).toHaveBeenCalledTimes(1);
    paused = true;
    await runtime.handleDirectMessage({ waifuId: "aria", botId: "aria-bot", userId: "500000000000000005", channelId: "7", messageId: "d2", createdAt: new Date().toISOString() });
    expect(dms).toHaveBeenCalledTimes(2);
    await runtime.handleDiscordMessage({ guildId: GUILD, channelId: CHANNEL, messageId: "m1", authorId: "kevin", authorBot: false });
    expect(guild).not.toHaveBeenCalled();
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

  it("answers the owner's /wake, /print and the waifu autocomplete (§10.4)", async () => {
    const { storage, runtime } = await setup();
    for (const [id, displayName, enabled] of [["aria", "Aria", true], ["mina", "Mina", true], ["old", "Old", false]] as const) {
      await storage.writeJson(`waifu:${id}`, `user/waifus/${id}/waifu.json`, WaifuConfigSchema, WaifuConfigSchema.parse({ ...createRevisionedBase(), id, name: displayName, displayName, enabled }));
    }
    const wake = vi.spyOn(runtime.cast, "ownerWake").mockResolvedValue("queued");
    const replies: string[] = [];
    const respond = async (content: string) => void replies.push(content);
    await runtime.handleWakeCommand({ guildId: GUILD, channelId: CHANNEL, userId: "1", waifuId: "ARIA", note: "say hi", respond });
    await runtime.handleWakeCommand({ guildId: GUILD, channelId: CHANNEL, userId: "1", waifuId: "nobody", respond });
    // /wake reaches only this server's cast (Mina is cast nowhere here).
    await runtime.handleWakeCommand({ guildId: GUILD, channelId: CHANNEL, userId: "1", waifuId: "mina", respond });
    expect(wake.mock.calls).toEqual([["aria", "say hi"]]);
    // /print may target any waifu.
    vi.spyOn(runtime.cast, "printNotes").mockResolvedValue("# Memory");
    await runtime.handlePrintCommand({ guildId: GUILD, channelId: CHANNEL, userId: "1", waifuId: "Mina", type: "notes", respond });
    expect(replies).toEqual(["Woke Aria.", "I don't know that waifu.", "Mina isn't cast in this server.", "# Memory"]);
    const choices: unknown[] = [];
    const collect = async (list: unknown) => void choices.push(list);
    await runtime.handleWaifuAutocomplete({ commandName: "wake", guildId: GUILD, channelId: CHANNEL, focusedValue: "A", respond: collect });
    await runtime.handleWaifuAutocomplete({ commandName: "print", guildId: GUILD, channelId: CHANNEL, focusedValue: "MI", respond: collect });
    await runtime.handleWaifuAutocomplete({ commandName: "print", guildId: GUILD, channelId: CHANNEL, focusedValue: "old", respond: collect });
    // /wake: this server's cast only. /print: every waifu, a disabled one too (the layout seeds Lumi).
    expect(choices).toEqual([[{ name: "Aria", value: "aria" }], [{ name: "Lumi", value: "lumi" }, { name: "Mina", value: "mina" }], [{ name: "Old", value: "old" }]]);
    await runtime.stop();
  });
});
