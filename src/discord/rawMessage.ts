// discord.js Message → RawDiscordMessage (spec 8.1): one record per Discord message, never merged.
// Typed structurally (the subset of discord.js we read) so tests can pass plain objects.

import type { RawDiscordMessage } from "../shared/schemas/discordMessage.js";
import type { DiscordMessagePatch } from "./gatewayEvents.js";

const IS_VOICE_MESSAGE_FLAG = 1 << 13; // MessageFlags.IsVoiceMessage
const FORWARD_REFERENCE_TYPE = 1; // MessageReferenceType.Forward
const POLL_RESULT_TYPE = 46;

type Iter<T> = { values(): Iterable<T> };
type KeyedIter<T> = { entries(): Iterable<[string, T]> };

export type DiscordAttachmentLike = {
  id: string;
  url: string;
  name: string;
  contentType?: string | null;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
};

export type DiscordEmbedLike = {
  data?: { type?: string; fields?: Array<{ name: string; value: string }> };
  title?: string | null;
  description?: string | null;
  url?: string | null;
  provider?: { name?: string | null } | null;
  thumbnail?: { url?: string | null } | null;
  fields?: Array<{ name: string; value: string }>;
};

export type DiscordMessageLike = {
  id: string;
  channelId: string;
  guildId?: string | null;
  author: { id: string; username: string; globalName?: string | null; bot: boolean };
  member?: { displayName?: string | null } | null;
  createdTimestamp: number;
  editedTimestamp?: number | null;
  type: number;
  content: string;
  flags?: { bitfield?: number; has?(bit: number): boolean } | null;
  attachments?: Iter<DiscordAttachmentLike>;
  embeds?: DiscordEmbedLike[];
  stickers?: Iter<{ name: string }>;
  poll?: { question: { text: string | null }; answers: Iter<{ text: string | null }> } | null;
  messageSnapshots?: Iter<{ content?: string | null; attachments?: Iter<DiscordAttachmentLike> }>;
  reference?: { messageId?: string | null; type?: number | null } | null;
  interaction?: { commandName?: string | null } | null;
  mentions?: {
    users?: KeyedIter<{ username: string; globalName?: string | null }>;
    members?: { get(id: string): { displayName?: string | null } | undefined } | null;
    roles?: KeyedIter<{ name: string }>;
    channels?: KeyedIter<{ name?: string | null }>;
  };
};

function hasFlag(flags: DiscordMessageLike["flags"], bit: number): boolean {
  if (!flags) return false;
  if (typeof flags.has === "function") return flags.has(bit);
  return ((flags.bitfield ?? 0) & bit) === bit;
}

function attachment(a: DiscordAttachmentLike, voice: boolean): RawDiscordMessage["attachments"][number] {
  return {
    id: a.id,
    url: a.url,
    filename: a.name,
    ...(a.contentType ? { contentType: a.contentType } : {}),
    size: Math.max(0, Math.floor(a.size ?? 0)),
    ...(typeof a.width === "number" ? { width: a.width } : {}),
    ...(typeof a.height === "number" ? { height: a.height } : {}),
    ...(typeof a.duration === "number" ? { durationSecs: a.duration } : {}),
    ...(voice ? { isVoice: true } : {})
  };
}

function embed(e: DiscordEmbedLike): RawDiscordMessage["embeds"][number] {
  const out: RawDiscordMessage["embeds"][number] = {};
  if (e.data?.type) out.type = e.data.type;
  if (e.title) out.title = e.title;
  if (e.description) out.description = e.description;
  if (e.url) out.url = e.url;
  if (e.provider?.name) out.providerName = e.provider.name;
  if (e.thumbnail?.url) out.thumbnailUrl = e.thumbnail.url;
  return out;
}

function pollResult(m: DiscordMessageLike): RawDiscordMessage["poll"] | undefined {
  const result = (m.embeds ?? []).find((e) => e.data?.type === "poll_result");
  const fields = result?.data?.fields ?? result?.fields ?? [];
  const field = (name: string) => fields.find((f) => f.name === name)?.value;
  const question = field("poll_question_text");
  if (!question) return undefined;
  const winner = field("victor_answer_text");
  return { question, answers: winner ? [winner] : [] };
}

