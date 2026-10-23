// Short message refs (spec 6.3/8.1/8.3): one ref table per conversation shared by every agent,
// base-36 of a per-conversation counter starting at 360 ("a0"). A ref, once assigned, never
// changes and is never reused (the counter only grows, also across pruning).

import { REF_COUNTER_START, type ConversationRefs } from "../../shared/schemas/context.js";

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

/** Drop refs of messages not in `keepIds` (pruned from the ledger). Undefined when unchanged. */
export function pruneRefs(refs: ConversationRefs, keepIds: ReadonlySet<string>): ConversationRefs | undefined {
  const kept = Object.entries(refs.refs).filter(([id]) => keepIds.has(id));
  if (kept.length === Object.keys(refs.refs).length) return undefined;
  return { ...refs, refs: Object.fromEntries(kept) };
}
