// ConversationMessageCache (spec 9.4): the Phase 5 `ConversationMessageSource`.
//
// Per conversation it keeps the recent `RawDiscordMessage`s in id order, fed by REST pages, the
// orchestrator's gateway events and our own sends. A conversation is *trusted* after a REST sync
// for as long as its gateway scope has not reconnected: trusted reads are served from memory with
// no REST call, so a pass with several agents (orchestrator + responders) costs at most one
// message fetch, usually none. An untrusted conversation (boot, reconnect, invalidated session)
// runs one single-flight catch-up; a trusted one re-validates its newest 10 messages every
// `tailCheckAfterMs`. Reactions are event-fed summaries: nothing here ever calls `users.fetch`.
//
// Task C (edits/deletes/threads) and the DM runner subscribe through `onEvent`; the cache itself
// never touches the ledger.

import type { Logger } from "../backend/logger.js";
import { conversationKey, type ConversationRef } from "../orchestration/context/keys.js";
import { DiscordConversationSource } from "../orchestration/context/fetchTranscript.js";
import type { ConversationMessageSource } from "../orchestration/context/types.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { DiscordGatewayFacade } from "./client.js";
import type {
  DiscordConnectionScope,
  DiscordConnectionState,
  DiscordConversationEvent,
  DiscordMessagePatch,
  DiscordReactionEmoji
} from "./gatewayEvents.js";
import { compareIds } from "./rawMessage.js";

export type ConversationFetchInput = Parameters<ConversationMessageSource["fetchSince"]>[0];
export type ConversationFetchResult = Awaited<ReturnType<ConversationMessageSource["fetchSince"]>>;

/** What the cache needs from the GuildDirectory (kept structural so tests can stub it). */
export interface CacheDirectoryHooks {
  /** Learn authors and mentioned users from messages the cache ingests (no I/O). */
  observeMessages(guildId: string, messages: readonly RawDiscordMessage[]): void;
  /** Single member fetch for `<@id>` mentions nobody knows (negative cache, ≤ 5 per call, ≤ 1.5 s). */
  resolveMentions(guildId: string, messages: readonly RawDiscordMessage[], o?: { signal?: AbortSignal }): Promise<void>;
  memberName(guildId: string, userId: string): string | undefined;
  emojiName(guildId: string, emojiId: string): string | undefined;
}

/**
 * What subscribers (ledger edit/delete handling, DM runner) see. Emitted after the cache state is
 * updated, whether or not the conversation is buffered, so a ledger can react to an edit of a
 * message the cache never held. `previous` is the cached version when there was one.
 */
export type ConversationCacheEvent =
  | { type: "create"; conversation: ConversationRef; message: RawDiscordMessage; own: boolean }
  | {
      type: "update";
      conversation: ConversationRef;
      message: RawDiscordMessage;
      previous?: RawDiscordMessage;
      /** "gateway" for live events, "catchup" for a change found by a REST catch-up/tail check. */
      source: "gateway" | "catchup";
    }
  | {
      type: "delete";
      conversation: ConversationRef;
      messageId: string;
      previous?: RawDiscordMessage;
      source: "gateway" | "catchup";
    }
  | { type: "deleteBulk"; conversation: ConversationRef; messageIds: string[] }
  | {
      type: "reaction";
      conversation: ConversationRef;
      action: "add" | "remove" | "removeAll" | "removeEmoji";
      messageId: string;
      emoji?: DiscordReactionEmoji;
      userId?: string;
      userName?: string;
    };

export type ReactionSummary = { emoji: string; count: number; userIds: string[] };

export type ConversationCacheOptions = {
  discord: () => DiscordGatewayFacade | undefined;
  logger: Logger;
  directory?: CacheDirectoryHooks;
  now?: () => number;
  /** Newest messages kept per conversation (default 400). */
  maxMessagesPerConversation?: number;
  /** Conversations kept (LRU, default 200). */
  maxConversations?: number;
  /** After this long trusted, the next read re-validates the newest 10 messages (default 10 min). */
  tailCheckAfterMs?: number;
  /** Gateway scope that delivers a DM conversation's events (default `dm:<waifuId>`; wave 2). */
  dmScope?: (waifuId: string) => DiscordConnectionScope;
};

