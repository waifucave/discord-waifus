// Intake (Living cast spec §4.1, §4.2, §10.3): turns Discord events into wake candidates.
//
// Per accepted guild message (human or configured waifu bot, in a cast channel or tracked thread):
//   1. direct reasons for each cast waifu: `mention` (her bot, or a reply to her message), `role`
//      (a role her bot member holds), `everyone` (@everyone/@here, humans only), `name` (her name,
//      display name or server nickname, ≥ 3 characters, as a whole word; humans only; off with
//      `wakeOnName: false`);
//   2. watches: every waifu with a matching `WatchFor` binding;
//   3. detector: when the author is human and no message in the current burst produced a direct
//      reason for anyone, the burst goes to the addressee detector.
// Every human message joins its place's burst, which is held by a typing-aware timer (`intakeHold.ts`):
// it fires `serverMs` after the last message, later while an author of the burst is typing there
// (`typingHoldMs` per typing event), at most `serverMaxWaitMs` after its first message. A human
// message's direct wakes wait for the burst too, merged per waifu, so "@Aria" followed by "what do
// you think about…" is one wake previewing the question. Watches and waifu-authored messages are
// routed at once. Messages by other waifus only wake through mention, role, reply-to-her and watch;
// her own never wake her. DMs wake her `dmMs` after the user's last message, held the same way while
// they type (capped at `dmMaxWaitMs`); a watch matching a DM message rides on that DM wake (one wake
// per message).
// Edits wake nobody except a newly added mention of her in a human message under 2 minutes old
// (once); a deleted message she had read becomes a pending notice (§10.3).

import type { DiscordDirectMessageEvent, DiscordTypingEvent } from "../discord/client.js";
import type { ConversationCacheEvent } from "../discord/conversationCache.js";
import { assignConversationRefs, readConversationRefs } from "../discord/refStore.js";
import { compareIds } from "../discord/rawMessage.js";
import { conversationKey, type ConversationRef } from "../orchestration/context/keys.js";
import { EMPTY_GUILD_DIRECTORY, renderDiscordMessage } from "../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../orchestration/context/types.js";
import { updateDmState } from "../orchestration/dm/dmStore.js";
import { readWaifu, listWaifus } from "../orchestration/stores/config.js";
import { DetectorHistoryFileSchema, type DetectorHistoryEntry } from "../shared/schemas/detector.js";
import { ServerConfigSchema, type ServerConfig, type WaifuConfig } from "../shared/schemas/domain.js";
import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { Wake, WakeReason } from "../shared/schemas/life.js";
import { createRevisionedBase } from "../shared/schemas/common.js";
import type { DailyCost } from "./budget.js";
import type { BotRoles } from "./botRoles.js";
import { availabilityAt } from "./clock.js";
import type { LifeDeps } from "./deps.js";
import { AddresseeDetector, detectorQuestion, drawAnyone, fallbackIsAnyone, type DetectorCastMember, type DetectorMessage } from "./detector/decider.js";
import { readLifeState, updateLifeState } from "./lifeStore.js";
import { messagePreview } from "./notifications.js";
import type { IntakeMarks } from "./intakeMarks.js";
import { FORGET_RECORDS_NOTICE, FORGET_RECORDS_UNREADABLE } from "./ownerNotices.js";
import { forgottenPeople, isRemovedMessage, selfAuthorIds } from "./people.js";
import type { ForgottenPerson } from "../orchestration/dm/forgotten.js";
import { handleOf } from "./places.js";
import { wordBoundaryIncludes } from "./text.js";
import { fireWatches, type FiredWatch } from "./watches.js";
import { homeStoreFor } from "./home/index.js";
import { TypingHolds, type HoldTiming } from "./intakeHold.js";
import { newWakeId } from "./wakeQueue.js";
import type { WakeRouter } from "./wakeRouter.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

export const EDIT_MENTION_WINDOW_MS = 2 * 60_000;
const DIRECT_ORDER: WakeReason[] = ["mention", "role", "everyone", "name"];

/** A wake only an @everyone or a shared role produced (several such are staggered, §4.1). */
function isShared(wake: Wake): boolean {
  const reasons = wake.reasons ?? [wake.reason];
  return !reasons.includes("mention") && !reasons.includes("name") && (reasons.includes("everyone") || reasons.includes("role"));
}

export type IntakeOptions = {
  deps: LifeDeps;
  router: WakeRouter;
  botRoles: BotRoles;
  cost: DailyCost;
  detector?: AddresseeDetector;
  /** Intake high-water marks (catch-up never takes a routed message again, review I3). */
  marks?: IntakeMarks;
  /** Test seam: the detector debouncer's clock. */
  now?: () => number;
};

export type GuildMessageInput = {
  guildId: string;
  channelId: string;
  messageId: string;
  /** Enabled waifu ids cast in the channel (or inherited by the thread). */
  castWaifuIds: string[];
  /** The author is one of our waifu bots. */
  authorIsWaifu: boolean;
  raw?: RawDiscordMessage;
};

/** A direct wake a human message produced, held until its burst fires. */
type HeldWake = { waifuId: string; wake: Wake };

