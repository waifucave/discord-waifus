// Short message refs (spec 6.3/8.1, Living cast §6.2): one ref table per conversation shared by
// every waifu, base-36 of a per-conversation counter starting at 360 ("a0"). A ref, once assigned,
// never changes and is never reused (the counter only grows, also across pruning). Moved here from
// the retired context engine; L2 adds the refs.json writer and its lock (the only writer).

import { REF_COUNTER_START, type ConversationRefs } from "../shared/schemas/context.js";

export { REF_COUNTER_START };

/** Counter → ref ("a0" for 360, "a1", …, "zz", "100", …). */
export function encodeRef(counter: number): string {
  if (!Number.isInteger(counter) || counter < 0) throw new RangeError(`Invalid ref counter: ${counter}`);
  return counter.toString(36);
}

/**
 * Assign refs to the ids that lack one, in the given order (callers pass ledger `seq` order so
 * refs grow with the transcript). Returns undefined when nothing changed.
 */
export function assignRefsTo(refs: ConversationRefs, messageIds: readonly string[]): ConversationRefs | undefined {
  let counter = Math.max(refs.counter, REF_COUNTER_START);
  let next: Record<string, string> | undefined;
  for (const id of messageIds) {
    if (refs.refs[id] !== undefined || next?.[id] !== undefined) continue;
    next ??= { ...refs.refs };
    next[id] = encodeRef(counter);
    counter += 1;
  }
  return next ? { ...refs, counter, refs: next } : undefined;
}

/**
 * Drop the refs of the messages the ledger just removed. Only removed ids: a ref may be assigned
 * before its message reaches the ledger (a decision note naming the replies it sent), and that
 * ref must survive until the message itself is pruned. Undefined when unchanged.
 */
export function pruneRefs(refs: ConversationRefs, removedIds: Iterable<string>): ConversationRefs | undefined {
  const removed = new Set(removedIds);
  const kept = Object.entries(refs.refs).filter(([id]) => !removed.has(id));
  if (kept.length === Object.keys(refs.refs).length) return undefined;
  return { ...refs, refs: Object.fromEntries(kept) };
}
