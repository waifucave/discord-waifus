// The life store (Living cast spec §5.1): epoch state, the append-only life log, side-effect
// intents, read cursors and the small per-waifu JSON files. Every write goes through the
// StorageService's per-resource locks; log and intent files are append-only JSON lines.
//
// A crash can leave a torn last line in a .jsonl file: readers skip any line that does not parse
// (and the boot repair rewrites the log without it), so a torn write never blocks a life.

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createRevisionedBase } from "../shared/schemas/common.js";
import {
  LifeIntentSchema,
  LifeLogLineSchema,
  LifeStateSchema,
  LifeUsageSchema,
  PlaceHandlesSchema,
  ReadCursorsSchema,
  WakeQueueSchema,
  type LifeIntent,
  type LifeLogLine,
  type LifeState,
  type LifeUsage,
  type PlaceHandles,
  type ReadCursors,
  type WakeQueue
} from "../shared/schemas/life.js";
import type { RevisionedRecord } from "../shared/schemas/common.js";
import type { StorageService } from "../storage/storageService.js";
import { atomicWriteText } from "../storage/atomic.js";
import { compareIds } from "../discord/rawMessage.js";
import { lifeLocks, lifePaths } from "./paths.js";

export function freshLifeState(waifuId: string, now: Date): LifeState {
  return LifeStateSchema.parse({
    ...createRevisionedBase(),
    waifuId,
    epoch: 1,
    epochStartedAt: now.toISOString(),
    status: "idle",
    summary: null,
    systemSnapshot: null,
    modelRoute: null,
    inlineImageCount: 0,
    inlineImageBytes: 0,
    shownImageKeys: [],
    readMessageIds: [],
    pendingNotices: [],
    deletedReadIds: [],
    scrubbedAt: {}
  });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

// ---- revisioned JSON files ---------------------------------------------------------------------------

type FileSpec<T extends RevisionedRecord> = {
  path: (waifuId: string) => string;
  lock: (waifuId: string) => string;
  schema: z.ZodType<T>;
  empty: () => T;
};

const files = {
  reads: {
    path: lifePaths.reads,
    lock: lifeLocks.reads,
    schema: ReadCursorsSchema,
    empty: () => ReadCursorsSchema.parse({ ...createRevisionedBase(), cursors: {} })
  } satisfies FileSpec<ReadCursors>,
  handles: {
    path: lifePaths.handles,
    lock: lifeLocks.handles,
    schema: PlaceHandlesSchema,
    empty: () => PlaceHandlesSchema.parse({ ...createRevisionedBase(), handles: {}, primary: {} })
  } satisfies FileSpec<PlaceHandles>,
  wakes: {
    path: lifePaths.wakes,
    lock: lifeLocks.wakes,
    schema: WakeQueueSchema,
    empty: () => WakeQueueSchema.parse({ ...createRevisionedBase() })
  } satisfies FileSpec<WakeQueue>,
  usage: {
    path: lifePaths.usage,
    lock: lifeLocks.usage,
    schema: LifeUsageSchema,
    empty: () => LifeUsageSchema.parse({ ...createRevisionedBase() })
  } satisfies FileSpec<LifeUsage>
};

export type LifeFileName = keyof typeof files;
type LifeFileType<K extends LifeFileName> = z.infer<(typeof files)[K]["schema"]>;

export async function readLifeFile<K extends LifeFileName>(storage: StorageService, waifuId: string, name: K): Promise<LifeFileType<K>> {
  const spec = files[name] as unknown as FileSpec<LifeFileType<K>>;
  return storage.readJson(spec.path(waifuId), spec.schema, spec.empty());
}

export async function updateLifeFile<K extends LifeFileName>(
  storage: StorageService,
  waifuId: string,
  name: K,
  transform: (current: LifeFileType<K>) => LifeFileType<K> | Promise<LifeFileType<K>>
): Promise<LifeFileType<K>> {
  const spec = files[name] as unknown as FileSpec<LifeFileType<K>>;
  return storage.updateRevisionedJson({
    resourceKey: spec.lock(waifuId),
    relativePath: spec.path(waifuId),
    schema: spec.schema,
    fallback: spec.empty(),
    transform
  });
}

// ---- state.json --------------------------------------------------------------------------------------

export async function readLifeState(storage: StorageService, waifuId: string, now: Date = new Date()): Promise<LifeState> {
  try {
    return await storage.readJson(lifePaths.state(waifuId), LifeStateSchema);
  } catch (error) {
    if (isMissing(error)) return freshLifeState(waifuId, now);
    throw error;
  }
}

export async function lifeStateExists(storage: StorageService, waifuId: string): Promise<boolean> {
  return stat(storage.dataPath(lifePaths.state(waifuId))).then(() => true, () => false);
}

export async function updateLifeState(
  storage: StorageService,
  waifuId: string,
  transform: (current: LifeState) => LifeState | Promise<LifeState>,
  now: Date = new Date()
): Promise<LifeState> {
  return storage.updateRevisionedJson({
    resourceKey: lifeLocks.state(waifuId),
    relativePath: lifePaths.state(waifuId),
    schema: LifeStateSchema,
    fallback: freshLifeState(waifuId, now),
    transform
  });
}

// ---- jsonl helpers ------------------------------------------------------------------------------------

async function readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<{ rows: T[]; torn: boolean }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return { rows: [], torn: false };
    throw error;
  }
  const rows: T[] = [];
  let torn = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data);
      else torn = true;
    } catch {
      torn = true;
    }
  }
  return { rows, torn };
}