export function toRawDiscordMessage(m: DiscordMessageLike, fallbackGuildId?: string): RawDiscordMessage {
  const voice = hasFlag(m.flags, IS_VOICE_MESSAGE_FLAG);
  const users: Record<string, string> = {};
  for (const [id, user] of m.mentions?.users?.entries() ?? []) {
    users[id] = m.mentions?.members?.get(id)?.displayName ?? user.globalName ?? user.username;
  }
  const roles: Record<string, string> = {};
  for (const [id, role] of m.mentions?.roles?.entries() ?? []) roles[id] = role.name;
  const channels: Record<string, string> = {};
  for (const [id, channel] of m.mentions?.channels?.entries() ?? []) if (channel.name) channels[id] = channel.name;

  const isPollResult = m.type === POLL_RESULT_TYPE;
  const poll = isPollResult
    ? pollResult(m)
    : m.poll
      ? {
          question: m.poll.question.text ?? "",
          answers: [...m.poll.answers.values()].map((a) => a.text ?? "").filter(Boolean)
        }
      : undefined;
  const guildId = m.guildId ?? fallbackGuildId;
  const referenceId =
    m.reference?.messageId && m.reference.type !== FORWARD_REFERENCE_TYPE ? m.reference.messageId : undefined;

  return {
    id: m.id,
    channelId: m.channelId,
    ...(guildId ? { guildId } : {}),
    authorId: m.author.id,
    authorName: m.member?.displayName ?? m.author.globalName ?? m.author.username,
    authorIsBot: m.author.bot,
    createdAt: new Date(m.createdTimestamp).toISOString(),
    ...(m.editedTimestamp ? { editedAt: new Date(m.editedTimestamp).toISOString() } : {}),
    type: m.type,
    content: m.content ?? "",
    attachments: [...(m.attachments?.values() ?? [])].map((a) => attachment(a, voice)),
    embeds: isPollResult ? [] : (m.embeds ?? []).map(embed),
    stickers: [...(m.stickers?.values() ?? [])].map((s) => ({ name: s.name })),
    ...(poll ? { poll } : {}),
    snapshots: [...(m.messageSnapshots?.values() ?? [])].map((s) => ({
      content: s.content ?? "",
      attachments: [...(s.attachments?.values() ?? [])].map((a) => attachment(a, false))
    })),
    ...(referenceId ? { referenceMessageId: referenceId } : {}),
    ...(m.interaction?.commandName ? { commandName: m.interaction.commandName } : {}),
    mentions: { users, roles, channels }
  };
}

/** A gateway message carries enough to build a RawDiscordMessage (partial updates do not). */
export function isCompleteDiscordMessage(m: Partial<DiscordMessageLike> | null | undefined): m is DiscordMessageLike {
  return Boolean(m && typeof m.id === "string" && typeof m.channelId === "string" && typeof m.content === "string" && m.author);
}

/** The fields a partial `messageUpdate` can change on a message we already hold. */
export function rawMessagePatch(
  m: Partial<Pick<DiscordMessageLike, "content" | "embeds" | "editedTimestamp" | "attachments" | "flags">>
): DiscordMessagePatch {
  const voice = hasFlag(m.flags, IS_VOICE_MESSAGE_FLAG);
  return {
    ...(typeof m.content === "string" ? { content: m.content } : {}),
    ...(m.embeds ? { embeds: m.embeds.map(embed) } : {}),
    ...(m.attachments ? { attachments: [...m.attachments.values()].map((a) => attachment(a, voice)) } : {}),
    ...(m.editedTimestamp ? { editedAt: new Date(m.editedTimestamp).toISOString() } : {})
  };
}

export function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Page a channel backwards (`before`, batches of 100) from the newest message until the message
 * `afterMessageId` (exclusive) or `maxMessages` are reached. Returns oldest-first.
 * `reachedCursor` is false only when the cap cut the batch before the cursor (or channel start).
 */
export async function pageMessagesSince<T extends { id: string }>(
  fetchPage: (before: string | undefined) => Promise<Iterable<T>>,
  o: { afterMessageId: string | null; maxMessages: number; signal?: AbortSignal; pageSize?: number }
): Promise<{ messages: T[]; reachedCursor: boolean }> {
  const pageSize = o.pageSize ?? 100;
  const max = Math.max(1, o.maxMessages);
  const collected: T[] = [];
  let before: string | undefined;
  let reachedCursor = false;
  outer: while (true) {
    if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error("Discord request aborted.");
    const page = [...(await fetchPage(before))].sort((a, b) => compareIds(b.id, a.id));
    for (const message of page) {
      if (o.afterMessageId !== null && compareIds(message.id, o.afterMessageId) <= 0) {
        reachedCursor = true;
        break outer;
      }
      // Cap reached: the cursor counts as reached only if it is the very next message.
      if (collected.length >= max) break outer;
      collected.push(message);
    }
    if (page.length < pageSize) {
      reachedCursor = true; // beginning of the channel
      break;
    }
    before = page[page.length - 1]!.id;
  }
  return { messages: collected.reverse(), reachedCursor };
}

/**
 * Drops the orchestrator bot's own posts (debug logs, `/print` fallbacks): they are never
 * conversation and must not reach any ledger.
 */
export function withoutAuthors<T extends { author?: { id?: string } | null }>(
  messages: T[],
  authorIds: Iterable<string | undefined | null>
): T[] {
  const ids = new Set([...authorIds].filter((id): id is string => Boolean(id)));
  if (ids.size === 0) return messages;
  return messages.filter((message) => !message.author?.id || !ids.has(message.author.id));
}
