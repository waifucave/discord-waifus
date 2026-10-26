// `/transcripts` as she sees it (Living cast spec §18.3): a read-only folder beside her home and
// `/tmp`, one file per conversation per day, rendered from the store when it is read:
//
//   /transcripts/<server>/<room>/<YYYY-MM-DD>.md            (a room)
//   /transcripts/<server>/<room>/<thread>/<YYYY-MM-DD>.md   (a thread)
//   /transcripts/dm/<name>/<YYYY-MM-DD>.md                  (her private chats)
//
// The folders follow her place handles (`bake-club/#general` → `bake-club/general`). She sees a
// room's days only inside her access intervals, and only the lines written while she was cast
// there; her own DMs whole; nobody else's DMs ever. A line is `HH:MM Name ↩#ref: text [file: a.png]`
// (`(edited)` when edited, her own lines as `you`); she never sees an id. Nothing here writes.

import type { StorageService } from "../../storage/storageService.js";
import { readConversationRefs } from "../../discord/refStore.js";
import { parseConversationKey, type ConversationKey } from "../../orchestration/context/keys.js";
import { clockText, localParts } from "../clock.js";
import { readLifeFile } from "../lifeStore.js";
import { slugify } from "../places.js";
import { ServerConfigSchema } from "../../shared/schemas/domain.js";
import { withThreadChannels } from "../../orchestration/stores/threads.js";
import path from "node:path";
import {
  dayInsideIntervals,
  insideIntervals,
  listTranscriptConversations,
  listTranscriptDays,
  readTranscriptAccess,
  readTranscriptDay,
  transcriptDayStat,
  type TranscriptInterval,
  type TranscriptLine
} from "./store.js";

export const TRANSCRIPTS_ROOT = "/transcripts";
export const TRANSCRIPTS_READ_ONLY = "transcripts are read-only";

/** One conversation she can read, and where it is in `/transcripts`. */
export type TranscriptFolder = {
  key: string;
  segments: string[];
  dm: boolean;
  /** Rooms: her access intervals (a DM is hers whole). */
  intervals?: TranscriptInterval[];
  /** Her handle for it (`bake-club/#general`, `dm/kevin`). */
  handle: string;
};

export type TranscriptEntry = { name: string; kind: "file" | "dir"; size: number; mtimeMs: number };

export type TranscriptViewOptions = { storage: StorageService; waifuId: string; timeZone: string; now: () => Date };

const DAY_NAME = /^(\d{4}-\d{2}-\d{2})\.md$/u;

