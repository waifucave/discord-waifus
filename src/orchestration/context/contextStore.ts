// File-backed ContextStore (spec 8.1/8.3) over StorageService's per-resource locks:
//   user/conversations/<key>/contexts/<agentId>.json  (resource `context:<key>:<agentId>`)
//   user/conversations/<key>/refs.json                (resource `refs:<key>`)
//   user/conversations/<key>/ledger.json              (resource `ledger:<key>`)
// Locks are not re-entrant, so every multi-resource operation takes all of its locks once
// (StorageService.withLocks sorts them) and then uses the raw read/write helpers below.

import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { resolveDataPath } from "../../config/paths.js";
import { CURRENT_SCHEMA_VERSION, bumpRevision, type RevisionedRecord } from "../../shared/schemas/common.js";
import {
  ContextStateSchema,
  ConversationLedgerSchema,
  ConversationRefsSchema,
  REF_COUNTER_START,
  type ContextState,
  type ConversationLedger,
  type ConversationRefs,
  type LedgerEntry
} from "../../shared/schemas/context.js";
import type { RawDiscordMessage } from "../../shared/schemas/discordMessage.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import type { StorageService } from "../../storage/storageService.js";
import {
  ContextAgent,
  ConversationKey,
  contextAgentId,
  contextStatePath,
  conversationLedgerPath,
  conversationRefsPath,
  parseConversationKey
} from "./keys.js";
import {
  ACTIVE_CONTEXT_MS,
  DEFAULT_REDACT_RECENT,
  applyDeletes,
  applyEdit,
  detectGapDeletes,
  entryRenderHash,
  newestSeq,
  observerPruneCursor,
  orderedEntries,
  pruneLedgerEntries,
  reconcileEntries,
  sealEntries,
  type EditOutcome
} from "./ledger.js";
import { EMPTY_GUILD_DIRECTORY } from "./messageRender.js";
import { assignRefsTo, pruneRefs } from "./refs.js";
import { hostTimeZone } from "./timeFormat.js";
import type { ContextStore, GuildDirectoryView, MessageRenderer } from "./types.js";

export const contextResourceKey = (k: ConversationKey, a: ContextAgent) => `context:${k}:${contextAgentId(a)}`;
export const refsResourceKey = (k: ConversationKey) => `refs:${k}`;
export const ledgerResourceKey = (k: ConversationKey) => `ledger:${k}`;
/** The stage-manager observer's cursor file (observerCursor.ts) sits beside the agent contexts. */
const OBSERVER_AGENT_ID = contextAgentId({ kind: "stage-manager" });

export type ReconcileLedgerOptions = {
  dir?: GuildDirectoryView;
  timeZone?: string;
  gapBeforeNew?: boolean;
};

export type MessageChangeOptions = ReconcileLedgerOptions & {
  /** Spec 9.5: a deleted message among the newest N entries (or unsealed) is redacted in place. */
  redactRecent?: number;
};

export type DeleteSummary = {
  redacted: string[];
  marked: string[];
  unknown: string[];
  /** Images of redacted entries: the caller purges them from the image cache. */
  purgedImages: LedgerEntry["images"];
};

export type WindowReconcileSummary = {
  edits: Record<string, EditOutcome>;
  deletes: DeleteSummary;
};

export type CommitPrepareInput = {
  /** Ledger entries the build rendered (sealed in this write). */
  sealIds: string[];
  /**
   * entryRenderHash of each sealed entry as the build rendered it. Any mismatch (the entry was
   * replaced meanwhile) aborts the whole write with `{ conflict: "ledger" }`.
   */
  expectedHashes?: Record<string, string>;
  eventSeqs?: number[];
  /**
   * Context-state transform applied in the same locked section; returning undefined aborts the
   * whole write (nothing sealed or persisted) with `{ conflict: "state" }`.
   */
  update: (current: ContextState) => ContextState | undefined;
};

export type CommitPrepareResult = { ok: true; state: ContextState } | { ok: false; conflict: "state" | "ledger" };