const DEFAULT_MAX_MESSAGES = 400;
const DEFAULT_MAX_CONVERSATIONS = 200;
const DEFAULT_TAIL_CHECK_AFTER_MS = 10 * 60 * 1000;
const TAIL_CHECK_SIZE = 10;
const MAX_TOMBSTONES = 200;
const MAX_REACTION_USERS = 20;
const MAX_REACTION_LOG = 50;

type ReactionLogEntry = {
  at: number;
  messageId: string;
  emojiKey: string;
  emoji: DiscordReactionEmoji;
  userId?: string;
  userName?: string;
};

type Buffer = {
  conversation: ConversationRef;
  scope: DiscordConnectionScope;
  messages: Map<string, RawDiscordMessage>;
  /** Every message with id >= this is present ("0" = back to the channel start); undefined = unknown. */
  coversFrom: string | undefined;
  /** Scope generation at the last completed sync; trusted while it equals the scope's generation. */
  syncedGen: number | undefined;
  trustedAt: number;
  tombstones: Set<string>;
  reactions: Map<string, Map<string, ReactionSummary>>;
  reactionLog: ReactionLogEntry[];
  flight: Promise<void> | undefined;
  /** Highest id handed to a caller (or used as its cursor): anything inserted below it arrives late. */
  maxServed: string | undefined;
  /** Ids inserted below `maxServed` since the last serve; the next serve returns them whatever the cursor. */
  late: Set<string>;
};

/** Per gateway scope: a unique generation per connection epoch, and whether the feed is live. */
type ScopeState = { gen: number; counter: number; resumeTo: number | undefined; live: boolean };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted.");
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted."));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function emojiKeyOf(emoji: DiscordReactionEmoji): string {
  return emoji.id ?? emoji.name;
}

function sameVersion(a: RawDiscordMessage, b: RawDiscordMessage): boolean {
  return a.editedAt === b.editedAt && a.content === b.content;
}

export class ConversationMessageCache implements ConversationMessageSource {
  private readonly buffers = new Map<string, Buffer>();
  private readonly scopes = new Map<DiscordConnectionScope, ScopeState>();
  private readonly listeners = new Set<(event: ConversationCacheEvent) => void>();
  private readonly seenCreates = new Set<string>();
  private readonly fallback: DiscordConversationSource;
  private detach: (() => void) | undefined;
  private readonly now: () => number;
  private readonly maxMessages: number;
  private readonly maxConversations: number;
  private readonly tailCheckAfterMs: number;

