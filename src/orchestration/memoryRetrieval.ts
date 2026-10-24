// Legacy ContextMessage adapter. The waifu prompt uses the epoch memory snapshot (T3); this
// remains for the observer's legacy window (observer.ts windowEntries).

import type { LedgerEntry } from "../shared/schemas/context.js";
import type { ContextMessage } from "./contextMessages.js";

/** Adapter: legacy context messages as ledger-shaped entries. */
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
