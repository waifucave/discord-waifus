// `ReadMessages`, `SendMessage`, `React` (Living cast spec §6.2–§6.4, §16.3.1, §16.3.2, D11).
//
// ReadMessages downloads attachments (images, PDFs, text files) into her `/tmp`, under the place's
// handle (`/tmp/bake-club/general/k3-cake.png`, `/tmp/dm/kevin/a7-menu.pdf`), and shows the path
// instead of the image; she looks with Read. SendMessage can attach files from her folders, except
// her private ones (MEMORY.md and the notes it links, her reminders, watches and places).

import { createHash } from "node:crypto";
import { z } from "zod";
import { assignConversationRefs, normalizeRef, readConversationRefs, resolveConversationRef, shiftId, snowflakeAt, snowflakeTime } from "../../discord/refStore.js";
import { compareIds } from "../../discord/rawMessage.js";
import { EMPTY_GUILD_DIRECTORY, formatBytes, imageRef, isImageAttachment, renderDiscordMessage, type RawAttachment } from "../../orchestration/context/messageRender.js";
import type { GuildDirectoryView } from "../../orchestration/context/types.js";
import { assessDmLimit } from "../../orchestration/dm/rateLimit.js";
import { readDmFloor, readDmLimitIfExists, readDmState, updateDmLimit, updateExistingDmState, aboveFloor } from "../../orchestration/dm/dmStore.js";
import { readActiveChatParticipants } from "../../orchestration/stores/participants.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { OutgoingFile } from "../../discord/client.js";
import { clockText, dayText, localDayKey } from "../clock.js";
import { keptForText } from "../lifeHarness.js";
import { sha256 } from "../home/homeStore.js";
import { isLifeDirPath, pathKey, safeFileName, type HerPath } from "../home/pathRules.js";
import { advanceReadCursor, appendIntent, updateLifeState } from "../lifeStore.js";
import { isOnlyToolCallSyntax, stripCopiedHeader, typingDelayMs } from "../outbound.js";
import { forgottenPeople, isRemovedMessage } from "../people.js";
import { placeLabel, placesWithHandles, resolvePlace, type ResolvedPlace } from "../places.js";
import { notePlace } from "../placeRecorder.js";
import { entryHeader, entryLine, type LineMessage, type LineView } from "../render.js";
import {
  atOrBelowFloor,
  compareLines,
  dayInsideIntervals,
  findTranscriptRef,
  insideIntervals,
  listTranscriptDays,
  newestTranscriptLine,
  readTranscriptDayLite,
  readTranscriptsStartedAt,
  transcriptRefsOf,
  type TranscriptLine
} from "../transcripts/store.js";
import { forgottenLine } from "../transcripts/forget.js";
import { transcriptChatLine, transcriptFolders, type TranscriptFolder } from "../transcripts/view.js";
import { transcriptText } from "../transcripts/writer.js";
import { DEFAULT_MAX, DEFAULT_RANGE_MAX, fold, matchesSearch, MAX_MESSAGES, parseAnchor, parseReadQuery, QUERY_SYNTAX, type ReadQuery } from "./readQuery.js";
import type { LifeDeps } from "../deps.js";
import { noteDmFile, pathArg, storeOf } from "./files.js";
import { transcriptsSegments } from "../transcripts/view.js";
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

/**
 * The message a ref names in a place: from `refs.json`, else (§22.1: a ref pruned there) from the
 * transcript line that carries it.
 */
async function messageIdForRef(deps: LifeDeps, place: ResolvedPlace, ref: string): Promise<string | undefined> {
  const known = await resolveConversationRef(deps.storage, place.placeKey as never, ref);
  if (known) return known;
  const normalized = normalizeRef(ref);
  if (!normalized) return undefined;
  // Never a line a forget covers or one at or below a DM floor, even before the forget job's part ran.
  let forgotten: Awaited<ReturnType<typeof forgottenPeople>>;
  try {
    forgotten = await forgottenPeople(deps.storage);
  } catch {
    return undefined;
  }
  const floor = place.kind === "dm" && place.userId && place.ref.kind === "dm" ? await readDmFloor(deps.storage, place.userId, place.ref.waifuId).catch(() => "unreadable" as const) : undefined;
  if (floor === "unreadable") return undefined;
  const line = await findTranscriptRef(deps.storage.dataRoot, place.placeKey, normalized, (candidate) => !forgottenLine(candidate, forgotten) && !atOrBelowFloor(candidate, floor)).catch(() => undefined);
  return line?.id;
}

// ---- ReadMessages (§6.2, §22.2) ------------------------------------------------------------------

