// Which places a running tool call touched (D14, spec §14.4): `resolvePlace` and `handleOf` note
// every placeKey they resolve or name while a call runs, whatever the tool is called, so the life
// loop can record on the tool-results line which calls were about a DM place. The owner's views
// decide on that record, not on the raw argument text.

import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<Set<string>>();

/** Notes a placeKey the running tool call resolved or named (a no-op outside a tool call). */
export function notePlace(placeKey: string): void {
  current.getStore()?.add(placeKey);
}

/**
 * Runs one tool call and returns the placeKeys it touched. They are noted into `places` as it runs,
 * so a caller that passes its own set still has them when the call throws (D14: a failed DM call is
 * a DM call).
 */
export async function withPlaceRecord<T>(run: () => Promise<T>, places: Set<string> = new Set()): Promise<{ value: T; places: ReadonlySet<string> }> {
  const value = await current.run(places, run);
  return { value, places };
}