/** The engine's store: the spec 8.1 ContextStore plus the reads/one-write the runtime needs. */
export interface ContextEngineStore extends ContextStore {
  reconcileLedger(
    k: ConversationKey,
    fetched: RawDiscordMessage[],
    render: MessageRenderer,
    o?: ReconcileLedgerOptions
  ): Promise<LedgerEntry[]>;
  loadLedger(k: ConversationKey): Promise<ConversationLedger>;
  loadRefs(k: ConversationKey): Promise<ConversationRefs>;
  /** Spec 9.5: one Discord message was edited. Never creates a ledger for a conversation without one. */
  applyMessageEdit(
    k: ConversationKey,
    message: RawDiscordMessage,
    render: MessageRenderer,
    o?: MessageChangeOptions
  ): Promise<EditOutcome>;
  /** Spec 9.5 hybrid delete for one or more messages (event, bulk delete or a gap in a page). */
  applyMessageDeletes(k: ConversationKey, ids: string[], o?: MessageChangeOptions): Promise<DeleteSummary>;
  /**
   * Catch-up over a CONTIGUOUS page of recent messages (after downtime or a reconnect): edits to
   * entries the ledger holds become events, ledger entries missing from the page's id range are
   * deleted. Messages the ledger does not hold are left for the next prepare (so its "earlier
   * messages not loaded" rule still applies).
   */
  reconcileWindow(
    k: ConversationKey,
    page: RawDiscordMessage[],
    render: MessageRenderer,
    o?: MessageChangeOptions
  ): Promise<WindowReconcileSummary>;
  /** Seal + state update + pruning under one set of locks (spec 8.3 "in ONE write"). */
  commitPrepare(k: ConversationKey, a: ContextAgent, i: CommitPrepareInput): Promise<CommitPrepareResult>;
  /** Prune ledger entries and refs below the minimum cursor of active contexts (spec 8.1). */
  pruneConversation(k: ConversationKey): Promise<{ removed: number }>;
  /**
   * State update given the newest ledger seq, read under the ledger and context locks together
   * (note anchors: nothing can be reconciled between reading the anchor and writing the note).
   */
  updateAnchored?(k: ConversationKey, a: ContextAgent, fn: (s: ContextState, newestSeq: number) => ContextState): Promise<ContextState>;
}

export type FileContextStoreOptions = {
  now?: () => Date;
  timeZone?: () => string;
  /** Newest ledger entries pruning never touches (default LEDGER_PROTECT_NEWEST). */
  pruneProtectNewest?: number;
};

export function defaultContextState(
  k: ConversationKey,
  a: ContextAgent,
  now: Date,
  timeZone: string
): ContextState {
  const iso = now.toISOString();
  return ContextStateSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: iso,
    conversationKey: k,
    agentId: contextAgentId(a),
    epoch: 0,
    epochStartedAt: iso,
    lastUsedAt: iso,
    timeZone
  });
}

function defaultRefs(k: ConversationKey, now: Date): ConversationRefs {
  return ConversationRefsSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    conversationKey: k,
    counter: REF_COUNTER_START
  });
}

function defaultLedger(k: ConversationKey, now: Date): ConversationLedger {
  return ConversationLedgerSchema.parse({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    conversationKey: k
  });
}

const DELETED_BEFORE_SEEN_TTL_MS = 10 * 60_000;
const DELETED_BEFORE_SEEN_MAX = 500;

export class FileContextStore implements ContextEngineStore {
  // Per conversation: ids deleted before the ledger held them (id → expiry), so a fetch that raced
  // the delete event cannot insert them afterwards. In memory: the race is seconds wide.
  private readonly deletedBeforeSeen = new Map<string, Map<string, number>>();
  private readonly now: () => Date;
  private readonly timeZone: () => string;
  private readonly protectNewest: number | undefined;

  constructor(
    private readonly storage: StorageService,
    options: FileContextStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? hostTimeZone;
    this.protectNewest = options.pruneProtectNewest;
  }

  async load(k: ConversationKey, a: ContextAgent): Promise<ContextState> {
    return this.readState(k, a);
  }

  async update(k: ConversationKey, a: ContextAgent, fn: (s: ContextState) => ContextState): Promise<ContextState> {
    return this.storage.locks.withLock(contextResourceKey(k, a), async () => {
      const current = await this.readState(k, a);
      return this.writeRecord(contextStatePath(k, a), ContextStateSchema, fn(structuredClone(current)));
    });
  }