type Burst = {
  messageIds: string[];
  /** Each message's author and preview: a held wake previews its author's newest message. */
  messages: Array<{ id: string; authorId: string; fromName: string; preview: string }>;
  /** Direct wakes waiting for the burst to fire (§4.2). */
  held: HeldWake[];
  direct: boolean;
  /** Waifus a watch woke for a message in this burst: the detector skips them (D-c). */
  watched: string[];
  authorId?: string;
  authorName?: string;
  guildId: string;
  channelId: string;
  castWaifuIds: string[];
};

type DmBurst = { messageIds: string[]; userName?: string };
/** Why intake still holds a message back from the mark: its routing (wakes, a stagger) or its burst. */
type HoldKind = "routing" | "burst";

export class Intake {
  /** Room bursts per place key (direct wakes and the detector alike). */
  private readonly burstHolds: TypingHolds<string>;
  /** DM bursts per `waifuId\0userId`. */
  private readonly dmHolds: TypingHolds<string>;
  private readonly bursts = new Map<string, Burst>();
  private readonly dmBursts = new Map<string, DmBurst>();
  private readonly editMentions = new Set<string>();
  private readonly lastHumanAt = new Map<string, string>();
  private readonly inflight = new Set<Promise<unknown>>();
  /** Message ids intake already took (live delivery and catch-up never both route one). */
  private readonly seen = new Set<string>();
  private closed = false;

  /** True when `messageId` was taken before; otherwise remembers it (the newest 5,000). */
  private alreadySeen(messageId: string): boolean {
    if (this.seen.has(messageId)) return true;
    this.seen.add(messageId);
    if (this.seen.size > 5_000) this.seen.delete(this.seen.values().next().value!);
    return false;
  }

  /**
   * Messages intake took but has not finished routing, per place and id (a count: its routing, its
   * burst). The mark never passes the oldest of them (N3): a staggered wake, a debouncing burst or a
   * running detector call that a reload drops is taken again by the next catch-up.
   */
  private readonly holds = new Map<string, Map<string, Set<HoldKind>>>();
  /** Routed messages whose mark waits for an older held message. */
  private readonly routed = new Map<string, Set<string>>();

  private hold(placeKey: string, messageId: string, kind: HoldKind): void {
    const held = this.holds.get(placeKey) ?? new Map<string, Set<HoldKind>>();
    const kinds = held.get(messageId) ?? new Set<HoldKind>();
    kinds.add(kind);
    held.set(messageId, kinds);
    this.holds.set(placeKey, held);
  }

  private release(placeKey: string, messageIds: readonly string[], kind: HoldKind): void {
    const held = this.holds.get(placeKey);
    if (!held) return;
    for (const id of messageIds) {
      const kinds = held.get(id);
      if (!kinds) continue;
      kinds.delete(kind);
      if (kinds.size === 0) held.delete(id);
    }
    if (held.size === 0) this.holds.delete(placeKey);
    this.mark(placeKey, []);
  }

  /**
   * The intake high-water mark moves past routed messages, never past one still held and never
   * after a close (a wake the closing router dropped was not routed) or while the app is paused.
   */
  private mark(placeKey: string, messageIds: readonly string[]): void {
    if (!this.o.marks || this.closed || this.deps.isPaused()) return;
    const waiting = this.routed.get(placeKey) ?? new Set<string>();
    for (const id of messageIds) waiting.add(id);
    if (waiting.size === 0) return;
    const held = [...(this.holds.get(placeKey)?.keys() ?? [])];
    const oldestHeld = held.length > 0 ? held.reduce((a, b) => (compareIds(a, b) <= 0 ? a : b)) : undefined;
    const markable = [...waiting].filter((id) => oldestHeld === undefined || compareIds(id, oldestHeld) < 0);
    if (markable.length > 0) {
      this.o.marks.advance(placeKey, markable.reduce((a, b) => (compareIds(a, b) >= 0 ? a : b)));
      for (const id of markable) waiting.delete(id);
    }
    if (waiting.size > 0) this.routed.set(placeKey, waiting);
    else this.routed.delete(placeKey);
  }

  constructor(private readonly o: IntakeOptions) {
    this.burstHolds = new TypingHolds(o.now);
    this.dmHolds = new TypingHolds(o.now);
  }

  close(): void {
    this.closed = true;
    this.burstHolds.cancelAll();
    this.dmHolds.cancelAll();
  }

  private timing(kind: "server" | "dm"): HoldTiming {
    const debounce = this.deps.config().discord.debounce;
    return kind === "server"
      ? { quietMs: debounce.serverMs, maxWaitMs: debounce.serverMaxWaitMs, typingHoldMs: debounce.typingHoldMs }
      : { quietMs: debounce.dmMs, maxWaitMs: debounce.dmMaxWaitMs, typingHoldMs: debounce.typingHoldMs };
  }

  /**
   * Someone is typing (§4.2): a pending burst of theirs in that place waits for them. Bots and people
   * with no message pending there hold nothing.
   */
  onTyping(event: DiscordTypingEvent): void {
    if (this.closed || event.bot) return;
    if (event.kind === "guild") this.burstHolds.typing(conversationKey({ kind: "guild", guildId: event.guildId, channelId: event.channelId }), event.userId);
    else this.dmHolds.typing(`${event.waifuId}\u0000${event.userId}`, event.userId);
  }

