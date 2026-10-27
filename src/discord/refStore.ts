// Short message refs (spec 6.3/8.1, Living cast §6.2): one ref table per conversation shared by
// every waifu, base-36 of a per-conversation counter starting at 360 ("a0"). A ref, once assigned,
// never changes and is never reused (the counter only grows, also across pruning).
//
// This module is the ONLY writer of `user/conversations/<key>/refs.json` (under the `refs:<key>`
// lock, which the DM forget also takes): the transcript writer at ingest (§22.1), `ReadMessages`,
// sends and notices assign refs in message-id order. Writing the first ref creates the conversation
// directory, which the durable image index needs before it records anything
// (src/discord/imageIndex.ts). Refs older than 10,000 messages or 30 days in that place are pruned
// once the table holds `REF_PRUNE_SLACK` more than 10,000 refs, and a message older than 30 days gets
// no new ref; a pruned ref still resolves through its transcript line (`findTranscriptRef`, read by the
// life's `messageIdForRef`), and an unknown one to nothing (`error: message too old` for the tools).

import { createRevisionedBase } from "../shared/schemas/common.js";
import { ConversationRefsSchema, REF_COUNTER_START, type ConversationRefs } from "../shared/schemas/context.js";
import type { StorageService } from "../storage/storageService.js";
import { conversationRefsPath, type ConversationKey } from "../orchestration/context/keys.js";
import { compareIds } from "./rawMessage.js";

export { REF_COUNTER_START };

/** Refs further than this many messages behind the counter are pruned. */
export const MAX_REF_SPAN = 10_000;
/** Refs of messages older than this are pruned (and such messages get no new ref). */
export const MAX_REF_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Pruning runs only once the table holds this many refs past the span (not at every write). */
export const REF_PRUNE_SLACK = 1_000;

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/** Counter → ref ("a0" for 360, "a1", …, "zz", "100", …). */
export function encodeRef(counter: number): string {
  if (!Number.isInteger(counter) || counter < 0) throw new RangeError(`Invalid ref counter: ${counter}`);
  return counter.toString(36);
}

/** Ref → counter (NaN for anything that is not a base-36 ref). */
export function decodeRef(ref: string): number {
  return /^[0-9a-z]{1,8}$/.test(ref) ? parseInt(ref, 36) : Number.NaN;
}

/** `#k3`, `k3`, ` #K3 ` → `k3`; undefined when it does not look like a ref. */
export function normalizeRef(input: string): string | undefined {
  const ref = input.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-z]{2,8}$/.test(ref) ? ref : undefined;
}

