// Discord message → frozen ledger body (spec 8.3, rendering table in 9.5). Runs once per message
// when it enters the conversation ledger; the result (incl. author and mention names) is frozen,
// so renames and relative time styles never rewrite a cached prefix.

import { attachmentKey, mimeFromFilename, normalizeImageMime } from "../../discord/attachments.js";
import type { ImageRef, RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import { formatDiscordTimestamp } from "./timeFormat.js";
import type { GuildDirectoryView, MessageRenderer } from "./types.js";

type RawAttachment = RawDiscordMessage["attachments"][number];
type RawEmbed = RawDiscordMessage["embeds"][number];

// Discord message types (https://discord.com/developers/docs/resources/message#message-object-message-types).
export const DISCORD_MESSAGE_TYPE = {
  default: 0,
  channelPinnedMessage: 6,
  userJoin: 7,
  threadCreated: 18,
  reply: 19,
  chatInputCommand: 20,
  threadStarterMessage: 21,
  contextMenuCommand: 23,
  pollResult: 46
} as const;

const EMBED_DESCRIPTION_MAX = 200;
const FORWARD_CONTENT_MAX = 500;
const GIF_PROVIDERS = /^(tenor|giphy)$/i;

export const EMPTY_GUILD_DIRECTORY: GuildDirectoryView = {
  memberName: () => undefined,
  roleName: () => undefined,
  channelName: () => undefined,
  emoji: () => undefined
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** "1.2 MB" / "340 KB" / "12 B". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "0:12" / "3:05". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Inline Discord tokens → model text: mentions, roles, channels, commands, emojis, timestamps. */
export function renderDiscordTokens(
  content: string,
  m: Pick<RawDiscordMessage, "mentions">,
  dir: GuildDirectoryView,
  tz: string
): string {
  return content
    .replace(/<@!?(\d+)>/g, (_raw, id: string) => {
      const name = m.mentions.users[id] ?? dir.memberName(id);
      // `<@Name>` is the model-facing mention form the send path turns back into a ping.
      return name ? `<@${name}>` : "@unknown-user";
    })
    .replace(/<@&(\d+)>/g, (_raw, id: string) => {
      const name = m.mentions.roles[id] ?? dir.roleName(id);
      return name ? `@${name}` : "@unknown-role";
    })
    .replace(/<#(\d+)>/g, (_raw, id: string) => {
      const name = m.mentions.channels[id] ?? dir.channelName(id);
      return name ? `#${name}` : "#unknown-channel";
    })
    .replace(/<\/([^:<>]+):\d+>/g, (_raw, command: string) => `/${command}`)
    .replace(/<(a?):([A-Za-z0-9_]+):(\d+)>/g, (_raw, animated: string, name: string, id: string) => {
      const known = dir.emoji(id);
      return known ? `<${animated}:${known}:>` : `:${name}:`;
    })
    .replace(/<t:(-?\d+)(?::([tTdDfFR]))?>/g, (_raw, unix: string, style: string | undefined) =>
      formatDiscordTimestamp(Number(unix), style, tz)
    );
}

function isImageAttachment(a: RawAttachment): boolean {
  const mime = normalizeImageMime(a.contentType);
  if (mime) return mime.startsWith("image/");
  return mimeFromFilename(a.filename) !== undefined;
}

function imageRef(a: RawAttachment, conversationKey: string | undefined): ImageRef {
  return {
    ...(conversationKey ? { conversationKey } : {}),
    key: attachmentKey(a.url, a.id),
    attachmentId: a.id,
    url: a.url,
    filename: a.filename,
    ...(a.contentType ? { contentType: a.contentType } : {}),
    bytes: a.size,
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {})
  };
}

/** Non-image attachment line: `[file: name.pdf · 1.2 MB]` · `[video: name]` · `[voice message · 0:12]`. */
export function renderAttachmentLine(a: RawAttachment): string {
  if (a.isVoice) return a.durationSecs !== undefined ? `[voice message · ${formatDuration(a.durationSecs)}]` : "[voice message]";
  const mime = normalizeImageMime(a.contentType) ?? "";
  if (mime.startsWith("video/")) return `[video: ${a.filename}]`;
  return `[file: ${a.filename} · ${formatBytes(a.size)}]`;
}