  /** Waits for detector calls and DM fires already started (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    void work.finally(() => this.inflight.delete(work)).catch(() => undefined);
    return work;
  }

  private get deps(): LifeDeps {
    return this.o.deps;
  }

  private async view(guildId: string | undefined): Promise<GuildDirectoryView> {
    if (!guildId) return EMPTY_GUILD_DIRECTORY;
    return this.deps.directory.view(guildId).catch(() => EMPTY_GUILD_DIRECTORY);
  }

  private async findMessage(conversation: ConversationRef, messageId: string): Promise<RawDiscordMessage | undefined> {
    const buffered = this.deps.conversations.bufferedMessages(conversation).find((message) => message.id === messageId);
    if (buffered) return buffered;
    const page = await this.deps.conversations.readPage({ conversation, limit: 20 }).catch(() => ({ messages: [] as RawDiscordMessage[] }));
    return page.messages.find((message) => message.id === messageId);
  }

  /** The forget records; an unreadable file is reported to the owner and fails closed (§7.5). */
  private async forgetRecords(): Promise<{ forgotten: ForgottenPerson[]; unreadable: boolean }> {
    try {
      const forgotten = await forgottenPeople(this.deps.storage);
      this.deps.notices?.clear(FORGET_RECORDS_NOTICE);
      return { forgotten, unreadable: false };
    } catch {
      this.deps.notices?.set(FORGET_RECORDS_NOTICE, FORGET_RECORDS_UNREADABLE);
      return { forgotten: [], unreadable: true };
    }
  }

  private async castWaifus(ids: readonly string[]): Promise<WaifuConfig[]> {
    const out: WaifuConfig[] = [];
    for (const id of ids) {
      const waifu = await readWaifu(this.deps.storage, id).catch(() => undefined);
      // Without her own bot she cannot post, so nothing wakes her.
      if (waifu?.enabled && waifu.botId) out.push(waifu);
    }
    return out;
  }

  /** Her name, display name and server nickname (each ≥ 3 characters), for the `name` rule. */
  private namesOf(waifu: WaifuConfig, guildId: string, selfIds: readonly string[]): string[] {
    const nick = selfIds.map((id) => this.deps.directory.memberName(guildId, id)).find((name): name is string => Boolean(name));
    return [...new Set([waifu.name, waifu.displayName, nick].filter((name): name is string => typeof name === "string" && name.trim().length >= 3))];
  }

  // ---- guild messages -------------------------------------------------------------------------------

  async onGuildMessage(input: GuildMessageInput): Promise<void> {
    // While paused nothing is taken (no wakes, no watch fires): the resume catch-up takes it then.
    if (this.closed || this.deps.isPaused()) return;
    const deps = this.deps;
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const placeKey = conversationKey(conversation);
    if (this.seen.has(input.messageId)) return;
    const raw = input.raw ?? (await this.findMessage(conversation, input.messageId));
    if (!raw || this.alreadySeen(raw.id)) return;
    const human = !raw.authorIsBot && !input.authorIsWaifu;
    const waifus = await this.castWaifus(input.castWaifuIds);
    if (waifus.length === 0) return;
    this.hold(placeKey, raw.id, "routing");
    let outcome: { staggered: Promise<unknown>[]; direct: boolean };
    try {
      outcome = await this.routeGuildMessage(input, { raw, human, waifus, placeKey, conversation });
    } catch (error) {
      this.release(placeKey, [raw.id], "routing");
      throw error;
    }
    // Its routing hold goes once every wake for it is routed (a staggered one waits on its timer): a
    // waifu's message is then marked; a human one waits for its burst (which routes its direct wakes).
    const routedAll = () => {
      if (!human) this.mark(placeKey, [raw.id]);
      this.release(placeKey, [raw.id], "routing");
    };
    if (outcome.staggered.length > 0) void this.track(Promise.allSettled(outcome.staggered).then(routedAll));
    else routedAll();
  }