const ReadInput = z.object({
  place: z.string().min(1),
  query: z.string().max(2000).optional(),
  // Before §22 the tool took these; an old habit still reads (as `max:` and `before #ref`).
  limit: z.number().int().min(1).max(100).optional(),
  before: z.string().min(1).optional()
});

/** At most this many places in one call (or `everywhere` with people: or search:). */
export const MAX_READ_PLACES = 5;
/**
 * A search reads at most `days` days of one place and `bytes` of transcript text in one call (all
 * places together). Mutable for tests only.
 */
export const SEARCH_LIMITS = { days: 400, bytes: 32 * 1024 * 1024 };
/** At most this many message ids one call adds to what she has read. */
export const MAX_READ_IDS_PER_CALL = 200;
const EVERYWHERE = "everywhere";
const CANT_READ = "error: messages can't be read right now";

function reactionLine(deps: LifeDeps, place: ResolvedPlace, messageId: string): string | undefined {
  const reactions = deps.conversations.reactionsFor(place.ref, messageId);
  if (reactions.length === 0) return undefined;
  return `  reactions: ${reactions.map((reaction) => (reaction.count > 1 ? `${reaction.emoji} ${reaction.count}` : reaction.emoji)).join(" · ")}`;
}

/** Lines with their time: a `— Sat 24 Oct —` line starts each day when the page is not all today. */
function withDayLines(entries: ReadonlyArray<{ at: string; lines: string[] }>, now: Date, timeZone: string): string[] {
  const today = localDayKey(now, timeZone);
  const days = entries.map((entry) => localDayKey(new Date(entry.at), timeZone));
  const allToday = days.every((day) => day === today);
  const out: string[] = [];
  let previous: string | undefined;
  entries.forEach((entry, index) => {
    const day = days[index]!;
    if (!allToday && day !== previous) out.push(`— ${dayText(new Date(entry.at), timeZone)} —`);
    previous = day;
    out.push(...entry.lines);
  });
  return out;
}

/**
 * `#k3`, or (a message without a ref) a local time for a hint. `before` leaves its whole minute out,
 * so a before-hint names the next minute (`before 2026-10-20 17:03` for a 17:02 message: nothing older
 * is skipped); `after` includes its minute.
 */
function anchorText(ref: string | undefined, at: string, timeZone: string, side: "before" | "after"): string {
  if (ref) return `#${ref}`;
  const when = new Date(Math.floor(Date.parse(at) / 60_000) * 60_000 + (side === "before" ? 60_000 : 0));
  return `${localDayKey(when, timeZone)} ${clockText(when, timeZone)}`;
}

type Section = { text: string; ids: string[] } | { error: string };

function hasRefAnchor(query: ReadQuery): boolean {
  return [query.before, query.after, query.around].some((anchor) => anchor?.kind === "ref");
}

/**
 * Reads one or more places (§22.2). Without people: or search:, each place is a page of its
 * conversation (the latest, or before / after / around an anchor, or a range); with them, its
 * transcript (her access intervals apply) plus what the cache holds that is not written yet.
 */
export async function readMessagesTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(ReadInput, input);
  if (!parsed.ok) return parsed.output;
  const { deps, waifu } = ctx;
  const args = parsed.value;
  const now = deps.now();
  const read = parseReadQuery(args.query?.trim() ?? "", { now, timeZone: deps.timeZone });
  if (!read.ok) return toolError(read.error);
  const query: ReadQuery = { ...read.query };
  // The old fields count only where the query does not say otherwise.
  if (args.limit !== undefined && query.max === undefined) query.max = args.limit;
  if (args.before !== undefined && query.before === undefined && query.around === undefined) {
    const anchor = parseAnchor(`#${args.before.trim().replace(/^#/u, "")}`, { now, timeZone: deps.timeZone });
    if (!anchor) return toolError(MESSAGE_TOO_OLD);
    query.before = anchor;
  }
  const filtered = query.people !== undefined || query.search !== undefined;
  const wanted = args.place.trim();
  let places: ResolvedPlace[];
  const everywhere = wanted.toLowerCase() === EVERYWHERE;
  if (everywhere) {
    if (!filtered) return toolError(`error: "everywhere" needs people: or search: in the query\n${QUERY_SYNTAX}`);
    places = await placesWithHandles(deps.storage, waifu.id);
  } else {
    const handles = wanted.split(",").map((handle) => handle.trim()).filter((handle) => handle.length > 0);
    if (handles.length > MAX_READ_PLACES) return toolError(`error: at most ${MAX_READ_PLACES} places at once (or "everywhere" with people: or search:)`);
    places = [];
    for (const handle of handles) {
      const place = await resolvePlace(deps.storage, waifu.id, handle);
      if (!place) return toolError(UNKNOWN_PLACE);
      if (!places.some((known) => known.placeKey === place.placeKey)) places.push(place);
    }
    if (places.length === 0) return toolError(UNKNOWN_PLACE);
  }
  if (places.length > 1 && hasRefAnchor(query)) return toolError("error: a #ref belongs to one place; read one place with it");
  let forgotten: Awaited<ReturnType<typeof forgottenPeople>>;
  try {
    forgotten = await forgottenPeople(deps.storage);
  } catch {
    return toolError(CANT_READ);
  }
  const search = filtered ? await SearchScope.open(ctx, forgotten) : undefined;
  const sections: string[] = [];
  const ids: string[] = [];
  for (const place of places) {
    const section = search ? await search.place(place, query, { quiet: everywhere }) : await pagePlace(ctx, place, query, forgotten);
    if (!section) continue;
    if ("error" in section) return toolError(section.error);
    // D14: a place whose messages are in the result is a place this call touched.
    notePlace(place.placeKey);
    sections.push(section.text);
    ids.push(...section.ids);
  }
  if (sections.length === 0) sections.push(search ? search.nothing(query) : "(no messages)");
  // With `everywhere` a place with no match has no section: one line names the places the size
  // limit cut (named places say it in their own section).
  const cut = everywhere ? search?.cutLine() : undefined;
  if (cut) sections.push(cut);
  if (ids.length > 0) {
    const added = ids.slice(-MAX_READ_IDS_PER_CALL);
    await updateLifeState(deps.storage, waifu.id, (current) => ({ ...current, readMessageIds: [...new Set([...current.readMessageIds, ...added])] }));
  }
  return { content: sections.join("\n\n"), messageIds: ids };
}

