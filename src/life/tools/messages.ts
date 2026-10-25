// `ReadMessages`, `SendMessage`, `React` (Living cast spec §6.2–§6.4, §16.3.1, §16.3.2, D11).
//
// ReadMessages downloads attachments (images, PDFs, text files) into her `/tmp`, under the place's
// handle (`/tmp/bake-club/general/k3-cake.png`, `/tmp/dm/kevin/a7-menu.pdf`), and shows the path
// instead of the image; she looks with Read. SendMessage can attach files from her folders, except
// her private ones (MEMORY.md and the notes it links, her reminders, watches and places).

import { createHash } from "node:crypto";
import { z } from "zod";
import { assignConversationRefs, resolveConversationRef, snowflakeTime } from "../../discord/refStore.js";
import { compareIds } from "../../discord/rawMessage.js";
import { EMPTY_GUILD_DIRECTORY, formatBytes, imageRef, isImageAttachment, renderDiscordMessage, type RawAttachment } from "../../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../../orchestration/context/types.js";
import { assessDmLimit } from "../../orchestration/dm/rateLimit.js";
import { readDmFloor, readDmLimitIfExists, readDmState, updateDmLimit, updateExistingDmState, aboveFloor } from "../../orchestration/dm/dmStore.js";
import { readActiveChatParticipants } from "../../orchestration/stores/participants.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { OutgoingFile } from "../../discord/client.js";
import { clockText } from "../clock.js";
import { keptForText } from "../lifeHarness.js";
import { sha256 } from "../home/homeStore.js";
import { pathKey, safeFileName, type HerPath } from "../home/pathRules.js";
import { advanceReadCursor, appendIntent, updateLifeState } from "../lifeStore.js";
import { isOnlyToolCallSyntax, stripCopiedHeader, typingDelayMs } from "../outbound.js";
import { forgottenPeople, isRemovedMessage } from "../people.js";
import { placeLabel, resolvePlace, type ResolvedPlace } from "../places.js";
import { entryHeader, type LineMessage, type LineView } from "../render.js";
import type { LifeDeps } from "../deps.js";
import { noteDmFile, pathArg, storeOf } from "./files.js";
import { CANNOT_POST, MESSAGE_TOO_OLD, parseInput, toolError, UNKNOWN_PLACE, type LifeTool, type ToolContext, type ToolOutput } from "./types.js";

/** At most this many attachments are downloaded by one ReadMessages call (§16.3.1). */
export const MAX_DOWNLOADS_PER_READ = 10;
/** A downloaded file larger than this is not attached by SendMessage (§16.3.2). */
export const MAX_SEND_FILE_BYTES = 10 * 1024 * 1024;
/** Discord's limit for one message's files together (a bot in a server without boosts). */
export const MAX_SEND_TOTAL_BYTES = 10 * 1024 * 1024;
const OCR_HINT_CHARS = 40;
const NO_BOT = "you have no Discord bot of your own, so you can't post; the owner has been told";

/** The digest of a message's content as Discord holds it (boot repair matches sends by it, §5.7). */
export function contentDigest(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex").slice(0, 32);
}

async function directoryFor(deps: LifeDeps, place: ResolvedPlace): Promise<GuildDirectoryView> {
  if (!place.guildId) return EMPTY_GUILD_DIRECTORY;
  return deps.directory.view(place.guildId).catch(() => EMPTY_GUILD_DIRECTORY);
}

async function messageIdForRef(deps: LifeDeps, place: ResolvedPlace, ref: string): Promise<string | undefined> {
  return resolveConversationRef(deps.storage, place.placeKey as never, ref);
}

