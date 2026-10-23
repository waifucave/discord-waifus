// Global memory snapshot (spec 6.5, 8.8): the memories a waifu sees for one epoch of one
// conversation, chosen for the people present, plus bounded mid-epoch inline notes. Implements
// the `MemorySnapshotProvider` contract; the context engine (T3) owns wiring it into prompts.

import path from "node:path";
import type { LedgerEntry } from "../shared/schemas/context.js";
import {
  type MemoryOrigin,
  type MemoryRecord,
  type MemorySubject,
  ServerConfigSchema
} from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import type { ConversationRef } from "./context/keys.js";
import type { MemorySnapshotProvider, Participant } from "./context/types.js";
import { type SubjectDirectory, loadSubjectDirectory, normalizeName, sameSubject, subjectNameResolver } from "./memorySubjects.js";
import { markMemoriesRetrieved, readMemoryStore } from "./stores/memories.js";
import { tokenSet } from "./text.js";

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type MemoryLineContext = {
  now: Date;
  nameFor(s: MemorySubject): string;
  placeFor(o: MemoryOrigin): string | undefined;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}

/** "just now" · "5 minutes ago" · "3 hours ago" · "yesterday" · "4 days ago" · "3 weeks ago" · … */
export function humanAge(fromIso: string, now: Date): string {
  const ms = Math.max(0, now.getTime() - Date.parse(fromIso));
  if (ms < 2 * MINUTE) return "just now";
  if (ms < HOUR) return plural(Math.round(ms / MINUTE), "minute");
  if (ms < DAY) return plural(Math.round(ms / HOUR), "hour");
  const days = Math.round(ms / DAY);
  if (days <= 1) return "yesterday";
  if (days < 14) return plural(days, "day");
  if (days < 60) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

function mentions(content: string, name: string): boolean {
  const key = normalizeName(name);
  return key.length > 0 && normalizeName(content).includes(key);
}

/**
 * `- Kevin: allergic to peanuts (fact · learned in Bake Club #general · 3 weeks ago)`.
 * Subject names are refreshed through `nameFor`; the "Name:" prefix lists only subjects the
 * content does not already name. DM origin renders "learned in a private chat" (O4); an
 * unknown place is left out. Waifu-tool notes (expiring `context` records) are labelled "note".
 */
export function renderMemoryLine(r: MemoryRecord, c: MemoryLineContext): string {
  const names = [...new Set(r.subjects.map((subject) => c.nameFor(subject)).filter(Boolean))];
  const missing = names.filter((name) => !mentions(r.content, name));
  const prefix = missing.length > 0 ? `${missing.join(" & ")}: ` : "";
  const content = r.content.trim().replace(/[.。]+$/u, "");
  const kind = r.expiresAt && r.kind === "context" ? "note" : r.kind;
  const place = r.origin.dm ? "a private chat" : c.placeFor(r.origin);
  const meta = [kind, place ? `learned in ${place}` : undefined, humanAge(r.createdAt, c.now)].filter(Boolean);
  return `- ${prefix}${content} (${meta.join(" · ")})`;
}

// ---------------------------------------------------------------------------
// Scoring (spec 8.8)
// score = 3.0·subjectMatch + 2.0·lexical + 1.0·recency + 0.6·strength/5 + 0.3·sameOrigin
//         − 0.5·diversity
// ---------------------------------------------------------------------------

export const SNAPSHOT_WEIGHTS = {
  subject: 3.0,
  lexical: 2.0,
  recency: 1.0,
  strength: 0.6,
  sameOrigin: 0.3,
  diversity: 0.5
} as const;
const RECENCY_HALF_LIFE_DAYS = 14;
const DIVERSITY_WINDOW_MS = 24 * HOUR;
const HUMAN_LINE_WEIGHT = 1.0;
const NON_HUMAN_LINE_WEIGHT = 0.4; // the waifu's own lines (and other bots')
/** Query window: the newest ledger entries considered for lexical matching. */
export const SNAPSHOT_QUERY_ENTRIES = 20;

export type QueryTokens = { human: Set<string>; other: Set<string> };

export function queryTokens(window: LedgerEntry[], limit = SNAPSHOT_QUERY_ENTRIES): QueryTokens {
  const human = new Set<string>();
  const other = new Set<string>();
  for (const entry of window.slice(-limit)) {
    if (entry.state === "deleted") continue;
    const target = entry.authorIsBot ? other : human;
    for (const token of tokenSet(entry.body)) target.add(token);
  }
  return { human, other };
}

export type ScoreContext = {
  participants: Participant[];
  query: QueryTokens;
  conversation: ConversationRef;
  now: Date;
  nameFor?: (s: MemorySubject) => string;
};

export function subjectMatch(record: MemoryRecord, participants: Participant[]): number {
  let best = 0;
  for (const subject of record.subjects) {
    for (const participant of participants) {
      const participantSubject: MemorySubject = participant.waifuId
        ? { waifuId: participant.waifuId, name: participant.displayName }
        : participant.discordUserId
          ? { discordUserId: participant.discordUserId, name: participant.displayName }
          : { name: participant.displayName };
      if (!sameSubject(subject, participantSubject)) continue;
      best = Math.max(best, participant.isHuman ? 1.0 : 0.6);
    }
  }
  return best;
}

export function lexicalMatch(record: MemoryRecord, query: QueryTokens, nameFor?: (s: MemorySubject) => string): number {
  const names = record.subjects.map((subject) => (nameFor ? nameFor(subject) : subject.name));
  const tokens = tokenSet(`${record.content} ${names.join(" ")}`);
  if (tokens.size === 0) return 0;
  let sum = 0;
  for (const token of tokens) {
    if (query.human.has(token)) sum += HUMAN_LINE_WEIGHT;
    else if (query.other.has(token)) sum += NON_HUMAN_LINE_WEIGHT;
  }
  return sum / tokens.size;
}

export function sameOriginScore(origin: MemoryOrigin, conversation: ConversationRef): number {
  if (conversation.kind === "dm") return origin.dm ? 1 : 0;
  if (origin.dm || origin.guildId !== conversation.guildId) return 0;
  return origin.channelId === conversation.channelId ? 1 : 0.5;
}

export function scoreMemoryRecord(record: MemoryRecord, c: ScoreContext): number {
  const ageDays = Math.max(0, (c.now.getTime() - Date.parse(record.updatedAt)) / DAY);
  const recency = Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS));
  const recentlyRetrieved =
    record.lastRetrievedAt !== undefined && c.now.getTime() - Date.parse(record.lastRetrievedAt) < DIVERSITY_WINDOW_MS
      ? 1
      : 0;
  return (
    SNAPSHOT_WEIGHTS.subject * subjectMatch(record, c.participants) +
    SNAPSHOT_WEIGHTS.lexical * lexicalMatch(record, c.query, c.nameFor) +
    SNAPSHOT_WEIGHTS.recency * recency +
    SNAPSHOT_WEIGHTS.strength * (record.strength / 5) +
    SNAPSHOT_WEIGHTS.sameOrigin * sameOriginScore(record.origin, c.conversation) -
    SNAPSHOT_WEIGHTS.diversity * recentlyRetrieved
  );
}

