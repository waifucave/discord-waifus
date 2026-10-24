// `read_messages`, `send_message`, `react` (Living cast spec §6.2–§6.4, D11).

import { z } from "zod";
import { assignConversationRefs, resolveConversationRef, snowflakeTime } from "../../discord/refStore.js";
import { compareIds } from "../../discord/rawMessage.js";
import { decideImageMode, ImageBuildAbortedError, imageTextFor } from "../../orchestration/context/images.js";
import { EMPTY_GUILD_DIRECTORY, renderDiscordMessage } from "../../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../../orchestration/context/types.js";
import { assessDmLimit } from "../../orchestration/dm/rateLimit.js";
import { readDmFloor, readDmLimitIfExists, readDmState, updateDmLimit, updateExistingDmState, aboveFloor } from "../../orchestration/dm/dmStore.js";
import { readActiveChatParticipants } from "../../orchestration/stores/participants.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { LifeImageBlock } from "../../shared/schemas/life.js";
import { clockText } from "../clock.js";
import { advanceReadCursor, readLifeState, updateLifeState } from "../lifeStore.js";
import { isOnlyToolCallSyntax, stripCopiedHeader, typingDelayMs } from "../outbound.js";
import { forgottenPeople, isRemovedMessage } from "../people.js";
import { placeLabel, resolvePlace, type ResolvedPlace } from "../places.js";
import { entryHeader, type LineMessage, type LineView } from "../render.js";
import type { LifeDeps } from "../deps.js";
import { CANNOT_POST, MESSAGE_TOO_OLD, parseInput, toolError, UNKNOWN_PLACE, type LifeResultBlock, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

const MAX_INLINE_PER_RESULT = 4;

async function directoryFor(deps: LifeDeps, place: ResolvedPlace): Promise<GuildDirectoryView> {
  if (!place.guildId) return EMPTY_GUILD_DIRECTORY;
  return deps.directory.view(place.guildId).catch(() => EMPTY_GUILD_DIRECTORY);
}

async function messageIdForRef(deps: LifeDeps, place: ResolvedPlace, ref: string): Promise<string | undefined> {
  return resolveConversationRef(deps.storage, place.placeKey as never, ref);
}

// ---- read_messages ------------------------------------------------------------------------------

const ReadInput = z.object({
  place: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(15),
  before: z.string().min(1).optional()
});

function reactionLine(deps: LifeDeps, place: ResolvedPlace, messageId: string): string | undefined {
  const reactions = deps.conversations.reactionsFor(place.ref, messageId);
  if (reactions.length === 0) return undefined;
  return `  reactions: ${reactions.map((reaction) => (reaction.count > 1 ? `${reaction.emoji} ${reaction.count}` : reaction.emoji)).join(" · ")}`;
}

/** Renders one page for her (also used by `/print life` previews of what she read). */
export async function readMessagesTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ReadInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu } = ctx;
  const args = parsed.value;
  const place = await resolvePlace(deps.storage, waifu.id, args.place);
  if (!place) return toolError(UNKNOWN_PLACE);
  let beforeId: string | undefined;
  if (args.before) {
    beforeId = await messageIdForRef(deps, place, args.before);
    if (!beforeId) return toolError(MESSAGE_TOO_OLD);
  }
  let forgotten;
  try {
    forgotten = await forgottenPeople(deps.storage);
  } catch {
    return toolError("error: messages can't be read right now");
  }
  // A forgotten DM's floor (§7.5) holds on the read path itself, not only in the cache: after a
  // restart the cache floor may not be loaded yet, and nothing at or below it may ever be shown.
  let dmFloor: string | undefined;
  if (place.kind === "dm" && place.userId) {
    try {
      dmFloor = await readDmFloor(deps.storage, place.userId, waifu.id);
    } catch {
      return toolError("error: messages can't be read right now");
    }
  }
  const raw = await deps.conversations.readPage({ conversation: place.ref, ...(beforeId ? { beforeId } : {}), limit: args.limit, signal: ctx.signal });
  const kept = dmFloor ? raw.messages.filter((message) => aboveFloor(message.id, dmFloor)) : raw.messages;
  // Nothing below the floor is "older" for her.
  const page = { ...raw, messages: kept, hasMore: raw.hasMore && kept.length === raw.messages.length };
  const now = deps.now();
  const tz = deps.timeZone;
  const dir = await directoryFor(deps, place);
  const ids = page.messages.map((message) => message.id);
  // Deleted messages she could have seen before (they have a ref) and that fall inside the page.
  const oldest = page.messages[0]?.id;
  const newest = page.messages[page.messages.length - 1]?.id;
  const deleted = oldest && newest
    ? deps.conversations.deletedIds(place.ref).filter((id) => compareIds(id, oldest) > 0 && compareIds(id, newest) < 0)
    : [];
  const refs = await assignConversationRefs(deps.storage, place.placeKey as never, ids, now);
  const auto = place.kind === "dm" && place.userId ? new Set((await readDmLimitIfExists(deps.storage, place.userId, waifu.id))?.autoMessageIds ?? []) : new Set<string>();
  const state = await readLifeState(deps.storage, waifu.id, now);
  const life = deps.config().life;
  const shown = new Set(state.shownImageKeys);
  let inlineCount = state.inlineImageCount;
  let inlineBytes = state.inlineImageBytes;
  let perResult = 0;
  const added = { count: 0, bytes: 0, keys: [] as string[] };
  const lookup = new Map<string, RawDiscordMessage>();
  for (const message of [...deps.conversations.bufferedMessages(place.ref), ...page.messages]) if (aboveFloor(message.id, dmFloor)) lookup.set(message.id, message);
  const view: LineView = {
    refs,
    lookup: (id) => lookup.get(id),
    selfAuthorIds: ctx.selfAuthorIds,
    timeZone: tz
  };
  const blocks: LifeResultBlock[] = [];
  const text: string[] = [`${place.handle} (${placeLabel(place)})`];
  const flush = () => {
    if (text.length > 0) blocks.push({ type: "text", text: text.join("\n") });
    text.length = 0;
  };
  const entries: Array<{ id: string; deleted?: boolean; message?: RawDiscordMessage }> = [
    ...page.messages.map((message) => ({ id: message.id, message })),
    ...deleted.filter((id) => refs.has(id)).map((id) => ({ id, deleted: true }))
  ].sort((a, b) => compareIds(a.id, b.id));
  for (const entry of entries) {
    if (entry.deleted) {
      const at = snowflakeTime(entry.id);
      text.push(`[${at !== undefined ? clockText(new Date(at), tz) : "--:--"} #${refs.get(entry.id)}] (message deleted)`);
      continue;
    }
    const message = entry.message!;
    const self = ctx.selfAuthorIds.includes(message.authorId);
    const line: LineMessage = {
      id: message.id,
      authorId: message.authorId,
      authorName: self ? "you" : message.authorName,
      at: message.createdAt,
      body: "",
      ...(message.referenceMessageId ? { replyToId: message.referenceMessageId } : {})
    };
    if (!self && isRemovedMessage(message, forgotten)) {
      text.push(`${entryHeader({ ...line, replyToId: undefined } as LineMessage, view)} someone: (removed)`);
      continue;
    }
    const rendered = renderDiscordMessage(message, dir, tz, { conversationKey: place.placeKey });
    if (!rendered) continue;
    let body = rendered.body;
    if (auto.has(message.id)) body = `[auto] ${body}`;
    if (message.editedAt) body = body ? `${body} (edited)` : "(edited)";
    text.push(body ? `${entryHeader(line, view)} ${line.authorName}: ${body}` : `${entryHeader(line, view)} ${line.authorName}:`);
    for (const image of rendered.images) {
      let mode: LifeImageBlock["mode"];
      if (shown.has(image.key) || !deps.images) {
        mode = { text: imageTextFor(await deps.ocr?.cachedText(image).catch(() => undefined)) };
      } else {
        try {
          const decided = await decideImageMode(image, {
            fetcher: deps.images,
            signal: ctx.signal,
            logger: deps.logger,
            acceptsImages: ctx.route.imageInput,
            ...(deps.ocr ? { ocr: deps.ocr } : {}),
            allowInline: (bytes) =>
              perResult < MAX_INLINE_PER_RESULT && inlineCount + 1 <= life.maxInlineImagesPerEpoch && inlineBytes + bytes <= life.maxInlineImageBytesPerEpoch
          });
          if (decided.mode === "inline") {
            mode = "inline";
            perResult += 1;
            inlineCount += 1;
            inlineBytes += decided.bytes;
            added.count += 1;
            added.bytes += decided.bytes;
          } else {
            mode = decided.mode;
          }
        } catch (error) {
          if (error instanceof ImageBuildAbortedError) throw error;
          mode = { text: imageTextFor(undefined) };
        }
      }
      shown.add(image.key);
      added.keys.push(image.key);
      if (mode === "inline") {
        flush();
        blocks.push({ type: "life_image", placeKey: place.placeKey, messageId: message.id, attachment: image, mode });
      } else {
        text.push(`  ${mode.text}`);
      }
    }
    const reactions = reactionLine(deps, place, message.id);
    if (reactions) text.push(reactions);
  }
  if (page.messages.length === 0) text.push("(no messages)");
  if (page.hasMore && oldest && refs.get(oldest)) text.push(`— older messages available; pass before:"#${refs.get(oldest)}" —`);
  flush();
  await updateLifeState(deps.storage, waifu.id, (current) => ({
    ...current,
    readMessageIds: [...new Set([...current.readMessageIds, ...ids])],
    shownImageKeys: [...new Set([...current.shownImageKeys, ...added.keys])],
    inlineImageCount: current.inlineImageCount + added.count,
    inlineImageBytes: current.inlineImageBytes + added.bytes
  }));
  if (!beforeId && newest) await advanceReadCursor(deps.storage, waifu.id, place.placeKey, newest, now);
  const content: LifeResultBlock[] | string = blocks.length === 1 && blocks[0]!.type === "text" ? blocks[0]!.text : blocks;
  return { content, messageIds: ids };
}

