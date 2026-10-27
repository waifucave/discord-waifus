// Shared fixtures for the Living cast tests (spec §12): a fake Discord that holds guild channels
// and DMs in memory, a data root with a server, a cast channel and waifus, a ModelClient over winter
// fakes, and a LivingCast wired to all of it. No live Discord, model or web calls.

import { deflateSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { fakeToolCallTurn } from "@yanlinglabs/winter-provider-runtime/testing";
import type { DiscordGatewayFacade } from "../src/discord/client.js";
import { ConversationMessageCache } from "../src/discord/conversationCache.js";
import { GuildDirectory } from "../src/discord/guildDirectory.js";
import { filterSinceCursor } from "../src/discord/conversationSource.js";
import { ModelClient } from "../src/models/client.js";
import { conversationKey, type ConversationRef } from "../src/orchestration/context/keys.js";
import { createRevisionedBase } from "../src/shared/schemas/common.js";
import { AppConfigSchema, DEFAULT_APP_CONFIG, type AppConfig } from "../src/shared/schemas/config.js";
import type { RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import {
  DiscordBotsFileSchema,
  ServerConfigSchema,
  WaifuConfigSchema,
  createEmptyRevisionedFile,
  type WaifuConfig
} from "../src/shared/schemas/domain.js";
import { StorageService } from "../src/storage/storageService.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { LivingCast, type LivingCastOptions } from "../src/life/livingCast.js";
import { checkEnvFor, homeStoreFor } from "../src/life/home/index.js";
import { addTranscriptLine, updateTranscriptAccess } from "../src/life/transcripts/store.js";
import { readWaifu } from "../src/orchestration/stores/config.js";
import { NoopUsageLedger, type UsageLedger, type UsageLedgerLine } from "../src/orchestration/usageLedger.js";
import { ANTHROPIC_MESSAGES, CHAT_COMPLETIONS, OPENAI_RESPONSES, fakeAdapter, fakeWinter, type FakeAdapter, type ScriptedTurn } from "./modelFakes.js";
import { quietLogger } from "./contextFixtures.js";
import { makeTempRoot } from "./testUtils.js";

export const GUILD = "100000000000000001";
export const CHANNEL = "200000000000000002";
export const CHANNEL_2 = "200000000000000003";
export const KEVIN = "300000000000000003";
export const MINA_USER = "300000000000000004";
export const ELLA_BOT = "400000000000000004";
export const MINA_BOT = "400000000000000005";
export const HOUSE_BOT = "400000000000000009";
export const TZ = "UTC";

const DISCORD_EPOCH = 1_420_070_400_000n;

/** A test clock that only moves when told. */
export class Clock {
  constructor(public ms = Date.parse("2026-10-24T14:00:00.000Z")) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

type PostOptions = {
  authorId?: string;
  authorName?: string;
  bot?: boolean;
  mentions?: Record<string, string>;
  roles?: Record<string, string>;
  everyone?: boolean;
  replyTo?: string;
  attachments?: RawDiscordMessage["attachments"];
};

/** Guild channels and DMs in memory. Sends land as real messages; nothing leaves the process. */
export class FakeDiscord implements DiscordGatewayFacade {
  readonly store = new Map<string, RawDiscordMessage[]>();
  readonly sent: Array<{ placeKey: string; content: string; senderBotId?: string; replyToMessageId?: string; messageId: string; files?: Array<{ name: string; size: number }> }> = [];
  readonly typing: string[] = [];
  readonly reactions: Array<{ placeKey: string; messageId: string; emoji: string; botId: string }> = [];
  botRoles: Record<string, string[]> = {};
  sendErrors: unknown[] = [];
  private counter = 0n;

  constructor(readonly clock: Clock) {}

  private nextId(): string {
    const base = (BigInt(this.clock.ms) - DISCORD_EPOCH) << 22n;
    this.counter = this.counter >= base ? this.counter + 1n : base;
    return this.counter.toString();
  }

  post(conversation: ConversationRef, content: string, o: PostOptions = {}): RawDiscordMessage {
    this.clock.advance(1_000);
    const message: RawDiscordMessage = {
      id: this.nextId(),
      channelId: conversation.kind === "guild" ? conversation.channelId : `dm-${conversation.userId}`,
      ...(conversation.kind === "guild" ? { guildId: conversation.guildId } : {}),
      authorId: o.authorId ?? KEVIN,
      authorName: o.authorName ?? "Kevin",
      authorIsBot: o.bot ?? false,
      createdAt: new Date(this.clock.ms).toISOString(),
      type: o.replyTo ? 19 : 0,
      content,
      attachments: o.attachments ?? [],
      embeds: [],
      stickers: [],
      snapshots: [],
      ...(o.replyTo ? { referenceMessageId: o.replyTo } : {}),
      mentions: { users: o.mentions ?? {}, roles: o.roles ?? {}, channels: {} },
      ...(o.everyone ? { mentionsEveryone: true } : {})
    };
    const key = conversationKey(conversation);
    this.store.set(key, [...(this.store.get(key) ?? []), message]);
    return message;
  }

  remove(conversation: ConversationRef, messageId: string): void {
    const key = conversationKey(conversation);
    this.store.set(key, (this.store.get(key) ?? []).filter((message) => message.id !== messageId));
  }

  messages(conversation: ConversationRef): RawDiscordMessage[] {
    return this.store.get(conversationKey(conversation)) ?? [];
  }

  async connect() {
    return { connected: true, houseConnected: true, waifuBotCount: 2, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<never[]> {
    return [];
  }
  ownAuthorIds() {
    return [ELLA_BOT, MINA_BOT, HOUSE_BOT];
  }

  async fetchContextSince(i: { guildId: string; channelId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages({ kind: "guild", guildId: i.guildId, channelId: i.channelId });
    return filterSinceCursor(all, i.afterMessageId, i.maxMessages, false);
  }

  async fetchDmContextSince(i: { waifuId: string; userId: string; afterMessageId: string | null; maxMessages: number }) {
    const all = this.messages({ kind: "dm", waifuId: i.waifuId, userId: i.userId });
    return filterSinceCursor(all, i.afterMessageId, i.maxMessages, false);
  }

  /** Discord's channel-messages page: before / after / around one id, at most `limit`, oldest first. */
  readonly pageRequests: Array<{ before?: string; after?: string; around?: string; limit: number }> = [];
  async fetchMessagesPage(i: { conversation: ConversationRef; before?: string; after?: string; around?: string; limit: number }) {
    this.pageRequests.push({ ...(i.before ? { before: i.before } : {}), ...(i.after ? { after: i.after } : {}), ...(i.around ? { around: i.around } : {}), limit: i.limit });
    const all = this.messages(i.conversation);
    if (i.around !== undefined) {
      const at = all.findIndex((message) => BigInt(message.id) >= BigInt(i.around!));
      const center = at < 0 ? all.length : at;
      const start = Math.max(0, center - Math.floor(i.limit / 2));
      return all.slice(start, start + i.limit);
    }
    if (i.after !== undefined) return all.filter((message) => BigInt(message.id) > BigInt(i.after!)).slice(0, i.limit);
    if (i.before !== undefined) return all.filter((message) => BigInt(message.id) < BigInt(i.before!)).slice(-i.limit);
    return all.slice(-i.limit);
  }

  private botAuthor(botId: string | undefined): { authorId: string; authorName: string } {
    if (botId === "mina-bot") return { authorId: MINA_BOT, authorName: "Mina" };
    return { authorId: ELLA_BOT, authorName: "Ella" };
  }

  /** What Discord's side does to outgoing content (the real facade resolves `<@Name>`, `:emoji:`). */
  rewrite: (content: string) => string = (content) => content;

  /** Attachments a send carried, as Discord would show them (a CDN url per file). */
  private sentAttachments(files: ReadonlyArray<{ name: string; data: Uint8Array }> | undefined): { attachments: RawDiscordMessage["attachments"]; summary: Array<{ name: string; size: number }> } {
    const list = files ?? [];
    return {
      attachments: list.map((file, index) => ({ id: `${this.nextId()}${index}`, filename: file.name, size: file.data.byteLength, url: `https://cdn.discordapp.com/attachments/x/${index}/${encodeURIComponent(file.name)}` })) as RawDiscordMessage["attachments"],
      summary: list.map((file) => ({ name: file.name, size: file.data.byteLength }))
    };
  }

  async sendWaifuMessage(input: { guildId: string; channelId: string; content: string; senderBotId?: string; replyToMessageId?: string; files?: Array<{ name: string; data: Uint8Array }>; onFinalContent?: (content: string) => void | Promise<void> }) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    const content = this.rewrite(input.content);
    await input.onFinalContent?.(content);
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const files = this.sentAttachments(input.files);
    const message = this.post(conversation, content, { ...this.botAuthor(input.senderBotId), bot: true, ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}), ...(files.attachments.length ? { attachments: files.attachments } : {}) });
    this.sent.push({ placeKey: conversationKey(conversation), content, ...(input.senderBotId ? { senderBotId: input.senderBotId } : {}), ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}), messageId: message.id, ...(files.summary.length ? { files: files.summary } : {}) });
    return { messageId: message.id };
  }

  async sendDirectMessage(input: { waifuId: string; userId: string; content: string; replyToMessageId?: string; files?: Array<{ name: string; data: Uint8Array }>; onFinalContent?: (content: string) => void | Promise<void> }) {
    const error = this.sendErrors.shift();
    if (error) throw error;
    const content = this.rewrite(input.content);
    await input.onFinalContent?.(content);
    const conversation: ConversationRef = { kind: "dm", waifuId: input.waifuId, userId: input.userId };
    const files = this.sentAttachments(input.files);
    const message = this.post(conversation, content, { ...this.botAuthor(input.waifuId === "mina" ? "mina-bot" : "ella-bot"), bot: true, ...(files.attachments.length ? { attachments: files.attachments } : {}) });
    this.sent.push({ placeKey: conversationKey(conversation), content, messageId: message.id, ...(files.summary.length ? { files: files.summary } : {}) });
    return { messageId: message.id };
  }

  async sendTyping(input: { channelId: string }) {
    this.typing.push(input.channelId);
  }
  async sendDirectTyping(input: { userId: string }) {
    this.typing.push(`dm:${input.userId}`);
  }

  async addReaction(input: { botId: string; conversation: ConversationRef; messageId: string; emoji: string }) {
    this.reactions.push({ placeKey: conversationKey(input.conversation), messageId: input.messageId, emoji: input.emoji, botId: input.botId });
  }

  async fetchBotMemberRoles(input: { botId: string; guildId: string }) {
    return this.botRoles[input.botId] ?? [];
  }
}

export const ROOM: ConversationRef = { kind: "guild", guildId: GUILD, channelId: CHANNEL };
export const ROOM_KEY = conversationKey(ROOM);
export const dmOf = (waifuId: string, userId = KEVIN): ConversationRef => ({ kind: "dm", waifuId, userId });

export type WaifuSeed = Partial<WaifuConfig> & { id: string; name: string; botId?: string };

export async function writeWaifuConfig(storage: StorageService, seed: WaifuSeed): Promise<void> {
  await storage.writeJson(
    `waifu:${seed.id}`,
    `user/waifus/${seed.id}/waifu.json`,
    WaifuConfigSchema,
    WaifuConfigSchema.parse({
      ...createRevisionedBase(),
      displayName: seed.name,
      enabled: true,
      model: { providerId: "anthropic", modelId: "claude-haiku-5-5" },
      persona: `${seed.name} is a sunny baker.`,
      availability: { bedTime: { enabled: false, start: "23:00", end: "07:00" } },
      dm: { allowDms: true, rateLimit: { maxReplies: 30, windowMinutes: 60 }, notifyWhenLimited: true, limitNotice: "", sleepNotice: "" },
      ...seed
    })
  );
}

/** A data root with Bake Club (#general cast: Ella, and Mina when given), bots and waifus. */
export async function seedWorld(storage: StorageService, o: { waifus?: WaifuSeed[]; cast?: string[] } = {}): Promise<void> {
  const waifus = o.waifus ?? [{ id: "ella", name: "Ella", botId: "ella-bot" }];
  await storage.writeJson(
    "discord-bots",
    "user/discord-bots.json",
    DiscordBotsFileSchema,
    DiscordBotsFileSchema.parse(
      createEmptyRevisionedFile({
        orchestrator: { id: HOUSE_BOT, displayName: "House", enabled: true, token: "t" },
        waifus: [
          { id: "ella-bot", displayName: "Ella", enabled: true, token: "t", applicationId: ELLA_BOT },
          { id: "mina-bot", displayName: "Mina", enabled: true, token: "t", applicationId: MINA_BOT }
        ]
      })
    )
  );
  for (const waifu of waifus) await writeWaifuConfig(storage, waifu);
  const cast = o.cast ?? waifus.map((waifu) => waifu.id);
  await storage.writeJson(
    `server:${GUILD}`,
    `user/servers/${GUILD}/server.json`,
    ServerConfigSchema,
    ServerConfigSchema.parse({
      ...createRevisionedBase(),
      guildId: GUILD,
      name: "Bake Club",
      channels: {
        [CHANNEL]: { channelId: CHANNEL, name: "general", enabledWaifuIds: cast },
        [CHANNEL_2]: { channelId: CHANNEL_2, name: "recipes", enabledWaifuIds: cast }
      }
    })
  );
}

/** Captures ledger lines in memory. */
export class MemoryLedger implements UsageLedger {
  readonly lines: UsageLedgerLine[] = [];
  async record(entry: UsageLedgerLine): Promise<void> {
    this.lines.push(entry);
  }
  async flush(): Promise<void> {}
}

export type LifeWorld = {
  root: string;
  storage: StorageService;
  discord: FakeDiscord;
  clock: Clock;
  cast: LivingCast;
  anthropic: FakeAdapter;
  chat: FakeAdapter;
  responses: FakeAdapter;
  ledger: MemoryLedger;
  models: ModelClient;
  config: AppConfig;
  setConfig(patch: (config: AppConfig) => AppConfig): void;
  /** A process restart: a new LivingCast (fresh caches) over the same data root, fake Discord and models. */
  restart(options?: Partial<LivingCastOptions>): LivingCast;
};

const openCasts = new Set<LivingCast>();

/** Stops every LivingCast built by lifeWorld (timers, lives) — call in afterEach before removing roots. */
export async function closeWorlds(): Promise<void> {
  const casts = [...openCasts];
  openCasts.clear();
  await Promise.all(casts.map((cast) => cast.stop().catch(() => undefined)));
}

export async function lifeWorld(
  roots: string[],
  o: {
    waifus?: WaifuSeed[];
    cast?: string[];
    scripts?: ScriptedTurn[];
    config?: (config: AppConfig) => AppConfig;
    options?: Partial<LivingCastOptions>;
    paused?: () => boolean;
    /** A ModelClient of the test's own (e.g. the real winter adapters against a loopback server). */
    models?: (o: { ledger: MemoryLedger; clock: Clock }) => ModelClient;
    /** Where the temp data root is made (default: the OS temp directory). */
    rootBase?: string;
  } = {}
): Promise<LifeWorld> {
  const root = await makeTempRoot("dc-waifus-life-", o.rootBase);
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  await seedWorld(storage, { ...(o.waifus ? { waifus: o.waifus } : {}), ...(o.cast ? { cast: o.cast } : {}) });
  const clock = new Clock();
  const discord = new FakeDiscord(clock);
  const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, o.scripts ?? []);
  const chat = fakeAdapter(CHAT_COMPLETIONS, o.scripts ?? []);
  const responses = fakeAdapter(OPENAI_RESPONSES, o.scripts ?? []);
  const ledger = new MemoryLedger();
  const models = o.models ? o.models({ ledger, clock }) : new ModelClient({ winter: fakeWinter(anthropic, chat, responses), credentials: () => "test-key", usageLedger: ledger, now: () => clock.ms });
  let config = AppConfigSchema.parse(o.config ? o.config(structuredClone(DEFAULT_APP_CONFIG)) : DEFAULT_APP_CONFIG);
  const logger = quietLogger() as never;
  const build = (options: Partial<LivingCastOptions> = {}): LivingCast => {
    const directory = new GuildDirectory({ storage, logger, transport: async () => undefined });
    const conversations = new ConversationMessageCache({ discord: () => discord, logger, directory });
    const built = new LivingCast({
      storage,
      logger,
      discord: () => discord,
      conversations,
      directory,
      models,
      config: () => config,
      isPaused: o.paused ?? (() => false),
      usageLedger: NoopUsageLedger,
      credentials: () => "test-key",
      now: clock.now,
      timeZone: TZ,
      random: () => 0,
      sleep: async () => undefined,
      manualScheduler: true,
      ...o.options,
      ...options
    });
    openCasts.add(built);
    return built;
  };
  const cast = build();
  return {
    root,
    storage,
    discord,
    clock,
    cast,
    anthropic,
    chat,
    responses,
    ledger,
    models,
    get config() {
      return config;
    },
    setConfig(patch) {
      config = AppConfigSchema.parse(patch(structuredClone(config)));
    },
    restart: build
  };
}

