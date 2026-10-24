import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";
import { ImageRefSchema } from "./discordMessage.js";

// A waifu's life on disk (Living cast spec §4.6, §5, §6.5, §6.6): `user/waifus/<id>/life/`. These
// schemas are the authority for the files; src/life/ reads and writes them.

// ---- state.json (§5.1) ---------------------------------------------------------------------------

export const LifeModelRouteSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  effort: z.string().min(1).optional()
});
export type LifeModelRoute = z.infer<typeof LifeModelRouteSchema>;

/** What block A and B were built from at epoch start (§5.4): fixed for the whole epoch. */
export const SystemSnapshotSchema = z.object({
  /** sha256 of block A (life harness, identity, persona, style, schedule, custom instructions) + the tools offered. */
  harnessHash: z.string().min(1),
  /** Block A exactly as sent. */
  harness: z.string(),
  /** Her MEMORY.md as of epoch start, already cut to the prompt limit. */
  memoryIndex: z.string(),
  /** The `<places>` text at epoch start. */
  places: z.string(),
  /** The tool names offered this epoch, in order. */
  tools: z.array(z.string()).default([])
});
export type SystemSnapshot = z.infer<typeof SystemSnapshotSchema>;

export const WakeReasonSchema = z.enum(["mention", "name", "role", "everyone", "watch", "dm", "detector", "reminder", "morning", "owner", "followup"]);
export type WakeReason = z.infer<typeof WakeReasonSchema>;

/** One queued wake (§4.6 `immediate`). Merged entries for one place carry every reason. */
export const WakeSchema = z.object({
  id: z.string().min(1),
  reason: WakeReasonSchema,
  /** Every reason merged into this entry, in arrival order (`mention, watch`). */
  reasons: z.array(WakeReasonSchema).optional(),
  placeKey: z.string().min(1).optional(),
  fromUserId: z.string().min(1).optional(),
  fromName: z.string().optional(),
  /** The (newest) triggering message. */
  messageId: z.string().min(1).optional(),
  /** ~60 characters of the triggering message, rendered once when the wake was queued. */
  preview: z.string().optional(),
  /** Her own note (reminder, watch) or the owner's (`owner`). */
  note: z.string().optional(),
  /** watch: the watch id and what matched. reminder: when she set it. */
  watchId: z.string().optional(),
  matched: z.string().optional(),
  setAt: IsoDateStringSchema.optional(),
  /** How many wakes were merged into this entry. */
  count: z.number().int().positive().optional(),
  /** morning: the rendered batch (built when her sleep ends). */
  batch: z.array(z.string()).optional(),
  /** The wake came from a message written by another waifu (room loop guard, §4.4). */
  waifuAuthored: z.boolean().optional(),
  at: IsoDateStringSchema
});
export type Wake = z.infer<typeof WakeSchema>;

export const CurrentTurnSchema = z.object({
  id: z.string().min(1),
  startedAt: IsoDateStringSchema,
  rounds: z.number().int().nonnegative(),
  wakeIds: z.array(z.string()),
  /** The turn's wakes, kept so a mid-turn compaction can repeat them in the next turn (§5.6). */
  wakes: z.array(WakeSchema).default([])
});
export type CurrentTurn = z.infer<typeof CurrentTurnSchema>;

export const TokenCalibrationSchema = z.object({
  ratio: z.number().positive(),
  samples: z.number().int().nonnegative(),
  updatedAt: IsoDateStringSchema,
  /** The estimator it was learned under (`TOKEN_ESTIMATOR_VERSION`); absent = version 1, dropped. */
  estimator: z.number().int().positive().optional()
});

