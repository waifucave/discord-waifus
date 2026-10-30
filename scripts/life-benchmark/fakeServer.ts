// The fake Discord of a benchmark run (spec §33.2): the scenario's server and DMs in memory, fed to
// the app the way the real gateway feeds it (conversation events for the message cache, a directory
// snapshot, the runtime's message and DM handlers), and recording everything the waifu sends and
// reacts. Nothing leaves the process. Attachments are served from memory by `FakeAttachments`. What she
// sends goes through the real client's mention repair first (spec §35.5), so a run records what Discord
// receives.

import { deflateSync } from "node:zlib";
import type { DiscordGatewayFacade, OutgoingFile } from "../../src/discord/client.js";
import type { DiscordConversationEvent, DiscordConversationEventListener, DiscordDirectoryEventListener } from "../../src/discord/gatewayEvents.js";
import { filterSinceCursor } from "../../src/discord/conversationSource.js";
import { denormalizeModelContentForDiscord } from "../../src/discord/normalization.js";
import type { GuildMemberCacheEntry } from "../../src/shared/schemas/domain.js";
import type { AttachmentFileRef, AttachmentFileResult, ImageFetchResult, ImageFetcher } from "../../src/discord/attachments.js";
import { conversationKey, type ConversationRef } from "../../src/orchestration/context/keys.js";
import type { ImageRef, RawDiscordMessage } from "../../src/shared/schemas/discordMessage.js";
import type { Attachment } from "./scenario.js";

const DISCORD_EPOCH = 1_420_070_400_000n;

/** The simulated clock: it moves only when the driver (or one of her own waits) moves it. */
export class SimClock {
  constructor(public ms: number) {}
  now = (): Date => new Date(this.ms);
  set(ms: number): void {
    if (ms > this.ms) this.ms = ms;
  }
  advance(ms: number): void {
    if (ms > 0) this.ms += ms;
  }
}

/** What the waifu sent: one record per Discord message or reaction. */
export type SentRecord = {
  kind: "message" | "reaction";
  placeKey: string;
  /** Guild channel or DM. */
  dm: boolean;
  messageId: string;
  at: string;
  /** What Discord received: her text after the real client's mention and emoji repair (`<@id>` mentions). */
  content: string;
  /** Her model's text, when the repair changed it. */
  modelContent?: string;
  /** `content` as Discord shows it (a mention as `@Name`), when that differs. */
  shown?: string;
  replyToMessageId?: string;
  files?: Array<{ name: string; size: number }>;
  emoji?: string;
};

/** Attachment bytes by URL and by key (the scenario's files, and images she opened with Read). */
export class FakeAttachments implements ImageFetcher {
  private readonly byKey = new Map<string, { mimeType: string; data: Buffer }>();

  register(key: string, mimeType: string, data: Buffer): void {
    this.byKey.set(key, { mimeType, data });
  }

  async get(ref: ImageRef): Promise<ImageFetchResult> {
    const hit = this.byKey.get(ref.key);
    if (!hit) return { ok: false, reason: "http_error" };
    if (!hit.mimeType.startsWith("image/")) return { ok: false, reason: "unsupported_type" };
    return { ok: true, mimeType: hit.mimeType, data: hit.data, source: "memory" };
  }

  async put(key: string, value: { mimeType: string; data: Buffer }): Promise<void> {
    this.byKey.set(key, value);
  }

  async purge(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.byKey.delete(key);
  }

  async fetchFile(ref: AttachmentFileRef, o: { maxBytes: number }): Promise<AttachmentFileResult> {
    const hit = this.byKey.get(ref.key);
    if (!hit) return { ok: false, reason: "http_error" };
    if (hit.data.byteLength > o.maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, data: hit.data, mimeType: hit.mimeType };
  }
}

export type FakeServerOptions = {
  clock: SimClock;
  waifuId: string;
  /** Her bot's config id (`discord-bots.json`) and Discord user id. */
  botConfigId: string;
  botUserId: string;
  botName: string;
  houseUserId: string;
  guild?: { id: string; name: string; channels: Array<{ id: string; name: string }> };
  people: Array<{ id: string; name: string }>;
  attachments: FakeAttachments;
  /** Each message or reaction she sends, as it lands. */
  onSent?: (record: SentRecord) => void;
};