/** `bake-club/#general/plans` → `["bake-club", "general", "plans"]`. */
export function handleSegments(handle: string): string[] {
  return handle
    .split("/")
    .map((segment) => segment.replace(/^#/u, ""))
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function tail(id: string): string {
  return id.slice(-4) || "x";
}

/** A handle for a conversation she has none for (from the server's names, else ids' tails). */
async function fallbackHandle(storage: StorageService, key: string): Promise<string> {
  const ref = parseConversationKey(key);
  if (!ref) return `unknown/${key}`;
  if (ref.kind === "dm") return `dm/user-${tail(ref.userId)}`;
  const server = await storage.readJson(path.join("user", "servers", ref.guildId, "server.json"), ServerConfigSchema).catch(() => undefined);
  const withThreads = server ? await withThreadChannels(storage, server).catch(() => server) : undefined;
  const serverSlug = slugify(server?.name) || `server-${tail(ref.guildId)}`;
  const channel = withThreads?.channels[ref.channelId];
  if (channel?.thread) {
    const parent = slugify(withThreads?.channels[channel.thread.parentId]?.name) || "channel";
    return `${serverSlug}/#${parent}/${slugify(channel.name) || `thread-${tail(ref.channelId)}`}`;
  }
  return `${serverSlug}/#${slugify(channel?.name) || `channel-${tail(ref.channelId)}`}`;
}

/** Every conversation she can read: rooms she was ever cast in (with a transcript), and her own DMs. */
export async function transcriptFolders(o: Pick<TranscriptViewOptions, "storage" | "waifuId">): Promise<TranscriptFolder[]> {
  const dataRoot = o.storage.dataRoot;
  const access = await readTranscriptAccess(dataRoot, o.waifuId);
  const handles = await readLifeFile(o.storage, o.waifuId, "handles").catch(() => ({ handles: {}, primary: {} as Record<string, string> }));
  const keys = new Set(await listTranscriptConversations(dataRoot));
  const folders: TranscriptFolder[] = [];
  const taken = new Set<string>();
  const add = async (key: string, dm: boolean, intervals?: TranscriptInterval[]) => {
    const handle = handles.primary[key] ?? (await fallbackHandle(o.storage, key));
    const segments = handleSegments(handle);
    if (segments.length === 0) return;
    // Two conversations on one path (a server called "dm"): the first keeps it, the next gets a suffix.
    let unique = segments;
    for (let n = 2; taken.has(unique.join("/")); n += 1) unique = [...segments.slice(0, -1), `${segments[segments.length - 1]}-${n}`];
    taken.add(unique.join("/"));
    folders.push({ key, segments: unique, dm, handle, ...(intervals ? { intervals } : {}) });
  };
  for (const key of [...keys].sort()) {
    const ref = parseConversationKey(key);
    if (!ref) continue;
    if (ref.kind === "dm") {
      if (ref.waifuId === o.waifuId && (await listTranscriptDays(dataRoot, key)).length > 0) await add(key, true);
      continue;
    }
    const intervals = access.conversations[key];
    if (intervals && intervals.length > 0) await add(key, false, intervals);
  }
  return folders;
}

/** `Sat 24 Oct 2026`. */
function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const noon = new Date(Date.UTC(year!, month! - 1, date!, 12));
  const parts = localParts(noon, "UTC");
  const monthName = noon.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${parts.weekday} ${date} ${monthName} ${year}`;
}

/** One day file as she reads it. */
export function renderTranscriptDay(o: {
  handle: string;
  day: string;
  lines: readonly TranscriptLine[];
  waifuId: string;
  timeZone: string;
  refs: ReadonlyMap<string, string>;
}): string {
  const byId = new Map(o.lines.map((line) => [line.id, line] as const));
  const out = [`# ${o.handle} · ${dayLabel(o.day)}`];
  for (const line of o.lines) {
    const name = line.waifu === o.waifuId ? "you" : line.author || "someone";
    let reply = "";
    if (line.reply) {
      const ref = o.refs.get(line.reply);
      const target = byId.get(line.reply);
      reply = ref ? ` ↩#${ref}` : target ? ` ↩${target.waifu === o.waifuId ? "you" : target.author}` : " ↩";
    }
    const files = (line.files ?? []).map((file) => `[file: ${file}]`).join(" ");
    const body = [line.text.replace(/\r\n/gu, "\n").split("\n").join("\n  "), files].filter((part) => part.length > 0).join(" ");
    out.push(`${clockText(new Date(line.at), o.timeZone)} ${name}${reply}:${body ? ` ${body}` : ""}${line.edited ? " (edited)" : ""}`);
  }
  if (o.lines.length === 0) out.push("(nothing was said here while you were in this room)");
  return `${out.join("\n")}\n`;
}

/**
 * Her `/transcripts` for one call (a Read, a Bash run, an API request): the folder list is read once,
 * day files are rendered when asked for (and a few kept for a stat followed by a read).
 */
export class TranscriptView {
  private folders: Promise<TranscriptFolder[]> | undefined;
  private readonly rendered = new Map<string, Promise<{ text: string; mtimeMs: number } | undefined>>();
  private readonly refs = new Map<string, Promise<Map<string, string>>>();
  private static readonly KEEP = 16;

  constructor(private readonly o: TranscriptViewOptions) {}

  get waifuId(): string {
    return this.o.waifuId;
  }

  list(): Promise<TranscriptFolder[]> {
    this.folders ??= transcriptFolders(this.o);
    return this.folders;
  }

  /** The conversation whose folder is exactly `segments`. */
  async folderAt(segments: readonly string[]): Promise<TranscriptFolder | undefined> {
    const joined = segments.join("/");
    return (await this.list()).find((folder) => folder.segments.join("/") === joined);
  }

  /** The days she may see in a conversation, oldest first. */
  async days(folder: TranscriptFolder): Promise<string[]> {
    const days = await listTranscriptDays(this.o.storage.dataRoot, folder.key);
    if (folder.dm || !folder.intervals) return days;
    return days.filter((day) => dayInsideIntervals(folder.intervals!, day, this.o.timeZone, this.o.now()));
  }

  /** What a path under /transcripts is (`segments` below it; empty = the folder itself). */
  async stat(segments: readonly string[]): Promise<{ kind: "file" | "dir"; size: number; mtimeMs: number } | undefined> {
    if (segments.length === 0) return { kind: "dir", size: 0, mtimeMs: 0 };
    const file = await this.file(segments);
    if (file) {
      const rendered = await this.render(file.folder, file.day);
      return rendered ? { kind: "file", size: Buffer.byteLength(rendered.text), mtimeMs: rendered.mtimeMs } : undefined;
    }
    const prefix = segments.join("/");
    const isDir = (await this.list()).some((folder) => folder.segments.join("/") === prefix || folder.segments.join("/").startsWith(`${prefix}/`));
    return isDir ? { kind: "dir", size: 0, mtimeMs: 0 } : undefined;
  }

  /**
   * A folder's entries (undefined when it is not a folder). A day reports its stored size (no day
   * is rendered to list a folder); `stat` and `read` give the rendered one.
   */
  async readdir(segments: readonly string[]): Promise<TranscriptEntry[] | undefined> {
    const prefix = segments.join("/");
    const folders = await this.list();
    const dirs = new Set<string>();
    let found = segments.length === 0;
    const entries: TranscriptEntry[] = [];
    for (const folder of folders) {
      const joined = folder.segments.join("/");
      if (joined === prefix) {
        found = true;
        for (const day of await this.days(folder)) {
          const name = `${day}.md`;
          const info = await transcriptDayStat(this.o.storage.dataRoot, folder.key, day);
          entries.push({ name, kind: "file", size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 });
        }
        continue;
      }
      if (segments.length === 0 || joined.startsWith(`${prefix}/`)) {
        found = true;
        const next = folder.segments[segments.length];
        if (next !== undefined) dirs.add(next);
      }
    }
    if (!found) return undefined;
    for (const name of [...dirs].sort()) if (!entries.some((entry) => entry.name === name)) entries.push({ name, kind: "dir", size: 0, mtimeMs: 0 });
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A day file's text (undefined when there is no such file for her). */
  async read(segments: readonly string[]): Promise<string | undefined> {
    const file = await this.file(segments);
    if (!file) return undefined;
    return (await this.render(file.folder, file.day))?.text;
  }

  /** The conversation a path is in (a folder or a day file below it), if any. */
  async conversationOf(segments: readonly string[]): Promise<TranscriptFolder | undefined> {
    const folders = await this.list();
    let best: TranscriptFolder | undefined;
    for (const folder of folders) {
      const n = folder.segments.length;
      if (segments.length >= n && folder.segments.every((segment, index) => segments[index] === segment) && (!best || n > best.segments.length)) best = folder;
    }
    return best;
  }

  /** True when the path is a private chat's (or the `dm` folder itself): D14. */
  async isPrivate(segments: readonly string[]): Promise<boolean> {
    if (segments.length === 0) return false;
    const conversation = await this.conversationOf(segments);
    if (conversation) return conversation.dm;
    // `/transcripts/dm` lists the people she has private chats with.
    return (await this.list()).some((folder) => folder.dm && segments.every((segment, index) => folder.segments[index] === segment));
  }

  private async file(segments: readonly string[]): Promise<{ folder: TranscriptFolder; day: string } | undefined> {
    if (segments.length < 2) return undefined;
    const match = DAY_NAME.exec(segments[segments.length - 1]!);
    if (!match) return undefined;
    const folder = await this.folderAt(segments.slice(0, -1));
    if (!folder) return undefined;
    const day = match[1]!;
    return (await this.days(folder)).includes(day) ? { folder, day } : undefined;
  }

  /** A conversation's refs, read once per view. */
  private refsOf(key: string): Promise<Map<string, string>> {
    let refs = this.refs.get(key);
    if (!refs) {
      refs = readConversationRefs(this.o.storage, key as ConversationKey).then(
        (file) => new Map(Object.entries(file.refs)),
        () => new Map<string, string>()
      );
      this.refs.set(key, refs);
    }
    return refs;
  }

  private render(folder: TranscriptFolder, day: string): Promise<{ text: string; mtimeMs: number } | undefined> {
    const id = `${folder.key}/${day}`;
    let cached = this.rendered.get(id);
    if (!cached) {
      cached = this.renderNow(folder, day);
      this.rendered.set(id, cached);
      if (this.rendered.size > TranscriptView.KEEP) this.rendered.delete(this.rendered.keys().next().value as string);
    }
    return cached;
  }

  private async renderNow(folder: TranscriptFolder, day: string): Promise<{ text: string; mtimeMs: number } | undefined> {
    const dataRoot = this.o.storage.dataRoot;
    const info = await transcriptDayStat(dataRoot, folder.key, day);
    if (!info) return undefined;
    const all = await readTranscriptDay(dataRoot, folder.key, day);
    const lines = folder.dm || !folder.intervals ? all : all.filter((line) => insideIntervals(folder.intervals!, line.at));
    const refs = await this.refsOf(folder.key);
    return { text: renderTranscriptDay({ handle: folder.handle, day, lines, waifuId: this.o.waifuId, timeZone: this.o.timeZone, refs }), mtimeMs: info.mtimeMs };
  }
}

/**
 * A path she wrote → the segments below `/transcripts` (empty for the folder itself), or undefined
 * when the path is not in `/transcripts`. `~` and relative paths start at her home.
 */
export function transcriptsSegments(input: string, slug: string): string[] | undefined {
  const raw = input.trim();
  if (!raw || raw.includes("\0")) return undefined;
  const absolute = raw === "~" ? `/home/${slug}` : raw.startsWith("~/") ? `/home/${slug}/${raw.slice(2)}` : raw.startsWith("/") ? raw : `/home/${slug}/${raw}`;
  const normalized = path.posix.normalize(absolute).replace(/\/+$/u, "") || "/";
  if (normalized !== TRANSCRIPTS_ROOT && !normalized.startsWith(`${TRANSCRIPTS_ROOT}/`)) return undefined;
  return normalized.slice(TRANSCRIPTS_ROOT.length).split("/").filter(Boolean);
}

/** `/transcripts/bake-club/general/2026-10-24.md`. */
export function transcriptsVirtual(segments: readonly string[]): string {
  return segments.length === 0 ? TRANSCRIPTS_ROOT : `${TRANSCRIPTS_ROOT}/${segments.join("/")}`;
}
