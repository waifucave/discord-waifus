// Her recent sends per place (Living cast spec §30.6, §38): a repeating watch's 10-minute spacing gives
// way once she has written in the message's place since the watch last fired, and a held room match
// fires nothing when she wrote there after it. Both look back at most the spacing, so a send is kept
// `RECENT_SENDS_MS` (until §38 the setting `life.busyEngagedMinutes`, default 10, kept them).

import type { LifeState } from "../shared/schemas/life.js";
import type { LifeDeps } from "./deps.js";
import { updateLifeState } from "./lifeStore.js";
import { WATCH_MIN_SPACING_MS } from "./wakeups/run.js";

/** How long her latest send in a place is kept: the watch spacing, the furthest anything looks back. */
export const RECENT_SENDS_MS = WATCH_MIN_SPACING_MS;

/** She sent a message in a place: its latest send is recorded; sends older than `RECENT_SENDS_MS` go. */
export async function noteSend(deps: Pick<LifeDeps, "storage" | "now">, waifuId: string, placeKey: string): Promise<void> {
  const now = deps.now();
  await updateLifeState(deps.storage, waifuId, (current): LifeState => {
    const recent = Object.fromEntries(Object.entries(current.recentSends ?? {}).filter(([, at]) => now.getTime() - Date.parse(at) < RECENT_SENDS_MS));
    return { ...current, recentSends: { ...recent, [placeKey]: now.toISOString() } };
  });
}