/** A forgotten DM's floor (§7.5), read on the read path itself (after a restart the cache may not know it yet). */
async function floorOf(deps: LifeDeps, waifuId: string, place: ResolvedPlace): Promise<string | undefined | "unreadable"> {
  if (place.kind !== "dm" || !place.userId) return undefined;
  try {
    return await readDmFloor(deps.storage, place.userId, waifuId);
  } catch {
    return "unreadable";
  }
}

/**
 * Refs for messages of a page (§22.1): `refs.json` first, then the ref stored on a message's
 * transcript line (one `refs.json` pruned), and only then a new one (never for a message whose line
 * has one, and never for one past the age limit).
 */
async function refsForMessages(deps: LifeDeps, place: ResolvedPlace, messages: ReadonlyArray<{ id: string; at: string }>, now: Date): Promise<Map<string, string>> {
  const key = place.placeKey;
  const current = await readConversationRefs(deps.storage, key as never);
  const missing = messages.filter((message) => current.refs[message.id] === undefined);
  const stored = await transcriptRefsOf({ dataRoot: deps.storage.dataRoot, timeZone: deps.timeZone }, key, missing).catch(() => new Map<string, string>());
  const assign = missing.filter((message) => !stored.has(message.id)).map((message) => message.id);
  const assigned = assign.length > 0 ? await assignConversationRefs(deps.storage, key as never, assign, now) : new Map(Object.entries(current.refs));
  return new Map([...assigned, ...stored]);
}