// ---- ReadMessages -------------------------------------------------------------------------------

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
  const lookup = new Map<string, RawDiscordMessage>();
  for (const message of [...deps.conversations.bufferedMessages(place.ref), ...page.messages]) if (aboveFloor(message.id, dmFloor)) lookup.set(message.id, message);
  const view: LineView = {
    refs,
    lookup: (id) => lookup.get(id),
    selfAuthorIds: ctx.selfAuthorIds,
    timeZone: tz
  };
  const text: string[] = [`${place.handle} (${placeLabel(place)})`];
  const entries: Array<{ id: string; deleted?: boolean; message?: RawDiscordMessage }> = [
    ...page.messages.map((message) => ({ id: message.id, message })),
    ...deleted.filter((id) => refs.has(id)).map((id) => ({ id, deleted: true }))
  ].sort((a, b) => compareIds(a.id, b.id));
  const downloads = new Downloads(ctx, place);
  downloads.plan(entries.flatMap((entry) => (entry.message && (ctx.selfAuthorIds.includes(entry.message.authorId) || !isRemovedMessage(entry.message, forgotten)) ? [entry.message] : [])));
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
    // A removed message's attachments are never downloaded (§16.3.1).
    if (!self && isRemovedMessage(message, forgotten)) {
      text.push(`${entryHeader({ ...line, replyToId: undefined } as LineMessage, view)} someone: (removed)`);
      continue;
    }
    const lines = await downloads.forMessage(message, refs.get(message.id) ?? "m");
    const rendered = renderDiscordMessage(message, dir, tz, { conversationKey: place.placeKey, attachmentText: (attachment) => lines.get(attachment) });
    if (!rendered) continue;
    let body = rendered.body;
    if (auto.has(message.id)) body = `[auto] ${body}`;
    if (message.editedAt) body = body ? `${body} (edited)` : "(edited)";
    text.push(body ? `${entryHeader(line, view)} ${line.authorName}: ${body}` : `${entryHeader(line, view)} ${line.authorName}:`);
    const reactions = reactionLine(deps, place, message.id);
    if (reactions) text.push(reactions);
  }
  if (page.messages.length === 0) text.push("(no messages)");
  if (page.hasMore && oldest && refs.get(oldest)) text.push(`— older messages available; pass before:"#${refs.get(oldest)}" —`);
  await updateLifeState(deps.storage, waifu.id, (current) => ({
    ...current,
    readMessageIds: [...new Set([...current.readMessageIds, ...ids])]
  }));
  if (!beforeId && newest) await advanceReadCursor(deps.storage, waifu.id, place.placeKey, newest, now);
  return { content: text.join("\n"), messageIds: ids };
}

// ---- attachment downloads (§16.3.1) ---------------------------------------------------------------

const DOWNLOAD_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "log", "yaml", "yml", "toml", "xml", "html", "htm", "css",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "sql", "ini", "cfg", "conf", "php", "lua", "r", "pl", "srt", "vtt"
]);

type AttachmentKind = "image" | "pdf" | "text" | "video" | "other";

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "flv", "3gp"]);

function attachmentKind(a: RawAttachment): AttachmentKind {
  if (a.isVoice) return "other";
  const mime = (a.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = /\.([A-Za-z0-9]{1,10})$/u.exec(a.filename)?.[1]?.toLowerCase() ?? "";
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "video";
  if (isImageAttachment(a)) return DOWNLOAD_IMAGE_TYPES.has(mime === "image/jpg" ? "image/jpeg" : mime) || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext) ? "image" : "other";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("text/") || mime === "application/json" || TEXT_EXTENSIONS.has(ext)) return "text";
  return "other";
}