  async updateAnchored(
    k: ConversationKey,
    a: ContextAgent,
    fn: (s: ContextState, newestSeq: number) => ContextState
  ): Promise<ContextState> {
    return this.storage.withLocks([ledgerResourceKey(k), contextResourceKey(k, a)], async () => {
      const ledger = await this.loadLedger(k);
      const current = await this.readState(k, a);
      return this.writeRecord(contextStatePath(k, a), ContextStateSchema, fn(structuredClone(current), newestSeq(ledger)));
    });
  }

  async loadLedger(k: ConversationKey): Promise<ConversationLedger> {
    return this.storage.readJson(conversationLedgerPath(k), ConversationLedgerSchema, defaultLedger(k, this.now()));
  }

  async loadRefs(k: ConversationKey): Promise<ConversationRefs> {
    return this.storage.readJson(conversationRefsPath(k), ConversationRefsSchema, defaultRefs(k, this.now()));
  }

  async assignRefs(k: ConversationKey, messageIds: string[]): Promise<Map<string, string>> {
    return this.storage.locks.withLock(refsResourceKey(k), async () => {
      let refs = await this.loadRefs(k);
      const next = assignRefsTo(refs, messageIds);
      if (next) refs = await this.writeRecord(conversationRefsPath(k), ConversationRefsSchema, next);
      const out = new Map<string, string>();
      for (const id of messageIds) {
        const ref = refs.refs[id];
        if (ref !== undefined) out.set(id, ref);
      }
      return out;
    });
  }

