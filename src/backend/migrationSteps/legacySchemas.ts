// Schemas of data shapes Living cast retired (spec §7.4, §11.2), kept only for the migrations that
// read or convert them: the global memory store (`user/memories.json`) and the pending observations
// queue. Nothing outside src/backend/migrations.ts and src/backend/migrationSteps/ may import this.
import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "../../shared/schemas/common.js";

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