/** One page of a place's conversation (§22.2 unfiltered): the latest, before / after / around, or a range. */
async function pagePlace(ctx: ToolContext, place: ResolvedPlace, query: ReadQuery, forgotten: Awaited<ReturnType<typeof forgottenPeople>>): Promise<Section> {
  const { deps } = ctx;
  const floor = await floorOf(deps, ctx.waifu.id, place);
  if (floor === "unreadable") return { error: CANT_READ };
  const dmFloor = floor;
  // Anchors → message ids. A #ref is included (`before #c1` reads #c1 and what is before it).
  const refId = async (ref: string) => messageIdForRef(deps, place, ref);
  let beforeId: string | undefined;
  let afterId: string | undefined;
  let aroundId: string | undefined;
  const range = (query.before !== undefined && query.after !== undefined) || query.around?.kind === "day";
  if (query.around?.kind === "day") {
    afterId = shiftId(snowflakeAt(query.around.start.getTime()), -1);
    beforeId = snowflakeAt(query.around.end.getTime());
  } else if (query.around) {
    aroundId = query.around.kind === "ref" ? await refId(query.around.ref) : snowflakeAt(query.around.at.getTime());
    if (!aroundId) return { error: MESSAGE_TOO_OLD };
  }
  if (query.before) {
    const anchor = query.before;
    const id = anchor.kind === "ref" ? await refId(anchor.ref) : undefined;
    if (anchor.kind === "ref" && !id) return { error: MESSAGE_TOO_OLD };
    beforeId = anchor.kind === "ref" ? shiftId(id!, 1) : snowflakeAt(anchor.kind === "time" ? anchor.at.getTime() : anchor.start.getTime());
  }
  if (query.after) {
    const anchor = query.after;
    const id = anchor.kind === "ref" ? await refId(anchor.ref) : undefined;
    if (anchor.kind === "ref" && !id) return { error: MESSAGE_TOO_OLD };
    afterId = shiftId(anchor.kind === "ref" ? id! : snowflakeAt(anchor.kind === "time" ? anchor.at.getTime() : anchor.start.getTime()), -1);
  }
  const max = query.max ?? (range ? DEFAULT_RANGE_MAX : DEFAULT_MAX);
  // One side anchored on a #ref: that message and `max` more (two pages when that is past 100).
  const inclusive = !range && ((query.before?.kind === "ref" && !query.after) || (query.after?.kind === "ref" && !query.before)) ? 1 : 0;
  const raw = await readPageOf(deps, ctx.signal, place, { beforeId, afterId, aroundId, limit: max + inclusive });
  const kept = dmFloor ? raw.messages.filter((message) => aboveFloor(message.id, dmFloor)) : raw.messages;
  // Nothing below the floor is "older" for her.
  const page = { messages: kept, hasMore: raw.hasMore && kept.length === raw.messages.length, hasNewer: raw.hasNewer };
  const now = deps.now();
  const tz = deps.timeZone;
  const dir = await directoryFor(deps, place);
  const ids = page.messages.map((message) => message.id);
  // Deleted messages she could have seen before (they have a ref) and that fall inside the page.
  const oldest = page.messages[0];
  const newest = page.messages[page.messages.length - 1];
  const deleted = oldest && newest
    ? deps.conversations.deletedIds(place.ref).filter((id) => compareIds(id, oldest.id) > 0 && compareIds(id, newest.id) < 0)
    : [];
  const refs = await refsForMessages(deps, place, page.messages.map((message) => ({ id: message.id, at: message.createdAt })), now);
  const auto = place.kind === "dm" && place.userId ? new Set((await readDmLimitIfExists(deps.storage, place.userId, ctx.waifu.id))?.autoMessageIds ?? []) : new Set<string>();
  const lookup = new Map<string, RawDiscordMessage>();
  for (const message of [...deps.conversations.bufferedMessages(place.ref), ...page.messages]) if (aboveFloor(message.id, dmFloor)) lookup.set(message.id, message);
  const view: LineView = {
    refs,
    lookup: (id) => lookup.get(id),
    selfAuthorIds: ctx.selfAuthorIds,
    timeZone: tz
  };
  const entries: Array<{ id: string; deleted?: boolean; message?: RawDiscordMessage }> = [
    ...page.messages.map((message) => ({ id: message.id, message })),
    ...deleted.filter((id) => refs.has(id)).map((id) => ({ id, deleted: true }))
  ].sort((a, b) => compareIds(a.id, b.id));
  const downloads = new Downloads(ctx, place);
  downloads.plan(entries.flatMap((entry) => (entry.message && (ctx.selfAuthorIds.includes(entry.message.authorId) || !isRemovedMessage(entry.message, forgotten)) ? [entry.message] : [])));
  const rendered: Array<{ at: string; lines: string[] }> = [];
  for (const entry of entries) {
    if (entry.deleted) {
      const at = snowflakeTime(entry.id);
      rendered.push({ at: new Date(at ?? now.getTime()).toISOString(), lines: [`[${at !== undefined ? clockText(new Date(at), tz) : "--:--"} #${refs.get(entry.id)}] (message deleted)`] });
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
      rendered.push({ at: message.createdAt, lines: [`${entryHeader(line, view)} someone: (removed)`] });
      continue;
    }
    const files = await downloads.forMessage(message, refs.get(message.id) ?? "m");
    const output = renderDiscordMessage(message, dir, tz, { conversationKey: place.placeKey, attachmentText: (attachment) => files.get(attachment) });
    if (!output) continue;
    let body = output.body;
    if (auto.has(message.id)) body = `[auto] ${body}`;
    if (message.editedAt) body = body ? `${body} (edited)` : "(edited)";
    const lines = [entryLine({ ...line, body }, view)];
    const reactions = reactionLine(deps, place, message.id);
    if (reactions) lines.push(reactions);
    rendered.push({ at: message.createdAt, lines });
  }
  const text: string[] = [`${place.handle} (${placeLabel(place)})`];
  if (page.hasMore && oldest) text.push(`— more before: before ${anchorText(refs.get(oldest.id), oldest.createdAt, tz, "before")} —`);
  text.push(...withDayLines(rendered, now, tz));
  if (page.messages.length === 0) text.push("(no messages)");
  if (page.hasNewer && newest) text.push(`— more after: after ${anchorText(refs.get(newest.id), newest.createdAt, tz, "after")} —`);
  // Only the latest page moves her read cursor (what she has caught up on).
  if (!query.before && !query.after && !query.around && newest) await advanceReadCursor(deps.storage, ctx.waifu.id, place.placeKey, newest.id, now);
  return { text: text.join("\n"), ids };
}