// ---- send_message -------------------------------------------------------------------------------

const SendInput = z.object({
  place: z.string().min(1),
  text: z.string().min(1).max(2000),
  reply_to: z.string().min(1).optional()
});

/** D11: may she write in this DM? (DMed her before, deliverable, wrote since any forget, not limited.) */
async function dmSendAllowed(deps: LifeDeps, ctx: ToolContext, place: ResolvedPlace): Promise<boolean> {
  const userId = place.userId!;
  const state = await readDmState(deps.storage, userId, ctx.waifu.id);
  if (!state?.lastInboundMessageId || state.undeliverableSince) return false;
  const floor = await readDmFloor(deps.storage, userId, ctx.waifu.id);
  if (floor && !aboveFloor(state.lastInboundMessageId, floor)) return false;
  if (ctx.turn.dmUsersSent.has(userId)) return true;
  const limits = await readDmLimitIfExists(deps.storage, userId, ctx.waifu.id);
  return !assessDmLimit(limits?.replyTimestamps ?? [], ctx.waifu.dm.rateLimit, deps.now()).limited;
}

async function presentPeople(deps: LifeDeps, place: ResolvedPlace): Promise<string[]> {
  const ids = new Set<string>();
  for (const message of deps.conversations.bufferedMessages(place.ref).slice(-50)) if (!message.authorIsBot) ids.add(message.authorId);
  if (place.guildId && place.channelId) {
    for (const participant of await readActiveChatParticipants(deps.storage, place.guildId, place.channelId).catch(() => [])) ids.add(participant.userId);
  }
  if (place.userId) ids.add(place.userId);
  return [...ids];
}

