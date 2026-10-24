// Is the process in pid.json really this data root's host? (B21b) Shared by the lifecycle commands
// and the host client the settings and life commands talk through.

import { z } from "zod";
import { RuntimeStateSchema } from "../backend/runtime.js";
import {
  hostInstanceState,
  PROCESS_START_TIME_SLACK_MS,
  type ProcessIdentityProbe
} from "../storage/instanceLock.js";

// status/stop only need the pid (plus, for status, a couple of display fields) out of
// runtime.json/pid.json — they never migrate anything. Loosen just the schemaVersion check
// (any non-negative integer, not literally CURRENT_SCHEMA_VERSION) so a stale runtime/pid file
// left on disk by a pre-upgrade process doesn't crash `waifus status`/`waifus stop`. The strict
// literal in RuntimeStateSchema itself is untouched — it still governs every write.
export const RuntimeStateReadSchema = RuntimeStateSchema.extend({
  schemaVersion: z.number().int().nonnegative()
});

/**
 * B21b: a live pid from pid.json is only the host if its identity checks out. The host lock
 * records the OS start time of its process; without a lock (a pre-lock host), a process that
 * started after the backend recorded its own start cannot be that backend — the pid was reused
 * after a crash. Unknown start times keep the old pid-liveness behavior.
 */
export async function hostPidIsGenuine(
  dataRoot: string,
  state: { pid: number; startedAt: string },
  probe: ProcessIdentityProbe
): Promise<boolean> {
  if (!probe.isAlive(state.pid)) return false;
  const lock = await hostInstanceState(dataRoot, probe);
  if (lock.state === "running" && lock.pid === state.pid) return true;
  if (lock.state === "stale" && lock.record?.pid === state.pid) return false;
  const started = await probe.startTime(state.pid);
  const recorded = Date.parse(state.startedAt);
  // The backend records `startedAt` after booting, so the genuine host started at or before it;
  // the shared slack absorbs ps second-resolution and clock drift.
  return started === null || !Number.isFinite(recorded) || started <= recorded + PROCESS_START_TIME_SLACK_MS;
}