export type PostOptions = {
  replyTo?: string;
  mentions?: Record<string, string>;
  everyone?: boolean;
  attachments?: Attachment[];
  /** Discord message type (7: a member joined). */
  type?: number;
};

export class FakeServer implements DiscordGatewayFacade {
  readonly store = new Map<string, RawDiscordMessage[]>();
  readonly sent: SentRecord[] = [];
  private readonly conversationListeners = new Set<DiscordConversationEventListener>();
  private readonly directoryListeners = new Set<DiscordDirectoryEventListener>();
  private counter = 0n;

  constructor(readonly o: FakeServerOptions) {}

  private nextId(): string {
    const base = (BigInt(this.o.clock.ms) - DISCORD_EPOCH) << 22n;
    this.counter = this.counter >= base ? this.counter + 1n : base;
    return this.counter.toString();
  }

  private emit(event: DiscordConversationEvent): void {
    for (const listener of this.conversationListeners) listener(event);
  }

  guildRef(channelId: string): ConversationRef {
    if (!this.o.guild) throw new Error("The scenario has no server.");
    return { kind: "guild", guildId: this.o.guild.id, channelId };
  }

  dmRef(userId: string): ConversationRef {
    return { kind: "dm", waifuId: this.o.waifuId, userId };
  }

  messages(conversation: ConversationRef): RawDiscordMessage[] {
    return this.store.get(conversationKey(conversation)) ?? [];
  }

  /** A message lands in a conversation (a person's, or hers) and the gateway event goes out. */
  post(conversation: ConversationRef, author: { id: string; name: string; bot: boolean }, content: string, o: PostOptions = {}, own = false): RawDiscordMessage {
    const id = this.nextId();
    const attachments = (o.attachments ?? []).map((attachment, index) => this.attachmentOf(conversation, `${id}${index}`, attachment));
    const message: RawDiscordMessage = {
      id,
      channelId: conversation.kind === "guild" ? conversation.channelId : `dm-${conversation.userId}`,
      ...(conversation.kind === "guild" ? { guildId: conversation.guildId } : {}),
      authorId: author.id,
      authorName: author.name,
      authorIsBot: author.bot,
      createdAt: new Date(this.o.clock.ms).toISOString(),
      type: o.type ?? (o.replyTo ? 19 : 0),
      content,
      attachments,
      embeds: [],
      stickers: [],
      snapshots: [],
      ...(o.replyTo ? { referenceMessageId: o.replyTo } : {}),
      mentions: { users: o.mentions ?? {}, roles: {}, channels: {} },
      ...(o.everyone ? { mentionsEveryone: true } : {})
    };
    const key = conversationKey(conversation);
    this.store.set(key, [...(this.store.get(key) ?? []), message]);
    this.emit({ type: "create", conversation, message, ...(own ? { own: true } : {}) });
    return message;
  }

  private attachmentOf(conversation: ConversationRef, attachmentId: string, attachment: Attachment): RawDiscordMessage["attachments"][number] {
    const data = attachment.png ? solidPng(attachment.png.width, attachment.png.height, attachment.png.rgb) : Buffer.from(attachment.text ?? "", "utf8");
    this.o.attachments.register(`att:${attachmentId}`, attachment.contentType, data);
    const channel = conversation.kind === "guild" ? conversation.channelId : `dm-${conversation.userId}`;
    return {
      id: attachmentId,
      url: `https://cdn.discordapp.com/attachments/${channel}/${attachmentId}/${encodeURIComponent(attachment.name)}`,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: data.byteLength,
      ...(attachment.png ? { width: attachment.png.width, height: attachment.png.height } : {})
    };
  }

  /** The server's members as the directory snapshot has them (the people and her bot). */
  members(): GuildMemberCacheEntry[] {
    return [
      ...this.o.people.map((person) => ({ userId: person.id, username: person.name.toLowerCase(), guildDisplayName: person.name, bot: false, perChannelLastSeenAt: {} })),
      { userId: this.o.botUserId, username: this.o.botName.toLowerCase(), guildDisplayName: this.o.botName, bot: true, perChannelLastSeenAt: {} }
    ];
  }

