// On-disk locations of a waifu's life (Living cast spec §5.1, §16.2). Data-root-relative paths (the
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

/** Her home folder (`/home/<slug>` to her, §16.2). */
export function homeDir(waifuId: string): string {
  return path.join(waifuDir(waifuId), "home");
}

/** Her `/tmp` (downloads and scratch files, expiring after `life.tmp.retentionDays`). */
export function tmpDir(waifuId: string): string {
  return path.join(waifuDir(waifuId), "tmp");
}

/** Where her notes lived before §16 (the L2-era layout; only the migration reads it). */
export function legacyNotesDir(waifuId: string): string {
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
  /** How her watches resolved, their fires, and the id counter (§16.5; not in her folder). */
  watchIds: (waifuId: string) => path.join(lifeDir(waifuId), "watch-ids.json"),
  /** Her reminder id counter and the occurrences already fired (§16.4). */
  scheduleIds: (waifuId: string) => path.join(lifeDir(waifuId), "schedule-ids.json"),
  /** Where her downloads came from (§16.2 provenance). */
  filesIndex: (waifuId: string) => path.join(lifeDir(waifuId), "files-index.json"),
  /** Bash change sets being applied (§16.9): `<toolCallId>.json`. */
  pendingChanges: (waifuId: string) => path.join(lifeDir(waifuId), "pending-changes"),
  maintenance: (waifuId: string) => path.join(lifeDir(waifuId), "maintenance.jsonl"),
  /** Per conversation, the last transcript line her dreams covered (§18.4). */
  dreamCursor: (waifuId: string) => path.join(lifeDir(waifuId), "dream-cursor.json"),
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
  maintenance: (waifuId: string) => `life-maintenance:${waifuId}`,
  /** Every write to her two folders and their side files (watch-ids, schedule-ids, files-index). */
  home: (waifuId: string) => `home:${waifuId}`,
  usage: (waifuId: string) => `life-usage:${waifuId}`
};
