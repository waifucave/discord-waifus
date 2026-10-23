// Stage-manager observer cursor (spec 6.5/I8, 8.7): the observer keeps only a per-conversation
// last-seen cursor, persisted as the T1 `ContextState` of agent "stage-manager" at
// user/conversations/<key>/contexts/stage-manager.json (resource key `context:<key>:stage-manager`).
// Minimal helper until the context engine's ContextStore lands; it reads and writes the same
// file through the same schema and lock, and only ever touches the cursor/lastUsedAt fields.

import { ContextStateSchema, type ContextState } from "../shared/schemas/context.js";
import { createEmptyRevisionedFile } from "../shared/schemas/domain.js";
import type { StorageService } from "../storage/storageService.js";
import {
  type ContextAgent,
  type ConversationRef,
  compareSnowflakes,
  contextAgentId,
  contextStatePath,
  conversationKey
} from "./context/keys.js";

const STAGE_MANAGER: ContextAgent = { kind: "stage-manager" };

export type ObserverCursor = {
  /** Ledger seq of the newest entry observed (null until the observer reads a ledger). */
  cursorSeq: number | null;
  /** Discord id of the newest message observed (the legacy window path uses only this). */
  cursorMessageId: string | null;
};

function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function freshState(ref: ConversationRef, now: Date): ContextState {
  const iso = now.toISOString();
  return ContextStateSchema.parse(
    createEmptyRevisionedFile({
      conversationKey: conversationKey(ref),
      agentId: contextAgentId(STAGE_MANAGER),
      epoch: 0,
      epochStartedAt: iso,
      lastUsedAt: iso,
      cursorSeq: null,
      cursorMessageId: null,
      timeZone: hostTimeZone()
    })
  );
}

function resourceKey(ref: ConversationRef): string {
  return `context:${conversationKey(ref)}:${contextAgentId(STAGE_MANAGER)}`;
}

export async function readObserverCursor(storage: StorageService, ref: ConversationRef): Promise<ObserverCursor> {
  const state = await storage.readJson(
    contextStatePath(conversationKey(ref), STAGE_MANAGER),
    ContextStateSchema,
    freshState(ref, new Date())
  );
  return { cursorSeq: state.cursorSeq, cursorMessageId: state.cursorMessageId };
}

/** True when message id `a` is newer than `b` (snowflake compare; plain string order otherwise). */
export function isNewerMessageId(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return compareSnowflakes(a, b) > 0;
  return a > b;
}

/**
 * Move the cursor forward (never backwards) and refresh lastUsedAt, which also keeps the
 * conversation's ledger from being pruned below the observer's position.
 */
export async function advanceObserverCursor(
  storage: StorageService,
  ref: ConversationRef,
  next: Partial<ObserverCursor>,
  now: Date = new Date()
): Promise<ObserverCursor> {
  const updated = await storage.updateRevisionedJson({
    resourceKey: resourceKey(ref),
    relativePath: contextStatePath(conversationKey(ref), STAGE_MANAGER),
    schema: ContextStateSchema,
    fallback: freshState(ref, now),
    transform: (current) => {
      const cursorSeq =
        next.cursorSeq === undefined || next.cursorSeq === null
          ? current.cursorSeq
          : Math.max(current.cursorSeq ?? -1, next.cursorSeq);
      const cursorMessageId =
        !next.cursorMessageId
          ? current.cursorMessageId
          : !current.cursorMessageId || isNewerMessageId(next.cursorMessageId, current.cursorMessageId)
            ? next.cursorMessageId
            : current.cursorMessageId;
      return { ...current, cursorSeq, cursorMessageId, lastUsedAt: now.toISOString() };
    }
  });
  return { cursorSeq: updated.cursorSeq, cursorMessageId: updated.cursorMessageId };
}