/**
 * `readPage` for up to `limit` messages: past Discord's 100 a second page continues where the first
 * stopped (one #ref anchor and `max:100` is 101 messages).
 */
async function readPageOf(
  deps: LifeDeps,
  signal: AbortSignal,
  place: ResolvedPlace,
  o: { beforeId?: string | undefined; afterId?: string | undefined; aroundId?: string | undefined; limit: number }
): Promise<{ messages: RawDiscordMessage[]; hasMore: boolean; hasNewer: boolean }> {
  const base = { conversation: place.ref, signal, ...(o.beforeId ? { beforeId: o.beforeId } : {}), ...(o.afterId ? { afterId: o.afterId } : {}), ...(o.aroundId ? { aroundId: o.aroundId } : {}) };
  let first = await deps.conversations.readPage({ ...base, limit: Math.min(MAX_MESSAGES, o.limit) });
  // A full page of 100 cannot say whether more exist (Discord pages stop at 100): one more look.
  if (o.limit >= MAX_MESSAGES && o.aroundId === undefined && first.messages.length >= MAX_MESSAGES) {
    if (o.afterId === undefined && !first.hasMore) {
      const probe = await deps.conversations.readPage({ conversation: place.ref, signal, beforeId: first.messages[0]!.id, limit: 1 });
      first = { ...first, hasMore: probe.messages.length > 0 };
    } else if (o.afterId !== undefined && !first.hasNewer) {
      const probe = await deps.conversations.readPage({ conversation: place.ref, signal, afterId: first.messages[first.messages.length - 1]!.id, ...(o.beforeId ? { beforeId: o.beforeId } : {}), limit: 1 });
      first = { ...first, hasNewer: probe.messages.length > 0 };
    }
  }
  const rest = o.limit - MAX_MESSAGES;
  if (rest <= 0 || o.aroundId !== undefined || first.messages.length === 0) return first;
  if (o.afterId !== undefined && first.hasNewer) {
    const next = await deps.conversations.readPage({ ...base, afterId: first.messages[first.messages.length - 1]!.id, limit: rest });
    return { messages: [...first.messages, ...next.messages], hasMore: first.hasMore, hasNewer: next.hasNewer };
  }
  if (o.afterId === undefined && first.hasMore) {
    const next = await deps.conversations.readPage({ ...base, beforeId: first.messages[0]!.id, limit: rest });
    return { messages: [...next.messages, ...first.messages], hasMore: next.hasMore, hasNewer: first.hasNewer };
  }
  return first;
}

/**
 * people: / search: (§22.2) over her transcripts (the store, her access intervals) and what the cache
 * holds that the store does not have yet. Opened once per call (her folders are listed once). Days
 * are read newest first (oldest first for `after` alone), without the schema, checking the call's
 * signal between days, within `SEARCH_LIMITS` (days per place, bytes per call); the
 * reply says which days were searched. A forget's lines and a DM's lines at or below its floor are
 * left out here too (the forget job's transcript part may not have run).
 */
class SearchScope {
  private bytesLeft = SEARCH_LIMITS.bytes;
  /** Places the limits left unread (none of their days) or read only in part, by handle. */
  readonly notSearched: string[] = [];
  readonly partly: string[] = [];

  /** The line saying which places the limits cut, when any (also when nothing matched). */
  cutLine(): string | undefined {
    const parts = [
      ...(this.notSearched.length > 0 ? [`not searched: ${this.notSearched.join(", ")}`] : []),
      ...(this.partly.length > 0 ? [`searched only in part: ${this.partly.join(", ")}`] : [])
    ];
    return parts.length > 0 ? `— the search reached its size limit; ${parts.join("; ")} (add before or after, or name fewer places) —` : undefined;
  }

  private constructor(
    private readonly ctx: ToolContext,
    private readonly forgotten: Awaited<ReturnType<typeof forgottenPeople>>,
    private readonly folders: Map<string, TranscriptFolder>,
    private readonly startedAt: string | undefined
  ) {}

  static async open(ctx: ToolContext, forgotten: Awaited<ReturnType<typeof forgottenPeople>>): Promise<SearchScope> {
    const folders = await transcriptFolders({ storage: ctx.deps.storage, waifuId: ctx.waifu.id }).catch(() => [] as TranscriptFolder[]);
    const startedAt = await readTranscriptsStartedAt(ctx.deps.storage.dataRoot);
    return new SearchScope(ctx, forgotten, new Map(folders.map((folder) => [folder.key, folder])), startedAt);
  }

