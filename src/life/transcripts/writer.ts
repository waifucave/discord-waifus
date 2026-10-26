// The transcript writer (Living cast spec §18.2): the conversation cache's feed (gateway messages,
// our own sends, edits, deletes and the REST pages catch-up reads) becomes transcript lines.
//
// A room is written only while some waifu is cast there; before each write the cast is compared
// with the open access intervals (an interval opens for a waifu newly cast, closes for one no longer
// cast), so a waifu added later never sees what was said before she arrived and one removed keeps
// what she saw. A DM is written for the waifu whose DM it is. Lines older than the store
// (`store.json` `startedAt`: no backfill before the feature), a forgotten person's messages from
// before their forget and the lines from before it that mention them (by id: a REST catch-up after a
// forget cannot bring them back), ids a forget or a Discord delete removed and DM lines at or below a
// forget floor are never written. Edits replace a line (marked edited); deletes remove it. Access
// intervals open and close at the time of the oldest message in the event (catch-up after downtime
// never shows a removed waifu what was said after she left).

import type { ConversationCacheEvent } from "../../discord/conversationCache.js";
import { snowflakeTime } from "../../discord/refStore.js";
import { conversationKey, type ConversationRef } from "../../orchestration/context/keys.js";
import { EMPTY_GUILD_DIRECTORY, renderDiscordMessage } from "../../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../../orchestration/context/types.js";
import { readForgottenPeople } from "../../orchestration/dm/forgotten.js";
import { channelHasWaifus, listWaifus } from "../../orchestration/stores/config.js";
import { withThreadChannels } from "../../orchestration/stores/threads.js";
import { ServerConfigSchema } from "../../shared/schemas/domain.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { LifeDeps } from "../deps.js";
import { isRemovedMessage, selfAuthorIds } from "../people.js";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { lineCarriesPerson } from "./forget.js";
import {
  addTranscriptLine,
  deleteTranscriptLines,
  editTranscriptLine,
  listAccessWaifuIds,
  listTranscriptDays,
  readTranscriptDay,
  readTranscriptAccess,
  reconcileRoomAccess,
  transcriptsStartedAt,
  type TranscriptEnv,
  type TranscriptLine
} from "./store.js";

export type TranscriptWriterDeps = Pick<LifeDeps, "storage" | "logger" | "directory" | "now" | "timeZone">;

const AUTHOR_CACHE_MS = 30_000;
const FORGOTTEN_CACHE_MS = 5_000;

/** The message's text as she reads it: mentions as `@Name`, custom emoji as `:name:`, no attachment lines. */
export function transcriptText(message: RawDiscordMessage, dir: GuildDirectoryView, timeZone: string): string | undefined {
  const bare: RawDiscordMessage = { ...message, attachments: [], snapshots: message.snapshots.map((snapshot) => ({ ...snapshot, attachments: [] })) };
  const rendered = renderDiscordMessage(bare, dir, timeZone);
  if (!rendered) return undefined;
  // `<@Name>` is the life's send form; a transcript reads like a chat log.
  return rendered.body.replace(/<@([^<>\n]+?)>/gu, "@$1").replace(/<(a?):([A-Za-z0-9_]+):>/gu, ":$2:");
}

/** User ids a message mentions (forget matches them). */
export function mentionedIds(message: RawDiscordMessage): string[] {
  const ids = new Set(Object.keys(message.mentions.users));
  for (const match of message.content.matchAll(/<@!?(\d+)>/gu)) ids.add(match[1]!);
  return [...ids];
}

export class TranscriptWriter {
  private readonly pending = new Set<Promise<unknown>>();
  /** The cast we last reconciled per room conversation (unknown until first seen in this process). */
  private readonly lastCast = new Map<string, string[]>();
  private authors: { at: number; map: Map<string, { waifuId: string; name: string }> } | undefined;
  private forgotten: { at: number; value: Awaited<ReturnType<typeof readForgottenPeople>> | "unreadable" } | undefined;
  private closed = false;

  constructor(private readonly deps: TranscriptWriterDeps) {}

  private get env(): TranscriptEnv {
    return { dataRoot: this.deps.storage.dataRoot, timeZone: this.deps.timeZone };
  }

  /** Boot: the store's start time, and every room's access reconciled with its cast now. */
  async start(): Promise<void> {
    await transcriptsStartedAt(this.deps.storage.dataRoot, this.deps.now());
    await this.reconcileAll();
  }