function isUndeliverable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 50007 || code === "50007";
}

export async function sendMessageTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(SendInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu, turn } = ctx;
  const args = parsed.value;
  const place = await resolvePlace(deps.storage, waifu.id, args.place);
  if (!place) return toolError(UNKNOWN_PLACE);
  if (place.kind === "dm" ? !(await dmSendAllowed(deps, ctx, place)) : place.paused === true) return toolError(CANNOT_POST);
  const maxPlaces = deps.config().life.maxSendPlacesPerTurn;
  if (!turn.sentPlaces.has(place.placeKey) && turn.sentPlaces.size >= maxPlaces) {
    return toolError(`you've already written in ${maxPlaces} places this turn`);
  }
  const text = stripCopiedHeader(args.text, [waifu.name, waifu.displayName]);
  if (!text) return toolError("there is nothing to send");
  if (isOnlyToolCallSyntax(text, ctx.toolNames)) return toolError("that looks like a tool call, not a message; write what you want to say");
  let replyToId: string | undefined;
  if (args.reply_to) {
    replyToId = await messageIdForRef(deps, place, args.reply_to);
    if (!replyToId) return toolError(MESSAGE_TOO_OLD);
  }
  const discord = deps.discord();
  if (!discord) return toolError("you can't reach Discord right now");
  // Typing first, for as long as a person would take (§6.3).
  if (place.kind === "dm") await discord.sendDirectTyping?.({ waifuId: waifu.id, userId: place.userId! });
  else await discord.sendTyping({ guildId: place.guildId!, channelId: place.channelId!, ...(waifu.botId ? { senderBotId: waifu.botId } : {}) });
  await deps.sleep(typingDelayMs(text), ctx.signal);
  if (ctx.signal.aborted) return toolError("interrupted before sending");
  let messageId: string;
  try {
    if (place.kind === "dm") {
      messageId = (await discord.sendDirectMessage!({ waifuId: waifu.id, userId: place.userId!, content: text, ...(replyToId ? { replyToMessageId: replyToId } : {}) })).messageId;
    } else {
      messageId = (
        await discord.sendWaifuMessage({
          guildId: place.guildId!,
          channelId: place.channelId!,
          content: text,
          ...(waifu.botId ? { senderBotId: waifu.botId } : {}),
          ...(replyToId ? { replyToMessageId: replyToId } : {}),
          allowedUserMentionIds: await presentPeople(deps, place)
        })
      ).messageId;
    }
  } catch (error) {
    if (place.kind === "dm" && isUndeliverable(error)) {
      await updateExistingDmState(deps.storage, place.userId!, waifu.id, (state) => ({ ...state, undeliverableSince: deps.now().toISOString() })).catch(() => undefined);
      return toolError("they can't receive your messages right now");
    }
    deps.logger.warn("Life send failed", { waifuId: waifu.id, placeKey: place.placeKey, message: error instanceof Error ? error.message : String(error) });
    return toolError("the message could not be sent");
  }
  const now = deps.now();
  if (place.kind === "dm") {
    const userId = place.userId!;
    // One reply per turn per user counts toward the rate limit (§4.4 guard 2).
    if (!turn.dmUsersSent.has(userId)) {
      await updateDmLimit(deps.storage, userId, waifu.id, (limits) => {
        const assessed = assessDmLimit([...limits.replyTimestamps, now.toISOString()], waifu.dm.rateLimit, now);
        return { ...limits, replyTimestamps: assessed.pruned };
      });
    }
    turn.dmUsersSent.add(userId);
    await updateExistingDmState(deps.storage, userId, waifu.id, (state) => ({ ...state, lastRepliedMessageId: messageId, lastReplyAt: now.toISOString() })).catch(() => undefined);
  }
  turn.sentPlaces.add(place.placeKey);
  const refs = await assignConversationRefs(deps.storage, place.placeKey as never, [messageId], now);
  await advanceReadCursor(deps.storage, waifu.id, place.placeKey, messageId, now);
  deps.logger.info("Life message sent", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, messageId });
  const ref = refs.get(messageId);
  return { content: ref ? `sent #${ref}` : "sent", resultRef: messageId, messageIds: [messageId] };
}