/** The creation time of a Discord snowflake (undefined for a non-snowflake id). */
export function snowflakeTime(id: string): number | undefined {
  if (!/^\d{15,20}$/.test(id)) return undefined;
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

/** The smallest snowflake of a millisecond (§22.2: a time anchor becomes a message id). */
export function snowflakeAt(ms: number): string {
  const offset = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH_MS;
  return (offset > 0n ? offset << 22n : 0n).toString();
}

/** A snowflake moved by `delta` (an inclusive anchor: `before` the next id, `after` the previous). */
export function shiftId(id: string, delta: number): string {
  const next = BigInt(id) + BigInt(delta);
  return (next > 0n ? next : 0n).toString();
}

/**
 * Assign refs to the ids that lack one, in the given order (callers pass message-id order so refs
 * grow with the conversation). Returns undefined when nothing changed.
 */
export function assignRefsTo(refs: ConversationRefs, messageIds: readonly string[], nowMs?: number): ConversationRefs | undefined {
  let counter = Math.max(refs.counter, REF_COUNTER_START);
  let next: Record<string, string> | undefined;
  for (const id of messageIds) {
    if (refs.refs[id] !== undefined || next?.[id] !== undefined) continue;
    // A message past the age limit gets no ref (it would be pruned at once); its transcript line may have one.
    const time = nowMs === undefined ? undefined : snowflakeTime(id);
    if (time !== undefined && nowMs! - time > MAX_REF_AGE_MS) continue;
    next ??= { ...refs.refs };
    next[id] = encodeRef(counter);
    counter += 1;
  }
  return next ? { ...refs, counter, refs: next } : undefined;
}

/** Drop the refs of the given message ids. Undefined when unchanged. */
export function pruneRefs(refs: ConversationRefs, removedIds: Iterable<string>): ConversationRefs | undefined {
  const removed = new Set(removedIds);
  const kept = Object.entries(refs.refs).filter(([id]) => !removed.has(id));
  if (kept.length === Object.keys(refs.refs).length) return undefined;
  return { ...refs, refs: Object.fromEntries(kept) };
}

/** Drop refs further than MAX_REF_SPAN behind the counter or older than MAX_REF_AGE_MS. */
export function pruneStaleRefs(refs: ConversationRefs, nowMs: number): ConversationRefs {
  const kept: Record<string, string> = {};
  let changed = false;
  for (const [id, ref] of Object.entries(refs.refs)) {
    const counter = decodeRef(ref);
    const tooFar = Number.isFinite(counter) && refs.counter - counter > MAX_REF_SPAN;
    const time = snowflakeTime(id);
    const tooOld = time !== undefined && nowMs - time > MAX_REF_AGE_MS;
    if (tooFar || tooOld) changed = true;
    else kept[id] = ref;
  }
  return changed ? { ...refs, refs: kept } : refs;
}

function emptyRefs(key: ConversationKey): ConversationRefs {
  return ConversationRefsSchema.parse({ ...createRevisionedBase(), conversationKey: key, counter: REF_COUNTER_START, refs: {} });
}

export function refsResource(key: string): string {
  return `refs:${key}`;
}

/** The conversation's ref table (empty when none was written). */
export async function readConversationRefs(storage: StorageService, key: ConversationKey): Promise<ConversationRefs> {
  return storage.readJson(conversationRefsPath(key), ConversationRefsSchema, emptyRefs(key));
}

/**
 * Assigns refs to `messageIds` (sorted into message-id order first) and returns messageId → ref for
 * every id that has one afterwards. Writes only when a ref was added or pruned.
 */
export async function assignConversationRefs(
  storage: StorageService,
  key: ConversationKey,
  messageIds: readonly string[],
  now: Date = new Date()
): Promise<Map<string, string>> {
  const ordered = [...new Set(messageIds)].sort(compareIds);
  const current = await readConversationRefs(storage, key);
  const nowMs = now.getTime();
  const assignable = (id: string) => {
    const time = snowflakeTime(id);
    return time === undefined || nowMs - time <= MAX_REF_AGE_MS;
  };
  if (ordered.every((id) => current.refs[id] !== undefined || !assignable(id))) return new Map(Object.entries(current.refs));
  const saved = await storage.updateRevisionedJson({
    resourceKey: refsResource(key),
    relativePath: conversationRefsPath(key),
    schema: ConversationRefsSchema,
    fallback: emptyRefs(key),
    transform: (refs) => {
      const assigned = assignRefsTo(refs, ordered, nowMs) ?? refs;
      // Pruning decodes every ref: only once the table has grown well past the span.
      return Object.keys(assigned.refs).length > MAX_REF_SPAN + REF_PRUNE_SLACK ? pruneStaleRefs(assigned, nowMs) : assigned;
    }
  });
  return new Map(Object.entries(saved.refs));
}

/** The message id a ref names in this conversation, or undefined (pruned, unknown, malformed). */
export async function resolveConversationRef(storage: StorageService, key: ConversationKey, ref: string): Promise<string | undefined> {
  const normalized = normalizeRef(ref);
  if (!normalized) return undefined;
  const refs = await readConversationRefs(storage, key);
  for (const [id, value] of Object.entries(refs.refs)) if (value === normalized) return id;
  return undefined;
}
