// `ReadMessages`, `SendMessage`, `React` (Living cast spec §6.2–§6.4, §16.3.1, §16.3.2, D11).
//
// ReadMessages downloads attachments (images, PDFs, text files) into her `/tmp`, under the place's
// handle (`/tmp/bake-club/general/k3-cake.png`, `/tmp/dm/kevin/a7-menu.pdf`), and shows the path
// instead of the image; she looks with Read. SendMessage can attach files from her folders, except
// her private ones (MEMORY.md and the notes it links, her reminders, watches and places).

import { createHash } from "node:crypto";
import { z } from "zod";
import { assignConversationRefs, normalizeRef, resolveConversationRef, shiftId, snowflakeAt, snowflakeTime } from "../../discord/refStore.js";
import { conversationKey } from "../../orchestration/context/keys.js";
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
import { placeLabel, placesWithHandles, refreshPlaces, resolvePlace, type ResolvedPlace } from "../places.js";
import { notePlace } from "../placeRecorder.js";
import { refsForMessages } from "../messageRefs.js";
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
  type TranscriptLine
} from "../transcripts/store.js";
import { forgottenLine } from "../transcripts/forget.js";
import { transcriptChatLine, transcriptFolders, type TranscriptFolder } from "../transcripts/view.js";
import { transcriptText } from "../transcripts/writer.js";
import { anchorBounds, DEFAULT_MAX, DEFAULT_RANGE_MAX, fold, matchesSearch, MAX_MESSAGES, parseAnchor, parseReadQuery, QUERY_SYNTAX, wordsOf, type ReadQuery } from "./readQuery.js";
import type { LifeDeps } from "../deps.js";
import { noteDmFile, pathArg, storeOf } from "./files.js";
import { transcriptsSegments } from "../transcripts/view.js";
import { messagePreview } from "../notifications.js";
import { legacySteps, MAX_MESSAGE_CHARS, MAX_TYPING_SECONDS, MAX_WAIT_SECONDS, MAX_WAIT_TOTAL_SECONDS, parseSendScript, scriptSends, sendLabel, type ScriptReact, type ScriptSend, type ScriptStep, type ScriptTyping, type ScriptWait } from "./sendScript.js";
import { failed, familyLines, intArg, numberArg, objectArg, outputText, runScriptTool, scriptSchema, ScriptError, textArg, type ScriptRun } from "./script.js";
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
  if (args.place.trim().toLowerCase() === EVERYWHERE && !filtered) return toolError(`error: "everywhere" needs people: or search: in the query\n${QUERY_SYNTAX}`);
  return readMessagesQuery(ctx, args.place, query);
}

/**
 * The read itself (§22.2): `wanted` is a handle, handles separated by commas (at most 5) or
 * `everywhere` (with people or search).
 */
