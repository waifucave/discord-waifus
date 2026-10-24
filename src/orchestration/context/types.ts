// Shared contracts of the Phase 4 context engine (spec 8.1, 8.3, 8.9). Types only, plus the
// NoopCompaction value; implementations land in later tasks (T2 engine, T6 memory, T7b compaction).

import type { ChatMessage, FinishReason, ImageBlock, TextBlock, ToolDef } from "@waifucave/gateway";
import type { CompactionSettings } from "../../shared/schemas/compaction.js";
import type { ContextNote, ContextState, LedgerEntry } from "../../shared/schemas/context.js";
import type { ImageRef, RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import type { MemoryKind, MemoryOrigin, MemorySource, MemorySubject } from "../../shared/schemas/domain.js";
import type { UsagePurpose } from "../../shared/schemas/usage.js";
import type { ContextAgent, ConversationKey, ConversationRef } from "./keys.js";

export type { CompactionSettings, UsagePurpose };
// One source of truth: the persisted zod schemas in shared/schemas/domain.ts (spec 8.2).
export type { MemoryOrigin, MemorySubject };

export type BuiltPrompt = {
  messages: ChatMessage[]; // cacheControl on A (system), B (header), C (last transcript block)
  tools: ToolDef[]; // stable per agent + conversation config
  promptCacheKey: string;
  refToMessageId: ReadonlyMap<string, string>;
  messageIdToRef: ReadonlyMap<string, string>;
  estimatedTokens: number;
  transcriptCount: number;
  cursorSeq: number | null;
  breakpoint: { kind: "entry" | "note"; seq: number } | null; // block that carries C
  debug: { system: string; header: string; transcript: string; tail: string }; // /print, inspector
};

// Phase 4: implemented over members/emojis/roles.json + the discord.js channel cache;
// Phase 5: GuildDirectory (spec 9.4).
export type GuildDirectoryView = {
  memberName(userId: string): string | undefined;
  roleName(id: string): string | undefined;
  channelName(id: string): string | undefined;
  emoji(id: string): string | undefined;
};

export type MessageRenderer = {
  render(
    m: RawDiscordMessage,
    dir: GuildDirectoryView,
    tz: string
  ): { body: string; images: ImageRef[]; kind: "default" | "system" } | null; // null = dropped system message
};

export type FrozenImages = {
  blocksFor(entry: LedgerEntry, state: ContextState): Promise<Array<TextBlock | ImageBlock>>;
};

// Omit over a union collapses to the common keys, so distribute it over each note kind.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewContextNote = DistributiveOmit<ContextNote, "id" | "seq" | "anchorSeq">;

export type PreparedContext = {
  conversation: ConversationRef;
  agent: ContextAgent;
  key: ConversationKey;
  state: ContextState;
  prompt: BuiltPrompt;
  transcript: LedgerEntry[];
  modelKey: string;
  startedAt: Date;
};

export type CandidateMemory = {
  waifuId: string;
  kind: MemoryKind;
  content: string;
  subjects: MemorySubject[];
  origin: MemoryOrigin;
  importance?: number;
  source: MemorySource;
};

export interface ContextStore {
  load(k: ConversationKey, a: ContextAgent): Promise<ContextState>;
  update(k: ConversationKey, a: ContextAgent, fn: (s: ContextState) => ContextState): Promise<ContextState>;
  assignRefs(k: ConversationKey, messageIds: string[]): Promise<Map<string, string>>;
  reconcileLedger(k: ConversationKey, fetched: RawDiscordMessage[], render: MessageRenderer): Promise<LedgerEntry[]>;
  sealLedger(k: ConversationKey, ids: string[], eventSeqs: number[]): Promise<void>;
  deleteConversation(k: ConversationKey): Promise<void>;
}

export type Participant = { discordUserId?: string; waifuId?: string; displayName: string; isHuman: boolean };

export interface MemorySnapshotProvider {
  selectSnapshot(i: {
    waifuId: string;
    conversation: ConversationRef;
    participants: Participant[];
    window: LedgerEntry[];
    now: Date;
    limit: number;
    maxPinned: number;
  }): Promise<{ ids: string[]; lines: string[] }>;
  proposeInlineNotes(i: {
    waifuId: string;
    conversation: ConversationRef;
    participants: Participant[];
    newParticipants: Participant[];
    excludeIds: string[];
    window: LedgerEntry[];
    epochStartedAt: string;
    now: Date;
    budget: number;
  }): Promise<Array<{ memoryIds: string[]; text: string }>>;
  markRetrieved(ids: string[], now: Date): void; // fire-and-forget, throttled
}

export type TokenBudget = {
  contextTokens: number;
  maxOutputTokens: number;
  triggerRatio: number;
  budgetTokens: number;
};

export type CompactionTrigger = "tokens" | "messages" | "overflow" | "manual";

export interface CompactionService {
  check(i: {
    state: ContextState;
    prompt: BuiltPrompt;
    budget: TokenBudget;
    settings: CompactionSettings;
  }): CompactionTrigger | undefined;
  compact(i: CompactInput): Promise<CompactionOutcome | void>;
  inFlight(k: ConversationKey, a: ContextAgent): Promise<CompactionOutcome | void> | undefined;
}

/**
 * A summarize call's result. `finishReason: "length"` means the summary was cut off; compaction
 * never stores it. A plain string (legacy shape) is accepted as a complete summary.
 */
export type SummaryResult = { text: string; finishReason?: FinishReason };
export type Summarize = (p: BuiltPrompt, instruction: string) => Promise<string | SummaryResult>;

export type CompactInput = {
  conversation: ConversationRef;
  agent: ContextAgent;
  prompt: BuiltPrompt;
  trigger: CompactionTrigger;
  summarize: Summarize;
  settings: CompactionSettings;
  /** Stops the caller waiting (rejects with the abort reason); the compaction itself continues. */
  signal?: AbortSignal;
  /**
   * Additive (T7b): the context state `prompt` was built from. It may be a not-yet-persisted
   * fresh epoch (first prepare, or a context idle beyond the pruning horizon), so the compaction
   * builds on it when the stored revision is unchanged. Default: the stored state at start.
   */
  basedOn?: ContextState;
  /** Additive (T7b): the agent's token budget; sizes the kept window and the overflow prompt. */
  budget?: TokenBudget;
  /** Additive (T7b): the agent's own author ids (their messages show no ref). */
  selfAuthorIds?: string[];
};

export type CompactionOutcome =
  | { status: "compacted"; trigger: CompactionTrigger; epoch: number; cursorSeq: number }
  | { status: "skipped"; reason: string }
  | { status: "discarded"; reason: string };

/** Compaction that never triggers and never runs: the default until T7b lands. */
export const NoopCompaction: CompactionService = {
  check: () => undefined,
  compact: async () => undefined,
  inFlight: () => undefined
};

export type ModelCallAttribution = {
  purpose: UsagePurpose;
  agentId?: string;
  waifuId?: string;
  guildId?: string;
  channelId?: string;
  conversationKey?: string;
};

export type RoleRenderer = {
  system(): string;
  header(snapshot: { lines: string[] }, state: ContextState): string;
  // `transcript`: the entries this build renders (additive; the orchestrator derives its runtime
  // notices from them); `retryNote` (the waifu's corrective second attempt, tail-only). The tail is
  // never cached or stored, so it may depend on anything.
  tail(
    state: ContextState,
    now: Date,
    extras: { recentReactions?: string[]; transcript?: readonly LedgerEntry[]; retryNote?: string }
  ): string;
  tools(): ToolDef[];
};

// Phase 4: thin REST adapter; Phase 5: ConversationMessageCache (spec 9.4).
export interface ConversationMessageSource {
  // afterMessageId = id of the NEWEST ledger entry (null on an empty ledger), not the cursor, so a
  // pass only downloads what is new; the backfill (bounded by backfillCap) runs only at epoch start.
  fetchSince(i: {
    conversation: ConversationRef;
    afterMessageId: string | null;
    maxMessages: number;
    signal?: AbortSignal;
  }): Promise<{ messages: RawDiscordMessage[]; reachedCursor: boolean }>;
}