  /** Stops taking events and waits for the writes already started. */
  async close(): Promise<void> {
    this.closed = true;
    await this.settle();
  }

  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(work: Promise<unknown>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.deps.logger.warn("Transcript write failed", { category: "life", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  onCacheEvent(event: ConversationCacheEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "create":
        this.track(this.write(event.conversation, [event.message], "live"));
        return;
      case "page":
        this.track(this.write(event.conversation, event.messages, "fill"));
        return;
      case "update":
        this.track(this.edit(event.conversation, event.message));
        return;
      case "delete":
        this.track(this.remove(event.conversation, [event.messageId]));
        return;
      case "deleteBulk":
        this.track(this.remove(event.conversation, event.messageIds));
        return;
      default:
        return;
    }
  }

  // ---- casts and access -----------------------------------------------------------------------------

  /** The cast of a room right now (threads inherit their parent's unless switched off). */
  async castOf(guildId: string, channelId: string): Promise<string[]> {
    const server = await this.deps.storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema).catch(() => undefined);
    if (!server) return [];
    const withThreads = await withThreadChannels(this.deps.storage, server).catch(() => server);
    const channel = withThreads.channels[channelId];
    return channelHasWaifus(channel) ? [...(channel.enabledWaifuIds ?? [])].sort() : [];
  }

  /** Opens and closes access intervals for a room when its cast differs from what we last saw. */
  private async reconcile(key: string, cast: readonly string[], at: { open: Date; close: Date }): Promise<void> {
    const known = this.lastCast.get(key);
    if (known && known.length === cast.length && known.every((id, index) => id === cast[index])) return;
    // First time in this process: who has an open interval there is read from the access files.
    const open = known ?? (await this.openWaifus(key));
    await reconcileRoomAccess(this.deps.storage.dataRoot, key, cast, at, open);
    this.lastCast.set(key, [...cast]);
  }

  /** Just after the newest line of a conversation (the last time it was written for anyone), else `fallback`. */
  private async lastWrittenAt(key: string, fallback: Date): Promise<Date> {
    const days = await listTranscriptDays(this.deps.storage.dataRoot, key);
    const day = days[days.length - 1];
    if (!day) return fallback;
    const lines = await readTranscriptDay(this.deps.storage.dataRoot, key, day);
    const last = lines[lines.length - 1];
    if (!last) return fallback;
    const at = Date.parse(last.at) + 1;
    return Number.isFinite(at) && at < fallback.getTime() ? new Date(at) : fallback;
  }

  private async openWaifus(key: string): Promise<string[]> {
    const out: string[] = [];
    for (const waifuId of await listAccessWaifuIds(this.deps.storage.dataRoot)) {
      const intervals = (await readTranscriptAccess(this.deps.storage.dataRoot, waifuId)).conversations[key] ?? [];
      if (intervals.some((interval) => interval.to === undefined)) out.push(waifuId);
    }
    return out;
  }

  /**
   * Every room with a cast (and every room someone still has an open interval in) reconciled. A cast
   * change found here happened while the app was down, at some time we do not know: intervals change
   * at the last moment anything was written (the store's newest line there), else now.
   */
  async reconcileAll(): Promise<void> {
    const now = this.deps.now();
    const casts = new Map<string, string[]>();
    let guildIds: string[] = [];
    try {
      guildIds = (await readdir(this.deps.storage.dataPath("user", "servers"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      guildIds = [];
    }
    for (const guildId of guildIds.sort()) {
      const server = await this.deps.storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema).catch(() => undefined);
      if (!server) continue;
      const withThreads = await withThreadChannels(this.deps.storage, server).catch(() => server);
      for (const [channelId, channel] of Object.entries(withThreads.channels)) {
        if (!channelHasWaifus(channel)) continue;
        try {
          casts.set(conversationKey({ kind: "guild", guildId, channelId }), [...(channel.enabledWaifuIds ?? [])].sort());
        } catch {
          // an id the key encoding refuses: never a conversation
        }
      }
    }
    for (const waifuId of await listAccessWaifuIds(this.deps.storage.dataRoot)) {
      for (const [key, intervals] of Object.entries((await readTranscriptAccess(this.deps.storage.dataRoot, waifuId)).conversations)) {
        if (intervals.some((interval) => interval.to === undefined) && !casts.has(key)) casts.set(key, []);
      }
    }
    for (const [key, cast] of casts) {
      this.lastCast.delete(key);
      await this.reconcile(key, cast, { open: now, close: await this.lastWrittenAt(key, now) });
    }
  }

  // ---- lines ----------------------------------------------------------------------------------------

  private async authorMap(): Promise<Map<string, { waifuId: string; name: string }>> {
    const now = Date.now();
    if (this.authors && now - this.authors.at < AUTHOR_CACHE_MS) return this.authors.map;
    const map = new Map<string, { waifuId: string; name: string }>();
    for (const waifu of await listWaifus(this.deps.storage).catch(() => [])) {
      for (const id of await selfAuthorIds(this.deps.storage, waifu)) map.set(id, { waifuId: waifu.id, name: waifu.name });
    }
    this.authors = { at: now, map };
    return map;
  }

  private async forgottenPeople(): Promise<Awaited<ReturnType<typeof readForgottenPeople>> | "unreadable"> {
    const now = Date.now();
    if (this.forgotten && now - this.forgotten.at < FORGOTTEN_CACHE_MS) return this.forgotten.value;
    let value: Awaited<ReturnType<typeof readForgottenPeople>> | "unreadable";
    try {
      value = await readForgottenPeople(this.deps.storage);
    } catch {
      value = "unreadable";
    }
    this.forgotten = { at: now, value };
    return value;
  }

  /** Clears the cached forget records (a forget just ran). */
  noteForget(): void {
    this.forgotten = undefined;
  }

  private async view(conversation: ConversationRef): Promise<GuildDirectoryView> {
    if (conversation.kind !== "guild") return EMPTY_GUILD_DIRECTORY;
    return this.deps.directory.view(conversation.guildId).catch(() => EMPTY_GUILD_DIRECTORY);
  }

  /** The line for a message (undefined for a message that renders as nothing). */
  async lineOf(conversation: ConversationRef, message: RawDiscordMessage): Promise<TranscriptLine | undefined> {
    const text = transcriptText(message, await this.view(conversation), this.deps.timeZone);
    if (text === undefined) return undefined;
    const files = [...message.attachments, ...message.snapshots.flatMap((snapshot) => snapshot.attachments)].map((attachment) => attachment.filename);
    const waifu = (await this.authorMap()).get(message.authorId);
    const mentions = mentionedIds(message);
    return {
      id: message.id,
      at: message.createdAt,
      authorId: message.authorId,
      author: waifu?.name ?? message.authorName,
      ...(waifu ? { waifu: waifu.waifuId } : {}),
      ...(message.referenceMessageId ? { reply: message.referenceMessageId } : {}),
      text,
      ...(files.length > 0 ? { files } : {}),
      ...(message.editedAt ? { edited: true as const } : {}),
      ...(mentions.length > 0 ? { mentions } : {})
    };
  }

  /** Whether lines of this conversation are kept: a DM always, a room while some waifu is cast there. */
  private async kept(conversation: ConversationRef, at: { open: Date; close: Date }): Promise<boolean> {
    if (conversation.kind === "dm") return true;
    const key = conversationKey(conversation);
    const cast = await this.castOf(conversation.guildId, conversation.channelId);
    await this.reconcile(key, cast, at);
    return cast.length > 0;
  }

  private async write(conversation: ConversationRef, messages: readonly RawDiscordMessage[], source: "live" | "fill"): Promise<void> {
    if (messages.length === 0) return;
    const key = conversationKey(conversation);
    const now = this.deps.now();
    // A waifu newly cast sees from now (from a live message, no later than it was sent); one no longer
    // cast loses the room from the oldest message of the event on.
    const first = messages.reduce((min, message) => Math.min(min, Date.parse(message.createdAt)), Number.POSITIVE_INFINITY);
    const oldest = Number.isFinite(first) ? new Date(Math.min(now.getTime(), first)) : now;
    if (!(await this.kept(conversation, { open: source === "live" ? oldest : now, close: oldest }))) return;
    const startedAt = await transcriptsStartedAt(this.deps.storage.dataRoot, now);
    const forgotten = await this.forgottenPeople();
    const authors = await this.authorMap();
    for (const message of messages) {
      const own = authors.has(message.authorId);
      // Unreadable forget records: a gap fill (old messages) waits; live messages are new.
      if (forgotten === "unreadable" && source === "fill") continue;
      if (!own && forgotten !== "unreadable" && isRemovedMessage(message, forgotten)) continue;
      const line = await this.lineOf(conversation, message);
      if (!line) continue;
      // A line from before a forget that mentions the forgotten person (anyone's, hers too).
      if (forgotten !== "unreadable" && forgotten.some((person) => Date.parse(line.at) <= Date.parse(person.at) && lineCarriesPerson(line, { userId: person.userId, names: [], at: new Date(person.at) }))) continue;
      await addTranscriptLine(this.env, key, line, { startedAt });
    }
  }

  private async edit(conversation: ConversationRef, message: RawDiscordMessage): Promise<void> {
    const line = await this.lineOf(conversation, message);
    if (!line) return;
    await editTranscriptLine(this.env, conversationKey(conversation), line);
  }

  private async remove(conversation: ConversationRef, ids: readonly string[]): Promise<void> {
    await deleteTranscriptLines(this.env, conversationKey(conversation), ids, (id) => snowflakeTime(id));
  }
}