  /** The wakes of one guild message, its watches and its burst (§4.1–§4.3). */
  private async routeGuildMessage(
    input: GuildMessageInput,
    o: { raw: RawDiscordMessage; human: boolean; waifus: WaifuConfig[]; placeKey: string; conversation: ConversationRef }
  ): Promise<{ staggered: Promise<unknown>[]; direct: boolean }> {
    const deps = this.deps;
    const { raw, human, waifus, placeKey, conversation } = o;
    const records = await this.forgetRecords();
    // Unreadable forget records fail closed: every human message is treated as possibly forgotten.
    const removed = records.unreadable ? human : isRemovedMessage(raw, records.forgotten);
    const dir = await this.view(input.guildId);
    const rendered = renderDiscordMessage(raw, dir, deps.timeZone);
    const text = removed ? "(removed)" : rendered?.body ?? "";
    const preview = messagePreview(raw, dir, deps.timeZone, { removed });
    const fromName = removed ? "someone" : raw.authorName;
    const now = deps.now();
    if (human) this.o.router.loopGuard.human(placeKey);
    const referenced = raw.referenceMessageId ? await this.findMessage(conversation, raw.referenceMessageId) : undefined;
    const mentionedUsers = new Set(Object.keys(raw.mentions.users));
    const mentionedRoles = new Set(Object.keys(raw.mentions.roles));
    const directWakes: Array<{ waifu: WaifuConfig; wake: Wake }> = [];
    const watched = new Set<string>();
    for (const waifu of waifus) {
      const selfIds = await selfAuthorIds(deps.storage, waifu);
      const own = selfIds.includes(raw.authorId);
      const base = {
        placeKey,
        fromUserId: raw.authorId,
        fromName,
        messageId: raw.id,
        preview,
        at: now.toISOString(),
        ...(input.authorIsWaifu ? { waifuAuthored: true } : {})
      };
      if (!own) {
        const reasons: WakeReason[] = [];
        if (selfIds.some((id) => mentionedUsers.has(id)) || (referenced && selfIds.includes(referenced.authorId))) reasons.push("mention");
        if (waifu.botId && mentionedRoles.size > 0) {
          const roles = await this.o.botRoles.roles(input.guildId, waifu.botId);
          if ([...mentionedRoles].some((role) => roles.has(role))) reasons.push("role");
        }
        if (human && raw.mentionsEveryone) reasons.push("everyone");
        // A mention already says it is for her; her name in the same message adds nothing.
        if (human && !removed && !reasons.includes("mention") && waifu.wakeOnName && this.namesOf(waifu, input.guildId, selfIds).some((name) => wordBoundaryIncludes(text, name))) reasons.push("name");
        if (reasons.length > 0) {
          const ordered = DIRECT_ORDER.filter((reason) => reasons.includes(reason));
          directWakes.push({ waifu, wake: { id: newWakeId(), reason: ordered[0]!, ...(ordered.length > 1 ? { reasons: ordered } : {}), ...base } });
        }
      }
      const fired = await fireWatches(homeStoreFor(deps, waifu), { placeKey, authorId: raw.authorId, text, own, createdAt: raw.createdAt }, { now, timeZone: deps.timeZone, maxFiresPerDay: deps.config().life.maxWatchFiresPerDay });
      for (const { watch, matched } of fired) {
        await this.o.router.route(waifu.id, { id: newWakeId(), reason: "watch", watchId: watch.id, matched, note: watch.note, ...base }, { guildId: input.guildId });
      }
      if (fired.length > 0) watched.add(waifu.id);
    }
    // A waifu's message is routed at once (typing never holds a waifu); several waifus woken by one
    // @everyone / shared role ping are staggered by 0–20 s (§4.1).
    if (!human) return { staggered: await this.routeDirect(input.guildId, directWakes.map((entry) => ({ waifuId: entry.waifu.id, wake: entry.wake }))), direct: directWakes.length > 0 };
    // Every human message joins the place's burst, and its direct wakes wait for it (§4.2). A burst
    // with any direct message in it (before or after the others, M9) never reaches the detector; a
    // waifu whose watch fired for a message in it is skipped by the detector for the burst (D-c: one
    // wake per message), others can still be picked.
    const next: Burst = this.bursts.get(placeKey) ?? { messageIds: [], messages: [], held: [], direct: false, watched: [], guildId: input.guildId, channelId: input.channelId, castWaifuIds: input.castWaifuIds };
    next.messageIds.push(raw.id);
    next.messages.push({ id: raw.id, authorId: raw.authorId, fromName, preview });
    // Every human message waits on its burst (fired, its held wakes routed, its detector call answered).
    this.hold(placeKey, raw.id, "burst");
    if (directWakes.length > 0) {
      next.held.push(...directWakes.map((entry) => ({ waifuId: entry.waifu.id, wake: entry.wake })));
      next.direct = true;
      this.lastHumanAt.set(placeKey, raw.createdAt);
    } else {
      next.authorId = raw.authorId;
      next.authorName = fromName;
    }
    for (const waifuId of watched) if (!next.watched.includes(waifuId)) next.watched.push(waifuId);
    next.castWaifuIds = input.castWaifuIds;
    this.bursts.set(placeKey, next);
    this.burstHolds.message(placeKey, { authorId: raw.authorId, timing: this.timing("server") }, () => {
      const done = this.bursts.get(placeKey);
      this.bursts.delete(placeKey);
      if (done) this.fireBurst(placeKey, done);
    });
    return { staggered: [], direct: directWakes.length > 0 };
  }

  /**
   * Routes direct wakes; with several shared ones (@everyone, a shared role) each is staggered by
   * 0–20 s (§4.1). Returns the staggered routings (they never hold up intake or the other waifus).
   */
  private async routeDirect(guildId: string, wakes: readonly HeldWake[]): Promise<Promise<unknown>[]> {
    const sharedCount = wakes.filter((entry) => isShared(entry.wake)).length;
    const staggered: Promise<unknown>[] = [];
    for (const entry of wakes) {
      const stagger = isShared(entry.wake) && sharedCount > 1;
      const routed = this.o.router.route(entry.waifuId, entry.wake, { guildId, stagger });
      if (stagger) staggered.push(this.track(routed));
      else await routed;
    }
    return staggered;
  }

