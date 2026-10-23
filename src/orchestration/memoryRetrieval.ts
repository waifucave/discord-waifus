// Legacy retrieval entry point for the pre-context-engine prompt path (`buildWaifuPromptParts`).
// Memories are global (D2): `guildId`/`channelId` only feed the small same-origin boost. Scoring
// and caps are the snapshot provider's (memorySnapshot.ts); T3 replaces this module's caller
// with the epoch snapshot.

import type { LedgerEntry } from "../shared/schemas/context.js";
import { MemoryRecord } from "../shared/schemas/domain.js";
import type { ContextMessage } from "./contextMessages.js";
import type { Participant } from "./context/types.js";
import { scoreMemoryRecord, queryTokens, selectSnapshotRecords } from "./memorySnapshot.js";

export type RetrievalInput = {
  records: MemoryRecord[];         // the whole store; this module filters waifu/active/expiry
  window: ContextMessage[];        // recent context
  guildId: string;
  waifuId: string;
  channelId: string;
  now: Date;
  limit: number;                   // total cap (pinned included)
  maxPinned?: number;              // default 6 (memory.maxPinnedInjected)
};

export type RetrievalResult = {
  selected: MemoryRecord[];        // pinned first, then durable, then notes
  lines: string[];                 // rendered for the legacy prompt block
};

const DEFAULT_MAX_PINNED = 6;

/** Adapter: legacy context messages as ledger-shaped entries (for the shared scorer). */
export function contextMessagesAsEntries(window: ContextMessage[]): LedgerEntry[] {
  return window.map((message, index) => ({
    id: message.id,
    seq: index,
    authorId: message.authorId,
    authorName: message.displayName || message.name,
    authorIsBot: message.authorKind === "waifu" || message.authorBot === true,
    at: message.timestamp,
    kind: "default",
    body: message.content,
    images: [],
    state: "live",
    sealed: false
  }));
}

/** Participants seen in the window (humans by Discord id; bots as non-human participants). */
export function participantsFromContext(window: ContextMessage[]): Participant[] {
  const seen = new Map<string, Participant>();
  for (const message of window) {
    if (seen.has(message.authorId)) continue;
    const isHuman = message.authorKind === "user" && message.authorBot !== true;
    seen.set(message.authorId, {
      discordUserId: message.authorId,
      displayName: message.displayName || message.name,
      isHuman
    });
  }
  return [...seen.values()];
}

export function scoreMemory(record: MemoryRecord, window: ContextMessage[], guildId: string, channelId: string, now: Date): number {
  return scoreMemoryRecord(record, {
    participants: participantsFromContext(window),
    query: queryTokens(contextMessagesAsEntries(window)),
    conversation: { kind: "guild", guildId, channelId },
    now
  });
}

export function relativeAge(from: string, now: Date): string {
  const minutes = Math.max(1, Math.round((now.getTime() - Date.parse(from)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderLine(record: MemoryRecord, now: Date): string {
  if (record.expiresAt !== undefined) {
    return `- (note, ${relativeAge(record.createdAt, now)}) ${record.content}`;
  }
  return `- (${record.kind}) ${record.content}`;
}

export function retrieveMemories(input: RetrievalInput): RetrievalResult {
  const selection = selectSnapshotRecords(input.records, {
    waifuId: input.waifuId,
    conversation: { kind: "guild", guildId: input.guildId, channelId: input.channelId },
    participants: participantsFromContext(input.window),
    window: contextMessagesAsEntries(input.window),
    now: input.now,
    limit: input.limit,
    maxPinned: input.maxPinned ?? DEFAULT_MAX_PINNED
  });
  return {
    selected: selection.records,
    lines: selection.records.map((record) => renderLine(record, input.now))
  };
}