export const LifeStateSchema = RevisionedRecordSchema.extend({
  waifuId: z.string().min(1),
  epoch: z.number().int().positive(),
  epochStartedAt: IsoDateStringSchema,
  status: z.enum(["idle", "turn"]),
  currentTurn: CurrentTurnSchema.optional(),
  summary: z.string().nullable(),
  /** Null until the first epoch's system prompt is built. */
  systemSnapshot: SystemSnapshotSchema.nullable(),
  /** The route the epoch runs on (null until built). */
  modelRoute: LifeModelRouteSchema.nullable(),
  inlineImageCount: z.number().int().nonnegative(),
  inlineImageBytes: z.number().int().nonnegative(),
  /** Image keys shown in this epoch (an image renders inline only at its first occurrence, §6.2). */
  shownImageKeys: z.array(z.string()).default([]),
  /** Message ids returned by `read_messages` this epoch (kept turns' ids carry over). */
  readMessageIds: z.array(z.string()),
  /** Folded into the next turn's notifications; never start a turn (§10.3). */
  pendingNotices: z.array(z.string()),
  /** Read messages deleted since (§10.3): listed for omission at the next compaction. */
  deletedReadIds: z.array(z.string()),
  tokenCalibration: TokenCalibrationSchema.optional(),
  /** The estimated size of the newest request (the time line's memory warning, §5.4). */
  lastRequestTokens: z.number().int().nonnegative().optional(),
  lastCompaction: z
    .object({ at: IsoDateStringSchema, reason: z.string(), summarized: z.boolean(), fromEpoch: z.number().int().positive() })
    .optional(),
  compactionPausedUntil: IsoDateStringSchema.optional(),
  /** A forget scrub wrote the summary; the new epoch starts after the scrub (§7.5 step 2). */
  pendingEpochStart: z.boolean().optional(),
  /** Thinking blocks stripped from the kept turns at epoch start, reported on the epoch's first call (§12). */
  epochStrippedThinkingBlocks: z.number().int().nonnegative().optional(),
  /** §5.2 errors: the failed turn, and whether its one follow-up turn has run. */
  failedTurn: z.object({ at: IsoDateStringSchema, followUpDone: z.boolean() }).optional(),
  lastTurnEndedAt: IsoDateStringSchema.optional(),
  /** Last nightly maintenance (§7.3). */
  lastMaintenanceAt: IsoDateStringSchema.optional(),
  /**
   * Her bot's server nicknames as last seen (guild id → name), so block A does not change just
   * because the guild directory has not loaded a guild yet (review M11).
   */
  serverNicknames: z.record(z.string(), z.string()).optional(),
  /** Per user: when a DM `/forget` last ran step 2 (§7.5 rate limit). */
  scrubbedAt: z.record(z.string(), IsoDateStringSchema).default({})
});
export type LifeState = z.infer<typeof LifeStateSchema>;

// ---- log/<epoch>.jsonl (§5.3) ----------------------------------------------------------------------

/**
 * An image inside a stored tool result: its mode is decided once, when the result is created, and
 * never stored as bytes. The builder resolves `inline` images through the image fetcher (§5.3).
 */
export const LifeImageBlockSchema = z.object({
  type: z.literal("life_image"),
  placeKey: z.string().min(1),
  messageId: z.string().min(1),
  attachment: ImageRefSchema,
  mode: z.union([z.literal("inline"), z.object({ text: z.string() })])
});
export type LifeImageBlock = z.infer<typeof LifeImageBlockSchema>;

export const LIFE_LOG_KINDS = ["notifications", "tool_results", "assistant", "system_note", "compaction_boundary"] as const;
export const LifeLogKindSchema = z.enum(LIFE_LOG_KINDS);
export type LifeLogKind = z.infer<typeof LifeLogKindSchema>;

/**
 * One life-log line. `message` is a winter `ProviderMessageLike` (assistant messages carry `origin`
 * and opaque `nativeState`, exactly as assembled); stored tool results may hold `life_image` blocks.
 * A `compaction_boundary` line carries no message.
 */
export const LifeLogLineSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: IsoDateStringSchema,
  kind: LifeLogKindSchema,
  turnId: z.string().optional(),
  message: z.record(z.string(), z.unknown()).nullable(),
  /** tool_results: per tool call, the Discord message ids the result shows (kept-turn omission, §5.6). */
  messageIds: z.record(z.string(), z.array(z.string())).optional(),
  /** compaction_boundary: where the epoch came from. */
  boundary: z.object({ fromEpoch: z.number().int().positive(), reason: z.string(), keptTurns: z.number().int().nonnegative() }).optional()
});
export type LifeLogLine = z.infer<typeof LifeLogLineSchema>;

// ---- intents.jsonl (§5.7) --------------------------------------------------------------------------

export const LifeIntentSchema = z.object({
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  argsDigest: z.string().min(1),
  at: IsoDateStringSchema,
  done: z.boolean().optional(),
  /** done lines: what the tool returned (send: the Discord message id). */
  resultRef: z.string().optional(),
  /**
   * send_message, written just before the Discord call: a digest of the final outgoing content
   * (after mentions and emoji were resolved), so boot repair recognises the message (§5.7).
   */
  contentDigest: z.string().optional()
});
export type LifeIntent = z.infer<typeof LifeIntentSchema>;

// ---- reads.json, handles.json (§5.5, §6.1) ----------------------------------------------------------

export const ReadCursorsSchema = RevisionedRecordSchema.extend({
  cursors: z.record(z.string(), z.object({ lastReadMessageId: z.string().min(1), at: IsoDateStringSchema })).default({})
});
export type ReadCursors = z.infer<typeof ReadCursorsSchema>;

export const PlaceHandlesSchema = RevisionedRecordSchema.extend({
  /** handle → placeKey; a handle, once assigned, is never reassigned. */
  handles: z.record(z.string(), z.string()).default({}),
  /** placeKey → its current primary handle. */
  primary: z.record(z.string(), z.string()).default({})
});
export type PlaceHandles = z.infer<typeof PlaceHandlesSchema>;