  /**
   * A burst's held direct wakes, one per waifu: reasons merged (a mention makes her name redundant),
   * previewing the newest message of the person who woke her (the question after the "@Aria").
   */
  private mergeHeld(burst: Burst): HeldWake[] {
    const byWaifu = new Map<string, Wake>();
    for (const { waifuId, wake } of burst.held) {
      const existing = byWaifu.get(waifuId);
      if (!existing) {
        byWaifu.set(waifuId, wake);
        continue;
      }
      const all = [...(existing.reasons ?? [existing.reason]), ...(wake.reasons ?? [wake.reason])];
      const ordered = DIRECT_ORDER.filter((reason) => all.includes(reason));
      const reasons = ordered.includes("mention") ? ordered.filter((reason) => reason !== "name") : ordered;
      const rest: Wake = { ...existing };
      delete rest.reasons;
      byWaifu.set(waifuId, {
        ...rest,
        reason: reasons[0]!,
        ...(reasons.length > 1 ? { reasons } : {}),
        ...(wake.messageId ? { messageId: wake.messageId } : {}),
        ...(wake.preview !== undefined ? { preview: wake.preview } : {}),
        ...(wake.fromUserId ? { fromUserId: wake.fromUserId } : {}),
        ...(wake.fromName ? { fromName: wake.fromName } : {})
      });
    }
    return [...byWaifu].map(([waifuId, wake]) => {
      const newest = [...burst.messages].reverse().find((message) => message.authorId === wake.fromUserId);
      if (!newest || !wake.messageId || compareIds(newest.id, wake.messageId) <= 0) return { waifuId, wake };
      return { waifuId, wake: { ...wake, messageId: newest.id, preview: newest.preview, fromName: newest.fromName } };
    });
  }

  /**
   * A burst is done: its held direct wakes are routed, the detector runs for it (unless direct), and
   * its messages are marked once routed (a held wake that could not be routed leaves them unmarked,
   * so the next catch-up takes them again).
   */
  private fireBurst(placeKey: string, burst: Burst): void {
    if (this.closed) return;
    const work = async () => {
      let routed = true;
      try {
        if (burst.held.length > 0) {
          try {
            await Promise.allSettled(await this.routeDirect(burst.guildId, this.mergeHeld(burst)));
          } catch (error) {
            routed = false;
            throw error;
          }
        }
        if (!burst.direct) await this.runDetector(placeKey, burst);
      } finally {
        if (routed) this.mark(placeKey, burst.messageIds);
        this.release(placeKey, burst.messageIds, "burst");
      }
    };
    void this.track(work());
  }