// ---- react --------------------------------------------------------------------------------------

const ReactInput = z.object({
  place: z.string().min(1),
  ref: z.string().min(1),
  emoji: z.string().min(1).max(100)
});

export async function reactTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ReactInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu } = ctx;
  const args = parsed.value;
  const place = await resolvePlace(deps.storage, waifu.id, args.place);
  if (!place) return toolError(UNKNOWN_PLACE);
  if (place.paused) return toolError(CANNOT_POST);
  const messageId = await messageIdForRef(deps, place, args.ref);
  if (!messageId) return toolError(MESSAGE_TOO_OLD);
  let emoji = args.emoji.trim();
  const custom = /^<?a?:([A-Za-z0-9_~]{2,32}):(\d+)?>?$/.exec(emoji);
  if (custom) {
    if (custom[2]) emoji = custom[2];
    else {
      const found = place.guildId ? await deps.directory.findEmoji(place.guildId, custom[1]!) : undefined;
      if (!found) return toolError(`there is no :${custom[1]}: emoji here`);
      emoji = found.id;
    }
  } else if (/[A-Za-z0-9]/.test(emoji) && !/\p{Extended_Pictographic}/u.test(emoji)) {
    return toolError("use a unicode emoji or :server_emoji:");
  }
  const discord = deps.discord();
  if (!discord?.addReaction || !waifu.botId) return toolError("you can't react right now");
  try {
    await discord.addReaction({ waifuId: waifu.id, botId: waifu.botId, conversation: place.ref, messageId, emoji });
  } catch (error) {
    deps.logger.warn("Life reaction failed", { waifuId: waifu.id, placeKey: place.placeKey, message: error instanceof Error ? error.message : String(error) });
    return toolError("the reaction could not be added");
  }
  deps.logger.info("Life reaction added", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, messageId });
  return { content: "reacted", resultRef: messageId };
}