  /**
   * Her text as the real client sends it (`DiscordGateway.sendWaifuMessage` / `sendDirectMessage`):
   * `denormalizeModelContentForDiscord` with the server's members and the place's people as active
   * authors; a DM with its person only, as the real DM send does. Returns the final content, the users
   * it mentions (the message's mention map, as Discord fills it) and the content as Discord shows it.
   */
  repair(content: string, o: { dm: boolean; activeAuthorIds: readonly string[] }): { content: string; mentions: Record<string, string>; shown: string } {
    const members = this.members();
    const final = denormalizeModelContentForDiscord(content, o.dm ? { activeAuthorIds: [...o.activeAuthorIds] } : { members, emojis: [], activeAuthorIds: [...o.activeAuthorIds] }).content;
    const names = new Map(members.map((member) => [member.userId, member.guildDisplayName ?? member.userId] as const));
    const mentions: Record<string, string> = {};
    const shown = final.replace(/<@!?(\d+)>/gu, (raw, id: string) => {
      const name = names.get(id);
      if (!name) return raw;
      mentions[id] = name;
      return `@${name}`;
    });
    return { content: final, mentions, shown };
  }

  private sentContent(model: string, repaired: { content: string; shown: string }): Pick<SentRecord, "content" | "modelContent" | "shown"> {
    return { content: repaired.content, ...(repaired.content !== model ? { modelContent: model } : {}), ...(repaired.shown !== repaired.content ? { shown: repaired.shown } : {}) };
  }

  private record(record: SentRecord): void {
    this.sent.push(record);
    this.o.onSent?.(record);
  }

  // ---- DiscordGatewayFacade ------------------------------------------------------------------------

  async connect() {
    return { connected: true, houseConnected: true, waifuBotCount: 1, warnings: [] };
  }
  async disconnect() {}
  async fetchFreshContext(): Promise<never[]> {
    return [];
  }
  ownAuthorIds(): string[] {
    return [this.o.botUserId, this.o.houseUserId];
  }

  onConversationEvent(listener: DiscordConversationEventListener): () => void {
    this.conversationListeners.add(listener);
    // Both gateway scopes are live from the start: the cache trusts what it has synced.
    listener({ type: "connection", scope: "guild", state: "ready" });
    listener({ type: "connection", scope: `dm:${this.o.waifuId}`, state: "ready" });
    return () => this.conversationListeners.delete(listener);
  }

  onDirectoryEvent(listener: DiscordDirectoryEventListener): () => void {
    this.directoryListeners.add(listener);
    const guild = this.o.guild;
    if (guild) {
      listener({
        guildId: guild.id,
        type: "snapshot",
        name: guild.name,
        roles: [],
        emojis: [],
        channels: guild.channels.map((channel) => ({ id: channel.id, name: channel.name, kind: "channel" as const })),
        members: [
          ...this.o.people.map((person) => ({ userId: person.id, username: person.name.toLowerCase(), guildDisplayName: person.name, bot: false, perChannelLastSeenAt: {} })),
          { userId: this.o.botUserId, username: this.o.botName.toLowerCase(), guildDisplayName: this.o.botName, bot: true, perChannelLastSeenAt: {} }
        ]
      });
    }
    return () => this.directoryListeners.delete(listener);
  }

  async fetchContextSince(i: { guildId: string; channelId: string; afterMessageId: string | null; maxMessages: number }) {
    return filterSinceCursor(this.messages({ kind: "guild", guildId: i.guildId, channelId: i.channelId }), i.afterMessageId, i.maxMessages, false);
  }

  async fetchDmContextSince(i: { waifuId: string; userId: string; afterMessageId: string | null; maxMessages: number }) {
    return filterSinceCursor(this.messages(this.dmRef(i.userId)), i.afterMessageId, i.maxMessages, false);
  }