  private async serverOf(guildId: string): Promise<ServerConfig | undefined> {
    try {
      const raw = await readFile(this.deps.storage.dataPath(path.join("user", "servers", guildId, "server.json")), "utf8");
      return ServerConfigSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  /** §4.3: one question about the burst, the mapping, the fallback and the history line. */
  async runDetector(placeKey: string, burst: Burst): Promise<string[]> {
    const deps = this.deps;
    const now = deps.now();
    const conversation: ConversationRef = { kind: "guild", guildId: burst.guildId, channelId: burst.channelId };
    const server = await this.serverOf(burst.guildId);
    if (deps.isPaused() || server?.paused) return [];
    const target = server?.detector?.target ?? deps.config().detector.target;
    const waifus = (await this.castWaifus(burst.castWaifuIds)).filter((waifu) => waifu.model);
    if (waifus.length === 0) return [];
    // D-c: a waifu her watch already woke for this burst gets no second wake from the detector.
    const watched = new Set(burst.watched);
    if (waifus.every((waifu) => watched.has(waifu.id))) return [];
    const newestId = burst.messageIds[burst.messageIds.length - 1]!;
    const page = await deps.conversations.readPage({ conversation, limit: 12 }).catch(() => ({ messages: [] as RawDiscordMessage[] }));
    const dir = await this.view(burst.guildId);
    const records = await this.forgetRecords();
    // Unreadable forget records: the transcript could hold a forgotten person's words; no detector.
    if (records.unreadable) return [];
    const forgotten = records.forgotten;
    const allWaifus = await listWaifus(deps.storage).catch(() => []);
    const waifuAuthors = new Map<string, string>();
    for (const waifu of allWaifus) for (const id of await selfAuthorIds(deps.storage, waifu)) waifuAuthors.set(id, waifu.id);
    const messages: DetectorMessage[] = [];
    const byId = new Map(page.messages.map((message) => [message.id, message]));
    for (const message of page.messages) {
      const removed = isRemovedMessage(message, forgotten);
      // A Discord reply names the author it answers (a forgotten one stays "someone").
      const answered = message.referenceMessageId ? (byId.get(message.referenceMessageId) ?? (await this.findMessage(conversation, message.referenceMessageId))) : undefined;
      const replyTo = answered ? (isRemovedMessage(answered, forgotten) ? "someone" : answered.authorName) : undefined;
      const rendered = renderDiscordMessage(message, dir, deps.timeZone);
      if (!rendered) continue;
      const imageText: string[] = [];
      if (!removed) for (const image of rendered.images.slice(0, 4)) imageText.push((await deps.ocr?.cachedText(image).catch(() => undefined)) ?? "");
      messages.push({
        id: message.id,
        authorKind: waifuAuthors.has(message.authorId) ? "waifu" : "user",
        name: removed ? "someone" : message.authorName,
        at: message.createdAt,
        text: removed ? "(removed)" : rendered.body,
        ...(replyTo ? { replyTo } : {}),
        ...(imageText.some(Boolean) ? { imageText: imageText.filter(Boolean) } : {})
      });
    }
    const cast: DetectorCastMember[] = [];
    for (const waifu of waifus) {
      const names = this.namesOf(waifu, burst.guildId, await selfAuthorIds(deps.storage, waifu));
      cast.push({ waifuId: waifu.id, names: names.length > 0 ? names : [waifu.name], persona: waifu.persona });
    }
    let choice: string | undefined;
    let probabilities: Record<string, number> = {};
    let error: string | undefined;
    const question = detectorQuestion({ target: target || "openai:gpt-6-luna", now, timeZone: deps.timeZone, cast, messages });
    if (target && this.o.detector) {
      try {
        const answer = await this.o.detector.decide({
          target,
          question,
          signal: AbortSignal.timeout(30_000),
          attribution: { guildId: burst.guildId, channelId: burst.channelId, conversationKey: placeKey }
        });
        choice = answer.choice;
        probabilities = answer.probabilities;
      } catch (failure) {
        error = failure instanceof Error ? failure.message : "detector_failed";
        deps.logger.warn("Addressee detector failed; using the fallback", { guildId: burst.guildId, channelId: burst.channelId, error });
      }
    }
    if (choice === undefined) {
      const newest = page.messages.find((message) => message.id === newestId);
      const burstText = newest ? (renderDiscordMessage(newest, dir, deps.timeZone)?.body ?? "") : "";
      // The human message before this burst (in the page, else the last one this process saw).
      const firstId = burst.messageIds[0]!;
      const before = [...page.messages]
        .reverse()
        .find((message) => compareIds(message.id, firstId) < 0 && !message.authorIsBot && !waifuAuthors.has(message.authorId));
      const previous = before?.createdAt ?? this.lastHumanAt.get(placeKey);
      choice = fallbackIsAnyone({ burstText, ...(previous ? { previousHumanAt: previous } : {}), now }) ? "fallback:anyone" : "fallback:none";
    }
    const newestMessage = page.messages.find((message) => message.id === newestId);
    if (newestMessage) this.lastHumanAt.set(placeKey, newestMessage.createdAt);
    // `waifu_<i>` and `anyone` wake one waifu; `all` wakes every cast waifu here (not only the
    // question's candidates), staggered like an @everyone. A waifu a watch woke is skipped (D-c);
    // the router defers the asleep and the over-budget ones as for any wake.
    let chosen: string[] = [];
    if (choice.startsWith("waifu_")) chosen = [question.candidates[Number(choice.slice(6))]?.waifuId].filter((id): id is string => Boolean(id));
    else if (choice === "anyone" || choice === "fallback:anyone") {
      const drawn = await this.drawFor(waifus.filter((waifu) => !watched.has(waifu.id)), conversation, now);
      if (drawn) chosen = [drawn];
    } else if (choice === "all") chosen = waifus.map((waifu) => waifu.id);
    chosen = chosen.filter((id) => !watched.has(id));
    const woke: string[] = [];
    if (chosen.length > 0) {
      const removed = newestMessage ? isRemovedMessage(newestMessage, forgotten) : false;
      const preview = newestMessage ? messagePreview(newestMessage, dir, deps.timeZone, { removed }) : undefined;
      const stagger = chosen.length > 1;
      const outcomes = await Promise.all(
        chosen.map(async (waifuId) => {
          const wake: Wake = {
            id: newWakeId(),
            reason: "detector",
            placeKey,
            ...(burst.authorId ? { fromUserId: burst.authorId } : {}),
            ...(burst.authorName ? { fromName: burst.authorName } : {}),
            messageId: newestId,
            ...(preview !== undefined ? { preview } : {}),
            ...(choice === "all" ? { forAll: true } : {}),
            at: now.toISOString()
          };
          return [waifuId, await this.o.router.route(waifuId, wake, { guildId: burst.guildId, stagger })] as const;
        })
      );
      for (const [waifuId, outcome] of outcomes) if (outcome !== "dropped") woke.push(waifuId);
    }
    await this.recordHistory(burst.guildId, {
      at: now.toISOString(),
      channelId: burst.channelId,
      burstMessageIds: burst.messageIds,
      choice,
      probabilities,
      ...(woke.length > 0 ? { woke } : {}),
      ...(target ? { target } : {}),
      ...(error ? { error } : {})
    });
    return woke;
  }

  private async drawFor(waifus: WaifuConfig[], conversation: ConversationRef, now: Date): Promise<string | undefined> {
    const deps = this.deps;
    const buffered = deps.conversations.bufferedMessages(conversation);
    const members = [];
    for (const waifu of waifus) {
      const state = availabilityAt(waifu.availability, now, deps.timeZone);
      let availability: "awake" | "busy" | "unavailable" = state.state === "awake" ? "awake" : state.state === "busy" ? "busy" : "unavailable";
      const budget = waifu.life.dailyBudgetUsd;
      if (availability !== "unavailable" && budget !== null && budget !== undefined && (await this.o.cost.today(waifu.id, now)) >= budget) availability = "unavailable";
      const selfIds = await selfAuthorIds(deps.storage, waifu);
      const last = [...buffered].reverse().find((message) => selfIds.includes(message.authorId));
      members.push({ waifuId: waifu.id, availability, ...(last ? { minutesSinceSpoke: (now.getTime() - Date.parse(last.createdAt)) / 60_000 } : {}) });
    }
    return drawAnyone(members, deps.random);
  }

  private async recordHistory(guildId: string, entry: DetectorHistoryEntry): Promise<void> {
    await this.deps.storage
      .updateRevisionedJson({
        resourceKey: `detector-history:${guildId}`,
        relativePath: path.join("user", "servers", guildId, "detector-history.json"),
        schema: DetectorHistoryFileSchema,
        fallback: DetectorHistoryFileSchema.parse({ ...createRevisionedBase(), guildId, entries: [] }),
        transform: (file) => ({ ...file, entries: [...file.entries, entry].slice(-300) })
      })
      .catch((error: unknown) => this.deps.logger.warn("Detector history write failed", { guildId, message: error instanceof Error ? error.message : String(error) }));
  }

  // ---- DMs ------------------------------------------------------------------------------------------

  /** A human's DM: DM state updated now; the `dm` wake `dmMs` after their last message, held while they type. */
  async onDirectMessage(event: DiscordDirectMessageEvent): Promise<void> {
    if (this.closed || this.seen.has(event.messageId)) return;
    const deps = this.deps;
    await updateDmState(deps.storage, { userId: event.userId, waifuId: event.waifuId, botId: event.botId }, (state) => {
      const newer = !state.lastInboundMessageId || compareIds(event.messageId, state.lastInboundMessageId) > 0;
      return {
        ...state,
        botId: event.botId,
        dmChannelId: event.channelId,
        ...(event.userDisplayName ? { userDisplayName: event.userDisplayName.slice(0, 100) } : {}),
        ...(newer ? { lastInboundMessageId: event.messageId, lastInboundAt: event.createdAt } : {}),
        undeliverableSince: undefined
      };
    });
    // While paused nothing is taken: the resume catch-up takes it then.
    if (deps.isPaused() || this.alreadySeen(event.messageId)) return;
    const key = `${event.waifuId}\u0000${event.userId}`;
    const burst = this.dmBursts.get(key) ?? { messageIds: [] };
    burst.messageIds.push(event.messageId);
    this.hold(conversationKey({ kind: "dm", waifuId: event.waifuId, userId: event.userId }), event.messageId, "routing");
    if (event.userDisplayName) burst.userName = event.userDisplayName;
    this.dmBursts.set(key, burst);
    this.dmHolds.message(key, { authorId: event.userId, timing: this.timing("dm") }, () => {
      const done = this.dmBursts.get(key);
      this.dmBursts.delete(key);
      if (done && !this.closed) void this.track(this.fireDm(event.waifuId, event.userId, done));
    });
  }

  private async fireDm(waifuId: string, userId: string, burst: DmBurst): Promise<void> {
    const deps = this.deps;
    const conversation: ConversationRef = { kind: "dm", waifuId, userId };
    const placeKey = conversationKey(conversation);
    const newestId = [...burst.messageIds].sort(compareIds).pop()!;
    const message = await this.findMessage(conversation, newestId);
    // Unreadable forget records fail closed here too: the DM's preview and name are hidden (F11).
    const records = await this.forgetRecords();
    const removed = records.unreadable || (message ? isRemovedMessage(message, records.forgotten) : false);
    try {
      // Her watches on these messages ride on the DM wake (§16.5, one wake per message): one line
      // `dm, watch · …` and one turn, matched after the DM's own hold, not at once.
      const fired = await this.dmWatches(waifuId, conversation, burst, records);
      const [first, ...more] = fired;
      const wake: Wake = {
        id: newWakeId(),
        reason: "dm",
        ...(first ? { reasons: ["dm", "watch"] as WakeReason[], watchId: first.watch.id, matched: first.matched, note: first.watch.note } : {}),
        placeKey,
        fromUserId: userId,
        fromName: removed ? "someone" : (burst.userName ?? message?.authorName ?? "someone"),
        messageId: newestId,
        ...(message ? { preview: messagePreview(message, EMPTY_GUILD_DIRECTORY, deps.timeZone, { removed }) } : {}),
        ...(burst.messageIds.length > 1 ? { count: burst.messageIds.length } : {}),
        at: deps.now().toISOString()
      };
      const outcome = await this.o.router.route(waifuId, wake, { dmUserId: userId });
      // A watch is her own intention: when the DM itself is dropped (its rate limit), the match still
      // reaches her as a plain watch wake. Further watches matching the same burst join its line.
      const watchWake = (entry: FiredWatch): Wake => ({
        id: newWakeId(),
        reason: "watch",
        watchId: entry.watch.id,
        matched: entry.matched,
        note: entry.watch.note,
        placeKey,
        fromUserId: userId,
        fromName: wake.fromName!,
        messageId: newestId,
        at: wake.at
      });
      for (const entry of outcome === "dropped" ? fired : more) await this.o.router.route(waifuId, watchWake(entry), {});
      this.mark(placeKey, burst.messageIds);
    } finally {
      this.release(placeKey, burst.messageIds, "routing");
    }
  }

  /** Her watches that fire for a DM burst's messages (once-watches removed, fires recorded). */
  private async dmWatches(
    waifuId: string,
    conversation: ConversationRef,
    burst: DmBurst,
    records: { forgotten: ForgottenPerson[]; unreadable: boolean }
  ): Promise<FiredWatch[]> {
    const deps = this.deps;
    const waifu = await readWaifu(deps.storage, waifuId).catch(() => undefined);
    if (!waifu) return [];
    const placeKey = conversationKey(conversation);
    const now = deps.now();
    const fired: FiredWatch[] = [];
    for (const id of [...burst.messageIds].sort(compareIds)) {
      const raw = await this.findMessage(conversation, id);
      if (!raw) continue;
      const removed = records.unreadable || isRemovedMessage(raw, records.forgotten);
      const text = removed ? "(removed)" : (renderDiscordMessage(raw, EMPTY_GUILD_DIRECTORY, deps.timeZone)?.body ?? "");
      const hits = await fireWatches(homeStoreFor(deps, waifu), { placeKey, authorId: raw.authorId, text, own: false, createdAt: raw.createdAt }, { now, timeZone: deps.timeZone, maxFiresPerDay: deps.config().life.maxWatchFiresPerDay }).catch((error: unknown) => {
        deps.logger.warn("Life DM watch check failed", { waifuId, message: error instanceof Error ? error.message : String(error) });
        return [] as FiredWatch[];
      });
      for (const hit of hits) if (!fired.some((entry) => entry.watch.id === hit.watch.id)) fired.push(hit);
    }
    return fired;
  }

  /** Fires every pending DM wake now (tests; the boot catch-up after a long pause). */
  flushDms(): void {
    for (const key of this.dmHolds.keys()) {
      const burst = this.dmBursts.get(key);
      this.dmHolds.cancel(key);
      this.dmBursts.delete(key);
      const [waifuId, userId] = key.split("\u0000");
      if (burst && waifuId && userId) void this.track(this.fireDm(waifuId, userId, burst));
    }
  }

  /** Fires every pending room burst now: its held wakes and its detector call (tests). */
  flushDetector(): void {
    for (const key of this.burstHolds.keys()) this.flushBurst(key);
  }

  /** Fires one place's pending burst now (the catch-up: nobody is typing an old message). */
  flushBurst(placeKey: string): void {
    if (!this.burstHolds.cancel(placeKey)) return;
    const burst = this.bursts.get(placeKey);
    this.bursts.delete(placeKey);
    if (burst) this.fireBurst(placeKey, burst);
  }

  // ---- edits and deletes (§4.2, §10.3) --------------------------------------------------------------

  onCacheEvent(event: ConversationCacheEvent, castOf: (guildId: string, channelId: string) => Promise<string[]>): void {
    if (this.closed) return;
    if (event.type === "update" && event.source === "gateway") void this.track(this.onEdit(event, castOf));
    else if (event.type === "delete") void this.track(this.onDeleted(event.conversation, [event.messageId], event.previous));
    else if (event.type === "deleteBulk") void this.track(this.onDeleted(event.conversation, event.messageIds, undefined));
  }

  private async onEdit(event: Extract<ConversationCacheEvent, { type: "update" }>, castOf: (guildId: string, channelId: string) => Promise<string[]>): Promise<void> {
    const deps = this.deps;
    const { message, previous, conversation } = event;
    if (conversation.kind !== "guild" || !previous || message.authorIsBot) return;
    if (deps.now().getTime() - Date.parse(message.createdAt) > EDIT_MENTION_WINDOW_MS) return;
    const added = Object.keys(message.mentions.users).filter((id) => !(id in previous.mentions.users));
    if (added.length === 0) return;
    const cast = await this.castWaifus(await castOf(conversation.guildId, conversation.channelId));
    const dir = await this.view(conversation.guildId);
    const records = await this.forgetRecords();
    const removed = records.unreadable || isRemovedMessage(message, records.forgotten);
    for (const waifu of cast) {
      const selfIds = await selfAuthorIds(deps.storage, waifu);
      if (!selfIds.some((id) => added.includes(id))) continue;
      const once = `${message.id}:${waifu.id}`;
      if (this.editMentions.has(once)) continue;
      this.editMentions.add(once);
      if (this.editMentions.size > 1000) this.editMentions.delete(this.editMentions.values().next().value as string);
      await this.o.router.route(
        waifu.id,
        {
          id: newWakeId(),
          reason: "mention",
          placeKey: conversationKey(conversation),
          fromUserId: message.authorId,
          fromName: removed ? "someone" : message.authorName,
          messageId: message.id,
          preview: messagePreview(message, dir, deps.timeZone, { removed }),
          at: deps.now().toISOString()
        },
        { guildId: conversation.guildId }
      );
    }
  }

  private async onDeleted(conversation: ConversationRef, messageIds: readonly string[], previous: RawDiscordMessage | undefined): Promise<void> {
    const deps = this.deps;
    const placeKey = conversationKey(conversation);
    const waifus = await listWaifus(deps.storage).catch(() => []);
    const refs = await readConversationRefs(deps.storage, placeKey as never).catch(() => undefined);
    for (const waifu of waifus) {
      if (conversation.kind === "dm" && conversation.waifuId !== waifu.id) continue;
      const state = await readLifeState(deps.storage, waifu.id).catch(() => undefined);
      if (!state) continue;
      const read = messageIds.filter((id) => state.readMessageIds.includes(id) && !state.deletedReadIds.includes(id));
      if (read.length === 0) continue;
      const handle = await handleOf(deps.storage, waifu.id, placeKey);
      const selfIds = await selfAuthorIds(deps.storage, waifu);
      const notices = read.map((id) => {
        const ref = refs?.refs[id];
        const who = previous && previous.id === id ? (selfIds.includes(previous.authorId) ? "You" : previous.authorName) : "Someone";
        return `(${who} deleted a message you read in ${handle}${ref ? `: #${ref}` : ""})`;
      });
      await updateLifeState(deps.storage, waifu.id, (current) => ({
        ...current,
        deletedReadIds: [...new Set([...current.deletedReadIds, ...read])],
        pendingNotices: [...current.pendingNotices, ...notices].slice(-50)
      }));
    }
  }
}