async function readMessagesQuery(ctx: ToolContext, wantedPlaces: string, query: ReadQuery): Promise<ToolOutput> {
  const { deps, waifu } = ctx;
  const filtered = query.people !== undefined || query.search !== undefined;
  const wanted = wantedPlaces.trim();
  let places: ResolvedPlace[];
  const everywhere = wanted.toLowerCase() === EVERYWHERE;
  if (everywhere) {
    if (!filtered) return toolError(`error: "everywhere" needs people or search`);
    places = await placesWithHandles(deps.storage, waifu.id);
  } else {
    const handles = wanted.split(",").map((handle) => handle.trim()).filter((handle) => handle.length > 0);
    if (handles.length > MAX_READ_PLACES) return toolError(`error: at most ${MAX_READ_PLACES} places at once (or "everywhere" with people or search)`);
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
  const refs = await refsForMessages(deps, place.placeKey, page.messages.map((message) => ({ id: message.id, at: message.createdAt })), now);
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
    const refs = await refsForMessages(deps, place.placeKey, shown.filter((line) => !line.ref).map((line) => ({ id: line.id, at: line.at })), now);
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

// ---- SendMessage (§6.3, §27) ----------------------------------------------------------------------

const SendInput = z.object({
  place: z.string().min(1),
  script: z.string().max(40_000).optional(),
  // Before §27 the tool took one message as these; an old call (a kept turn's habit) still runs.
  text: z.string().max(4000).optional(),
  reply_to: z.string().min(1).optional(),
  files: z.array(z.string().min(1).max(2000)).max(10).optional()
});

export const PRIVATE_FILE_REASON = "your notes and the files in ~/life/ are private and can't be attached";
export const TRANSCRIPT_COPY_REASON = "a copy of a private chat's transcript can't be attached";

/**
 * The files of one message (§16.3.2): what can go, or the first one that can't and why (by its index
 * in `requested`).
 */
async function attachments(ctx: ToolContext, requested: readonly string[]): Promise<{ files: OutgoingFile[]; refused?: { index: number; reason: string } }> {
  const store = storeOf(ctx);
  const max = ctx.deps.config().life.send.maxFiles;
  const privateFiles = await store.privateFiles();
  const files: OutgoingFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const [index, input] of requested.entries()) {
    const refuse = (reason: string) => ({ files, refused: { index, reason } });
    // Transcripts are hers to read, never to send (§18.3).
    if (transcriptsSegments(input, store.slug)) return refuse(`${input} (transcripts can't be attached)`);
    const target = await pathArg(store, input);
    if (!target.ok) return refuse(`${input} (${String(target.output.content).replace(/^error:\s*/u, "")})`);
    const p = target.path;
    // Names compare as the disk does (`~/memory.md` is `~/MEMORY.md`).
    const key = pathKey(p.virtual);
    if (seen.has(key)) continue;
    seen.add(key);
    if (privateFiles.has(key) || isLifeDirPath(p)) return refuse(`${p.display} (${PRIVATE_FILE_REASON})`);
    if (files.length >= max) return refuse(`${p.display} (${max === 0 ? "files can't be attached" : `at most ${max} file${max === 1 ? "" : "s"} per message`})`);
    const info = await store.files.inspect(p);
    if (info.kind === "missing") return refuse(`${p.display} (it doesn't exist)`);
    if (info.kind === "dir") return refuse(`${p.display} (it is a folder)`);
    if (info.kind !== "file") return refuse(`${p.display} (it can't be used)`);
    if (info.size > MAX_SEND_FILE_BYTES) return refuse(`${p.display} (larger than ${MAX_SEND_FILE_BYTES / (1024 * 1024)} MB)`);
    if (total + info.size > MAX_SEND_TOTAL_BYTES) return refuse(`${p.display} (the files together would be over ${MAX_SEND_TOTAL_BYTES / (1024 * 1024)} MB, Discord's limit for one message)`);
    const data = await store.files.readBytes(p, { maxBytes: MAX_SEND_FILE_BYTES }).catch(() => undefined);
    if (!data) return refuse(`${p.display} (it can't be read)`);
    // A copy of a private chat's transcript never goes out (§18.3, D14).
    if (await store.isTranscriptCopy(p)) {
      await noteDmFile(store, p);
      return refuse(`${p.display} (${TRANSCRIPT_COPY_REASON})`);
    }
    // A DM's download sent anywhere is about that DM (D14): the owner's views hide the call.
    await noteDmFile(store, p);
    total += data.length;
    files.push({ name: p.segments[p.segments.length - 1]!, data });
  }
  return { files };
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

/** A send checked and ready: its final text, resolved reply and files. */
type ReadySend = { step: ScriptSend; text: string; replyToId?: string; files: OutgoingFile[] };
type ReadyReact = { step: ScriptReact; messageId: string; emoji: string };
type ReadyStep = ReadySend | ReadyReact | { step: ScriptWait | ScriptTyping };

const lineError = (line: number, message: string) => toolError(`line ${line}: ${message.replace(/^error:\s*/u, "")}; nothing was sent`);

/** Refs for `ids` in a place, after the messages before them get theirs (refs stay in message order, §4.7). */
async function refsThrough(deps: LifeDeps, place: ResolvedPlace, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const newest = ids.reduce((a, b) => (compareIds(a, b) >= 0 ? a : b));
  const now = deps.now();
  const dmFloor = place.kind === "dm" && place.ref.kind === "dm" ? await readDmFloor(deps.storage, place.userId!, place.ref.waifuId).catch(() => undefined) : undefined;
  // The buffer and one page before it (served from the buffer when the conversation is trusted).
  const earlier = await deps.conversations.readPage({ conversation: place.ref, beforeId: newest, limit: 50 }).catch(() => ({ messages: [] as RawDiscordMessage[] }));
  const before = [...deps.conversations.bufferedMessages(place.ref), ...earlier.messages]
    .filter((message) => compareIds(message.id, newest) < 0 && aboveFloor(message.id, dmFloor))
    .map((message) => message.id);
  return assignConversationRefs(deps.storage, place.placeKey as never, [...before, ...ids], now);
}

/** People's messages a place's typical length comes from (§27.2): the newest 50, at least 10. */
export const TYPICAL_SAMPLE = 50;
export const TYPICAL_MIN_SAMPLES = 10;
/** Below this many characters a line is never called long. */
export const LONG_LINE_MIN_CHARS = 120;
const TYPICAL_DAYS = 14;

/**
 * The typical length of a message from people in a place (§27.2): the median of the newest 50 non-empty
 * messages from people (not waifus, not bots; in a DM the other person), from the cache and then the
 * place's transcript; undefined with fewer than 10.
 */
export async function typicalLength(ctx: ToolContext, place: ResolvedPlace): Promise<number | undefined> {
  const { deps } = ctx;
  const own = new Set([...ctx.selfAuthorIds, ...(deps.discord()?.ownAuthorIds?.() ?? [])]);
  const person = (authorId: string) => (place.kind === "dm" ? authorId === place.userId : !own.has(authorId));
  const lengths = new Map<string, number>();
  for (const message of deps.conversations.bufferedMessages(place.ref)) {
    if (message.authorIsBot || !person(message.authorId) || !message.content.trim()) continue;
    lengths.set(message.id, message.content.trim().length);
  }
  if (lengths.size < TYPICAL_SAMPLE) {
    const days = (await listTranscriptDays(deps.storage.dataRoot, place.placeKey).catch(() => [] as string[])).slice(-TYPICAL_DAYS).reverse();
    for (const day of days) {
      const { lines } = await readTranscriptDayLite(deps.storage.dataRoot, place.placeKey, day).catch(() => ({ lines: [] as TranscriptLine[] }));
      for (const line of lines) if (!line.waifu && person(line.authorId) && line.text.trim() && !lengths.has(line.id)) lengths.set(line.id, line.text.trim().length);
      if (lengths.size >= TYPICAL_SAMPLE) break;
    }
  }
  const newest = [...lengths.entries()].sort((a, b) => compareIds(b[0], a[0])).slice(0, TYPICAL_SAMPLE).map(([, length]) => length);
  if (newest.length < TYPICAL_MIN_SAMPLES) return undefined;
  const sorted = newest.sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The room-aware nudge (§27.2): her longest line when it is over max(3 × typical, 120). */
async function lengthNudge(ctx: ToolContext, place: ResolvedPlace, texts: readonly string[]): Promise<string | undefined> {
  const longest = Math.max(0, ...texts.map((text) => text.length));
  if (longest <= LONG_LINE_MIN_CHARS) return undefined;
  const typical = await typicalLength(ctx, place).catch(() => undefined);
  if (typical === undefined || longest <= Math.max(3 * typical, LONG_LINE_MIN_CHARS)) return undefined;
  return `that line was ${longest} characters; people here usually write about ${typical}`;
}

/**
 * A `wait` (§27.1): pauses up to `seconds`, cut short when someone else writes there. Returns what
 * came in meanwhile (by others, newest last): from the cache's events, and a page after the wait's
 * start (so a cache without events sees them too).
 */
async function waitInPlace(ctx: ToolContext, place: ResolvedPlace, seconds: number, after: string): Promise<RawDiscordMessage[]> {
  const { deps, signal } = ctx;
  const self = new Set(ctx.selfAuthorIds);
  const came = new Map<string, RawDiscordMessage>();
  const early = new AbortController();
  const stopEarly = () => early.abort();
  signal.addEventListener("abort", stopEarly, { once: true });
  const off = deps.conversations.onEvent((event) => {
    if (event.type !== "create" || event.conversation.kind !== place.ref.kind || conversationKey(event.conversation) !== place.placeKey) return;
    if (self.has(event.message.authorId)) return;
    came.set(event.message.id, event.message);
    early.abort();
  });
  try {
    await deps.sleep(seconds * 1000, early.signal);
  } finally {
    off();
    signal.removeEventListener("abort", stopEarly);
  }
  if (signal.aborted) return [];
  const dmFloor = place.kind === "dm" ? await readDmFloor(deps.storage, place.userId!, ctx.waifu.id).catch(() => undefined) : undefined;
  const page = await deps.conversations.readPage({ conversation: place.ref, afterId: after, limit: 50, signal }).catch(() => ({ messages: [] as RawDiscordMessage[] }));
  for (const message of page.messages) if (!self.has(message.authorId) && compareIds(message.id, after) > 0) came.set(message.id, message);
  return [...came.values()].filter((message) => aboveFloor(message.id, dmFloor)).sort((a, b) => compareIds(a.id, b.id));
}

/** What came in during a wait, as notification lines with refs (§27.1, §20). */
async function cameInLines(ctx: ToolContext, place: ResolvedPlace, messages: readonly RawDiscordMessage[]): Promise<string[]> {
  const { deps } = ctx;
  const forgotten = await forgottenPeople(deps.storage).catch(() => undefined);
  const refs = await refsThrough(deps, place, messages.map((message) => message.id)).catch(() => new Map<string, string>());
  const dir = await directoryFor(deps, place);
  const shown = messages.slice(-deps.config().life.notificationLinesPerPlace);
  const lines = shown.map((message, index) => {
    const removed = !forgotten || isRemovedMessage(message, forgotten);
    const preview = messagePreview(message, dir, deps.timeZone, { removed });
    const name = removed ? "someone" : message.authorName.replace(/"/gu, "'").replace(/\s*[\r\n]+\s*/gu, " ");
    const ref = refs.get(message.id);
    const parts = [place.handle, ...(index === 0 && messages.length > shown.length ? [`+${messages.length - shown.length} earlier`] : []), `from ${name}`];
    const quoted = `"${preview.replace(/"/gu, "'").replace(/\s*[\r\n]+\s*/gu, " ")}"`;
    parts.push(preview ? (ref ? `#${ref} ${quoted}` : quoted) : ref ? `#${ref}` : "");
    return `- ${parts.filter(Boolean).join(" · ")}`;
  });
  return lines;
}

/** A reaction's emoji as Discord takes it (React's rules), or why it can't be used. */
async function reactionEmoji(deps: LifeDeps, place: ResolvedPlace, raw: string): Promise<{ ok: true; emoji: string } | { ok: false; error: string }> {
  const emoji = raw.trim();
  const custom = /^<?a?:([A-Za-z0-9_~]{2,32}):(\d+)?>?$/.exec(emoji);
  if (custom) {
    if (custom[2]) return { ok: true, emoji: custom[2] };
    const found = place.guildId ? await deps.directory.findEmoji(place.guildId, custom[1]!) : undefined;
    return found ? { ok: true, emoji: found.id } : { ok: false, error: `there is no :${custom[1]}: emoji here` };
  }
  if (/[A-Za-z0-9]/.test(emoji) && !/\p{Extended_Pictographic}/u.test(emoji)) return { ok: false, error: "use a unicode emoji or :server_emoji:" };
  return { ok: true, emoji };
}

/** The steps of a call: its script, or (before §27) its one message. */
function stepsOf(args: z.infer<typeof SendInput>, maxFiles: number): ReturnType<typeof parseSendScript> {
  if (args.script !== undefined) return parseSendScript(args.script, { maxFiles });
  if (args.text === undefined && args.files === undefined) return { ok: false, line: 1, error: "script is missing: write each message on an m: line" };
  return legacySteps({ text: args.text, reply_to: args.reply_to, files: args.files });
}

/** The steps a SendMessage call's arguments name (boot repair reads them; undefined when they don't parse). */
export function sendCallSteps(input: unknown, maxFiles: number): ScriptStep[] | undefined {
  const parsed = SendInput.safeParse(input ?? {});
  if (!parsed.success) return undefined;
  const steps = stepsOf(parsed.data, Math.max(maxFiles, 10));
  return steps.ok ? steps.steps : undefined;
}

type SendStop =
  | { at: number; line: number; kind: "wait"; seconds: number; came: RawDiscordMessage[] }
  | { at: number; line: number; kind: "failed"; reason: string }
  | { at: number; line: number; kind: "interrupted" };

/** What one send ran to (§27.1): what went out, why it stopped, what was left. */
export type SendOutcome = {
  place: ResolvedPlace;
  sentIds: string[];
  refs: Map<string, string>;
  reacted: string[];
  stop?: SendStop;
  /** What came in during the wait that stopped it, as notification lines. */
  cameLines: string[];
  /** The sends and reactions left after the stop (`not sent: …`, `not done: react #k2 👍`). */
  left: string[];
  nudge?: string;
  /** How many steps the send had (one step alone reports an error without its line). */
  steps: number;
};

/**
 * One send to one place (§27, §32.2): the whole of it is checked first (permission, caps, every
 * message's text, refs, files and emoji); any error refuses it (`where(line)` names the step) and
 * nothing is sent. Then the steps run in order: typing before each message as a person would take, a
 * wait that someone else cuts short stops the rest. Each send has its own intent line and done line
 * (boot repair, §5.7); `beforeSending` runs once everything is checked, before the first Discord call.
 */
export async function runSend(
  ctx: ToolContext,
  placeArg: string,
  place: ResolvedPlace,
  steps: readonly ScriptStep[],
  o: { where: (line: number) => string; beforeSending?: (ready: ReadonlyArray<{ step: ScriptStep }>) => Promise<void> }
): Promise<SendOutcome | { error: string }> {
  const { deps, waifu, turn } = ctx;
  const life = deps.config().life;
  const stepError = (line: number, message: string) => ({ error: `error: ${o.where(line)}: ${message.replace(/^error:\s*/u, "")}; nothing was sent` });
  // Without a bot of her own she cannot post at all (never through the House bot): she is told,
  // and so is the owner (review M12).
  if (!waifu.botId) {
    deps.notices?.set(`no-bot:${waifu.id}`, `${waifu.displayName} has no Discord bot of her own, so she cannot post; link one on the Cast page.`);
    return { error: `error: ${NO_BOT}` };
  }
  const sends = scriptSends(steps);
  if (sends.length > 0 ? (place.kind === "dm" ? !(await dmSendAllowed(deps, ctx, place)) : place.paused === true) : place.paused === true) return { error: CANNOT_POST };
  const maxPlaces = life.maxSendPlacesPerTurn;
  if (sends.length > 0 && !turn.sentPlaces.has(place.placeKey) && turn.sentPlaces.size >= maxPlaces) return { error: `error: you've already written in ${maxPlaces} places this turn` };
  const sentSoFar = turn.sends ?? 0;
  if (sends.length > 0 && sentSoFar >= life.maxSendsPerTurn) return { error: `error: you've already sent ${life.maxSendsPerTurn} messages this turn; wait for replies` };
  if (sentSoFar + sends.length > life.maxSendsPerTurn) {
    const left = life.maxSendsPerTurn - sentSoFar;
    return { error: `error: this script sends ${sends.length} messages, and you can send ${left} more this turn; nothing was sent` };
  }
  // Every step checked before anything goes out.
  const ready: ReadyStep[] = [];
  for (const step of steps) {
    if (step.kind === "send") {
      const text = step.text ? stripCopiedHeader(step.text, [waifu.name, waifu.displayName]) : "";
      if (step.text && !text && step.files.length === 0) return stepError(step.line, "there is nothing left to send on that line");
      if (text && isOnlyToolCallSyntax(text, ctx.toolNames)) return stepError(step.line, "that looks like a tool call, not a message; write what you want to say");
      let replyToId: string | undefined;
      if (step.replyTo) {
        replyToId = await messageIdForRef(deps, place, step.replyTo.ref);
        if (!replyToId) return stepError(step.replyTo.line, `#${step.replyTo.ref}: message too old`);
      }
      const attached = step.files.length > 0 ? await attachments(ctx, step.files.map((file) => file.path)) : { files: [] };
      if (attached.refused) return stepError(step.files[attached.refused.index]!.line, `can't attach ${attached.refused.reason}`);
      ready.push({ step, text, ...(replyToId ? { replyToId } : {}), files: attached.files });
    } else if (step.kind === "react") {
      const messageId = await messageIdForRef(deps, place, step.ref);
      if (!messageId) return stepError(step.line, `#${step.ref}: message too old`);
      const emoji = await reactionEmoji(deps, place, step.emoji);
      if (!emoji.ok) return stepError(step.line, emoji.error);
      ready.push({ step, messageId, emoji: emoji.emoji });
    } else ready.push({ step });
  }
  const discord = deps.discord();
  if (!discord) return { error: "error: you can't reach Discord right now" };
  if (ready.some((item) => item.step.kind === "react") && !discord.addReaction) return { error: "error: you can't react right now" };
  await o.beforeSending?.(ready);
  const sentIds: string[] = [];
  const sentTexts: string[] = [];
  const reacted: string[] = [];
  let stop: SendStop | undefined;
  // After a wait or a typing line, the place is looked at again before the next send or reaction:
  // a server paused, a DM closed or a place no longer hers meanwhile stops the rest (§27.4).
  let recheck = false;
  const stillOpen = async (forSend: boolean): Promise<boolean> => {
    if (deps.isPaused()) return false;
    refreshPlaces(deps.storage, waifu.id);
    const current = await resolvePlace(deps.storage, waifu.id, placeArg).catch(() => undefined);
    if (!current || current.placeKey !== place.placeKey) return false;
    if (current.kind === "dm") return !forSend || (await dmSendAllowed(deps, ctx, current).catch(() => false));
    return current.paused !== true;
  };
  const showTyping = async () => {
    if (place.kind === "dm") await discord.sendDirectTyping?.({ waifuId: waifu.id, userId: place.userId! });
    else await discord.sendTyping({ guildId: place.guildId!, channelId: place.channelId!, senderBotId: waifu.botId });
  };
  for (const [at, item] of ready.entries()) {
    const step = item.step;
    if (ctx.signal.aborted) {
      stop = { at, line: step.line, kind: "interrupted" };
      break;
    }
    if (step.kind === "wait") {
      const after = sentIds.length > 0 && compareIds(sentIds[sentIds.length - 1]!, snowflakeAt(deps.now().getTime())) > 0 ? sentIds[sentIds.length - 1]! : snowflakeAt(deps.now().getTime());
      const came = await waitInPlace(ctx, place, step.seconds, after);
      if (ctx.signal.aborted) {
        stop = { at: at + 1, line: step.line, kind: "interrupted" };
        break;
      }
      if (came.length > 0) {
        stop = { at: at + 1, line: step.line, kind: "wait", seconds: step.seconds, came };
        break;
      }
      recheck = true;
      continue;
    }
    if (step.kind === "typing") {
      await showTyping().catch(() => undefined);
      await deps.sleep(step.seconds * 1000, ctx.signal);
      recheck = true;
      continue;
    }
    if (recheck) {
      recheck = false;
      if (!(await stillOpen(step.kind === "send"))) {
        stop = { at, line: step.line, kind: "failed", reason: CANNOT_POST.replace(/^error:\s*/u, "") };
        break;
      }
    }
    if (step.kind === "react") {
      const react = item as ReadyReact;
      try {
        await discord.addReaction!({ waifuId: waifu.id, botId: waifu.botId, conversation: place.ref, messageId: react.messageId, emoji: react.emoji });
      } catch (error) {
        deps.logger.warn("Life reaction failed", { waifuId: waifu.id, placeKey: place.placeKey, message: error instanceof Error ? error.message : String(error) });
        stop = { at, line: step.line, kind: "failed", reason: "the reaction could not be added" };
        break;
      }
      reacted.push(step.ref);
      deps.logger.info("Life reaction added", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, ...(place.placeKey.startsWith("dm_") ? {} : { place: place.handle }), messageId: react.messageId });
      continue;
    }
    const send = item as ReadySend;
    // Typing first, for as long as a person would take (§6.3).
    await showTyping().catch(() => undefined);
    await deps.sleep(typingDelayMs(send.text), ctx.signal);
    if (ctx.signal.aborted) {
      stop = { at, line: step.line, kind: "interrupted" };
      break;
    }
    // Just before the Discord call: a digest of the final content (mentions and emoji resolved) goes
    // into her intents with the line, so boot repair recognises this message after a crash (§5.7).
    const onFinalContent = async (final: string) => {
      if (!ctx.intent) return;
      await appendIntent(deps.storage, waifu.id, { ...ctx.intent, at: deps.now().toISOString(), line: step.line, contentDigest: contentDigest(final) });
    };
    let messageId: string;
    try {
      if (place.kind === "dm") {
        messageId = (
          await discord.sendDirectMessage!({
            waifuId: waifu.id,
            userId: place.userId!,
            content: send.text,
            ...(send.replyToId ? { replyToMessageId: send.replyToId } : {}),
            ...(send.files.length > 0 ? { files: send.files } : {}),
            onFinalContent
          })
        ).messageId;
      } else {
        messageId = (
          await discord.sendWaifuMessage({
            guildId: place.guildId!,
            channelId: place.channelId!,
            content: send.text,
            senderBotId: waifu.botId,
            ...(send.replyToId ? { replyToMessageId: send.replyToId } : {}),
            allowedUserMentionIds: await presentPeople(deps, place),
            ...(send.files.length > 0 ? { files: send.files } : {}),
            onFinalContent
          })
        ).messageId;
      }
    } catch (error) {
      let reason = "the message could not be sent";
      if (place.kind === "dm" && isUndeliverable(error)) {
        await updateExistingDmState(deps.storage, place.userId!, waifu.id, (state) => ({ ...state, undeliverableSince: deps.now().toISOString() })).catch(() => undefined);
        reason = "they can't receive your messages right now";
      } else if (send.files.length > 0 && isTooLarge(error)) {
        reason = "the message could not be sent: the files are too large for Discord here; send fewer or smaller ones";
      } else {
        deps.logger.warn("Life send failed", { waifuId: waifu.id, placeKey: place.placeKey, message: error instanceof Error ? error.message : String(error) });
        if (isNoAccess(error)) reason = "the message could not be sent: Discord says you can't post in this room right now; that can change, so try again later";
      }
      stop = { at, line: step.line, kind: "failed", reason };
      break;
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
    sentIds.push(messageId);
    sentTexts.push(send.text);
    if (ctx.intent) await appendIntent(deps.storage, waifu.id, { ...ctx.intent, at: now.toISOString(), line: step.line, lineDone: true, resultRef: messageId });
    deps.notices?.clear(`no-bot:${waifu.id}`);
    // Her message gets its ref after the messages before it get theirs (refs stay in message order, §4.7).
    await refsThrough(deps, place, [messageId]);
    await advanceReadCursor(deps.storage, waifu.id, place.placeKey, messageId, now);
    // A room's handle lets the dashboard name the place; a DM's handle would name the person.
    deps.logger.info("Life message sent", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, ...(place.placeKey.startsWith("dm_") ? {} : { place: place.handle }), messageId });
  }
  const refs = sentIds.length > 0 ? await refsThrough(deps, place, sentIds).catch(() => new Map<string, string>()) : new Map<string, string>();
  const left: string[] = [];
  if (stop) {
    for (const item of ready.slice(stop.at)) {
      if (item.step.kind === "send") left.push(`not sent: ${sendLabel(item.step)}`);
      else if (item.step.kind === "react") left.push(`not done: react #${item.step.ref} ${item.step.emoji}`);
    }
  }
  const cameLines = stop?.kind === "wait" ? await cameInLines(ctx, place, stop.came) : [];
  const nudge = sentTexts.length > 0 ? await lengthNudge(ctx, place, sentTexts) : undefined;
  return { place, sentIds, refs, reacted, ...(stop ? { stop } : {}), cameLines, left, ...(nudge ? { nudge } : {}), steps: ready.length };
}

/** Whether a send did nothing and stopped for a reason other than a wait (an error for her). */
function sendFailed(outcome: SendOutcome): string | undefined {
  const { stop } = outcome;
  if (outcome.sentIds.length > 0 || outcome.reacted.length > 0 || !stop || stop.kind === "wait") return undefined;
  return stop.kind === "interrupted" ? "interrupted before sending" : stop.reason;
}

/**
 * SendMessage with its pre-§32 arguments (`place` and a §27 script of lines, or `text`/`reply_to`/
 * `files`): a log line from before, run and reported as then.
 */
export async function sendMessageTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = parseInput(SendInput, input);
  if (!parsed.ok) return parsed.output;
  // The place first: a refused DM script is still a DM call (D14: resolving it records the place).
  const place = await resolvePlace(ctx.deps.storage, ctx.waifu.id, parsed.value.place);
  if (!place) return toolError(UNKNOWN_PLACE);
  const script = stepsOf(parsed.value, ctx.deps.config().life.send.maxFiles);
  if (!script.ok) return lineError(script.line, script.error);
  const outcome = await runSend(ctx, parsed.value.place, place, script.steps, { where: (line) => `line ${line}` });
  if ("error" in outcome) return toolError(outcome.error);
  const failedReason = sendFailed(outcome);
  if (failedReason !== undefined) {
    if (outcome.stop?.kind === "interrupted") return toolError(failedReason);
    // One line alone says just what happened; in a longer script, which line and that nothing went out.
    return toolError(outcome.steps === 1 ? failedReason : `line ${outcome.stop!.line}: ${failedReason}; nothing was sent`);
  }
  const done: string[] = [];
  if (outcome.sentIds.length > 0) done.push(`sent ${outcome.sentIds.map((id) => (outcome.refs.get(id) ? `#${outcome.refs.get(id)}` : "a message")).join(" ")}`);
  if (outcome.reacted.length > 0) done.push(`reacted to ${outcome.reacted.map((ref) => `#${ref}`).join(" ")}`);
  const lines: string[] = [];
  const stop = outcome.stop;
  if (stop) {
    const head = done.join(", ");
    const what = stop.kind === "wait" ? `stopped at line ${stop.line} (wait ${stop.seconds}):` : stop.kind === "failed" ? `line ${stop.line} failed: ${stop.reason}` : `interrupted at line ${stop.line}`;
    lines.push(head ? `${head}; ${what}` : what);
    lines.push(...outcome.cameLines, ...outcome.left);
  } else lines.push(done.join(", "));
  if (outcome.nudge) lines.push(outcome.nudge);
  const came = stop?.kind === "wait" ? stop.came : [];
  return {
    content: lines.join("\n"),
    ...(outcome.sentIds.length > 0 ? { resultRef: outcome.sentIds.join(","), sentPlaces: [place.placeKey] } : {}),
    messageIds: [...outcome.sentIds, ...came.map((message) => message.id)]
  };
}

// ---- SendMessage: tools.send_message (§32.2) ------------------------------------------------------------

/** send_message calls in one script (several places within the per-turn place cap). */
export const MAX_SEND_CALLS = 10;
const SEND_FIELDS = ["place", "messages"] as const;
/** A script's waits and typing, all its calls together. */
export const SEND_SCRIPT_WALL_MS = 150_000;

/** Her `messages` items as steps (§27's), numbered across the whole script for the intents. */
function stepsOfItems(items: unknown, firstLine: number, maxFiles: number): { steps: ScriptStep[]; labels: Map<number, string>; waited: number } {
  if (!Array.isArray(items) || items.length === 0) throw new ScriptError('tools.send_message: messages is a list, like [{ text: "hi" }]', "TypeError");
  if (items.length > 40) throw new ScriptError("tools.send_message: at most 40 items in messages", "RangeError");
  const steps: ScriptStep[] = [];
  const labels = new Map<number, string>();
  let waited = 0;
  items.forEach((raw, index) => {
    const label = `messages[${index}]`;
    const line = firstLine + index;
    labels.set(line, label);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ScriptError(`${label} is an object: { text }, { attach }, { react, to }, { wait } or { typing }`, "TypeError");
    const item = Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, value]) => value !== null && value !== undefined));
    const keys = Object.keys(item);
    const only = (allowed: readonly string[]) => {
      const extra = keys.find((key) => !allowed.includes(key));
      if (extra !== undefined) throw new ScriptError(`${label}: unknown field ${JSON.stringify(extra.slice(0, 40))} here (it takes ${allowed.join(", ")})`, "TypeError");
    };
    if ("text" in item || ("attach" in item && !("react" in item))) {
      only(["text", "reply_to", "attach"]);
      const text = item["text"] === undefined ? "" : textArg(`${label}.text`, item["text"], MAX_MESSAGE_CHARS)!.trim();
      const attach = item["attach"] === undefined ? [] : item["attach"];
      if (!Array.isArray(attach) || !attach.every((path) => typeof path === "string" && path.trim() !== "" && path.length <= 2_000)) throw new ScriptError(`${label}.attach is a list of paths in your folders, like ["~/cake.png"]`, "TypeError");
      if (attach.length > 0 && maxFiles <= 0) throw new ScriptError(`${label}: files can't be attached`, "TypeError");
      if (attach.length > maxFiles) throw new ScriptError(`${label}: at most ${maxFiles} file${maxFiles === 1 ? "" : "s"} per message`, "RangeError");
      if (!text && attach.length === 0) throw new ScriptError(`${label}: text is the message`, "TypeError");
      let replyTo: { ref: string; line: number } | undefined;
      if (item["reply_to"] !== undefined) {
        const ref = typeof item["reply_to"] === "string" ? refOfArg(item["reply_to"]) : undefined;
        if (!ref) throw new ScriptError(`${label}.reply_to is a message's ref, like "#k3"`, "TypeError");
        replyTo = { ref, line };
      }
      steps.push({ kind: "send", line, text, files: (attach as string[]).map((path) => ({ path: path.trim(), line })), ...(replyTo ? { replyTo } : {}) });
      return;
    }
    if ("react" in item) {
      only(["react", "to"]);
      const ref = typeof item["to"] === "string" ? refOfArg(item["to"]) : undefined;
      if (!ref) throw new ScriptError(`${label}.to is the ref of the message to react to, like "#k3"`, "TypeError");
      const emoji = textArg(`${label}.react`, item["react"], 100)!;
      steps.push({ kind: "react", line, ref, emoji: emoji.trim() });
      return;
    }
    if ("wait" in item) {
      only(["wait"]);
      const seconds = numberArg(`${label}.wait (seconds)`, item["wait"], 1, MAX_WAIT_SECONDS)!;
      waited += seconds;
      steps.push({ kind: "wait", line, seconds });
      return;
    }
    if ("typing" in item) {
      only(["typing"]);
      const seconds = numberArg(`${label}.typing (seconds)`, item["typing"], 1, MAX_TYPING_SECONDS)!;
      waited += seconds;
      steps.push({ kind: "typing", line, seconds });
      return;
    }
    throw new ScriptError(`${label} is { text, reply_to, attach }, { attach }, { react, to }, { wait } or { typing }`, "TypeError");
  });
  if (!steps.some((step) => step.kind === "send" || step.kind === "react")) throw new ScriptError('tools.send_message: there is nothing to send: add { text: "…" }', "TypeError");
  return { steps, labels, waited };
}