export function isRetrievable(record: MemoryRecord, waifuId: string, now: Date): boolean {
  return (
    record.waifuId === waifuId &&
    record.status === "active" &&
    (!record.expiresAt || Date.parse(record.expiresAt) > now.getTime())
  );
}

// Ties keep store (insertion) order: Array.prototype.sort is stable and inputs are store-ordered.
const byCreatedAt = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt);

export type SnapshotSelection = { records: MemoryRecord[]; scores: Map<string, number> };

/**
 * Pure snapshot selection: total ≤ limit, pinned ≤ maxPinned (best-scored pinned first), the
 * remaining slots by score. Output order is stable for the epoch: pinned, then durable, then
 * notes, each oldest first.
 */
export function selectSnapshotRecords(
  records: MemoryRecord[],
  i: { waifuId: string; conversation: ConversationRef; participants: Participant[]; window: LedgerEntry[];
    now: Date; limit: number; maxPinned: number; nameFor?: (s: MemorySubject) => string }
): SnapshotSelection {
  const context: ScoreContext = {
    participants: i.participants,
    query: queryTokens(i.window),
    conversation: i.conversation,
    now: i.now,
    ...(i.nameFor ? { nameFor: i.nameFor } : {})
  };
  const scores = new Map<string, number>();
  const ranked = records
    .filter((record) => isRetrievable(record, i.waifuId, i.now))
    .map((record) => {
      const score = scoreMemoryRecord(record, context);
      scores.set(record.id, score);
      return { record, score };
    })
    .sort((a, b) => b.score - a.score || byCreatedAt(a.record, b.record));
  const limit = Math.max(0, i.limit);
  const pinned = ranked.filter((item) => item.record.pinned).slice(0, Math.min(Math.max(0, i.maxPinned), limit));
  const rest = ranked.filter((item) => !item.record.pinned).slice(0, limit - pinned.length);
  const storeOrder = new Map(records.map((record, index) => [record.id, index]));
  const chronological = (a: MemoryRecord, b: MemoryRecord) =>
    byCreatedAt(a, b) || (storeOrder.get(a.id) ?? 0) - (storeOrder.get(b.id) ?? 0);
  const chosenPinned = pinned.map((item) => item.record).sort(chronological);
  const chosen = rest.map((item) => item.record);
  const durable = chosen.filter((record) => !record.expiresAt).sort(chronological);
  const notes = chosen.filter((record) => record.expiresAt).sort(chronological);
  return { records: [...chosenPinned, ...durable, ...notes], scores };
}