  /** The days searched, as she reads them. */
  private rangeText(from: { day?: string; ms?: number }, to: { day?: string; ms?: number }, cut: boolean): string {
    const tz = this.ctx.deps.timeZone;
    const now = this.ctx.deps.now();
    const begins = this.startedAt ? Date.parse(this.startedAt) : undefined;
    let fromText: string;
    if (from.day) fromText = from.day;
    else if (from.ms !== undefined && (begins === undefined || from.ms >= begins)) fromText = localDayKey(new Date(from.ms), tz);
    else fromText = begins !== undefined ? `${localDayKey(new Date(begins), tz)} (when your transcripts begin)` : "the start";
    const toText = to.day ?? localDayKey(new Date(to.ms !== undefined ? Math.min(to.ms, now.getTime()) : now.getTime()), tz);
    return `searched ${fromText} – ${toText}${cut ? "; the search stopped at its size limit: add before or after to look further" : ""}`;
  }

  /** The reply when nothing matched anywhere. */
  nothing(query: ReadQuery): string {
    const bounds = this.boundsOf(query);
    return `no messages match (${this.rangeText({ ...(bounds.lowerMs !== undefined ? { ms: bounds.lowerMs } : {}) }, { ...(bounds.upperMs !== undefined ? { ms: bounds.upperMs } : {}) }, false)})`;
  }

  /** Time bounds of the anchors that are times or days (refs are resolved per place). */
  private boundsOf(query: ReadQuery): { lowerMs?: number; upperMs?: number } {
    const out: { lowerMs?: number; upperMs?: number } = {};
    if (query.after && query.after.kind !== "ref") out.lowerMs = query.after.kind === "time" ? query.after.at.getTime() : query.after.start.getTime();
    if (query.before && query.before.kind !== "ref") out.upperMs = query.before.kind === "time" ? query.before.at.getTime() : query.before.start.getTime();
    if (query.around?.kind === "day") {
      out.lowerMs = query.around.start.getTime();
      out.upperMs = query.around.end.getTime();
    }
    return out;
  }

  /** A line she may see (§7.5 forgets, a DM floor). */
  private visible(line: Pick<TranscriptLine, "id" | "at" | "authorId" | "mentions" | "text">, floor: string | undefined): boolean {
    return !forgottenLine(line, this.forgotten) && !atOrBelowFloor(line, floor);
  }

