// Intake (Living cast spec §4.1, §4.2, §10.3): turns Discord events into wake candidates.
//
// Per accepted guild message (human or configured waifu bot, in a cast channel or tracked thread):
//   1. direct reasons for each cast waifu: `mention` (her bot, or a reply to her message), `role`
//      (a role her bot member holds), `everyone` (@everyone/@here, humans only), `name` (her name,
//      display name or server nickname, ≥ 3 characters, as a whole word; humans only; off with
//      `wakeOnName: false`);
//   2. watches: every waifu with a matching `watch_for` binding;
//   3. detector: when the author is human and no message in the current burst produced a direct
//      reason for anyone, the burst (channel debounce `serverMs`/`serverMaxWaitMs`) goes to the
//      addressee detector.
// Messages by other waifus only wake through mention, role, reply-to-her and watch; her own never
// wake her. DMs wake her 30 s after the user's last message (`dmMs`, capped at `dmMaxWaitMs`).
// Edits wake nobody except a newly added mention of her in a human message under 2 minutes old
// (once); a deleted message she had read becomes a pending notice (§10.3).

import type { DiscordDirectMessageEvent } from "../discord/client.js";
import type { ConversationCacheEvent } from "../discord/conversationCache.js";
import { assignConversationRefs, readConversationRefs } from "../discord/refStore.js";
import { compareIds } from "../discord/rawMessage.js";
import { KeyedDebouncer } from "../orchestration/debounce.js";
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
import { FORGET_RECORDS_NOTICE, FORGET_RECORDS_UNREADABLE } from "./ownerNotices.js";
import { forgottenPeople, isRemovedMessage, selfAuthorIds } from "./people.js";
import type { ForgottenPerson } from "../orchestration/dm/forgotten.js";
import { handleOf } from "./places.js";
import { wordBoundaryIncludes } from "./text.js";
import { fireWatches } from "./watches.js";
import { newWakeId } from "./wakeQueue.js";
import type { WakeRouter } from "./wakeRouter.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

export const EDIT_MENTION_WINDOW_MS = 2 * 60_000;
const DIRECT_ORDER: WakeReason[] = ["mention", "role", "everyone", "name"];

