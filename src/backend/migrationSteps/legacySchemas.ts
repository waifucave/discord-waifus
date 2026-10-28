// Schemas of data shapes Living cast retired (spec §7.4, §11.2), kept only for the migrations that
// read or convert them: the global memory store (`user/memories.json`) and the pending observations
// queue. Nothing outside src/backend/migrations.ts and src/backend/migrationSteps/ may import this.
import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "../../shared/schemas/common.js";
import { parseLocalDateTime } from "../../life/clock.js";

// W3 unified memory record. Replaces the former WaifuMemory/ShortTermMemory split: a
// "short-term memory" is now just a record with source "waifu_tool", kind "context", and an
// expiresAt. Old persisted records (importance/permanent/scope/sourceMessageIds) are migrated by
// shape detection in runMigrations BEFORE any read can default these fields — see migrateMemoryStoreV2.
export const MEMORY_KINDS = ["fact", "preference", "relationship", "event", "commitment", "context"] as const;
export const MemoryKindSchema = z.enum(MEMORY_KINDS);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MEMORY_SOURCES = ["waifu_tool", "stage_manager", "dream", "user"] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// Phase 4 (spec 8.8, D2): memories are global per waifu. Where a memory was learned is provenance
// only (`origin`), never a retrieval filter. Subjects are the people/waifus the memory is about,
// keyed by stable ids; `name` is the last-known display name (refreshed at render time).
export const MemoryOriginSchema = z.object({
  guildId: z.string().min(1).optional(),
  channelId: z.string().min(1).optional(),
  dm: z.literal(true).optional(),
  // DM provenance (spec 9.1.4): the Discord user of the private chat, so forgetting a user
  // finds every DM-origin record and the same-origin boost stays inside that user's own DM.
  userId: z.string().min(1).optional()
});
export type MemoryOrigin = z.infer<typeof MemoryOriginSchema>;

export const MemorySubjectSchema = z.object({
  discordUserId: z.string().min(1).optional(),
  waifuId: z.string().min(1).optional(),
  name: z.string().min(1)
});
export type MemorySubject = z.infer<typeof MemorySubjectSchema>;

export const MEMORY_ARCHIVED_REASONS = ["merged", "expired", "deduped", "user", "unknown_waifu"] as const;
export const MemoryArchivedReasonSchema = z.enum(MEMORY_ARCHIVED_REASONS);
export type MemoryArchivedReason = z.infer<typeof MemoryArchivedReasonSchema>;

export const MemoryRecordSchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema.default("fact"),
  source: MemorySourceSchema.default("stage_manager"),
  pinned: z.boolean().default(false), // user-managed; never auto-edited, always injected
  strength: z.number().min(0).max(5).default(3),
  origin: MemoryOriginSchema.default({}),
  subjects: z.array(MemorySubjectSchema).default([]),
  // Per-record optimistic-concurrency counter: every content write bumps it (API, observer ops,
  // dream, waifu tool, archival); retrieval statistics (lastRetrievedAt) never do.
  revision: z.number().int().nonnegative().default(0),
  expiresAt: IsoDateStringSchema.optional(), // hard TTL (waifu notes); absent = durable
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  lastRetrievedAt: IsoDateStringSchema.optional(),
  status: z.enum(["active", "archived"]).default("active"),
  archivedReason: MemoryArchivedReasonSchema.optional(),
  mergedInto: z.string().min(1).optional()
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const MemoryStoreSchema = RevisionedRecordSchema.extend({
  memories: z.array(MemoryRecordSchema)
});
export type MemoryStore = z.infer<typeof MemoryStoreSchema>;

export const PendingObservationSchema = z.object({
  id: z.string().min(1),
  waifuId: z.string().min(1),
  content: z.string().min(1),
  kind: MemoryKindSchema,
  importance: z.number().int().min(1).max(5),
  subjects: z.array(MemorySubjectSchema).default([]),
  origin: MemoryOriginSchema.default({}),
  // The conversation the observer read (`g_<guild>_<channel>` | `dm_<user>_<waifu>`).
  conversationKey: z.string().min(1).optional(),
  createdAt: IsoDateStringSchema
});
export type PendingObservation = z.infer<typeof PendingObservationSchema>;

export const PendingObservationsFileSchema = RevisionedRecordSchema.extend({
  observations: z.array(PendingObservationSchema)
});
export type PendingObservationsFile = z.infer<typeof PendingObservationsFileSchema>;

// Living cast L2's app-kept watch and reminder files (`life/watches.json`, `life/schedule.json`),
// read only by `living-cast-home-v1`, which turns them into her own files (spec §16.13).
export const L2WatchBindingSchema = z.object({
  placeKey: z.string().min(1).optional(),
  fromUserId: z.string().min(1).optional(),
  fromName: z.string().optional(),
  words: z.array(z.string().min(1)).max(10).optional(),
  anyMessage: z.boolean().optional()
});
export const L2WatchesFileSchema = z.object({
  nextId: z.number().int().positive().default(1),
  watches: z
    .array(
      z.object({
        id: z.string().min(1),
        note: z.string().max(200),
        createdAt: IsoDateStringSchema,
        expiresAt: IsoDateStringSchema,
        once: z.boolean(),
        bindings: z.array(L2WatchBindingSchema).min(1).max(5),
        fires: z.array(IsoDateStringSchema).default([])
      })
    )
    .default([])
});
export const L2ScheduleFileSchema = z.object({
  nextId: z.number().int().positive().default(1),
  reminders: z
    .array(
      z.object({
        id: z.string().min(1),
        note: z.string().max(200),
        dueAt: IsoDateStringSchema,
        repeat: z.enum(["daily", "weekly"]).optional(),
        createdAt: IsoDateStringSchema
      })
    )
    .default([])
});