  async place(place: ResolvedPlace, query: ReadQuery, o: { quiet: boolean }): Promise<Section | undefined> {
    const { deps, waifu, signal } = this.ctx;
    const tz = deps.timeZone;
    const now = deps.now();
    const floor = await floorOf(deps, waifu.id, place);
    if (floor === "unreadable") return { error: CANT_READ };
    // Bounds: ids for #refs (inclusive), times for the rest.
    const bounds = this.boundsOf(query);
    let lowerId: string | undefined;
    let upperId: string | undefined;
    let center: { id?: string; ms?: number } | undefined;
    for (const [side, anchor] of [["after", query.after], ["before", query.before], ["around", query.around]] as const) {
      if (anchor?.kind !== "ref") continue;
      const id = await messageIdForRef(deps, place, anchor.ref);
      if (!id) return { error: MESSAGE_TOO_OLD };
      if (side === "after") lowerId = id;
      else if (side === "before") upperId = id;
      else center = { id };
    }
    if (query.around?.kind === "time") center = { ms: query.around.at.getTime() };
    const lowerMs = bounds.lowerMs ?? (lowerId ? snowflakeTime(lowerId) : undefined);
    const upperMs = bounds.upperMs ?? (upperId ? snowflakeTime(upperId) : undefined);
    const people = query.people;
    const inBounds = (line: Pick<TranscriptLine, "id" | "at">) => {
      const at = Date.parse(line.at);
      if (lowerId !== undefined ? compareIds(line.id, lowerId) < 0 : lowerMs !== undefined && at < lowerMs) return false;
      if (upperId !== undefined ? compareIds(line.id, upperId) > 0 : upperMs !== undefined && at >= upperMs) return false;
      return true;
    };
    const matches = (line: TranscriptLine) =>
      inBounds(line) &&
      (!people || people.some((name) => (name === "you" ? line.waifu === waifu.id : fold(line.author) === name))) &&
      (!query.search || matchesSearch([line.text, ...(line.files ?? [])].join(" "), query.search));
    const matched: TranscriptLine[] = [];
    // What a reply may point at, for every line read (its ref, author and whether it was hers).
    const targets = new Map<string, TranscriptLine>();
    const take = (line: TranscriptLine) => {
      targets.set(line.id, { id: line.id, at: line.at, authorId: line.authorId, author: line.author, text: "", ...(line.ref ? { ref: line.ref } : {}), ...(line.waifu ? { waifu: line.waifu } : {}) });
      if (matches(line)) matched.push(line);
    };
    // Her transcript of this place, the days the bounds allow, read in the order the selection wants.
    const folder = this.folders.get(place.placeKey);
    const ascending = query.after !== undefined && query.before === undefined && center === undefined;
    let cut = false;
    const scanned: string[] = [];
    if (folder) {
      const dataRoot = deps.storage.dataRoot;
      const firstDay = lowerMs !== undefined ? localDayKey(new Date(lowerMs), tz) : undefined;
      const lastDay = upperMs !== undefined ? localDayKey(new Date(upperMs), tz) : undefined;
      const days = (await listTranscriptDays(dataRoot, folder.key)).filter(
        (day) => !(firstDay && day < firstDay) && !(lastDay && day > lastDay) && (folder.dm || !folder.intervals || dayInsideIntervals(folder.intervals, day, tz, now))
      );
      if (!ascending) days.reverse();
      for (const day of days) {
        signal.throwIfAborted();
        if (scanned.length >= SEARCH_LIMITS.days || this.bytesLeft <= 0) {
          cut = true;
          break;
        }
        const { lines, bytes } = await readTranscriptDayLite(dataRoot, folder.key, day);
        this.bytesLeft -= bytes;
        scanned.push(day);
        for (const line of lines) {
          if (!folder.dm && folder.intervals && !insideIntervals(folder.intervals, line.at)) continue;
          if (!this.visible(line, floor)) continue;
          take(line);
        }
      }
    }
    // The cache's messages newer than the store's newest line of this place (whoever could see it):
    // a room only inside her current interval, a DM of hers always.
    if (!(cut && !ascending)) {
      const newest = await newestTranscriptLine(deps.storage.dataRoot, place.placeKey).catch(() => undefined);
      const room = place.kind !== "dm";
      if (!room || folder?.intervals) {
        const dir = await directoryFor(deps, place);
        for (const message of deps.conversations.bufferedMessages(place.ref)) {
          if (newest && compareIds(message.id, newest.id) <= 0) continue;
          if (!aboveFloor(message.id, floor)) continue;
          if (room && !insideIntervals(folder!.intervals!, message.createdAt)) continue;
          const self = this.ctx.selfAuthorIds.includes(message.authorId);
          if (!self && isRemovedMessage(message, this.forgotten)) continue;
          const body = transcriptText(message, dir, tz);
          if (body === undefined) continue;
          const files = [...message.attachments, ...message.snapshots.flatMap((snapshot) => snapshot.attachments)].map((attachment) => attachment.filename);
          const line: TranscriptLine = {
            id: message.id,
            at: message.createdAt,
            authorId: message.authorId,
            author: self ? waifu.name : message.authorName,
            ...(self ? { waifu: waifu.id } : {}),
            ...(message.referenceMessageId ? { reply: message.referenceMessageId } : {}),
            text: body,
            ...(files.length > 0 ? { files } : {}),
            ...(Object.keys(message.mentions.users).length > 0 ? { mentions: Object.keys(message.mentions.users) } : {})
          };
          if (this.visible(line, floor)) take(line);
        }
      }
    }
    if (cut) (scanned.length === 0 ? this.notSearched : this.partly).push(place.handle);
    matched.sort(compareLines);
    if (matched.length === 0 && o.quiet) return undefined;
    const range = (query.before !== undefined && query.after !== undefined) || query.around?.kind === "day";
    const max = query.max ?? (range ? DEFAULT_RANGE_MAX : DEFAULT_MAX);
    let start: number;
    if (center) {
      const at = matched.findIndex((line) => (center!.id !== undefined ? compareIds(line.id, center!.id) >= 0 : Date.parse(line.at) >= center!.ms!));
      start = Math.max(0, (at < 0 ? matched.length : at) - Math.floor(max / 2));
      start = Math.max(0, Math.min(start, matched.length - max));
    } else if (ascending) {
      start = 0;
    } else {
      start = Math.max(0, matched.length - max);
    }
    const shown = matched.slice(start, start + max);
    const refs = await refsForMessages(deps, place, shown.filter((line) => !line.ref).map((line) => ({ id: line.id, at: line.at })), now);
    const refOf = (line: TranscriptLine) => line.ref ?? refs.get(line.id);
    const text: string[] = [`${place.handle} (${placeLabel(place)})`];
    // The window searched: the anchors, or as far as the scan went when it stopped early.
    const oldestScanned = ascending ? scanned[0] : scanned[scanned.length - 1];
    const newestScanned = ascending ? scanned[scanned.length - 1] : scanned[0];
    const from = cut && !ascending && oldestScanned ? { day: oldestScanned } : lowerMs !== undefined ? { ms: lowerMs } : {};
    const to = cut && ascending && newestScanned ? { day: newestScanned } : upperMs !== undefined ? { ms: upperMs } : {};
    text.push(`${matched.length} ${matched.length === 1 ? "message matches" : "messages match"}${shown.length < matched.length ? `, ${shown.length} shown` : ""} (${this.rangeText(from, to, cut)})`);
    const first = shown[0];
    const last = shown[shown.length - 1];
    if ((start > 0 || (cut && !ascending)) && first) text.push(`— more before: before ${anchorText(refOf(first), first.at, tz, "before")} —`);
    text.push(
      ...withDayLines(
        shown.map((line) => ({ at: line.at, lines: [transcriptChatLine(refOf(line) && !line.ref ? { ...line, ref: refOf(line)! } : line, { waifuId: waifu.id, timeZone: tz, refs, byId: targets })] })),
        now,
        tz
      )
    );
    if ((start + shown.length < matched.length || (cut && ascending)) && last) text.push(`— more after: after ${anchorText(refOf(last), last.at, tz, "after")} —`);
    return { text: text.join("\n"), ids: shown.map((line) => line.id) };
  }
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

export const PRIVATE_FILE_REASON = "your notes and the files in ~/life/ are private and can't be attached";
export const TRANSCRIPT_COPY_REASON = "a copy of a private chat's transcript can't be attached";

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
    // Transcripts are hers to read, never to send (§18.3).
    if (transcriptsSegments(input, store.slug)) {
      skipped.push(`${input} (transcripts can't be attached)`);
      continue;
    }
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
    if (privateFiles.has(key) || isLifeDirPath(p)) {
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
      // A copy of a private chat's transcript never goes out (§18.3, D14).
      if (await store.isTranscriptCopy(p)) {
        await noteDmFile(store, p);
        skipped.push(`${p.display} (${TRANSCRIPT_COPY_REASON})`);
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

/** Discord's 50001 (missing access) and 50013 (missing permissions): her bot can't post in that channel. */
function isNoAccess(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 50001 || code === "50001" || code === 50013 || code === "50013";
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
    return toolError(attached.skipped.length > 0 ? `nothing was sent: not attached: ${attached.skipped.join(", ")}` : "there is nothing to send: put your message in text, or save a file with Write first and list its path in files");
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
    if (isNoAccess(error)) return toolError("the message could not be sent: Discord says you can't post in this room right now; that can change, so try again later");
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
  return [
    `Read messages in your places (a room, thread or private chat; up to 5 handles separated by commas, or everywhere with people: or search:). Lines look like \`[14:02 #k3] Kevin ↩#k1: text\`; \`#k3\` is the message's ref. Files people sent are saved in /tmp ${keptForText(retentionDays)} and shown by their path; open them with Read.`,
    "query (optional; empty = the latest messages), terms in any order:",
    "before|after|around <#ref | 2026-10-25 17:02 | 2026-10-25 | 17:02 | yesterday 17:02> (a #ref is included; before + after = a range) · max:N (1–100, default 15)",
    "people:Name, Name (you = yourself) · search:words, other words (any one of them; every word of it must appear)",
    "Examples: query \"around #k3 max:10\"; place \"everywhere\" with query \"people:Kevin search:exam, test after 2026-10-20\"."
  ].join("\n");
}

const SEND_DESCRIPTION =
  "Send a message to a place. This is the only way anyone sees what you write. Keep it like a chat message; send several if you have several things to say. Use <@Name> to mention someone who is there.";
const PRIVATE_ATTACH_TEXT = "MEMORY.md, the notes it links to and the files in ~/life/ can't be attached.";

/** SendMessage's input schema; `files` (at most `maxFiles`) only when attaching is on. */
function sendSchema(maxFiles: number): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      place: { type: "string", description: "A place handle." },
      text: { type: "string", maxLength: 2000, description: maxFiles > 0 ? "The message itself. It may be empty only when you attach a file." : "The message itself." },
      reply_to: { type: "string", description: "Optional: the ref of the message you are replying to, like #k3." },
      ...(maxFiles > 0
        ? { files: { type: "array", items: { type: "string" }, maxItems: maxFiles, description: `Optional: paths of files to attach, like /tmp/cake-small.png (at most ${maxFiles}). To post something you write as a file, save it with Write first.` } }
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
        place: { type: "string", description: "A place handle from ~/life/places.md, like bake-club/#general or dm/kevin; several separated by commas (at most 5), or everywhere (with people: or search:)." },
        query: { type: "string", description: "Optional: before|after|around an anchor, max:N, people:Names, search:words (see the description)." }
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