// ---- wakes.json (§4.6) -------------------------------------------------------------------------------

export const DeferredPlaceSchema = z.object({
  mentions: z.number().int().nonnegative().default(0),
  messages: z.number().int().nonnegative().default(0),
  dms: z.number().int().nonnegative().default(0),
  detector: z.number().int().nonnegative().default(0),
  fromUserIds: z.array(z.string()).default([]),
  /** Display names, by user id (for the morning batch). */
  names: z.record(z.string(), z.string()).default({})
});
export type DeferredPlace = z.infer<typeof DeferredPlaceSchema>;

export const WakeQueueSchema = RevisionedRecordSchema.extend({
  immediate: z.array(WakeSchema).default([]),
  deferred: z
    .object({
      /** Why she is not taking wakes: asleep, or over her daily budget. */
      reason: z.enum(["sleep", "budget"]).optional(),
      since: IsoDateStringSchema.optional(),
      /** Per place: counters (never dropped). */
      places: z.record(z.string(), DeferredPlaceSchema).default({}),
      /** Deferred reminders, watch matches and owner notes, with their notes. */
      items: z.array(WakeSchema).default([])
    })
    .default({ places: {}, items: [] }),
  /** Per-user wake limit (§4.4 guard 3): per user, the times of the last hour's wakes. */
  userWakes: z.record(z.string(), z.array(IsoDateStringSchema)).default({}),
  /** "+N more from Kevin" lines, folded into the next turn without starting one. */
  quiet: z.array(z.object({ userId: z.string(), name: z.string(), count: z.number().int().positive(), placeKey: z.string().optional() })).default([])
});
export type WakeQueue = z.infer<typeof WakeQueueSchema>;

// ---- watches.json (§6.5) -----------------------------------------------------------------------------

export const WatchBindingSchema = z.object({
  placeKey: z.string().min(1).optional(),
  fromUserId: z.string().min(1).optional(),
  fromName: z.string().optional(),
  words: z.array(z.string().min(1)).max(10).optional(),
  anyMessage: z.boolean().optional()
});
export type WatchBinding = z.infer<typeof WatchBindingSchema>;

export const WatchSchema = z.object({
  id: z.string().min(1),
  note: z.string().max(200),
  createdAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema,
  once: z.boolean(),
  bindings: z.array(WatchBindingSchema).min(1).max(5),
  /** Fire times in the last day (the daily cap) and the last fire (the 10-minute spacing). */
  fires: z.array(IsoDateStringSchema).default([])
});
export type Watch = z.infer<typeof WatchSchema>;

export const WatchesFileSchema = RevisionedRecordSchema.extend({
  nextId: z.number().int().positive().default(1),
  watches: z.array(WatchSchema).default([])
});
export type WatchesFile = z.infer<typeof WatchesFileSchema>;

// ---- schedule.json (§6.6) ----------------------------------------------------------------------------

export const ReminderSchema = z.object({
  id: z.string().min(1),
  note: z.string().max(200),
  dueAt: IsoDateStringSchema,
  repeat: z.enum(["daily", "weekly"]).optional(),
  createdAt: IsoDateStringSchema
});
export type Reminder = z.infer<typeof ReminderSchema>;

export const ScheduleFileSchema = RevisionedRecordSchema.extend({
  nextId: z.number().int().positive().default(1),
  reminders: z.array(ReminderSchema).default([])
});
export type ScheduleFile = z.infer<typeof ScheduleFileSchema>;

// ---- user/search/usage.json (host-wide web caps and recent queries, §6.8–§6.9, §14) --------------------

export const SearchUsageSchema = RevisionedRecordSchema.extend({
  /** Local day (YYYY-MM-DD) the counters belong to. */
  day: z.string().default(""),
  searches: z.number().int().nonnegative().default(0),
  fetches: z.number().int().nonnegative().default(0),
  /** The newest queries and fetched URLs (for the dashboard), newest last, at most 100. */
  recent: z
    .array(z.object({ at: IsoDateStringSchema, waifuId: z.string(), kind: z.enum(["search", "fetch"]), query: z.string(), ok: z.boolean() }))
    .default([])
});
export type SearchUsage = z.infer<typeof SearchUsageSchema>;

// ---- usage.json (web caps, §6.8–§6.9) -----------------------------------------------------------------

export const LifeUsageSchema = RevisionedRecordSchema.extend({
  /** Local day (YYYY-MM-DD) the counters belong to. */
  day: z.string().default(""),
  searches: z.number().int().nonnegative().default(0),
  fetches: z.number().int().nonnegative().default(0)
});
export type LifeUsage = z.infer<typeof LifeUsageSchema>;
