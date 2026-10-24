// On-disk locations of a waifu's life (Living cast spec §5.1, §7.1). Data-root-relative paths (the
// form StorageService takes); every helper validates the waifu id first, so a request id can never
// steer a path outside `user/waifus/<id>/`.

import path from "node:path";

// The API's assertSafeId alphabet (ids may contain "_", ".", ":", "-"); dot-only ids refused.
const WAIFU_ID = /^[A-Za-z0-9._:-]+$/;

export function assertLifeWaifuId(waifuId: string): void {
  if (typeof waifuId !== "string" || !WAIFU_ID.test(waifuId) || /^\.+$/.test(waifuId)) {
    throw new Error(`Invalid waifu id: ${String(waifuId)}`);
  }
}

export function waifuDir(waifuId: string): string {
  assertLifeWaifuId(waifuId);
  return path.join("user", "waifus", waifuId);
}

export function lifeDir(waifuId: string): string {
  return path.join(waifuDir(waifuId), "life");
}

export function notesDir(waifuId: string): string {
  return path.join(waifuDir(waifuId), "notes");
}

export const lifePaths = {
  state: (waifuId: string) => path.join(lifeDir(waifuId), "state.json"),
  logDir: (waifuId: string) => path.join(lifeDir(waifuId), "log"),
  log: (waifuId: string, epoch: number) => {
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`Invalid epoch: ${String(epoch)}`);
    return path.join(lifeDir(waifuId), "log", `${epoch}.jsonl`);
  },
  intents: (waifuId: string) => path.join(lifeDir(waifuId), "intents.jsonl"),
  reads: (waifuId: string) => path.join(lifeDir(waifuId), "reads.json"),
  handles: (waifuId: string) => path.join(lifeDir(waifuId), "handles.json"),
  wakes: (waifuId: string) => path.join(lifeDir(waifuId), "wakes.json"),
  watches: (waifuId: string) => path.join(lifeDir(waifuId), "watches.json"),
  schedule: (waifuId: string) => path.join(lifeDir(waifuId), "schedule.json"),
  maintenance: (waifuId: string) => path.join(lifeDir(waifuId), "maintenance.jsonl"),
  pendingScrubs: (waifuId: string) => path.join(lifeDir(waifuId), "pending-scrubs.json"),
  usage: (waifuId: string) => path.join(lifeDir(waifuId), "usage.json")
};

/** Storage lock names. `life:<id>` serialises turns, compaction, maintenance and forget scrubs (§5.1). */
export const lifeLocks = {
  life: (waifuId: string) => `life:${waifuId}`,
  state: (waifuId: string) => `life-state:${waifuId}`,
  log: (waifuId: string) => `life-log:${waifuId}`,
  intents: (waifuId: string) => `life-intents:${waifuId}`,
  reads: (waifuId: string) => `life-reads:${waifuId}`,
  handles: (waifuId: string) => `life-handles:${waifuId}`,
  wakes: (waifuId: string) => `life-wakes:${waifuId}`,
  watches: (waifuId: string) => `life-watches:${waifuId}`,
  schedule: (waifuId: string) => `life-schedule:${waifuId}`,
  maintenance: (waifuId: string) => `life-maintenance:${waifuId}`,
  notes: (waifuId: string) => `notes:${waifuId}`,
  usage: (waifuId: string) => `life-usage:${waifuId}`
};