/** Embed line: `[link: <title> — <description≤200> (<provider/host>)]`; GIF/tenor → `[gif: <title or host>]`. */
export function renderEmbedLine(e: RawEmbed): string | undefined {
  const host = hostOf(e.url) ?? hostOf(e.thumbnailUrl);
  const source = e.providerName?.trim() || host;
  const title = e.title?.trim();
  if (e.type === "gifv" || (e.providerName && GIF_PROVIDERS.test(e.providerName.trim()))) {
    return `[gif: ${title || source || "gif"}]`;
  }
  const description = e.description ? clip(e.description, EMBED_DESCRIPTION_MAX) : "";
  const head = title || (description ? "" : source || e.url || "");
  if (!head && !description) return undefined;
  const text = [head, description].filter(Boolean).join(" — ");
  return source && source !== head ? `[link: ${text} (${source})]` : `[link: ${text}]`;
}

/** `[poll: "<q>" — A / B / C]`. */
export function renderPollLine(poll: NonNullable<RawDiscordMessage["poll"]>): string {
  const answers = poll.answers.map((a) => a.trim()).filter(Boolean);
  return answers.length ? `[poll: "${poll.question}" — ${answers.join(" / ")}]` : `[poll: "${poll.question}"]`;
}

function renderSystem(m: RawDiscordMessage): string | null {
  switch (m.type) {
    case DISCORD_MESSAGE_TYPE.userJoin:
      return "[joined the server]";
    case DISCORD_MESSAGE_TYPE.channelPinnedMessage:
      return "[pinned a message]";
    case DISCORD_MESSAGE_TYPE.threadCreated:
      return m.content.trim() ? `[started a thread: ${m.content.trim()}]` : "[started a thread]";
    case DISCORD_MESSAGE_TYPE.pollResult: {
      const winner = m.poll?.answers[0];
      if (!m.poll) return "[poll ended]";
      return winner ? `[poll ended: "${m.poll.question}" — winner: ${winner}]` : `[poll ended: "${m.poll.question}"]`;
    }
    default:
      return null;
  }
}

/**
 * The full Phase 4 renderer (spec 9.5 table). Pure and deterministic. `o.conversationKey` tags the
 * image refs with their conversation, so caching them adds them to its durable image index.
 */
export function renderDiscordMessage(
  m: RawDiscordMessage,
  dir: GuildDirectoryView,
  tz: string,
  o: { conversationKey?: string } = {}
): { body: string; images: ImageRef[]; kind: "default" | "system" } | null {
  const conversational =
    m.type === DISCORD_MESSAGE_TYPE.default ||
    m.type === DISCORD_MESSAGE_TYPE.reply ||
    m.type === DISCORD_MESSAGE_TYPE.threadStarterMessage;
  const command = m.type === DISCORD_MESSAGE_TYPE.chatInputCommand || m.type === DISCORD_MESSAGE_TYPE.contextMenuCommand;
  if (!conversational && !command) {
    const body = renderSystem(m);
    return body === null ? null : { body, images: [], kind: "system" };
  }

  const lines: string[] = [];
  if (command) lines.push(m.commandName ? `[used /${m.commandName}]` : "[used a command]");
  const content = renderDiscordTokens(m.content, m, dir, tz).trim();
  if (content) lines.push(content);
  const images: ImageRef[] = [];
  for (const attachment of m.attachments) {
    if (isImageAttachment(attachment)) images.push(imageRef(attachment, o.conversationKey));
    else lines.push(renderAttachmentLine(attachment));
  }
  for (const embed of m.embeds) {
    const line = renderEmbedLine(embed);
    if (line) lines.push(line);
  }
  for (const sticker of m.stickers) lines.push(`[sticker: ${sticker.name}]`);
  if (m.poll) lines.push(renderPollLine(m.poll));
  for (const snapshot of m.snapshots) {
    const forwarded = clip(renderDiscordTokens(snapshot.content, m, dir, tz), FORWARD_CONTENT_MAX);
    lines.push(forwarded ? `[forwarded] ${forwarded}` : "[forwarded]");
    for (const attachment of snapshot.attachments) {
      if (isImageAttachment(attachment)) images.push(imageRef(attachment, o.conversationKey));
      else lines.push(renderAttachmentLine(attachment));
    }
  }
  return { body: lines.join("\n"), images, kind: command ? "system" : "default" };
}

export const discordMessageRenderer: MessageRenderer = { render: renderDiscordMessage };
