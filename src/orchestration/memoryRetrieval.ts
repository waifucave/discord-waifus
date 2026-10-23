// Legacy ContextMessage adapters over the snapshot scorer (memorySnapshot.ts). The waifu prompt
// uses the epoch memory snapshot (T3); these remain for the observer's legacy window.

import type { LedgerEntry } from "../shared/schemas/context.js";
import { MemoryRecord } from "../shared/schemas/domain.js";
import type { ContextMessage } from "./contextMessages.js";
import type { Participant } from "./context/types.js";
import { scoreMemoryRecord, queryTokens } from "./memorySnapshot.js";

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