/** One assistant turn calling tools (ids `call_<n>`). */
export function toolTurn(calls: Array<{ name: string; input: unknown; id?: string }>, o: { text?: string; usage?: { inputTokens: number; outputTokens: number } } = {}): ProviderEvent[] {
  let n = 0;
  return fakeToolCallTurn(
    calls.map((call) => ({ id: call.id ?? `call_${(n += 1)}_${call.name}`, name: call.name, input: call.input })),
    { ...(o.text !== undefined ? { text: o.text } : {}), usage: o.usage ?? { inputTokens: 1000, outputTokens: 50 } }
  );
}

export function script(...turns: ProviderEvent[][]): ScriptedTurn[] {
  return turns.map((events) => () => events);
}

/** A real PNG of `width`×`height` (one solid colour), for Read and Bash image tests. */
export function tinyPng(width = 4, height = 4, rgb: [number, number, number] = [200, 80, 40]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A small valid PDF with one line of text per page. */
export function tinyPdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, index) => {
    const pageId = pageIds[index]!;
    const stream = `BT /F1 18 Tf 40 700 Td (${text.replace(/[()\\]/gu, "")}) Tj ET`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = Buffer.byteLength(out);
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** One of her files on disk (`home` or `tmp`), or undefined. */
export async function herFile(w: Pick<LifeWorld, "root">, waifuId: string, relative: string): Promise<string | undefined> {
  return readFile(path.join(w.root, "user", "waifus", waifuId, ...relative.split("/")), "utf8").catch(() => undefined);
}

/** Her home folder for a test: plain files written and read on disk (no checks), like the owner would. */
export function homeOf(w: Pick<LifeWorld, "root">, waifuId = "ella") {
  const host = (relative: string) => path.join(w.root, "user", "waifus", waifuId, "home", ...relative.split("/"));
  return {
    async write(relative: string, content: string): Promise<void> {
      await mkdir(path.dirname(host(relative)), { recursive: true });
      await writeFile(host(relative), content);
    },
    read: (relative: string): Promise<string | undefined> => readFile(host(relative), "utf8").catch(() => undefined)
  };
}

/** Writes one of her files through her store with every check (her reminders and watches resolve too). */
export async function writeHerFile(w: Pick<LifeWorld, "cast" | "storage">, relative: string, content: string, waifuId = "ella"): Promise<void> {
  const waifu = await readWaifu(w.storage, waifuId);
  const store = homeStoreFor(w.cast.deps, waifu);
  const target = store.resolve(`~/${relative}`);
  if (!target.ok) throw new Error(target.error);
  await store.writeText(target.path, content, checkEnvFor(w.cast.deps, waifuId));
}

/** Her reminder or watch file (in `~/life/`), parsed. */
export async function herEntries(w: Pick<LifeWorld, "root">, name: "reminders.json" | "watches.json", waifuId = "ella"): Promise<Array<Record<string, unknown>>> {
  const text = await homeOf(w, waifuId).read(`life/${name}`);
  return text?.trim() ? (JSON.parse(text) as Array<Record<string, unknown>>) : [];
}

/**
 * Transcript lines (spec §18.2) for a waifu: her room access opens a day back, then each line is
 * written `minutesAgo` before the clock (default: one a minute, the last a minute ago).
 */
export async function seedTranscript(
  w: Pick<LifeWorld, "root" | "clock">,
  lines: Array<{ text: string; author?: string; authorId?: string; waifu?: string; minutesAgo?: number }>,
  o: { conversation?: ConversationRef; waifuId?: string } = {}
): Promise<string[]> {
  const conversation = o.conversation ?? ROOM;
  const key = conversationKey(conversation);
  const waifuId = o.waifuId ?? "ella";
  if (conversation.kind === "guild") {
    await updateTranscriptAccess(w.root, waifuId, (access) => {
      if (access.conversations[key]?.length) return undefined;
      access.conversations[key] = [{ from: new Date(w.clock.ms - 86_400_000).toISOString() }];
      return access;
    });
  }
  const ids: string[] = [];
  for (const [index, line] of lines.entries()) {
    const at = new Date(w.clock.ms - (line.minutesAgo ?? lines.length - index) * 60_000);
    const id = ((BigInt(at.getTime()) - DISCORD_EPOCH) << 22n).toString();
    ids.push(id);
    await addTranscriptLine({ dataRoot: w.root, timeZone: TZ }, key, {
      id,
      at: at.toISOString(),
      authorId: line.authorId ?? KEVIN,
      author: line.author ?? "Kevin",
      ...(line.waifu ? { waifu: line.waifu } : {}),
      text: line.text
    });
  }
  return ids;
}