  constructor(private readonly d: ConversationCacheOptions) {
    this.fallback = new DiscordConversationSource(d.discord);
    this.now = d.now ?? (() => Date.now());
    this.maxMessages = d.maxMessagesPerConversation ?? DEFAULT_MAX_MESSAGES;
    this.maxConversations = d.maxConversations ?? DEFAULT_MAX_CONVERSATIONS;
    this.tailCheckAfterMs = d.tailCheckAfterMs ?? DEFAULT_TAIL_CHECK_AFTER_MS;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  /**
   * Subscribe to the gateway's conversation events. Until this succeeds (fakes without
   * `onConversationEvent`, or before `start()`), every read is a plain REST fetch. Boot starts
   * untrusted: every conversation runs one catch-up on its first read.
   */
  attach(): () => void {
    if (this.detach) return this.detach;
    const discord = this.d.discord();
    if (!discord?.onConversationEvent) return () => undefined;
    const off = discord.onConversationEvent((event) => this.handle(event));
    this.detach = () => {
      off();
      this.detach = undefined;
      this.buffers.clear();
    };
    return this.detach;
  }

  get attached(): boolean {
    return this.detach !== undefined;
  }

  /** Subscribe to message/reaction events (edits, deletes, DM traffic). Returns the unsubscribe. */
  onEvent(listener: (event: ConversationCacheEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop everything cached for a conversation (`/clear everything`, DM forget). */
  forget(conversation: ConversationRef): void {
    this.buffers.delete(conversationKey(conversation));
  }

  /** Trusted = a read right now would make no REST call (tail check aside). */
  isTrusted(conversation: ConversationRef): boolean {
    const buf = this.buffers.get(conversationKey(conversation));
    return buf !== undefined && this.trusted(buf);
  }

  // ---- ConversationMessageSource ----------------------------------------------------------------

  async fetchSince(i: ConversationFetchInput): Promise<ConversationFetchResult> {
    throwIfAborted(i.signal);
    const discord = this.d.discord();
    if (!discord) return { messages: [], reachedCursor: true };
    let result: ConversationFetchResult;
    if (!this.attached) {
      // No event feed: nothing could keep a buffer honest, so this is the Phase 4 REST adapter.
      result = await this.rest(i);
    } else {
      result = await this.fetchBuffered(i);
    }
    await this.resolveMentions(i.conversation, result.messages, i.signal);
    return result;
  }

  private async fetchBuffered(i: ConversationFetchInput): Promise<ConversationFetchResult> {
    const buf = this.touch(i.conversation);
    for (let attempt = 0; attempt < 2; attempt++) {
      throwIfAborted(i.signal);
      if (this.trusted(buf) && !this.tailCheckDue(buf) && this.covers(buf, i)) return this.serveAndTrim(buf, i);
      const { promise, own } = this.sync(buf, i);
      await raceAbort(promise, i.signal);
      // Our own REST round answered this request: when the fetch cap cut it short (the page
      // did not reach the cursor) the buffer holds exactly what that page held.
      const synced = this.synced(buf);
      if (synced && (own || this.covers(buf, i))) return this.serveAndTrim(buf, i, { allowGap: true });
    }
    throwIfAborted(i.signal);
    // A reconnect keeps landing mid-flight: do not loop, answer from REST directly.
    return this.rest(i);
  }

  // ---- reactions -------------------------------------------------------------------------------

  reactionsFor(conversation: ConversationRef, messageId: string): ReactionSummary[] {
    const buf = this.buffers.get(conversationKey(conversation));
    return [...(buf?.reactions.get(messageId)?.values() ?? [])].map((r) => ({ ...r, userIds: [...r.userIds] }));
  }

  /**
   * Lines like `Kevin reacted 😂 to #k3` for reactions added after `sinceMs` (the viewing agent's
   * last own message) to messages that have a `#ref`. Oldest first, at most `limit` (default 8).
   * Reactions are never rendered in the transcript (they mutate old messages); this feeds the tail.
   */
  recentReactions(
    conversation: ConversationRef,
    o: { sinceMs: number; refs: ReadonlyMap<string, string>; limit?: number }
  ): string[] {
    const buf = this.buffers.get(conversationKey(conversation));
    if (!buf) return [];
    const guildId = conversation.kind === "guild" ? conversation.guildId : undefined;
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const entry of buf.reactionLog) {
      if (entry.at < o.sinceMs) continue;
      const ref = o.refs.get(entry.messageId);
      if (!ref) continue;
      const name =
        entry.userName ?? (guildId && entry.userId ? this.d.directory?.memberName(guildId, entry.userId) : undefined) ?? "Someone";
      const line = `${name} reacted ${this.emojiLabel(guildId, entry.emoji)} to #${ref}`;
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
    return lines.slice(-(o.limit ?? 8));
  }

  private emojiLabel(guildId: string | undefined, emoji: DiscordReactionEmoji): string {
    if (!emoji.id) return emoji.name;
    const known = guildId ? this.d.directory?.emojiName(guildId, emoji.id) : undefined;
    return `:${known ?? emoji.name}:`;
  }

  // ---- event ingestion -------------------------------------------------------------------------

  private handle(event: DiscordConversationEvent): void {
    switch (event.type) {
      case "connection":
        this.onConnection(event.scope, event.state);
        return;
      case "create":
        this.onCreate(event.conversation, event.message, event.own === true);
        return;
      case "update":
        this.onUpdate(event);
        return;
      case "delete":
        this.onDelete(event.conversation, event.messageId, "gateway");
        return;
      case "deleteBulk": {
        const buf = this.peek(event.conversation);
        for (const id of event.messageIds) this.removeMessage(buf, id);
        this.emit({ type: "deleteBulk", conversation: event.conversation, messageIds: event.messageIds });
        return;
      }
      case "reaction":
        this.onReaction(event);
        return;
    }
  }

  /**
   * discord.js emits ShardReconnecting before every resume, so `reconnecting` only parks the
   * current generation: `resumed` restores it (the gateway replayed what was missed), while
   * `ready` (fresh session) and `disconnected` leave a new, untrusted one in place.
   */
  private onConnection(scope: DiscordConnectionScope, state: DiscordConnectionState): void {
    const s = this.scopeState(scope);
    switch (state) {
      case "ready":
        s.gen = ++s.counter;
        s.resumeTo = undefined;
        s.live = true;
        return;
      case "reconnecting":
        if (s.resumeTo === undefined) s.resumeTo = s.gen;
        s.gen = ++s.counter;
        s.live = false;
        return;
      case "resumed":
        if (s.resumeTo !== undefined) s.gen = s.resumeTo;
        s.resumeTo = undefined;
        s.live = true;
        return;
      default:
        s.gen = ++s.counter;
        s.resumeTo = undefined;
        s.live = false;
    }
  }

  private scopeState(scope: DiscordConnectionScope): ScopeState {
    let s = this.scopes.get(scope);
    if (!s) {
      s = { gen: 0, counter: 0, resumeTo: undefined, live: false };
      this.scopes.set(scope, s);
    }
    return s;
  }

  /** Public so a DM transport that already holds the raw message can record its own send. */
  recordOwnSend(conversation: ConversationRef, message: RawDiscordMessage): void {
    this.onCreate(conversation, message, true);
  }

  private onCreate(conversation: ConversationRef, message: RawDiscordMessage, ownHint: boolean): void {
    // Our own send arrives twice (published by the sender, then by the orchestrator's gateway).
    if (this.seenCreates.has(message.id)) return;
    // Own = authored by one of our bots, whichever of the two deliveries came first.
    const own = ownHint || this.ownAuthorIds().has(message.authorId);
    this.seenCreates.add(message.id);
    if (this.seenCreates.size > 1000) this.seenCreates.delete(this.seenCreates.values().next().value as string);
    const buf = this.peek(conversation);
    if (buf && !buf.tombstones.has(message.id) && !buf.messages.has(message.id)) {
      this.put(buf, message);
      this.trim(buf);
    }
    this.observe(conversation, [message]);
    this.emit({ type: "create", conversation, message, own });
  }

  private ownAuthorIds(): ReadonlySet<string> {
    try {
      return new Set(this.d.discord()?.ownAuthorIds?.() ?? []);
    } catch {
      return new Set();
    }
  }

  /** Insert a message; a new id below what callers were already served is marked late (C1). */
  private put(buf: Buffer, message: RawDiscordMessage): void {
    if (!buf.messages.has(message.id) && buf.maxServed !== undefined && compareIds(message.id, buf.maxServed) < 0) {
      buf.late.add(message.id);
    }
    buf.messages.set(message.id, message);
  }

  private onUpdate(event: Extract<DiscordConversationEvent, { type: "update" }>): void {
    const buf = this.peek(event.conversation);
    const previous = buf?.messages.get(event.messageId);
    let message: RawDiscordMessage | undefined;
    if (event.message) {
      message = event.message;
    } else if (event.patch && previous) {
      message = this.patched(previous, event.patch);
    }
    if (!message) return; // a partial update for a message we do not hold cannot be applied
    if (buf && !buf.tombstones.has(message.id) && (previous || this.inCoverage(buf, message.id))) {
      this.put(buf, message);
    }
    this.observe(event.conversation, [message]);
    this.emit({
      type: "update",
      conversation: event.conversation,
      message,
      ...(previous ? { previous } : {}),
      source: "gateway"
    });
  }

  private patched(previous: RawDiscordMessage, patch: DiscordMessagePatch): RawDiscordMessage {
    return { ...previous, ...patch };
  }

  private onDelete(conversation: ConversationRef, messageId: string, source: "gateway" | "catchup"): void {
    const buf = this.peek(conversation);
    const previous = this.removeMessage(buf, messageId);
    this.emit({ type: "delete", conversation, messageId, ...(previous ? { previous } : {}), source });
  }

  private removeMessage(buf: Buffer | undefined, messageId: string): RawDiscordMessage | undefined {
    if (!buf) return undefined;
    const previous = buf.messages.get(messageId);
    buf.messages.delete(messageId);
    buf.reactions.delete(messageId);
    buf.reactionLog = buf.reactionLog.filter((entry) => entry.messageId !== messageId);
    buf.late.delete(messageId);
    buf.tombstones.add(messageId);
    if (buf.tombstones.size > MAX_TOMBSTONES) {
      const oldest = buf.tombstones.values().next().value;
      if (oldest !== undefined) buf.tombstones.delete(oldest);
    }
    return previous;
  }

  private onReaction(event: Extract<DiscordConversationEvent, { type: "reaction" }>): void {
    const buf = this.peek(event.conversation);
    if (buf && !this.belowCoverage(buf, event.messageId)) {
      const byEmoji = buf.reactions.get(event.messageId) ?? new Map<string, ReactionSummary>();
      const key = event.emoji ? emojiKeyOf(event.emoji) : undefined;
      if (event.action === "add" && event.emoji && key) {
        const summary = byEmoji.get(key) ?? { emoji: key, count: 0, userIds: [] };
        const known = event.userId !== undefined && summary.userIds.includes(event.userId);
        summary.count = typeof event.count === "number" ? event.count : known ? summary.count : summary.count + 1;
        if (event.userId && !known && summary.userIds.length < MAX_REACTION_USERS) summary.userIds.push(event.userId);
        byEmoji.set(key, summary);
        buf.reactions.set(event.messageId, byEmoji);
        buf.reactionLog.push({
          at: this.now(),
          messageId: event.messageId,
          emojiKey: key,
          emoji: event.emoji,
          ...(event.userId ? { userId: event.userId } : {}),
          ...(event.userName ? { userName: event.userName } : {})
        });
        if (buf.reactionLog.length > MAX_REACTION_LOG) buf.reactionLog.splice(0, buf.reactionLog.length - MAX_REACTION_LOG);
      } else if (event.action === "remove" && key) {
        const summary = byEmoji.get(key);
        if (summary) {
          summary.count = typeof event.count === "number" ? event.count : Math.max(0, summary.count - 1);
          if (event.userId) summary.userIds = summary.userIds.filter((id) => id !== event.userId);
          if (summary.count <= 0) byEmoji.delete(key);
        }
        for (let index = buf.reactionLog.length - 1; index >= 0; index--) {
          const entry = buf.reactionLog[index]!;
          if (entry.messageId === event.messageId && entry.emojiKey === key && entry.userId === event.userId) {
            buf.reactionLog.splice(index, 1);
            break;
          }
        }
      } else if (event.action === "removeEmoji" && key) {
        byEmoji.delete(key);
        buf.reactionLog = buf.reactionLog.filter((entry) => !(entry.messageId === event.messageId && entry.emojiKey === key));
      } else if (event.action === "removeAll") {
        buf.reactions.delete(event.messageId);
        buf.reactionLog = buf.reactionLog.filter((entry) => entry.messageId !== event.messageId);
      }
    }
    this.emit({
      type: "reaction",
      conversation: event.conversation,
      action: event.action,
      messageId: event.messageId,
      ...(event.emoji ? { emoji: event.emoji } : {}),
      ...(event.userId ? { userId: event.userId } : {}),
      ...(event.userName ? { userName: event.userName } : {})
    });
  }

  private emit(event: ConversationCacheEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.d.logger.error("Conversation cache listener failed", {
          type: event.type,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  private observe(conversation: ConversationRef, messages: readonly RawDiscordMessage[]): void {
    if (conversation.kind !== "guild") return;
    try {
      this.d.directory?.observeMessages(conversation.guildId, messages);
    } catch (error) {
      this.d.logger.warn("Guild directory observe failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  private async resolveMentions(conversation: ConversationRef, messages: readonly RawDiscordMessage[], signal?: AbortSignal) {
    if (conversation.kind !== "guild" || !this.d.directory || messages.length === 0) return;
    try {
      await this.d.directory.resolveMentions(conversation.guildId, messages, { signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      this.d.logger.warn("Mention resolution failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // ---- trust and coverage ----------------------------------------------------------------------

  private scopeOf(conversation: ConversationRef): DiscordConnectionScope {
    return conversation.kind === "guild" ? "guild" : (this.d.dmScope?.(conversation.waifuId) ?? `dm:${conversation.waifuId}`);
  }

  private generation(scope: DiscordConnectionScope): number {
    return this.scopeState(scope).gen;
  }

  /** A sync of the current connection epoch happened (whether or not the feed is live right now). */
  private synced(buf: Buffer): boolean {
    return buf.coversFrom !== undefined && buf.syncedGen === this.generation(buf.scope);
  }

  /** Trusted = synced, and the scope's event feed has reported a live connection (M2). */
  private trusted(buf: Buffer): boolean {
    return this.attached && this.scopeState(buf.scope).live && this.synced(buf);
  }

  private tailCheckDue(buf: Buffer): boolean {
    return this.now() - buf.trustedAt >= this.tailCheckAfterMs;
  }

  private belowCoverage(buf: Buffer, id: string): boolean {
    return buf.coversFrom !== undefined && compareIds(id, buf.coversFrom) < 0;
  }

  /** Reactions only live for messages the buffer still covers. */
  private pruneReactions(buf: Buffer): void {
    for (const id of [...buf.reactions.keys()]) if (this.belowCoverage(buf, id)) buf.reactions.delete(id);
    if (buf.reactionLog.some((entry) => this.belowCoverage(buf, entry.messageId))) {
      buf.reactionLog = buf.reactionLog.filter((entry) => !this.belowCoverage(buf, entry.messageId));
    }
  }

  private inCoverage(buf: Buffer, id: string): boolean {
    return buf.coversFrom !== undefined && compareIds(id, buf.coversFrom) >= 0;
  }

  /** Can the buffer answer this request without a REST call (ignoring trust)? */
  private covers(buf: Buffer, i: ConversationFetchInput): boolean {
    if (buf.coversFrom === undefined) return false;
    if (i.afterMessageId !== null) return compareIds(i.afterMessageId, buf.coversFrom) >= 0;
    return buf.coversFrom === "0" || buf.messages.size >= Math.max(1, i.maxMessages);
  }

  /** Answer from the buffer, then enforce the bound (a REST window larger than the bound is still answered whole). */
  private serveAndTrim(buf: Buffer, i: ConversationFetchInput, o: { allowGap?: boolean } = {}): ConversationFetchResult {
    const result = this.serve(buf, i, o);
    this.trim(buf);
    return result;
  }

  private serve(buf: Buffer, i: ConversationFetchInput, o: { allowGap?: boolean } = {}): ConversationFetchResult {
    const max = Math.max(1, i.maxMessages);
    const sorted = [...buf.messages.values()].sort((a, b) => compareIds(a.id, b.id));
    const after = i.afterMessageId === null ? sorted : sorted.filter((m) => compareIds(m.id, i.afterMessageId!) > 0);
    const gap = o.allowGap === true && !this.covers(buf, i);
    // Messages that showed up below what callers already saw are returned whatever the cursor, once.
    const afterIds = new Set(after.map((m) => m.id));
    const late = [...buf.late].flatMap((id) => {
      const message = buf.messages.get(id);
      return message && !afterIds.has(id) ? [message] : [];
    });
    buf.late.clear();
    const capped = after.length > max;
    const messages = [...late, ...(capped ? after.slice(-max) : after)].sort((a, b) => compareIds(a.id, b.id));
    const last = messages[messages.length - 1]?.id;
    for (const candidate of [last, i.afterMessageId ?? undefined]) {
      if (candidate !== undefined && (buf.maxServed === undefined || compareIds(candidate, buf.maxServed) > 0)) buf.maxServed = candidate;
    }
    if (capped) return { messages, reachedCursor: false };
    return { messages, reachedCursor: gap ? false : i.afterMessageId !== null || buf.coversFrom === "0" };
  }

  // ---- REST sync -------------------------------------------------------------------------------

  private async rest(i: ConversationFetchInput): Promise<ConversationFetchResult> {
    const discord = this.d.discord();
    if (!discord) return { messages: [], reachedCursor: true };
    if (i.conversation.kind === "dm") {
      if (!discord.fetchDmContextSince) return { messages: [], reachedCursor: true };
      return discord.fetchDmContextSince({
        waifuId: i.conversation.waifuId,
        userId: i.conversation.userId,
        afterMessageId: i.afterMessageId,
        maxMessages: i.maxMessages,
        ...(i.signal ? { signal: i.signal } : {})
      });
    }
    return this.fallback.fetchSince(i);
  }

  /** Single-flight per conversation; `own` = this call started the round (a joiner re-checks coverage). */
  private sync(buf: Buffer, i: ConversationFetchInput): { promise: Promise<void>; own: boolean } {
    if (buf.flight) return { promise: buf.flight, own: false };
    const flight = this.runSync(buf, i).finally(() => {
      if (buf.flight === flight) buf.flight = undefined;
    });
    buf.flight = flight;
    return { promise: flight, own: true };
  }

  private async runSync(buf: Buffer, i: ConversationFetchInput): Promise<void> {
    const gen = this.generation(buf.scope);
    // The flight outlives a caller that aborts; the data it fetches still warms the buffer.
    const request = { conversation: i.conversation };
    if (this.trusted(buf) && this.tailCheckDue(buf) && this.covers(buf, i)) {
      if (await this.tailCheck(buf, request, gen)) return;
      // The newest page cannot be stitched onto the buffer without losing messages in between:
      // distrust it and rebuild from the caller's cursor.
      buf.syncedGen = undefined;
    }
    await this.catchUp(buf, { ...request, afterMessageId: i.afterMessageId, maxMessages: i.maxMessages }, gen);
  }

  /** Re-validate the newest 10 messages; drift is repaired from the page and announced as catch-up events. */
  private async tailCheck(buf: Buffer, request: { conversation: ConversationRef }, gen: number): Promise<boolean> {
    const page = await this.rest({ ...request, afterMessageId: null, maxMessages: TAIL_CHECK_SIZE });
    const bufferNewest = [...buf.messages.keys()].sort(compareIds).pop();
    if (bufferNewest !== undefined && !page.reachedCursor && page.messages.length > 0) {
      // No overlap with the buffer (more than a page of messages went missing), or an unbuffered
      // id older than the newest buffered one (a hole): patching the page would hide messages.
      const noOverlap = compareIds(page.messages[0]!.id, bufferNewest) > 0;
      const hole = page.messages.some(
        (m) => !buf.messages.has(m.id) && !buf.tombstones.has(m.id) && compareIds(m.id, bufferNewest) < 0
      );
      if (noOverlap || hole) return false;
    }
    const lowest = page.messages[0]?.id;
    const inWindow = (id: string) => (page.reachedCursor || lowest === undefined ? true : compareIds(id, lowest) >= 0);
    const fetched = new Map(page.messages.map((m) => [m.id, m]));
    const newest = page.messages[page.messages.length - 1]?.id;
    let matches = true;
    for (const [id, message] of buf.messages) {
      // Newer than the page = delivered by an event after the page was cut.
      if (!inWindow(id) || (newest !== undefined && compareIds(id, newest) > 0)) continue;
      const fresh = fetched.get(id);
      if (!fresh || !sameVersion(fresh, message)) matches = false;
    }
    for (const id of fetched.keys()) if (!buf.messages.has(id) && !buf.tombstones.has(id)) matches = false;
    if (matches) {
      buf.trustedAt = this.now();
      return true;
    }
    this.d.logger.warn("Conversation cache tail check found drift; repairing from REST", {
      conversationKey: conversationKey(buf.conversation)
    });
    this.apply(buf, page, { inWindow, emit: true, gen });
    return true;
  }

  private async catchUp(buf: Buffer, i: ConversationFetchInput, gen: number): Promise<void> {
    let after = i.afterMessageId;
    let max = Math.max(1, i.maxMessages);
    if (after !== null && buf.coversFrom !== undefined && compareIds(after, buf.coversFrom) >= 0) {
      // The buffer already covers the caller's cursor: re-fetch from the 10th newest buffered
      // message (or the cursor, if older) so edits/deletes among the latest messages are noticed.
      const ids = [...buf.messages.keys()].sort(compareIds);
      const tail = ids.length >= TAIL_CHECK_SIZE ? ids[ids.length - TAIL_CHECK_SIZE]! : undefined;
      if (tail !== undefined && compareIds(tail, after) < 0 && compareIds(tail, buf.coversFrom) >= 0) after = tail;
      max += TAIL_CHECK_SIZE;
    }
    const page = await this.rest({ conversation: i.conversation, afterMessageId: after, maxMessages: max });
    const lowerBound = after;
    const inWindow = page.reachedCursor
      ? (id: string) => lowerBound === null || compareIds(id, lowerBound) > 0
      : (id: string) => page.messages[0] === undefined || compareIds(id, page.messages[0].id) >= 0;
    this.apply(buf, page, {
      inWindow,
      emit: buf.coversFrom !== undefined,
      gen,
      ...(page.reachedCursor ? { coversFrom: lowerBound ?? "0" } : { coversFrom: page.messages[0]?.id, replace: true })
    });
  }

  /** Merge a REST page into the buffer; ids inside the window that the page lacks were deleted. */
  private apply(
    buf: Buffer,
    page: ConversationFetchResult,
    o: { inWindow: (id: string) => boolean; emit: boolean; gen: number; coversFrom?: string; replace?: boolean }
  ): void {
    const fetched = new Map(page.messages.map((m) => [m.id, m]));
    const newest = page.messages[page.messages.length - 1]?.id;
    for (const [id, previous] of [...buf.messages]) {
      if (fetched.has(id) || newest === undefined || compareIds(id, newest) > 0) continue; // newer = from events
      if (o.inWindow(id)) {
        // Inside the authoritative window but missing from the page: deleted while we were not listening.
        buf.messages.delete(id);
        if (o.emit) this.emit({ type: "delete", conversation: buf.conversation, messageId: id, previous, source: "catchup" });
      } else if (o.replace === true) {
        buf.messages.delete(id); // older than a capped page: no longer contiguous with now
      }
    }
    for (const message of page.messages) {
      if (buf.tombstones.has(message.id)) continue;
      const existing = buf.messages.get(message.id);
      if (existing && existing.editedAt && (!message.editedAt || message.editedAt <= existing.editedAt)) continue; // an event is newer
      this.put(buf, message);
      if (existing && o.emit && !sameVersion(existing, message)) {
        this.emit({ type: "update", conversation: buf.conversation, message, previous: existing, source: "catchup" });
      }
    }
    if (o.coversFrom !== undefined) {
      buf.coversFrom =
        buf.coversFrom !== undefined && !o.replace && compareIds(buf.coversFrom, o.coversFrom) < 0 ? buf.coversFrom : o.coversFrom;
    }
    buf.syncedGen = o.gen;
    buf.trustedAt = this.now();
    this.pruneReactions(buf);
    this.observe(buf.conversation, page.messages);
  }

  private trim(buf: Buffer): void {
    if (buf.messages.size <= this.maxMessages) return;
    const ids = [...buf.messages.keys()].sort(compareIds);
    const drop = ids.slice(0, ids.length - this.maxMessages);
    for (const id of drop) {
      buf.messages.delete(id);
      buf.late.delete(id);
    }
    // Everything from the oldest remaining message on is still contiguous.
    buf.coversFrom = ids[ids.length - this.maxMessages];
    this.pruneReactions(buf);
  }

  // ---- LRU -------------------------------------------------------------------------------------

  private peek(conversation: ConversationRef): Buffer | undefined {
    return this.buffers.get(conversationKey(conversation));
  }

  private touch(conversation: ConversationRef): Buffer {
    const key = conversationKey(conversation);
    let buf = this.buffers.get(key);
    if (buf) {
      this.buffers.delete(key);
    } else {
      buf = {
        conversation,
        scope: this.scopeOf(conversation),
        messages: new Map(),
        coversFrom: undefined,
        syncedGen: undefined,
        trustedAt: 0,
        tombstones: new Set(),
        reactions: new Map(),
        reactionLog: [],
        flight: undefined,
        maxServed: undefined,
        late: new Set()
      };
    }
    this.buffers.set(key, buf);
    while (this.buffers.size > this.maxConversations) {
      const oldest = [...this.buffers].find(([, candidate]) => !candidate.flight && candidate !== buf);
      if (!oldest) break;
      this.buffers.delete(oldest[0]);
    }
    return buf;
  }
}