async function appendJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  if (rows.length === 0) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), { encoding: "utf8", mode: 0o600 });
}

// ---- log/<epoch>.jsonl ----------------------------------------------------------------------------------

export async function readLifeLog(storage: StorageService, waifuId: string, epoch: number): Promise<LifeLogLine[]> {
  return (await readJsonl(storage.dataPath(lifePaths.log(waifuId, epoch)), LifeLogLineSchema)).rows;
}

/** True when the log has a line that does not parse (a torn append). */
export async function lifeLogTorn(storage: StorageService, waifuId: string, epoch: number): Promise<boolean> {
  return (await readJsonl(storage.dataPath(lifePaths.log(waifuId, epoch)), LifeLogLineSchema)).torn;
}

/** Appends lines (already sequenced by the caller) to an epoch's log. */
export async function appendLifeLog(storage: StorageService, waifuId: string, epoch: number, lines: readonly LifeLogLine[]): Promise<void> {
  await storage.withLocks([lifeLocks.log(waifuId)], () => appendJsonl(storage.dataPath(lifePaths.log(waifuId, epoch)), lines));
}

/** Rewrites an epoch's log whole (boot repair of a torn file; forget). */
export async function rewriteLifeLog(storage: StorageService, waifuId: string, epoch: number, lines: readonly LifeLogLine[]): Promise<void> {
  await storage.withLocks([lifeLocks.log(waifuId)], () =>
    atomicWriteText(storage.dataPath(lifePaths.log(waifuId, epoch)), lines.map((line) => `${JSON.stringify(line)}\n`).join(""))
  );
}