/** Inline-note thresholds: a new participant's memories, or a strong lexical hit on new lines. */
export const INLINE_NOTE_LEXICAL_THRESHOLD = 0.5;
export const INLINE_NOTE_MAX_LINES = 3;

/**
 * Pure mid-epoch note proposal. One note per newly arrived participant (their best memories, up
 * to 3 lines), then one note per strong lexical hit on human lines written since the epoch
 * started; never repeats `excludeIds`, at most `budget` notes.
 */
export function proposeInlineNoteRecords(
  records: MemoryRecord[],
  i: { waifuId: string; conversation: ConversationRef; participants: Participant[]; newParticipants: Participant[];
    excludeIds: string[]; window: LedgerEntry[]; epochStartedAt: string; now: Date; budget: number;
    nameFor?: (s: MemorySubject) => string }
): MemoryRecord[][] {
  if (i.budget <= 0) return [];
  const excluded = new Set(i.excludeIds);
  const eligible = records.filter((record) => isRetrievable(record, i.waifuId, i.now) && !excluded.has(record.id));
  const sinceEpoch = i.window.filter((entry) => entry.at >= i.epochStartedAt);
  const context: ScoreContext = {
    participants: i.participants,
    query: queryTokens(sinceEpoch),
    conversation: i.conversation,
    now: i.now,
    ...(i.nameFor ? { nameFor: i.nameFor } : {})
  };
  const score = (record: MemoryRecord) => scoreMemoryRecord(record, context);
  const notes: MemoryRecord[][] = [];
  const used = new Set<string>();
  for (const participant of i.newParticipants) {
    if (notes.length >= i.budget) break;
    const about = eligible
      .filter((record) => !used.has(record.id) && subjectMatch(record, [participant]) > 0)
      .sort((a, b) => score(b) - score(a) || byCreatedAt(a, b))
      .slice(0, INLINE_NOTE_MAX_LINES);
    if (about.length === 0) continue;
    about.forEach((record) => used.add(record.id));
    notes.push(about);
  }
  const humanOnly: QueryTokens = { human: context.query.human, other: new Set() };
  const lexicalHits = eligible
    .filter((record) => !used.has(record.id))
    .map((record) => ({ record, lexical: lexicalMatch(record, humanOnly, i.nameFor) }))
    .filter((item) => item.lexical >= INLINE_NOTE_LEXICAL_THRESHOLD)
    .sort((a, b) => b.lexical - a.lexical || score(b.record) - score(a.record));
  for (const hit of lexicalHits) {
    if (notes.length >= i.budget) break;
    used.add(hit.record.id);
    notes.push([hit.record]);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export type MemoryRenderDirectory = {
  nameFor(s: MemorySubject): string;
  placeFor(o: MemoryOrigin): string | undefined;
};

export type MemorySnapshotProviderDeps = {
  readMemories(): Promise<MemoryRecord[]>;
  /** Names/places for rendering; defaults to stored subject names and no place. */
  directory?(conversation: ConversationRef): Promise<MemoryRenderDirectory>;
  stampRetrieved?(ids: string[], now: Date): Promise<void>;
  onStampError?(error: unknown): void;
  /** In-memory throttle per memory id for markRetrieved (default 1 h). */
  throttleMs?: number;
};

const DEFAULT_DIRECTORY: MemoryRenderDirectory = { nameFor: (s) => s.name, placeFor: () => undefined };

export function createMemorySnapshotProvider(deps: MemorySnapshotProviderDeps): MemorySnapshotProvider {
  const throttleMs = deps.throttleMs ?? HOUR;
  const lastStamped = new Map<string, number>();
  const directoryFor = async (conversation: ConversationRef) =>
    deps.directory ? await deps.directory(conversation) : DEFAULT_DIRECTORY;
  return {
    async selectSnapshot(i) {
      const [records, directory] = await Promise.all([deps.readMemories(), directoryFor(i.conversation)]);
      const selection = selectSnapshotRecords(records, { ...i, nameFor: directory.nameFor });
      return {
        ids: selection.records.map((record) => record.id),
        lines: selection.records.map((record) => renderMemoryLine(record, { now: i.now, ...directory }))
      };
    },
    async proposeInlineNotes(i) {
      const [records, directory] = await Promise.all([deps.readMemories(), directoryFor(i.conversation)]);
      return proposeInlineNoteRecords(records, { ...i, nameFor: directory.nameFor }).map((group) => ({
        memoryIds: group.map((record) => record.id),
        text: group.map((record) => renderMemoryLine(record, { now: i.now, ...directory })).join("\n")
      }));
    },
    markRetrieved(ids, now) {
      if (!deps.stampRetrieved) return;
      const nowMs = now.getTime();
      const due = [...new Set(ids)].filter((id) => nowMs - (lastStamped.get(id) ?? -Infinity) >= throttleMs);
      if (due.length === 0) return;
      due.forEach((id) => lastStamped.set(id, nowMs));
      void deps.stampRetrieved(due, now).catch((error: unknown) => {
        due.forEach((id) => lastStamped.delete(id));
        deps.onStampError?.(error);
      });
    }
  };
}

/** Place names from server.json (`Bake Club #general`) for the given guilds; unknown → undefined. */
export async function loadPlaceResolver(
  storage: StorageService,
  guildIds: Iterable<string>
): Promise<(o: MemoryOrigin) => string | undefined> {
  const servers = new Map<string, { name?: string; channels: Record<string, { name?: string }> }>();
  for (const guildId of new Set(guildIds)) {
    try {
      const server = await storage.readJson(path.join("user", "servers", guildId, "server.json"), ServerConfigSchema);
      servers.set(guildId, { ...(server.name ? { name: server.name } : {}), channels: server.channels });
    } catch {
      // Unknown or unreadable server: its memories render without a place.
    }
  }
  return (o) => {
    if (o.dm || !o.guildId) return undefined;
    const server = servers.get(o.guildId);
    if (!server?.name) return undefined;
    const channel = o.channelId ? server.channels[o.channelId]?.name : undefined;
    return channel ? `${server.name} #${channel}` : server.name;
  };
}

/**
 * The production provider over the data root: reads user/memories.json on every call, refreshes
 * subject names from the conversation guild's member cache and the configured waifus, resolves
 * places from server.json, and stamps lastRetrievedAt (throttled, never bumping revisions).
 */
export function createStorageMemorySnapshotProvider(
  storage: StorageService,
  options: { onStampError?: (error: unknown) => void; throttleMs?: number } = {}
): MemorySnapshotProvider {
  return createMemorySnapshotProvider({
    readMemories: async () => (await readMemoryStore(storage)).memories,
    directory: async (conversation) => {
      const records = (await readMemoryStore(storage)).memories;
      const directories: SubjectDirectory[] = [
        await loadSubjectDirectory(storage, conversation.kind === "guild" ? conversation.guildId : undefined)
      ];
      const placeFor = await loadPlaceResolver(
        storage,
        records.map((record) => record.origin.guildId).filter((id): id is string => Boolean(id))
      );
      return { nameFor: subjectNameResolver(directories), placeFor };
    },
    stampRetrieved: (ids, now) => markMemoriesRetrieved(storage, ids, now),
    ...(options.onStampError ? { onStampError: options.onStampError } : {}),
    ...(options.throttleMs !== undefined ? { throttleMs: options.throttleMs } : {})
  });
}
