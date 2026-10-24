// Shared fakes for the context-engine tests (not a test file itself).

import type { ChatMessage, ResolvedModel, ToolDef } from "@waifucave/gateway";
import type { ImageFetcher, ImageFetchResult } from "../src/discord/attachments.js";
import type { ContextState } from "../src/shared/schemas/context.js";
import type { ImageRef, RawDiscordMessage } from "../src/shared/schemas/discordMessage.js";
import type {
  BuiltPrompt,
  ConversationMessageSource,
  MemorySnapshotProvider,
  RoleRenderer
} from "../src/orchestration/context/types.js";
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

export function fakeModel(o: { images?: boolean; contextTokens?: number } = {}): ResolvedModel {
  return {
    providerId: "anthropic",
    modelId: "claude-test",
    limits: { contextTokens: o.contextTokens ?? 200_000, maxOutputTokens: 8192 },
    modalities: { input: o.images === false ? ["text"] : ["text", "image"], output: ["text"] }
  } as ResolvedModel;
}

export const ADD_MEMORY_TOOL: ToolDef = {
  name: "add_memory",
  description: "Remember something.",
  parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }
};

export function fakeRoleRenderer(name = "Aria", tools: ToolDef[] = [ADD_MEMORY_TOOL]): RoleRenderer & { tailCalls: number } {
  const renderer = {
    tailCalls: 0,
    system: () => `You are ${name}. Static harness text.`,
    header: (snapshot: { lines: string[] }, state: ContextState) =>
      [
        state.summary ? `<conversation_summary>${state.summary}</conversation_summary>` : "",
        `<memories>\n${snapshot.lines.join("\n") || "(none)"}\n</memories>`,
        `<place>Bake Club › #general</place>`
      ]
        .filter(Boolean)
        .join("\n"),
    tail: (state: ContextState, now: Date) => {
      renderer.tailCalls += 1;
      return `Now ${now.toISOString()} (${state.timeZone}). Write ${name}'s next message.`;
    },
    tools: () => tools
  };
  return renderer;
}

export const noSnapshots: MemorySnapshotProvider = {
  selectSnapshot: async () => ({ ids: [], lines: [] }),
  proposeInlineNotes: async () => [],
  markRetrieved: () => undefined
};

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

  async get(ref: ImageRef): Promise<ImageFetchResult> {
    this.calls.push(ref);
    const reason = this.failKeys.get(ref.key);
    if (reason) return { ok: false, reason };
    const size = this.sizes.get(ref.key);
    const data = size === undefined ? Buffer.from(`png:${ref.key}`) : Buffer.alloc(size);
    return { ok: true, mimeType: "image/png", data, source: "network" };
  }
}

export function quietLogger() {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
}

/** A minimal BuiltPrompt for pipeline tests (one system message, one user turn, optional tools). */
export function testPrompt(o: { system?: string; messages?: ChatMessage[]; tools?: ToolDef[]; promptCacheKey?: string } = {}): BuiltPrompt {
  const system = o.system ?? "SYS";
  const messages: ChatMessage[] = [
    { role: "system", content: [{ type: "text", text: system }] },
    ...(o.messages ?? [{ role: "user", content: [{ type: "text", text: "[10:00 #a0] Ann: hello\n" }] }])
  ];
  return {
    messages,
    tools: o.tools ?? [],
    promptCacheKey: o.promptCacheKey ?? "waifu:test:g_1_2",
    refToMessageId: new Map(),
    messageIdToRef: new Map(),
    estimatedTokens: 0,
    transcriptCount: 1,
    cursorSeq: null,
    breakpoint: null,
    debug: { system, header: "", transcript: "", tail: "" }
  };
}