  async fetchMessagesPage(i: { conversation: ConversationRef; before?: string; after?: string; around?: string; limit: number }) {
    const all = this.messages(i.conversation);
    if (i.around !== undefined) {
      const at = all.findIndex((message) => BigInt(message.id) >= BigInt(i.around!));
      const center = at < 0 ? all.length : at;
      const start = Math.max(0, center - Math.floor(i.limit / 2));
      return all.slice(start, start + i.limit);
    }
    if (i.after !== undefined && i.before !== undefined) return all.filter((m) => BigInt(m.id) > BigInt(i.after!) && BigInt(m.id) < BigInt(i.before!)).slice(0, i.limit);
    if (i.after !== undefined) return all.filter((message) => BigInt(message.id) > BigInt(i.after!)).slice(0, i.limit);
    if (i.before !== undefined) return all.filter((message) => BigInt(message.id) < BigInt(i.before!)).slice(-i.limit);
    return all.slice(-i.limit);
  }

  private herAuthor() {
    return { id: this.o.botUserId, name: this.o.botName, bot: true };
  }

  private filesOf(files: readonly OutgoingFile[] | undefined): { attachments: Attachment[]; summary: Array<{ name: string; size: number }> } {
    const list = files ?? [];
    return {
      attachments: list.map((file) => ({ name: file.name, contentType: "application/octet-stream", text: file.data.toString("utf8").slice(0, 20_000) })),
      summary: list.map((file) => ({ name: file.name, size: file.data.byteLength }))
    };
  }

  async sendWaifuMessage(input: { guildId: string; channelId: string; content: string; senderBotId?: string; replyToMessageId?: string; allowedUserMentionIds: string[]; files?: OutgoingFile[]; onFinalContent?: (content: string) => void | Promise<void> }) {
    const repaired = this.repair(input.content, { dm: false, activeAuthorIds: input.allowedUserMentionIds });
    await input.onFinalContent?.(repaired.content);
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const files = this.filesOf(input.files);
    const message = this.post(conversation, this.herAuthor(), repaired.content, { ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}), mentions: repaired.mentions, attachments: files.attachments }, true);
    this.record({ kind: "message", placeKey: conversationKey(conversation), dm: false, messageId: message.id, at: message.createdAt, ...this.sentContent(input.content, repaired), ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}), ...(files.summary.length ? { files: files.summary } : {}) });
    return { messageId: message.id };
  }

  async sendDirectMessage(input: { waifuId: string; userId: string; content: string; replyToMessageId?: string; files?: OutgoingFile[]; onFinalContent?: (content: string) => void | Promise<void> }) {
    const repaired = this.repair(input.content, { dm: true, activeAuthorIds: [input.userId] });
    await input.onFinalContent?.(repaired.content);
    const conversation = this.dmRef(input.userId);
    const files = this.filesOf(input.files);
    const message = this.post(conversation, this.herAuthor(), repaired.content, { ...(input.replyToMessageId ? { replyTo: input.replyToMessageId } : {}), mentions: repaired.mentions, attachments: files.attachments }, true);
    this.record({ kind: "message", placeKey: conversationKey(conversation), dm: true, messageId: message.id, at: message.createdAt, ...this.sentContent(input.content, repaired), ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}), ...(files.summary.length ? { files: files.summary } : {}) });
    return { messageId: message.id };
  }

  async sendTyping() {}
  async sendDirectTyping() {}

  async addReaction(input: { conversation: ConversationRef; messageId: string; emoji: string }) {
    this.emit({ type: "reaction", conversation: input.conversation, action: "add", messageId: input.messageId, emoji: { name: input.emoji }, userId: this.o.botUserId, userName: this.o.botName });
    this.record({ kind: "reaction", placeKey: conversationKey(input.conversation), dm: input.conversation.kind === "dm", messageId: input.messageId, at: new Date(this.o.clock.ms).toISOString(), content: "", emoji: input.emoji });
  }

  async fetchBotMemberRoles(): Promise<string[]> {
    return [];
  }
}

/** A real one-colour PNG. */
export function solidPng(width: number, height: number, rgb: readonly [number, number, number]): Buffer {
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [...rgb]).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
