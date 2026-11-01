// Channel access (Living cast spec §42, owner request 2026-11-01): when the owner casts a waifu in a
// server channel her bot can't view or post in (a private channel that only some roles see), the
// House bot opens it to her bot alone with a channel override, and takes that override away again
// when she is no longer cast there. Only overrides it added are ever removed (recorded in
// `app/channel-access.json`), and only while they are still exactly what it set; an override for her
// bot that someone else set, or that someone changed or removed, is theirs and left alone.

import path from "node:path";
import { z } from "zod";
import type { Logger } from "../backend/logger.js";
import type { DiscordGatewayFacade } from "../discord/client.js";
import type { OwnerNotices } from "../life/ownerNotices.js";
import type { StorageService } from "../storage/storageService.js";
import { listServers, listWaifus, readDiscordBotsFile } from "./stores/config.js";

export const CHANNEL_ACCESS_PATH = path.join("app", "channel-access.json");

const GrantSchema = z.object({
  guildId: z.string().min(1),
  /** The channel the override is on (a thread's channel). */
  channelId: z.string().min(1),
  botId: z.string().min(1),
  botUserId: z.string().min(1),
  /** The permissions it allows, as Discord's bitfield string; nothing is denied. */
  allow: z.string().min(1),
  /** The server-config channel entries it is for (a channel, or a thread of it with a cast of its own). */
  for: z.array(z.string().min(1)),
  at: z.string().min(1)
});
const FileSchema = z.object({ grants: z.array(GrantSchema).default([]) });
type Grant = z.infer<typeof GrantSchema>;

type Wanted = { guildId: string; entryId: string; waifuId: string; botId: string; where: string };

const UNREADABLE_NOTICE = "channel-access:unreadable";
const noticeKey = (w: Wanted) => `channel-access:${w.guildId}:${w.entryId}:${w.waifuId}`;

export class ChannelAccessSync {
  private running: Promise<void> | undefined;
  private again = false;
  /** The notice keys this sync has set (in memory, like the notices). */
  private readonly noticed = new Set<string>();

  constructor(
    private readonly options: {
      storage: StorageService;
      discord: () => DiscordGatewayFacade;
      logger: Logger;
      notices?: OwnerNotices;
      now?: () => Date;
    }
  ) {}

  /** One pass over every server; a call while one runs queues one more after it. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    };
    this.running = run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const discord = this.options.discord();
    if (!discord.openChannelFor || !discord.closeChannelFor) return;
    const [servers, waifus, bots] = await Promise.all([listServers(this.options.storage), listWaifus(this.options.storage), readDiscordBotsFile(this.options.storage)]);
    const waifuBots = new Set(bots.waifus.filter((bot) => bot.enabled !== false).map((bot) => bot.id));
    const botOf = new Map(waifus.flatMap((waifu) => (waifu.botId && waifuBots.has(waifu.botId) ? [[waifu.id, { botId: waifu.botId, name: waifu.displayName }] as const] : [])));
    const wanted: Wanted[] = [];
    for (const server of servers) {
      for (const [entryId, channel] of Object.entries(server.channels)) {
        for (const waifuId of channel.enabledWaifuIds ?? []) {
          const bot = botOf.get(waifuId);
          if (bot) wanted.push({ guildId: server.guildId, entryId, waifuId, botId: bot.botId, where: `${bot.name} in ${server.name ?? server.guildId} #${channel.name ?? entryId}` });
        }
      }
    }
    const file = await this.read();
    if (!file) return;
    const grants = file.grants.map((grant) => ({ ...grant, for: [...grant.for] }));
    const covered = (w: Wanted) => grants.some((g) => g.guildId === w.guildId && g.botId === w.botId && g.for.includes(w.entryId));

    for (const w of wanted) {
      if (covered(w)) continue;
      try {
        const result = await discord.openChannelFor({ botId: w.botId, guildId: w.guildId, channelId: w.entryId });
        if (result.status === "opened") {
          grants.push({ guildId: w.guildId, channelId: result.channelId, botId: w.botId, botUserId: result.botUserId, allow: result.allow, for: [w.entryId], at: (this.options.now?.() ?? new Date()).toISOString() });
          this.options.logger.info("Opened a channel for her bot", { guildId: w.guildId, channelId: result.channelId, waifuId: w.waifuId });
          this.clearNotice(noticeKey(w));
        } else if (result.status === "open" || result.status === "theirs") {
          // One of ours on that channel already (a thread of it, or the channel itself) covers this entry too.
          const ours = grants.find((g) => g.guildId === w.guildId && g.botId === w.botId && g.channelId === result.channelId);
          if (ours) ours.for.push(w.entryId);
          if (ours || result.status === "open") this.clearNotice(noticeKey(w));
          else this.setNotice(noticeKey(w), `${w.where}: her bot can't post there, and someone has set a channel override for it; change it in Discord (the House bot leaves it alone).`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.options.logger.warn("Could not open a channel for her bot", { guildId: w.guildId, channelId: w.entryId, waifuId: w.waifuId, message });
        this.setNotice(noticeKey(w), `${w.where}: her bot can't post there and the House bot couldn't open it (${message}); give the House bot Manage Permissions there, or open it for her bot in Discord.`);
      }
    }

    const kept: Grant[] = [];
    for (const grant of grants) {
      grant.for = grant.for.filter((entryId) => wanted.some((w) => w.guildId === grant.guildId && w.botId === grant.botId && w.entryId === entryId));
      if (grant.for.length > 0) {
        kept.push(grant);
        continue;
      }
      try {
        const result = await discord.closeChannelFor({ guildId: grant.guildId, channelId: grant.channelId, botUserId: grant.botUserId, allow: grant.allow });
        if (result === "unknown") {
          kept.push(grant);
          continue;
        }
        if (result === "removed") this.options.logger.info("Closed a channel the House bot had opened for her bot", { guildId: grant.guildId, channelId: grant.channelId, botId: grant.botId });
      } catch (error) {
        kept.push(grant);
        this.options.logger.warn("Could not close a channel the House bot had opened for her bot", { guildId: grant.guildId, channelId: grant.channelId, botId: grant.botId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    // A notice about a cast she is no longer in goes with it.
    const wantedKeys = new Set(wanted.map(noticeKey));
    for (const key of this.noticed) if (!wantedKeys.has(key)) this.clearNotice(key);
    if (JSON.stringify(kept) !== JSON.stringify(file.grants)) {
      await this.options.storage.writeJson("app:channel-access", CHANNEL_ACCESS_PATH, FileSchema, { grants: kept });
    }
  }

  /** Unreadable: nothing is done (the overrides it lists could never be closed again), with a notice. */
  private async read(): Promise<z.infer<typeof FileSchema> | undefined> {
    try {
      const file = await this.options.storage.readJson(CHANNEL_ACCESS_PATH, FileSchema, { grants: [] });
      this.clearNotice(UNREADABLE_NOTICE);
      return file;
    } catch (error) {
      this.options.logger.warn("Channel access record unreadable", { message: error instanceof Error ? error.message : String(error) });
      this.setNotice(UNREADABLE_NOTICE, "app/channel-access.json is unreadable: the House bot neither opens nor closes channels for the waifu bots until it is repaired or removed (removing it forgets which overrides it added).");
      return undefined;
    }
  }

  private setNotice(key: string, text: string): void {
    this.noticed.add(key);
    this.options.notices?.set(key, text);
  }

  private clearNotice(key: string): void {
    this.noticed.delete(key);
    this.options.notices?.clear(key);
  }
}