  async reconcileLedger(
    k: ConversationKey,
    fetched: RawDiscordMessage[],
    render: MessageRenderer,
    o: ReconcileLedgerOptions = {}
  ): Promise<LedgerEntry[]> {
    return this.storage.locks.withLock(ledgerResourceKey(k), async () => {
      let ledger = await this.loadLedger(k);
      const result = reconcileEntries(ledger, fetched, render, this.reconcileOptions(k, o));
      if (result.changed) {
        ledger = await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, result.ledger);
      }
      return orderedEntries(ledger);
    });
  }

  async applyMessageEdit(
    k: ConversationKey,
    message: RawDiscordMessage,
    render: MessageRenderer,
    o: MessageChangeOptions = {}
  ): Promise<EditOutcome> {
    return this.storage.locks.withLock(ledgerResourceKey(k), async () => {
      const ledger = await this.loadLedger(k);
      const result = applyEdit(ledger, message, render, this.reconcileOptions(k, o));
      if (result.ledger !== ledger) await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, result.ledger);
      return result.outcome;
    });
  }

  async applyMessageDeletes(k: ConversationKey, ids: string[], o: MessageChangeOptions = {}): Promise<DeleteSummary> {
    return this.storage.locks.withLock(ledgerResourceKey(k), async () => {
      const ledger = await this.loadLedger(k);
      return this.deleteLocked(k, ledger, ids, o);
    });
  }

  async reconcileWindow(
    k: ConversationKey,
    page: RawDiscordMessage[],
    render: MessageRenderer,
    o: MessageChangeOptions = {}
  ): Promise<WindowReconcileSummary> {
    return this.storage.locks.withLock(ledgerResourceKey(k), async () => {
      let ledger = await this.loadLedger(k);
      const summary: WindowReconcileSummary = {
        edits: {},
        deletes: { redacted: [], marked: [], unknown: [], purgedImages: [] }
      };
      if (Object.keys(ledger.entries).length === 0) return summary;
      const options = this.reconcileOptions(k, o);
      let changed = false;
      for (const message of page) {
        if (!ledger.entries[message.id]) continue;
        const result = applyEdit(ledger, message, render, options);
        summary.edits[message.id] = result.outcome;
        if (result.ledger !== ledger) {
          ledger = result.ledger;
          changed = true;
        }
      }
      if (changed) ledger = await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, ledger);
      const missing = detectGapDeletes(ledger, page);
      if (missing.length > 0) summary.deletes = await this.deleteLocked(k, ledger, missing, o);
      return summary;
    });
  }

  // Caller holds the ledger lock.
  private async deleteLocked(
    k: ConversationKey,
    ledger: ConversationLedger,
    ids: string[],
    o: MessageChangeOptions
  ): Promise<DeleteSummary> {
    const result = applyDeletes(ledger, ids, { redactRecent: o.redactRecent ?? DEFAULT_REDACT_RECENT, now: this.now() });
    // A delete that beats its message into the ledger (the fetch raced the event) must not be
    // resurrected by that fetch: remember the id for a while.
    // Only for a conversation that has a ledger: a channel nobody has talked in yet needs no memory.
    if (ledger.revision > 0 || Object.keys(ledger.entries).length > 0) {
      for (const id of result.unknown) this.rememberDeleted(k, id);
    }
    if (result.ledger !== ledger) await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, result.ledger);
    return { redacted: result.redacted, marked: result.marked, unknown: result.unknown, purgedImages: result.purgedImages };
  }

  private reconcileOptions(k: ConversationKey, o: ReconcileLedgerOptions) {
    const skipIds = this.recentlyDeleted(k);
    return {
      dir: o.dir ?? EMPTY_GUILD_DIRECTORY,
      timeZone: o.timeZone ?? this.timeZone(),
      gapBeforeNew: o.gapBeforeNew,
      now: this.now(),
      ...(skipIds ? { skipIds } : {})
    };
  }

  private rememberDeleted(k: ConversationKey, id: string): void {
    // Sweep every conversation's expired ids, so a bucket nobody reads again cannot linger.
    const nowMs = this.now().getTime();
    for (const [key, other] of this.deletedBeforeSeen) {
      for (const [otherId, expiresAt] of other) if (expiresAt <= nowMs) other.delete(otherId);
      if (other.size === 0) this.deletedBeforeSeen.delete(key);
    }
    const bucket = this.deletedBeforeSeen.get(k) ?? new Map<string, number>();
    bucket.set(id, this.now().getTime() + DELETED_BEFORE_SEEN_TTL_MS);
    if (bucket.size > DELETED_BEFORE_SEEN_MAX) {
      const oldest = bucket.keys().next().value;
      if (oldest !== undefined) bucket.delete(oldest);
    }
    this.deletedBeforeSeen.set(k, bucket);
  }

  private recentlyDeleted(k: ConversationKey): ReadonlySet<string> | undefined {
    const bucket = this.deletedBeforeSeen.get(k);
    if (!bucket) return undefined;
    const now = this.now().getTime();
    for (const [id, expiresAt] of bucket) if (expiresAt <= now) bucket.delete(id);
    if (bucket.size === 0) {
      this.deletedBeforeSeen.delete(k);
      return undefined;
    }
    return new Set(bucket.keys());
  }

  async sealLedger(k: ConversationKey, ids: string[], eventSeqs: number[]): Promise<void> {
    await this.storage.locks.withLock(ledgerResourceKey(k), async () => {
      const ledger = await this.loadLedger(k);
      const next = sealEntries(ledger, ids, eventSeqs);
      if (next) await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, next);
    });
  }

  async commitPrepare(k: ConversationKey, a: ContextAgent, i: CommitPrepareInput): Promise<CommitPrepareResult> {
    return this.storage.withLocks([ledgerResourceKey(k), refsResourceKey(k), contextResourceKey(k, a)], async () => {
      let ledger = await this.loadLedger(k);
      for (const [id, hash] of Object.entries(i.expectedHashes ?? {})) {
        const entry = ledger.entries[id];
        if (!entry || entryRenderHash(entry) !== hash) return { ok: false, conflict: "ledger" } as const;
      }
      const current = await this.readState(k, a);
      const next = i.update(structuredClone(current));
      if (!next) return { ok: false, conflict: "state" } as const;
      const sealed = sealEntries(ledger, i.sealIds, i.eventSeqs ?? []);
      if (sealed) ledger = sealed;
      const state = await this.writeRecord(contextStatePath(k, a), ContextStateSchema, next);
      const pruned = await this.pruneLocked(k, ledger, { [contextAgentId(a)]: state });
      if (pruned || sealed) {
        await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, pruned ?? ledger);
      }
      return { ok: true, state } as const;
    });
  }

  async pruneConversation(k: ConversationKey): Promise<{ removed: number }> {
    return this.storage.withLocks([ledgerResourceKey(k), refsResourceKey(k)], async () => {
      const ledger = await this.loadLedger(k);
      const before = Object.keys(ledger.entries).length;
      const pruned = await this.pruneLocked(k, ledger, {});
      if (!pruned) return { removed: 0 };
      await this.writeRecord(conversationLedgerPath(k), ConversationLedgerSchema, pruned);
      return { removed: before - Object.keys(pruned.entries).length };
    });
  }

  async deleteConversation(k: ConversationKey): Promise<void> {
    if (!parseConversationKey(k)) throw new Error(`Invalid conversation key: ${String(k)}`);
    const keys = [ledgerResourceKey(k), refsResourceKey(k)];
    for (const agentId of await this.listContextAgentIds(k)) keys.push(`context:${k}:${agentId}`);
    await this.storage.withLocks(keys, async () => {
      await rm(resolveDataPath(this.storage.dataRoot, "user", "conversations", k), { recursive: true, force: true });
    });
  }

  /** Agent ids with a persisted context in this conversation. */
  async listContextAgentIds(k: ConversationKey): Promise<string[]> {
    const dir = resolveDataPath(this.storage.dataRoot, path.dirname(contextStatePath(k, { kind: "orchestrator" })));
    try {
      return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  // Caller holds the ledger and refs locks. Returns the pruned ledger (not yet written) or
  // undefined; refs are written here. Active cursors are every context used in the last 7 days
  // plus the stage-manager observer's (its state lives beside them, same activity rule, but its
  // cursor is "read through" and its hold is capped, see observerPruneCursor).
  private async pruneLocked(
    k: ConversationKey,
    ledger: ConversationLedger,
    overrides: Record<string, ContextState>
  ): Promise<ConversationLedger | undefined> {
    const now = this.now().getTime();
    const cursors: Array<number | null> = [];
    const agentIds = new Set([...(await this.listContextAgentIds(k)), ...Object.keys(overrides)]);
    for (const agentId of agentIds) {
      const state = overrides[agentId] ?? (await this.readStateFile(k, agentId));
      if (!state) continue;
      if (now - Date.parse(state.lastUsedAt) > ACTIVE_CONTEXT_MS) continue;
      if (agentId === OBSERVER_AGENT_ID) {
        const observer = observerPruneCursor(ledger, state);
        if (observer !== undefined) cursors.push(observer);
        continue;
      }
      cursors.push(state.cursorSeq);
    }
    const result = pruneLedgerEntries(ledger, {
      activeCursors: cursors,
      ...(this.protectNewest !== undefined ? { protectNewest: this.protectNewest } : {})
    });
    if (!result) return undefined;
    const refs = await this.loadRefs(k);
    const nextRefs = pruneRefs(refs, result.removedIds);
    if (nextRefs) await this.writeRecord(conversationRefsPath(k), ConversationRefsSchema, nextRefs);
    return result.ledger;
  }

  private async readState(k: ConversationKey, a: ContextAgent): Promise<ContextState> {
    return this.storage.readJson(contextStatePath(k, a), ContextStateSchema, defaultContextState(k, a, this.now(), this.timeZone()));
  }

  private async readStateFile(k: ConversationKey, agentId: string): Promise<ContextState | undefined> {
    if (!/^[A-Za-z0-9._:-]+$/.test(agentId) || /^\.+$/.test(agentId)) return undefined;
    const relative = path.join(path.dirname(contextStatePath(k, { kind: "orchestrator" })), `${agentId}.json`);
    try {
      return await this.storage.readJson(relative, ContextStateSchema);
    } catch {
      return undefined; // missing or unreadable: never blocks pruning of others, never protects
    }
  }

  private async writeRecord<T extends RevisionedRecord>(relativePath: string, schema: z.ZodType<T>, value: T): Promise<T> {
    const next = schema.parse(bumpRevision({ ...value, schemaVersion: CURRENT_SCHEMA_VERSION }, this.now().toISOString()));
    await atomicWriteJson(resolveDataPath(this.storage.dataRoot, relativePath), next);
    return next;
  }
}
