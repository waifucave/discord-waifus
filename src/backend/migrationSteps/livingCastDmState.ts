// Step `living-cast-dm-state-v1` (Living cast spec §11.2): a DM that was in flight at upgrade
// (`pendingTriggerMessageId` / `pendingSince` in `user/dms/<userId>/<waifuId>.json`) becomes an
// immediate `dm` wake in that waifu's queue (`user/waifus/<id>/life/wakes.json`), so her first turn
// after the upgrade answers it; the retired DM runner's `recentRuns` are dropped.
//
// The wake is written before the DM state loses its pending fields, under a deterministic id, so a
// re-run after a crash in between never queues it twice. A DM state without those fields is left
// byte-identical.

import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../shared/schemas/common.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { isObject, nonEmptyString, readJsonFile } from "./memorySupport.js";

const SNOWFLAKE = /^\d{17,20}$/;
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;
const RETIRED_FIELDS = ["pendingTriggerMessageId", "pendingSince", "recentRuns"];
const MAX_IMMEDIATE_WAKES = 200;

async function list(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Adds the wake to `immediate` unless one with its id is already there. */
async function queueDmWake(dataRoot: string, waifuId: string, wake: Record<string, unknown>, now: string): Promise<void> {
  const file = path.join(dataRoot, "user", "waifus", waifuId, "life", "wakes.json");
  const read = await readJsonFile(file);
  const queue: Record<string, unknown> =
    read.kind === "ok" && isObject(read.value)
      ? read.value
      : { schemaVersion: CURRENT_SCHEMA_VERSION, revision: 0, updatedAt: now, immediate: [] };
  const immediate = Array.isArray(queue.immediate) ? queue.immediate : [];
  if (immediate.some((entry) => isObject(entry) && entry.id === wake.id)) return;
  if (immediate.length >= MAX_IMMEDIATE_WAKES) return;
  await atomicWriteJson(file, {
    ...queue,
    revision: typeof queue.revision === "number" ? queue.revision + 1 : 1,
    updatedAt: now,
    immediate: [...immediate, wake]
  });
}

export async function migrateLivingCastDmState(dataRoot: string, o: { now?: () => Date } = {}): Promise<string | undefined> {
  const now = (o.now ?? (() => new Date()))().toISOString();
  let woken = 0;
  let cleaned = 0;
  const dmsDir = path.join(dataRoot, "user", "dms");
  for (const userId of await list(dmsDir)) {
    if (!SNOWFLAKE.test(userId)) continue;
    for (const name of await list(path.join(dmsDir, userId))) {
      if (!name.endsWith(".json")) continue;
      const waifuId = name.slice(0, -".json".length);
      if (!WAIFU_ID.test(waifuId) || /^\.+$/u.test(waifuId)) continue;
      const file = path.join(dmsDir, userId, name);
      const read = await readJsonFile(file);
      if (read.kind !== "ok" || !isObject(read.value)) continue;
      const state = read.value;
      if (!RETIRED_FIELDS.some((field) => field in state)) continue;
      const trigger = nonEmptyString(state.pendingTriggerMessageId);
      // A deleted waifu gets no wake (and no stray life folder).
      const waifuExists = await stat(path.join(dataRoot, "user", "waifus", waifuId, "waifu.json")).then(() => true, () => false);
      if (waifuExists && (trigger || nonEmptyString(state.pendingSince))) {
        const displayName = nonEmptyString(state.userDisplayName);
        await queueDmWake(
          dataRoot,
          waifuId,
          {
            id: `w-upgrade-dm-${userId}`,
            reason: "dm",
            placeKey: `dm_${userId}_${waifuId}`,
            fromUserId: userId,
            fromName: displayName ?? "someone",
            ...(trigger && SNOWFLAKE.test(trigger) ? { messageId: trigger } : {}),
            at: nonEmptyString(state.pendingSince) ?? nonEmptyString(state.lastInboundAt) ?? now
          },
          now
        );
        woken += 1;
      }
      for (const field of RETIRED_FIELDS) delete state[field];
      await atomicWriteJson(file, state);
      cleaned += 1;
    }
  }
  if (cleaned === 0) return undefined;
  return `living-cast-dm-state-${woken}-of-${cleaned}`;
}