// Her reminder and watch files from L4 to §30 (`~/reminders.json`, `~/watches.json`, then in
// `~/life/`), written by `living-cast-home-v1` and read by `living-cast-wakeups-v1`, which turns them
// into `~/life/wakeups.json` (spec §30.3).
export type LegacyReminderEntry = { id: string; at: string; repeat?: "daily" | "weekly"; note: string };
export type LegacyWatchBindingEntry = { place?: string; from?: string; words?: string[]; any_message?: boolean };
export type LegacyWatchEntry = { id: string; timeout: string; once: boolean; note: string; when: LegacyWatchBindingEntry[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** `[{...}, …]` one entry per line, with spaces after `:` and `,` (the files' look then). */
export function legacyFormatEntries(entries: ReadonlyArray<Record<string, unknown>>): string {
  if (entries.length === 0) return "[]\n";
  const spaced = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(spaced).join(", ")}]`;
    if (isRecord(value)) return `{${Object.entries(value).map(([key, inner]) => `${JSON.stringify(key)}: ${spaced(inner)}`).join(", ")}}`;
    return JSON.stringify(value);
  };
  return `[\n${entries.map((entry) => `  ${spaced(entry)}`).join(",\n")}\n]\n`;
}

export function legacyScheduleText(entries: readonly LegacyReminderEntry[]): string {
  return legacyFormatEntries(entries.map((entry) => ({ id: entry.id, at: entry.at, ...(entry.repeat ? { repeat: entry.repeat } : {}), note: entry.note })));
}

export function legacyWatchesText(entries: readonly LegacyWatchEntry[]): string {
  return legacyFormatEntries(entries.map((entry) => ({ id: entry.id, timeout: entry.timeout, once: entry.once, note: entry.note, when: entry.when.map((binding) => ({ ...binding })) })));
}

/** Her saved reminders, read leniently (an entry without a readable time is left out; one without an id has id "": it gets a new one). */
export function readLegacyReminders(text: string | undefined, timeZone: string): LegacyReminderEntry[] {
  if (!text?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LegacyReminderEntry[] => {
    if (!isRecord(entry) || typeof entry["at"] !== "string" || !parseLocalDateTime(entry["at"], timeZone)) return [];
    return [{ id: typeof entry["id"] === "string" ? entry["id"] : "", at: entry["at"], ...(entry["repeat"] === "daily" || entry["repeat"] === "weekly" ? { repeat: entry["repeat"] } : {}), note: typeof entry["note"] === "string" ? entry["note"] : "" }];
  });
}

/** Her saved watches, read leniently (the same rules). */
export function readLegacyWatches(text: string | undefined, timeZone: string): LegacyWatchEntry[] {
  if (!text?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): LegacyWatchEntry[] => {
    if (!isRecord(entry) || typeof entry["timeout"] !== "string" || !parseLocalDateTime(entry["timeout"], timeZone)) return [];
    const when = Array.isArray(entry["when"]) ? (entry["when"] as unknown[]).filter(isRecord) : [];
    return [
      {
        id: typeof entry["id"] === "string" ? entry["id"] : "",
        timeout: entry["timeout"],
        once: entry["once"] !== false,
        note: typeof entry["note"] === "string" ? entry["note"] : "",
        when: when.map((b) => ({
          ...(typeof b["place"] === "string" ? { place: b["place"] } : {}),
          ...(typeof b["from"] === "string" ? { from: b["from"] } : {}),
          ...(Array.isArray(b["words"]) ? { words: (b["words"] as unknown[]).filter((w): w is string => typeof w === "string") } : {}),
          ...(typeof b["any_message"] === "boolean" ? { any_message: b["any_message"] } : {})
        }))
      }
    ];
  });
}

/** `life/watch-ids.json` before §30: how each watch's bindings resolved, fires, timeouts routed. */
export const LegacyWatchIdsSchema = z.object({
  nextId: z.number().int().positive().default(1),
  sourceHash: z.string().default(""),
  watches: z.record(z.string(), z.object({ bindings: z.array(L2WatchBindingSchema).default([]), fires: z.array(IsoDateStringSchema).default([]) })).default({}),
  fired: z.array(z.string()).default([]),
  recoveredAt: IsoDateStringSchema.optional()
});
export type LegacyWatchIds = z.infer<typeof LegacyWatchIdsSchema>;

/** `life/schedule-ids.json` before §30: the reminder id counter and occurrences routed. */
export const LegacyScheduleIdsSchema = z.object({
  nextId: z.number().int().positive().default(1),
  fired: z.array(z.string()).default([]),
  recoveredAt: IsoDateStringSchema.optional()
});