function refOfArg(raw: string): string | undefined {
  const ref = raw.trim().replace(/^#/u, "");
  return /^[0-9a-z]{1,12}$/iu.test(ref) ? ref.toLowerCase() : undefined;
}

/** The script's send state: its calls run one at a time, numbered, its waits and typing counted together. */
type SendScript = { queue: Promise<unknown>; calls: number; nextLine: number; waited: number };

/** One `tools.send_message({ place, messages })` (§32.2). */
async function sendMessageCall(arg: unknown, ctx: ToolContext, run: ScriptRun, script: SendScript): Promise<Record<string, unknown>> {
  const o = objectArg("send_message", arg, SEND_FIELDS, '{ place: "bake-club/#general", messages: [{ text: "hi" }] }');
  const placeArg = textArg("tools.send_message: place", o["place"], 200)!.trim();
  // The place first: a refused DM call is still a DM call (D14: resolving it records the place).
  const place = await resolvePlace(ctx.deps.storage, ctx.waifu.id, placeArg);
  if (!place) throw new ScriptError(`tools.send_message: unknown place ${placeArg.slice(0, 80)}; see ~/life/places.md`);
  const life = ctx.deps.config().life;
  const firstLine = script.nextLine;
  const { steps, labels, waited } = stepsOfItems(o["messages"], firstLine, life.send.maxFiles);
  script.nextLine += steps.length;
  // Waits and typing share one budget across the script (§27.1): it never holds her turn longer.
  if (script.waited + waited > MAX_WAIT_TOTAL_SECONDS) throw new ScriptError(`tools.send_message: waiting and typing add up to ${script.waited + waited} seconds in this script; at most ${MAX_WAIT_TOTAL_SECONDS}`, "RangeError");
  script.waited += waited;
  const call = (script.calls += 1);
  const where = (line: number) => labels.get(line) ?? "messages";
  const outcome = await runSend(ctx, placeArg, place, steps, {
    where,
    // Before the first Discord call: what this call means to send, for boot repair (§5.7).
    beforeSending: async (ready) => {
      if (!ctx.intent) return;
      const sends = ready.flatMap((item) => (item.step.kind === "send" ? [{ line: item.step.line, text: item.step.text, files: item.step.files.map((file) => file.path) }] : []));
      await appendIntent(ctx.deps.storage, ctx.waifu.id, { ...ctx.intent, at: ctx.deps.now().toISOString(), plan: { call, place: placeArg, sends } });
    }
  });
  if ("error" in outcome) throw new ScriptError(`tools.send_message: ${outcome.error.replace(/^error:\s*/u, "")}`);
  if (ctx.intent && outcome.steps > 0) await appendIntent(ctx.deps.storage, ctx.waifu.id, { ...ctx.intent, at: ctx.deps.now().toISOString(), callDone: call, ...(outcome.sentIds.length > 0 ? { resultRef: outcome.sentIds.join(",") } : {}) });
  const came = outcome.stop?.kind === "wait" ? outcome.stop.came : [];
  run.messageIds.push(...outcome.sentIds, ...came.map((message) => message.id));
  run.resultRefs.push(...outcome.sentIds);
  if (outcome.sentIds.length > 0) run.sentPlaces.add(place.placeKey);
  const failedReason = sendFailed(outcome);
  if (failedReason !== undefined) {
    if (outcome.stop?.kind === "interrupted") throw new ScriptError(`tools.send_message: ${failedReason}`);
    throw new ScriptError(`tools.send_message: ${outcome.steps === 1 ? failedReason : `${where(outcome.stop!.line)}: ${failedReason}; nothing was sent`}`);
  }
  const sent = outcome.sentIds.map((id) => (outcome.refs.get(id) ? `#${outcome.refs.get(id)}` : "a message"));
  const reactions = outcome.reacted.map((ref) => `#${ref}`);
  const result: Record<string, unknown> = { sent, reactions };
  const stop = outcome.stop;
  /** The item of this call's list at a script line (0-based). */
  const indexOf = (line: number) => line - firstLine;
  let ran = "the whole list ran";
  if (stop) {
    // A stopped wait ends this list only; the next item is where it stopped.
    const next = stop.kind === "wait" ? indexOf(stop.line) + 1 : indexOf(stop.line);
    if (stop.kind === "wait") result["stopped"] = { reason: "new_message", next_index: next, incoming: outcome.cameLines };
    else if (stop.kind === "failed") result["stopped"] = { reason: "send_failed", next_index: next, error: stop.reason };
    else result["stopped"] = { reason: "interrupted", next_index: next };
    const why = stop.kind === "wait" ? "someone wrote during the wait" : stop.kind === "failed" ? stop.reason : "interrupted";
    ran = next < steps.length ? `stopped (${why}): messages[${next}] and after were not sent` : `stopped (${why}) at its end`;
  }
  if (outcome.nudge) result["note"] = outcome.nudge;
  const did = [sent.length > 0 ? `sent ${sent.join(" ")}` : "", reactions.length > 0 ? `reacted to ${reactions.join(" ")}` : ""].filter(Boolean).join(", ");
  run.receipts.push(`send_message to ${placeArg}: ${did || "nothing sent"}; ${ran}`);
  return result;
}

async function sendScriptTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  // A call with a place is one from before §32 (a §27 script of lines, or one message).
  if (input !== null && typeof input === "object" && "place" in input) return sendMessageTool(input, ctx);
  const script: SendScript = { queue: Promise.resolve(), calls: 0, nextLine: 1, waited: 0 };
  return runScriptTool(input, ctx, {
    tool: "SendMessage",
    functions: [
      {
        name: "send_message",
        max: MAX_SEND_CALLS,
        maxArgChars: 128 * 1024,
        // One at a time, in the order she called them (her sends, intents and waits stay in order).
        run: (arg, run) => {
          const next = script.queue.then(() => sendMessageCall(arg, ctx, run, script));
          script.queue = next.catch(() => undefined);
          return next;
        }
      }
    ],
    wallMs: SEND_SCRIPT_WALL_MS
  });
}