/** The `/tmp` folder of a place: its handle without `#` (`bake-club/#general` → `bake-club/general`). */
export function placeFolder(handle: string): string[] {
  return handle
    .split("/")
    .map((segment) => segment.replace(/^#/u, ""))
    .filter(Boolean)
    .map((segment) => safeFileName(segment, "place"));
}

/**
 * One ReadMessages call's downloads: at most 10, within the size cap, deduped by attachment id.
 * The 10 go to the newest messages first (`plan`); older ones say to read fewer at a time.
 */
class Downloads {
  private readonly allowed = new Set<RawAttachment>();
  private readonly store;
  private index: Awaited<ReturnType<ReturnType<typeof storeOf>["readIndex"]>> | undefined;

  constructor(
    private readonly ctx: ToolContext,
    private readonly place: ResolvedPlace
  ) {
    this.store = storeOf(ctx);
  }

  /** Picks the attachments this read downloads: newest message first, up to MAX_DOWNLOADS_PER_READ. */
  plan(messages: readonly RawDiscordMessage[]): void {
    const max = this.ctx.deps.config().life.attachments.maxBytes;
    for (const message of [...messages].sort((a, b) => compareIds(b.id, a.id))) {
      for (const attachment of [...message.attachments, ...message.snapshots.flatMap((snapshot) => snapshot.attachments)]) {
        if (this.allowed.size >= MAX_DOWNLOADS_PER_READ) return;
        const kind = attachmentKind(attachment);
        if (attachment.isVoice || kind === "other" || kind === "video" || attachment.size > max) continue;
        this.allowed.add(attachment);
      }
    }
  }

  /** The line each attachment of a message shows (by attachment object). */
  async forMessage(message: RawDiscordMessage, ref: string): Promise<Map<RawAttachment, string>> {
    const out = new Map<RawAttachment, string>();
    const used = new Set<string>();
    for (const attachment of [...message.attachments, ...message.snapshots.flatMap((snapshot) => snapshot.attachments)]) {
      const line = await this.one(message, attachment, ref, used);
      if (line !== undefined) out.set(attachment, line);
    }
    return out;
  }

  private async one(message: RawDiscordMessage, attachment: RawAttachment, ref: string, used: Set<string>): Promise<string | undefined> {
    const kind = attachmentKind(attachment);
    // A voice message keeps its own line (`[voice message · 0:12]`).
    if (attachment.isVoice) return undefined;
    const label = kind === "image" ? "image" : kind === "video" ? "video" : "file";
    const size = formatBytes(attachment.size);
    const max = this.ctx.deps.config().life.attachments.maxBytes;
    if (kind === "other" || kind === "video" || attachment.size > max) return `[${label}: ${attachment.filename} · ${size} · not downloaded]`;
    if (!this.allowed.has(attachment)) return `[${label}: ${attachment.filename} · ${size} · not downloaded (too many in one read; read fewer)]`;
    const target = this.targetPath(attachment, ref, used);
    if (!target) return `[${label}: ${attachment.filename} · ${size} · not downloaded]`;
    const saved = await this.download(message, attachment, target);
    if (!saved) return `[${label}: ${attachment.filename} · ${size} · couldn't be downloaded]`;
    if (kind === "image") {
      const ocr = await this.ctx.deps.ocr?.cachedText(imageRef(attachment, this.place.placeKey)).catch(() => undefined);
      const hint = (ocr ?? "").replace(/\s+/gu, " ").replace(/"/gu, "'").trim();
      const short = hint.length > OCR_HINT_CHARS ? `${hint.slice(0, OCR_HINT_CHARS).trimEnd()}…` : hint;
      return `[image: ${saved.display}${short ? ` · "${short}"` : ""}]`;
    }
    return `[file: ${saved.display} · ${size}]`;
  }

  private targetPath(attachment: RawAttachment, ref: string, used: Set<string>): HerPath | undefined {
    let name = safeFileName(`${ref}-${attachment.filename}`);
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      for (let n = 2; used.has(name); n += 1) name = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
    }
    used.add(name);
    const resolved = this.store.resolve(["/tmp", ...placeFolder(this.place.handle), name].join("/"));
    return resolved.ok ? resolved.path : undefined;
  }

  /** The saved path (already there with the same bytes, or fetched now), or undefined. */
  private async download(message: RawDiscordMessage, attachment: RawAttachment, target: HerPath): Promise<HerPath | undefined> {
    const { deps } = this.ctx;
    this.index ??= await this.store.readIndex();
    const known = this.index.entries.find((entry) => entry.attachmentId === attachment.id && entry.path === target.virtual);
    if (known && (await this.store.hashOf(target)) === known.sha256) return target;
    const fetcher = deps.images?.fetchFile;
    if (!fetcher) return undefined;
    const ref = imageRef(attachment, this.place.placeKey);
    const result = await fetcher.call(deps.images, ref, { maxBytes: deps.config().life.attachments.maxBytes, signal: this.ctx.signal }).catch(() => undefined);
    if (!result?.ok) return undefined;
    const saved = await this.store
      .saveDownload(target, result.data, {
        placeKey: this.place.placeKey,
        messageId: message.id,
        authorId: message.authorId,
        attachmentId: attachment.id,
        downloadedAt: deps.now().toISOString()
      })
      .catch((error: unknown) => {
        deps.logger.warn("Life attachment could not be saved", { waifuId: this.ctx.waifu.id, message: error instanceof Error ? error.message : String(error) });
        return false;
      });
    if (saved) this.index = undefined;
    return saved ? target : undefined;
  }
}

// ---- SendMessage ---------------------------------------------------------------------------------

const SendInput = z.object({
  place: z.string().min(1),
  text: z.string().max(2000).default(""),
  reply_to: z.string().min(1).optional(),
  files: z.array(z.string().min(1).max(2000)).max(10).default([])
});

export const PRIVATE_FILE_REASON = "your notes, reminders, watches and places are private and can't be attached";

/** The files she asked to attach: what can go, and why the rest can't (§16.3.2). */
async function attachments(ctx: ToolContext, requested: readonly string[]): Promise<{ files: OutgoingFile[]; skipped: string[] }> {
  const store = storeOf(ctx);
  const max = ctx.deps.config().life.send.maxFiles;
  const privateFiles = await store.privateFiles();
  const files: OutgoingFile[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const input of requested) {
    const target = await pathArg(store, input);
    if (!target.ok) {
      skipped.push(`${input} (${String(target.output.content).replace(/^error:\s*/u, "")})`);
      continue;
    }
    const p = target.path;
    // Names compare as the disk does (`~/memory.md` is `~/MEMORY.md`).
    const key = pathKey(p.virtual);
    if (seen.has(key)) continue;
    seen.add(key);
    if (privateFiles.has(key)) {
      skipped.push(`${p.display} (${PRIVATE_FILE_REASON})`);
      continue;
    }
    if (files.length >= max) {
      skipped.push(`${p.display} (${max === 0 ? "files can't be attached" : `at most ${max} file${max === 1 ? "" : "s"} per message`})`);
      continue;
    }
    const info = await store.files.inspect(p);
    if (info.kind === "missing") skipped.push(`${p.display} (it doesn't exist)`);
    else if (info.kind === "dir") skipped.push(`${p.display} (it is a folder)`);
    else if (info.kind !== "file") skipped.push(`${p.display} (it can't be used)`);
    else if (info.size > MAX_SEND_FILE_BYTES) skipped.push(`${p.display} (larger than ${MAX_SEND_FILE_BYTES / (1024 * 1024)} MB)`);
    else if (total + info.size > MAX_SEND_TOTAL_BYTES) skipped.push(`${p.display} (the files together would be over ${MAX_SEND_TOTAL_BYTES / (1024 * 1024)} MB, Discord's limit for one message)`);
    else {
      const data = await store.files.readBytes(p, { maxBytes: MAX_SEND_FILE_BYTES }).catch(() => undefined);
      if (!data) {
        skipped.push(`${p.display} (it can't be read)`);
        continue;
      }
      // A DM's download sent anywhere is about that DM (D14): the owner's views hide the call.
      await noteDmFile(store, p);
      total += data.length;
      files.push({ name: p.segments[p.segments.length - 1]!, data });
    }
  }
  return { files, skipped };
}

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

/** Discord's 40005 (request entity too large): the files are over the server's upload limit. */
function isTooLarge(error: unknown): boolean {
  const { code, status } = (error as { code?: unknown; status?: unknown } | null) ?? {};
  return code === 40005 || code === "40005" || status === 413;
}

export async function sendMessageTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(SendInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu, turn } = ctx;
  const args = parsed.value;
  const place = await resolvePlace(deps.storage, waifu.id, args.place);
  if (!place) return toolError(UNKNOWN_PLACE);
  // Without a bot of her own she cannot post at all (never through the House bot): she is told,
  // and so is the owner (review M12).
  if (!waifu.botId) {
    deps.notices?.set(`no-bot:${waifu.id}`, `${waifu.displayName} has no Discord bot of her own, so she cannot post; link one on the Cast page.`);
    return toolError(NO_BOT);
  }
  if (place.kind === "dm" ? !(await dmSendAllowed(deps, ctx, place)) : place.paused === true) return toolError(CANNOT_POST);
  const life = deps.config().life;
  const maxPlaces = life.maxSendPlacesPerTurn;
  if (!turn.sentPlaces.has(place.placeKey) && turn.sentPlaces.size >= maxPlaces) {
    return toolError(`you've already written in ${maxPlaces} places this turn`);
  }
  if ((turn.sends ?? 0) >= life.maxSendsPerTurn) return toolError(`you've already sent ${life.maxSendsPerTurn} messages this turn; wait for replies`);
  const text = stripCopiedHeader(args.text, [waifu.name, waifu.displayName]);
  if (text && isOnlyToolCallSyntax(text, ctx.toolNames)) return toolError("that looks like a tool call, not a message; write what you want to say");
  const attached = args.files.length > 0 ? await attachments(ctx, args.files) : { files: [], skipped: [] };
  if (!text && attached.files.length === 0) {
    return toolError(attached.skipped.length > 0 ? `nothing was sent: not attached: ${attached.skipped.join(", ")}` : "there is nothing to send");
  }
  let replyToId: string | undefined;
  if (args.reply_to) {
    replyToId = await messageIdForRef(deps, place, args.reply_to);
    if (!replyToId) return toolError(MESSAGE_TOO_OLD);
  }
  const discord = deps.discord();
  if (!discord) return toolError("you can't reach Discord right now");
  // Typing first, for as long as a person would take (§6.3).
  if (place.kind === "dm") await discord.sendDirectTyping?.({ waifuId: waifu.id, userId: place.userId! });
  else await discord.sendTyping({ guildId: place.guildId!, channelId: place.channelId!, senderBotId: waifu.botId });
  await deps.sleep(typingDelayMs(text), ctx.signal);
  if (ctx.signal.aborted) return toolError("interrupted before sending");
  // Just before the Discord call: a digest of the final content (mentions and emoji resolved) goes
  // into her intents, so boot repair recognises the message after a crash (§5.7, review I5).
  const onFinalContent = async (final: string) => {
    if (!ctx.intent) return;
    await appendIntent(deps.storage, waifu.id, { ...ctx.intent, at: deps.now().toISOString(), contentDigest: contentDigest(final) });
  };
  let messageId: string;
  try {
    if (place.kind === "dm") {
      messageId = (
        await discord.sendDirectMessage!({
          waifuId: waifu.id,
          userId: place.userId!,
          content: text,
          ...(replyToId ? { replyToMessageId: replyToId } : {}),
          ...(attached.files.length > 0 ? { files: attached.files } : {}),
          onFinalContent
        })
      ).messageId;
    } else {
      messageId = (
        await discord.sendWaifuMessage({
          guildId: place.guildId!,
          channelId: place.channelId!,
          content: text,
          senderBotId: waifu.botId,
          ...(replyToId ? { replyToMessageId: replyToId } : {}),
          allowedUserMentionIds: await presentPeople(deps, place),
          ...(attached.files.length > 0 ? { files: attached.files } : {}),
          onFinalContent
        })
      ).messageId;
    }
  } catch (error) {
    if (place.kind === "dm" && isUndeliverable(error)) {
      await updateExistingDmState(deps.storage, place.userId!, waifu.id, (state) => ({ ...state, undeliverableSince: deps.now().toISOString() })).catch(() => undefined);
      return toolError("they can't receive your messages right now");
    }
    if (attached.files.length > 0 && isTooLarge(error)) return toolError("the message could not be sent: the files are too large for Discord here; send fewer or smaller ones");
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
  turn.sends = (turn.sends ?? 0) + 1;
  deps.notices?.clear(`no-bot:${waifu.id}`);
  // The messages before hers without a ref get theirs first (the buffer and one page before it,
  // served from the buffer when the conversation is trusted), so her send never takes a ref ahead
  // of a message written before it (refs stay in message order, §4.7).
  const dmFloor = place.kind === "dm" ? await readDmFloor(deps.storage, place.userId!, waifu.id).catch(() => undefined) : undefined;
  const earlier = await deps.conversations.readPage({ conversation: place.ref, beforeId: messageId, limit: 50 }).catch(() => ({ messages: [] as RawDiscordMessage[] }));
  const before = [...deps.conversations.bufferedMessages(place.ref), ...earlier.messages]
    .filter((message) => compareIds(message.id, messageId) < 0 && aboveFloor(message.id, dmFloor))
    .map((message) => message.id);
  const refs = await assignConversationRefs(deps.storage, place.placeKey as never, [...before, messageId], now);
  await advanceReadCursor(deps.storage, waifu.id, place.placeKey, messageId, now);
  // A room's handle lets the dashboard name the place; a DM's handle would name the person.
  deps.logger.info("Life message sent", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, ...(place.placeKey.startsWith("dm_") ? {} : { place: place.handle }), messageId });
  const ref = refs.get(messageId);
  const sent = ref ? `sent #${ref}` : "sent";
  return { content: attached.skipped.length > 0 ? `${sent}; not attached: ${attached.skipped.join(", ")}` : sent, resultRef: messageId, messageIds: [messageId] };
}

function readMessagesDescription(retentionDays: number): string {
  return `Read the latest messages in one of your places (a room, thread or private chat). Lines look like \`[14:02 #k3] Kevin: text\`; \`#k3\` is the message's ref. Files people sent are saved in /tmp ${keptForText(retentionDays)} and shown by their path; open them with Read. Pass before with a ref to read older messages.`;
}

const SEND_DESCRIPTION =
  "Send a message to a place. This is the only way anyone sees what you write. Keep it like a chat message; send several if you have several things to say. Use <@Name> to mention someone who is there.";
const PRIVATE_ATTACH_TEXT = "MEMORY.md, the notes it links to, schedule.json, watches.json, places.md and profile.json can't be attached.";

/** SendMessage's input schema; `files` (at most `maxFiles`) only when attaching is on. */
function sendSchema(maxFiles: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      place: { type: "string", description: "A place handle." },
      text: { type: "string", maxLength: 2000, description: maxFiles > 0 ? "The message (may be empty when you attach a file)." : "The message." },
      reply_to: { type: "string", description: "Optional: the ref of the message you are replying to, like #k3." },
      ...(maxFiles > 0
        ? { files: { type: "array", items: { type: "string" }, maxItems: maxFiles, description: `Optional: paths of files to attach, like /tmp/cake-small.png (at most ${maxFiles}).` } }
        : {})
    },
    required: ["place"],
    additionalProperties: false
  };
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
  deps.logger.info("Life reaction added", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, ...(place.placeKey.startsWith("dm_") ? {} : { place: place.handle }), messageId });
  return { content: "reacted", resultRef: messageId };
}

export const messageTools: LifeTool[] = [
  {
    name: "ReadMessages",
    description:
      readMessagesDescription(7),
    describe: (config) => readMessagesDescription(config.life.tmp.retentionDays),
    inputSchema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A place handle from places.md, like bake-club/#general or dm/kevin." },
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
    name: "SendMessage",
    description:
      `${SEND_DESCRIPTION} You can attach files from your folders; ${PRIVATE_ATTACH_TEXT}`,
    describe: (config) => (config.life.send.maxFiles > 0 ? `${SEND_DESCRIPTION} You can attach files from your folders; ${PRIVATE_ATTACH_TEXT}` : SEND_DESCRIPTION),
    schemaFor: (config) => sendSchema(config.life.send.maxFiles),
    inputSchema: sendSchema(4),
    sideEffect: true,
    run: sendMessageTool
  },
  {
    name: "React",
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