export const messageTools: LifeTool[] = [
  {
    name: "read_messages",
    description:
      "Read the latest messages in one of your places (a room, thread or private chat). Lines look like `[14:02 #k3] Kevin: text`; `#k3` is the message's ref. Pass `before` with a ref to read older messages.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A place handle from your places, like bake-club/#general or dm/kevin." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many messages (default 15)." },
        before: { type: "string", description: "A message ref like #a0: read messages older than it." }
      },
      required: ["place"],
      additionalProperties: false
    },
    sideEffect: false,
    run: readMessagesTool
  },
  {
    name: "send_message",
    description:
      "Send a message to a place. This is the only way anyone sees what you write. Keep it like a chat message; send several if you have several things to say. Use <@Name> to mention someone who is there.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A place handle." },
        text: { type: "string", minLength: 1, maxLength: 2000 },
        reply_to: { type: "string", description: "Optional: the ref of the message you are replying to, like #k3." }
      },
      required: ["place", "text"],
      additionalProperties: false
    },
    sideEffect: true,
    run: sendMessageTool
  },
  {
    name: "react",
    description: "Add a reaction to a message.",
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string" },
        ref: { type: "string", description: "The message ref, like #k3." },
        emoji: { type: "string", description: "A unicode emoji, or :server_emoji:." }
      },
      required: ["place", "ref", "emoji"],
      additionalProperties: false
    },
    sideEffect: true,
    run: reactTool
  }
];

export { messageIdForRef };