// ---- ReadMessages: tools.read_messages (§32.2) ----------------------------------------------------------

/** read_messages calls in one script. */
export const MAX_READ_CALLS = 5;
/** What one ReadMessages script shows, at most (five calls of up to 100 messages in 5 places each). */
export const READ_MESSAGES_OUTPUT_CHARS = 100_000;
const READ_FIELDS = ["place", "around", "before", "after", "max", "people", "search"] as const;

/** A list field given as one text or a list of texts. */
function textList(where: string, value: unknown, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  const list = typeof value === "string" ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > max || !list.every((item) => typeof item === "string" && item.trim() !== "" && item.length <= 300)) {
    throw new ScriptError(`${where} is text or a list of at most ${max} texts`, "TypeError");
  }
  return list as string[];
}

/** One `tools.read_messages({ place, around | before | after, max, people, search })`: the §22 lines. */
async function readMessagesCall(arg: unknown, ctx: ToolContext, run: ScriptRun): Promise<string> {
  const o = objectArg("read_messages", arg, READ_FIELDS, '{ place: "bake-club/#general" }');
  const at = "tools.read_messages";
  const now = ctx.deps.now();
  const placeValue = o["place"];
  const handles = typeof placeValue === "string" ? placeValue.split(",").map((handle) => handle.trim()).filter(Boolean) : textList(`${at}: place`, placeValue, MAX_READ_PLACES)?.map((handle) => handle.trim());
  if (!handles || handles.length === 0) throw new ScriptError(`${at}: place is a place handle (like "bake-club/#general" or "dm/kevin"), a list of up to ${MAX_READ_PLACES}, or "everywhere"`, "TypeError");
  const query: ReadQuery = {};
  for (const key of ["around", "before", "after"] as const) {
    const raw = o[key];
    if (raw === undefined) continue;
    const anchor = typeof raw === "string" ? parseAnchor(raw, { now, timeZone: ctx.deps.timeZone }) : undefined;
    if (!anchor) throw new ScriptError(`${at}: ${key} is a #ref or a time, like "#k3", "2026-10-25 17:02", "2026-10-25", "17:02" or "yesterday 17:02"`, "TypeError");
    query[key] = anchor;
  }
  if (query.around && (query.before || query.after)) throw new ScriptError(`${at}: around can't be combined with before or after`, "TypeError");
  if (query.before && query.after) {
    const lo = anchorBounds(query.after).from;
    const hi = anchorBounds(query.before).to;
    if (lo !== undefined && hi !== undefined && lo >= hi) throw new ScriptError(`${at}: the range is empty: after must be earlier than before`, "RangeError");
  }
  const max = intArg(`${at}: max`, o["max"], 1, MAX_MESSAGES);
  if (max !== undefined) query.max = max;
  const people = textList(`${at}: people`, o["people"], 20);
  if (people) query.people = people.map((name) => fold(name.trim().replace(/^@/u, "")));
  const search = textList(`${at}: search`, o["search"], 20);
  if (search) {
    const alternatives = search.map(wordsOf).filter((words) => words.length > 0);
    if (alternatives.length === 0) throw new ScriptError(`${at}: search needs at least one word`, "TypeError");
    query.search = alternatives;
  }
  const result = await readMessagesQuery(ctx, handles.join(","), query);
  if (result.isError) failed(result, "read_messages");
  if (result.messageIds?.length) run.messageIds.push(...result.messageIds);
  return outputText(result);
}

