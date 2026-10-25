// Shared fakes for the Discord conversation tests (not a test file itself).

import type { AttachmentFileRef, AttachmentFileResult, ImageFetcher, ImageFetchResult } from "../src/discord/attachments.js";
import type { ImageRef, RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import type { ConversationMessageSource } from "../src/orchestration/context/types.js";
import type { ConversationRef } from "../src/orchestration/context/keys.js";

export const BASE_TIME = Date.parse("2026-10-24T14:00:00.000Z");
let snowflakeCounter = 0n;

/** Increasing numeric ids that sort like snowflakes. */
export function nextId(): string {
  snowflakeCounter += 1n;
  return (1_300_000_000_000_000_000n + snowflakeCounter).toString();
}

export function raw(partial: Partial<RawDiscordMessage> & { content?: string }): RawDiscordMessage {
  return {
    id: partial.id ?? nextId(),
    channelId: "200",
    guildId: "100",
    authorId: "kevin",
    authorName: "Kevin",
    authorIsBot: false,
    createdAt: new Date(BASE_TIME).toISOString(),
    type: 0,
    content: "",
    attachments: [],
    embeds: [],
    stickers: [],
    snapshots: [],
    mentions: { users: {}, roles: {}, channels: {} },
    ...partial
  };
}

/** In-memory channel: messages in send order; fetchSince honours afterMessageId + maxMessages. */
export class FakeChannel implements ConversationMessageSource {
  readonly messages: RawDiscordMessage[] = [];
  fetches: Array<{ afterMessageId: string | null; maxMessages: number }> = [];

  post(partial: Partial<RawDiscordMessage> & { content?: string }, atMs?: number): RawDiscordMessage {
    const message = raw({
      createdAt: new Date(atMs ?? BASE_TIME + this.messages.length * 60_000).toISOString(),
      ...partial
    });
    this.messages.push(message);
    return message;
  }

  async fetchSince(i: { conversation: ConversationRef; afterMessageId: string | null; maxMessages: number }) {
    this.fetches.push({ afterMessageId: i.afterMessageId, maxMessages: i.maxMessages });
    const index = i.afterMessageId === null ? -1 : this.messages.findIndex((m) => m.id === i.afterMessageId);
    const after = this.messages.slice(index + 1);
    const reachedCursor = after.length <= i.maxMessages;
    return { messages: after.slice(-i.maxMessages), reachedCursor };
  }
}

/** Deterministic fetcher: every https Discord CDN url "downloads" bytes derived from its key. */
export class FakeImageFetcher implements ImageFetcher {
  calls: ImageRef[] = [];
  failKeys = new Map<string, Exclude<ImageFetchResult, { ok: true }>["reason"]>();
  /** Byte size to serve for a key (zero-filled), instead of the tiny default body. */
  sizes = new Map<string, number>();

  /** Bytes the app put in the cache itself (`file:<sha256>`, an image she opened with Read). */
  readonly local = new Map<string, { mimeType: string; data: Buffer }>();
  /** Downloads (`fetchFile`, ReadMessages): bytes to serve per attachment key, and every call made. */
  readonly files = new Map<string, Buffer>();
  readonly fileCalls: AttachmentFileRef[] = [];

  async get(ref: ImageRef): Promise<ImageFetchResult> {
    this.calls.push(ref);
    const reason = this.failKeys.get(ref.key);
    if (reason) return { ok: false, reason };
    const local = this.local.get(ref.key);
    if (local) return { ok: true, mimeType: local.mimeType, data: local.data, source: "memory" };
    // A key of our own is served from the cache only, never fetched.
    if (ref.key.startsWith("file:")) return { ok: false, reason: "http_error" };
    const size = this.sizes.get(ref.key);
    const data = size === undefined ? Buffer.from(`png:${ref.key}`) : Buffer.alloc(size);
    return { ok: true, mimeType: "image/png", data, source: "network" };
  }

  async put(key: string, value: { mimeType: string; data: Buffer }): Promise<void> {
    this.local.set(key, value);
  }

  async fetchFile(ref: AttachmentFileRef, o: { maxBytes: number }): Promise<AttachmentFileResult> {
    this.fileCalls.push(ref);
    const reason = this.failKeys.get(ref.key);
    if (reason) return { ok: false, reason };
    const data = this.files.get(ref.key) ?? Buffer.from(`file:${ref.key}`);
    if (data.length > o.maxBytes) return { ok: false, reason: "too_large" };
    return { ok: true, data, ...(ref.contentType ? { mimeType: ref.contentType } : {}) };
  }
}

export function quietLogger() {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}
