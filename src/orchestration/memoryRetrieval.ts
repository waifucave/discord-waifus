import { MemoryRecord } from "../shared/schemas/domain.js";
import { ContextMessage } from "./context.js";

export type RetrievalInput = {
  records: MemoryRecord[];         // pre-filtered: guild+waifu+active; this module re-checks expiry
  window: ContextMessage[];        // recent context (last ~12 used)
  guildId: string;
  waifuId: string;
  channelId: string;
  now: Date;
  limit: number;                   // scored-record cap; pinned are extra
};

export type RetrievalResult = {
  selected: MemoryRecord[];        // pinned first, then top-scored
  lines: string[];                 // rendered for the prompt block
};

const WINDOW_MESSAGES = 12;
const RECENCY_HALF_LIFE_DAYS = 7;
const FRESH_NOTE_HOURS = 48;

// Copied verbatim from loopDetector.ts — modules stay decoupled per W1 precedent.
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by", "from",
  "that", "this", "these", "those", "it", "its", "as", "into", "about",
  "i", "you", "he", "she", "they", "we", "them", "his", "her", "their",
  "do", "does", "did", "have", "has", "had", "will", "would", "should", "could", "can",
  "not", "no", "yes", "so", "than", "then", "very", "just", "also", "too"
]);

// Copied verbatim from loopDetector.ts — modules stay decoupled per W1 precedent.
export function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token))
  );
}

function overlap(memoryTokens: Set<string>, windowTokens: Set<string>): number {
  if (memoryTokens.size === 0 || windowTokens.size === 0) return 0;
  let hits = 0;
  for (const token of memoryTokens) if (windowTokens.has(token)) hits += 1;
  return hits / memoryTokens.size;  // fraction of the memory grounded in the window
}

export function scoreMemory(record: MemoryRecord, windowTokens: Set<string>, channelId: string, now: Date): number {
  const memoryTokens = tokenSet(`${record.content} ${record.entities.join(" ")}`);
  const lexical = overlap(memoryTokens, windowTokens);
  const ageDays = Math.max(0, (now.getTime() - Date.parse(record.updatedAt)) / 86_400_000);
  const recency = Math.exp(-Math.LN2 * (ageDays / RECENCY_HALF_LIFE_DAYS));
  const channelMatch = record.channelId === channelId ? 1 : 0;
  const freshNote =
    record.source === "waifu_tool" &&
    now.getTime() - Date.parse(record.createdAt) < FRESH_NOTE_HOURS * 3_600_000
      ? 1
      : 0;
  return 2.0 * lexical + 1.0 * recency + 0.6 * (record.strength / 5) + 0.4 * channelMatch + 0.4 * freshNote;
}

export function relativeAge(from: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function isNote(record: MemoryRecord): boolean {
  return record.expiresAt !== undefined;
}

function renderLine(record: MemoryRecord, now: Date): string {
  if (isNote(record)) {
    const age = relativeAge(record.createdAt, now);
    return `- (note, ${age}) ${record.content}`;
  }
  return `- (${record.kind}) ${record.content}`;
}

export function retrieveMemories(input: RetrievalInput): RetrievalResult {
  const { records, window, guildId, waifuId, channelId, now, limit } = input;
  const nowMs = now.getTime();

  // Defensive re-check: filter by guild, waifu, active status, and expiry
  const eligible = records.filter(
    (record) =>
      record.guildId === guildId &&
      record.waifuId === waifuId &&
      record.status === "active" &&
      (!record.expiresAt || Date.parse(record.expiresAt) > nowMs)
  );

  // Split pinned (always selected, not counted against limit) from the rest
  const pinned = eligible.filter((record) => record.pinned);
  const candidates = eligible.filter((record) => !record.pinned);

  // Build window token set from the last WINDOW_MESSAGES context messages
  const windowText = window
    .slice(-WINDOW_MESSAGES)
    .map((msg) => msg.content)
    .join(" ");
  const windowTokens = tokenSet(windowText);

  // Score non-pinned candidates
  const scored = candidates
    .map((record) => ({ record, score: scoreMemory(record, windowTokens, channelId, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.record);

  // Order within the scored set: durable (no expiresAt) → notes (has expiresAt), each oldest→newest by createdAt
  const byCreatedAt = (a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt);
  const durable = scored.filter((r) => !isNote(r)).sort(byCreatedAt);
  const notes = scored.filter((r) => isNote(r)).sort(byCreatedAt);

  // Pinned records ordered oldest→newest by createdAt
  const pinnedSorted = [...pinned].sort(byCreatedAt);

  // Final ordering: pinned → durable → notes
  const selected = [...pinnedSorted, ...durable, ...notes];
  const lines = selected.map((record) => renderLine(record, now));

  return { selected, lines };
}