async function readScriptTool(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
  // A call with a place is one from before §32 (`place` and a `query`).
  if (input !== null && typeof input === "object" && "place" in input) return readMessagesTool(input, ctx);
  return runScriptTool(input, ctx, {
    tool: "ReadMessages",
    functions: [{ name: "read_messages", max: MAX_READ_CALLS, run: (arg, run) => readMessagesCall(arg, ctx, run) }],
    outputChars: READ_MESSAGES_OUTPUT_CHARS
  });
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
  const emoji = await reactionEmoji(deps, place, args.emoji);
  if (!emoji.ok) return toolError(emoji.error);
  const discord = deps.discord();
  if (!discord?.addReaction || !waifu.botId) return toolError("you can't react right now");
  try {
    await discord.addReaction({ waifuId: waifu.id, botId: waifu.botId, conversation: place.ref, messageId, emoji: emoji.emoji });
  } catch (error) {
    deps.logger.warn("Life reaction failed", { waifuId: waifu.id, placeKey: place.placeKey, message: error instanceof Error ? error.message : String(error) });
    return toolError("the reaction could not be added");
  }
  deps.logger.info("Life reaction added", { category: "life", waifuId: waifu.id, placeKey: place.placeKey, ...(place.placeKey.startsWith("dm_") ? {} : { place: place.handle }), messageId });
  return { content: "reacted", resultRef: messageId };
}