/** Epoch numbers with a log file, ascending. */
export async function listLogEpochs(storage: StorageService, waifuId: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(storage.dataPath(lifePaths.logDir(waifuId)));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names
    .map((name) => /^(\d+)\.jsonl$/.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export const OLD_EPOCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes old epoch logs (§5.1): every log but `keepEpoch` older than 7 days, or every one but
 * `keepEpoch` when `all` (after a forget, §7.5 step 5).
 */
export async function pruneOldEpochLogs(storage: StorageService, waifuId: string, keepEpoch: number, o: { all?: boolean; now?: Date } = {}): Promise<number[]> {
  const removed: number[] = [];
  const now = (o.now ?? new Date()).getTime();
  for (const epoch of await listLogEpochs(storage, waifuId)) {
    if (epoch === keepEpoch) continue;
    const file = storage.dataPath(lifePaths.log(waifuId, epoch));
    if (!o.all) {
      const info = await stat(file).catch(() => undefined);
      if (!info || now - info.mtimeMs < OLD_EPOCH_RETENTION_MS) continue;
    }
    await rm(file, { force: true });
    removed.push(epoch);
  }
  return removed;
}

// ---- intents.jsonl (§5.7) ---------------------------------------------------------------------------------

export async function appendIntent(storage: StorageService, waifuId: string, intent: LifeIntent): Promise<void> {
  await storage.withLocks([lifeLocks.intents(waifuId)], () => appendJsonl(storage.dataPath(lifePaths.intents(waifuId)), [LifeIntentSchema.parse(intent)]));
}

export async function readIntents(storage: StorageService, waifuId: string): Promise<LifeIntent[]> {
  return (await readJsonl(storage.dataPath(lifePaths.intents(waifuId)), LifeIntentSchema)).rows;
}

/** Keeps only the intents of `keepTurnIds` (the file is trimmed when a turn closes cleanly). */
export async function compactIntents(storage: StorageService, waifuId: string, keepTurnIds: ReadonlySet<string>): Promise<void> {
  await storage.withLocks([lifeLocks.intents(waifuId)], async () => {
    const file = storage.dataPath(lifePaths.intents(waifuId));
    const { rows } = await readJsonl(file, LifeIntentSchema);
    const kept = rows.filter((row) => keepTurnIds.has(row.turnId));
    if (kept.length === rows.length) return;
    if (kept.length === 0) await rm(file, { force: true });
    else await atomicWriteText(file, kept.map((row) => `${JSON.stringify(row)}\n`).join(""));
  });
}

// ---- reads.json (§5.5) ---------------------------------------------------------------------------------------

/** Moves her read cursor for a place forward to `messageId` (never backwards). */
export async function advanceReadCursor(storage: StorageService, waifuId: string, placeKey: string, messageId: string, now: Date): Promise<void> {
  await updateLifeFile(storage, waifuId, "reads", (current) => {
    const existing = current.cursors[placeKey];
    if (existing && compareIds(existing.lastReadMessageId, messageId) >= 0) return current;
    return { ...current, cursors: { ...current.cursors, [placeKey]: { lastReadMessageId: messageId, at: now.toISOString() } } };
  });
}

/** The forget path: the cursor is reset to the forget floor (or removed). */
export async function setReadCursor(storage: StorageService, waifuId: string, placeKey: string, messageId: string | undefined, now: Date): Promise<void> {
  await updateLifeFile(storage, waifuId, "reads", (current) => {
    const cursors = { ...current.cursors };
    if (messageId === undefined) delete cursors[placeKey];
    else cursors[placeKey] = { lastReadMessageId: messageId, at: now.toISOString() };
    return { ...current, cursors };
  });
}

// ---- maintenance.jsonl (§7.3) --------------------------------------------------------------------------------

export type MaintenanceReport = {
  at: string;
  kind: "maintenance" | "scrub" | "forget";
  [key: string]: unknown;
};

export async function appendMaintenanceReport(storage: StorageService, waifuId: string, report: MaintenanceReport): Promise<void> {
  await storage.withLocks([lifeLocks.maintenance(waifuId)], () => appendJsonl(storage.dataPath(lifePaths.maintenance(waifuId)), [report]));
}

export async function readMaintenanceReports(storage: StorageService, waifuId: string): Promise<MaintenanceReport[]> {
  return (await readJsonl(storage.dataPath(lifePaths.maintenance(waifuId)), z.record(z.string(), z.unknown()) as unknown as z.ZodType<MaintenanceReport>)).rows;
}

/** Rewrites maintenance.jsonl without the lines `drop` matches (forget, §7.5 step 3). Returns how many went. */
export async function scrubMaintenanceReports(storage: StorageService, waifuId: string, drop: (line: string) => boolean): Promise<number> {
  return storage.withLocks([lifeLocks.maintenance(waifuId)], async () => {
    const file = storage.dataPath(lifePaths.maintenance(waifuId));
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissing(error)) return 0;
      throw error;
    }
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const kept = lines.filter((line) => !drop(line));
    if (kept.length === lines.length) return 0;
    await atomicWriteText(file, kept.map((line) => `${line}\n`).join(""));
    return lines.length - kept.length;
  });
}
