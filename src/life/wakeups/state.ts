// Her wakeups' `state` (Living cast spec §30.2): the JSON object a function filter or check may
// change, for conditions across events. Kept in memory as it changes and saved into her
// `~/life/wakeups.json` at most once a minute and at shutdown (fewer SSD writes); a restart without a
// clean shutdown loses at most the last minute of it.
//
// Her own write of the file wins: a wakeup whose `state` she changed in the file (or that she
// removed) drops what was waiting in memory; one she left as it was keeps the newer state.

import type { WakeupEntry } from "./file.js";

/** At most this often a waifu's pending state is written into her file. */
export const STATE_SAVE_MS = 60_000;

type Pending = { states: Map<string, { state: Record<string, unknown>; source: string | undefined }>; savedAt: number };

const PENDING = new Map<string, Pending>();

const keyOf = (dataRoot: string, waifuId: string) => `${dataRoot}\u0000${waifuId}`;

/** The state a run starts from: what waits in memory, else the file's. */
export function currentState(dataRoot: string, waifuId: string, entry: Pick<WakeupEntry, "id" | "state">, source: string | undefined): Record<string, unknown> {
  const pending = PENDING.get(keyOf(dataRoot, waifuId))?.states.get(entry.id);
  if (pending && pending.source === source) return pending.state;
  return entry.state ?? {};
}

/** A run changed the state (only an actual change is kept). */
export function setState(dataRoot: string, waifuId: string, id: string, source: string | undefined, state: Record<string, unknown>, nowMs: number): void {
  const key = keyOf(dataRoot, waifuId);
  let pending = PENDING.get(key);
  if (!pending) PENDING.set(key, (pending = { states: new Map(), savedAt: nowMs }));
  pending.states.set(id, { state, source });
}

/** What waits to be saved for her (id → state), and whether it is due (`nowMs` past the minute). */
export function pendingStates(dataRoot: string, waifuId: string, nowMs?: number): Map<string, { state: Record<string, unknown>; source: string | undefined }> | undefined {
  const pending = PENDING.get(keyOf(dataRoot, waifuId));
  if (!pending || pending.states.size === 0) return undefined;
  if (nowMs !== undefined && nowMs - pending.savedAt < STATE_SAVE_MS) return undefined;
  return new Map(pending.states);
}

/** The waiting states were written (those still the same are cleared). */
export function markSaved(dataRoot: string, waifuId: string, saved: ReadonlyMap<string, { state: Record<string, unknown> }>, nowMs: number): void {
  const pending = PENDING.get(keyOf(dataRoot, waifuId));
  if (!pending) return;
  for (const [id, value] of saved) if (pending.states.get(id)?.state === value.state) pending.states.delete(id);
  pending.savedAt = nowMs;
}

/** Waifus with state waiting (shutdown saves them all). */
export function waifusWithPending(dataRoot: string): string[] {
  const prefix = `${dataRoot}\u0000`;
  return [...PENDING].filter(([key, pending]) => key.startsWith(prefix) && pending.states.size > 0).map(([key]) => key.slice(prefix.length));
}

/** Drops waiting state (one wakeup, or all of hers). */
export function dropState(dataRoot: string, waifuId: string, id?: string): void {
  const key = keyOf(dataRoot, waifuId);
  if (id === undefined) PENDING.delete(key);
  else PENDING.get(key)?.states.delete(id);
}

/**
 * After her own write of the file: a wakeup she removed, or whose state (or code) she changed, loses
 * what waited in memory; one she left alone keeps it.
 */
export function reconcileAfterWrite(dataRoot: string, waifuId: string, before: readonly WakeupEntry[], after: readonly WakeupEntry[]): void {
  const pending = PENDING.get(keyOf(dataRoot, waifuId));
  if (!pending) return;
  const old = new Map(before.map((entry) => [entry.id, entry]));
  const now = new Map(after.map((entry) => [entry.id, entry]));
  for (const id of [...pending.states.keys()]) {
    const was = old.get(id);
    const is = now.get(id);
    if (!is || !was || JSON.stringify(was.state ?? null) !== JSON.stringify(is.state ?? null)) pending.states.delete(id);
  }
}