function readMessagesDescription(retentionDays: number): string {
  return [
    `Read messages in your places (a room, thread or private chat). ${familyLines("read_messages")}`,
    `tools.read_messages({ place, around, before, after, max, people, search }) returns the lines as text. Lines look like \`[14:02 #k3] Kevin ↩#k1: text\`; \`#k3\` is the message's ref. Files people sent are saved in /tmp ${keptForText(retentionDays)} and shown by their path; open them with Read.`,
    '- place: a handle like "bake-club/#general" or "dm/kevin", a list of up to 5, or "everywhere" (with people or search).',
    '- around, before or after: a #ref (included) or a time: "2026-10-25 17:02", "2026-10-25" (that day), "17:02", "yesterday 17:02"; before and after together are a range. Nothing: the latest messages.',
    '- max: how many per place (1–100, default 15). people: names (you = yourself). search: words, or a list of alternatives (any one; every word of it must appear).',
    `At most ${MAX_READ_CALLS} reads in one script.`,
    'Example: return await tools.read_messages({ place: "bake-club/#general", around: "#k3", max: 10 })'
  ].join("\n");
}

const PRIVATE_ATTACH_TEXT = "MEMORY.md, the notes it links to and the files in ~/life/ can't be attached.";

/** SendMessage's description (§27.1, §32.2); attach only when attaching is on. */
function sendDescription(maxFiles: number): string {
  return [
    `Send messages. This is the only way anyone sees what you write. ${familyLines("send_message")}`,
    "tools.send_message({ place, messages }) sends to one place (call it again for another); messages is a list, in order:",
    '- { text } — one message; add reply_to: "#k3" to reply to a message',
    ...(maxFiles > 0 ? [`- attach: ["~/cake.png"] — a list of files from your folders with a message (at most ${maxFiles}); { attach } alone sends just the files. ${PRIVATE_ATTACH_TEXT} To post something you write as a file, add it with Edit first.`] : []),
    '- { react: "😂", to: "#k4" } — a reaction (a unicode emoji or :server_emoji:)',
    "- { wait: 5 } — pause 1–60 seconds; if anyone else writes there meanwhile, the rest isn't sent and you see what came in",
    "- { typing: 3 } — show typing for 1–10 seconds (waits and typing: at most 120 seconds in one script)",
    "Each item is exactly one of these. It returns { sent: [refs], reactions: [refs], stopped?: { reason, next_index, incoming } } (a wait someone cut short ends that list only). Keep each message as short as a chat line and send several instead of one long one. Use <@Name> to mention someone who is there. The whole list is checked first: if something is wrong, nothing of that call is sent. What was sent is listed after your output either way.",
    'Example: return await tools.send_message({ place: "bake-club/#general", messages: [{ text: "wait what" }, { text: "kevin you said saturday" }, { wait: 5 }, { text: "ok fine i\'m in", reply_to: "#k3" }, { react: "😂", to: "#k4" }] })'
  ].join("\n");
}

export const messageTools: LifeTool[] = [
  {
    name: "ReadMessages",
    description: readMessagesDescription(7),
    describe: (config) => readMessagesDescription(config.life.tmp.retentionDays),
    inputSchema: scriptSchema("JavaScript calling tools.read_messages({ place, … }) and text()."),
    sideEffect: false,
    run: readScriptTool
  },
  {
    name: "SendMessage",
    description: sendDescription(4),
    describe: (config) => sendDescription(config.life.send.maxFiles),
    inputSchema: scriptSchema("JavaScript calling tools.send_message({ place, messages: [ … ] })."),
    sideEffect: true,
    run: sendScriptTool
  },
  {
    // Not offered since §32 (send_message reacts); kept so old log lines still read.
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