export type IntakeOptions = {
  deps: LifeDeps;
  router: WakeRouter;
  botRoles: BotRoles;
  cost: DailyCost;
  detector?: AddresseeDetector;
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

type Burst = {
  messageIds: string[];
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

export class Intake {
  private readonly detectorDebounce: KeyedDebouncer<string>;
  private readonly dmDebounce: KeyedDebouncer<string>;
  private readonly bursts = new Map<string, Burst>();
  private readonly dmBursts = new Map<string, DmBurst>();
  private readonly editMentions = new Set<string>();
  private readonly lastHumanAt = new Map<string, string>();
  private readonly inflight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly o: IntakeOptions) {
    this.detectorDebounce = new KeyedDebouncer(o.now);
    this.dmDebounce = new KeyedDebouncer(o.now);
  }

  close(): void {
    this.closed = true;
    this.detectorDebounce.cancelAll();
    this.dmDebounce.cancelAll();
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
      if (waifu?.enabled) out.push(waifu);
    }
    return out;
  }

  /** Her name, display name and server nickname (each ≥ 3 characters), for the `name` rule. */
  private namesOf(waifu: WaifuConfig, guildId: string): string[] {
    const nick = waifu.botId ? this.deps.directory.memberName(guildId, waifu.botId) : undefined;
    return [...new Set([waifu.name, waifu.displayName, nick].filter((name): name is string => typeof name === "string" && name.trim().length >= 3))];
  }

  // ---- guild messages -------------------------------------------------------------------------------

  async onGuildMessage(input: GuildMessageInput): Promise<void> {
    if (this.closed) return;
    const deps = this.deps;
    const conversation: ConversationRef = { kind: "guild", guildId: input.guildId, channelId: input.channelId };
    const placeKey = conversationKey(conversation);
    const raw = input.raw ?? (await this.findMessage(conversation, input.messageId));
    if (!raw) return;
    const human = !raw.authorIsBot && !input.authorIsWaifu;
    const waifus = await this.castWaifus(input.castWaifuIds);
    if (waifus.length === 0) return;
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
    const directWakes: Array<{ waifu: WaifuConfig; wake: Wake; shared: boolean }> = [];
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
        if (human && !removed && !reasons.includes("mention") && waifu.wakeOnName && this.namesOf(waifu, input.guildId).some((name) => wordBoundaryIncludes(text, name))) reasons.push("name");
        if (reasons.length > 0) {
          const ordered = DIRECT_ORDER.filter((reason) => reasons.includes(reason));
          const shared = !ordered.includes("mention") && !ordered.includes("name") && (ordered.includes("everyone") || ordered.includes("role"));
          directWakes.push({ waifu, wake: { id: newWakeId(), reason: ordered[0]!, ...(ordered.length > 1 ? { reasons: ordered } : {}), ...base }, shared });
        }
      }
      const fired = await fireWatches(deps.storage, waifu.id, { placeKey, authorId: raw.authorId, text, own }, { now, maxFiresPerDay: deps.config().life.maxWatchFiresPerDay });
      for (const { watch, matched } of fired) {
        await this.o.router.route(waifu.id, { id: newWakeId(), reason: "watch", watchId: watch.id, matched, note: watch.note, ...base }, { guildId: input.guildId });
      }
      if (fired.length > 0) watched.add(waifu.id);
    }
    // Several waifus woken by one @everyone / shared role ping are staggered by 0–20 s (§4.1).
    const sharedCount = directWakes.filter((entry) => entry.shared).length;
    for (const entry of directWakes) {
      const stagger = entry.shared && sharedCount > 1;
      const routed = this.o.router.route(entry.waifu.id, entry.wake, { guildId: input.guildId, stagger });
      // A staggered wake waits on its own timer; it never holds up intake or the other waifus.
      if (stagger) void this.track(routed);
      else await routed;
    }
    if (!human) return;
    // Every human message joins the place's burst. A burst with any direct message in it (before or
    // after the others, M9) never reaches the detector; a waifu whose watch fired for a message in it
    // is skipped by the detector for the burst (D-c: one wake per message), others can still be picked.
    const next: Burst = this.bursts.get(placeKey) ?? { messageIds: [], direct: false, watched: [], guildId: input.guildId, channelId: input.channelId, castWaifuIds: input.castWaifuIds };
    next.messageIds.push(raw.id);
    if (directWakes.length > 0) {
      next.direct = true;
      this.lastHumanAt.set(placeKey, raw.createdAt);
    } else {
      next.authorId = raw.authorId;
      next.authorName = fromName;
    }
    for (const waifuId of watched) if (!next.watched.includes(waifuId)) next.watched.push(waifuId);
    next.castWaifuIds = input.castWaifuIds;
    this.bursts.set(placeKey, next);
    const debounce = deps.config().discord.debounce;
    this.detectorDebounce.schedule(placeKey, { quietMs: debounce.serverMs, maxWaitMs: debounce.serverMaxWaitMs }, () => {
      const done = this.bursts.get(placeKey);
      this.bursts.delete(placeKey);
      if (done && !done.direct && !this.closed) void this.track(this.runDetector(placeKey, done));
    });
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
    for (const message of page.messages) {
      const removed = isRemovedMessage(message, forgotten);
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
        ...(imageText.some(Boolean) ? { imageText: imageText.filter(Boolean) } : {})
      });
    }
    const cast: DetectorCastMember[] = waifus.map((waifu) => ({ waifuId: waifu.id, names: this.namesOf(waifu, burst.guildId).length > 0 ? this.namesOf(waifu, burst.guildId) : [waifu.name], persona: waifu.persona }));
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
    let chosen: string | undefined;
    if (choice.startsWith("waifu_")) chosen = question.candidates[Number(choice.slice(6))]?.waifuId;
    else if (choice === "anyone" || choice === "fallback:anyone") chosen = await this.drawFor(waifus.filter((waifu) => !watched.has(waifu.id)), conversation, now);
    if (chosen && watched.has(chosen)) chosen = undefined;
    const woke: string[] = [];
    if (chosen) {
      const removed = newestMessage ? isRemovedMessage(newestMessage, forgotten) : false;
      const wake: Wake = {
        id: newWakeId(),
        reason: "detector",
        placeKey,
        ...(burst.authorId ? { fromUserId: burst.authorId } : {}),
        ...(burst.authorName ? { fromName: burst.authorName } : {}),
        messageId: newestId,
        ...(newestMessage ? { preview: messagePreview(newestMessage, dir, deps.timeZone, { removed }) } : {}),
        at: now.toISOString()
      };
      const outcome = await this.o.router.route(chosen, wake, { guildId: burst.guildId });
      if (outcome !== "dropped") woke.push(chosen);
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

  /** A human's DM: DM state updated now; the `dm` wake 30 s after their last message (cap 180 s). */
  async onDirectMessage(event: DiscordDirectMessageEvent): Promise<void> {
    if (this.closed) return;
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
    if (deps.isPaused()) return;
    const key = `${event.waifuId}\u0000${event.userId}`;
    const burst = this.dmBursts.get(key) ?? { messageIds: [] };
    burst.messageIds.push(event.messageId);
    if (event.userDisplayName) burst.userName = event.userDisplayName;
    this.dmBursts.set(key, burst);
    const debounce = deps.config().discord.debounce;
    this.dmDebounce.schedule(key, { quietMs: debounce.dmMs, maxWaitMs: debounce.dmMaxWaitMs }, () => {
      const done = this.dmBursts.get(key);
      this.dmBursts.delete(key);
      if (done && !this.closed) void this.track(this.fireDm(event.waifuId, event.userId, done));
    });
  }

  private async fireDm(waifuId: string, userId: string, burst: DmBurst): Promise<void> {
    const deps = this.deps;
    const conversation: ConversationRef = { kind: "dm", waifuId, userId };
    const newestId = [...burst.messageIds].sort(compareIds).pop()!;
    const message = await this.findMessage(conversation, newestId);
    const wake: Wake = {
      id: newWakeId(),
      reason: "dm",
      placeKey: conversationKey(conversation),
      fromUserId: userId,
      fromName: burst.userName ?? message?.authorName ?? "someone",
      messageId: newestId,
      ...(message ? { preview: messagePreview(message, EMPTY_GUILD_DIRECTORY, deps.timeZone) } : {}),
      ...(burst.messageIds.length > 1 ? { count: burst.messageIds.length } : {}),
      at: deps.now().toISOString()
    };
    await this.o.router.route(waifuId, wake, { dmUserId: userId });
  }

  /** Fires every pending DM wake now (tests; the boot catch-up after a long pause). */
  flushDms(): void {
    for (const key of this.dmDebounce.keys()) {
      const burst = this.dmBursts.get(key);
      this.dmDebounce.cancel(key);
      this.dmBursts.delete(key);
      const [waifuId, userId] = key.split("\u0000");
      if (burst && waifuId && userId) void this.track(this.fireDm(waifuId, userId, burst));
    }
  }

  /** Runs every pending detector burst now (tests). */
  flushDetector(): void {
    for (const key of this.detectorDebounce.keys()) {
      this.detectorDebounce.cancel(key);
      const burst = this.bursts.get(key);
      this.bursts.delete(key);
      if (burst && !burst.direct) void this.track(this.runDetector(key, burst));
    }
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
          fromName: message.authorName,
          messageId: message.id,
          preview: messagePreview(message, dir, deps.timeZone),
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
