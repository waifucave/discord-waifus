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
  tools: z.array(z.string()).default([]),
  /** Their descriptions this epoch (sent unchanged for the whole epoch). */
  toolDescriptions: z.record(z.string(), z.string()).optional(),
  /** Their input schemas this epoch (limits they state follow the config at epoch start). */
  toolSchemas: z.record(z.string(), z.record(z.string(), z.unknown())).optional()
});
export type SystemSnapshot = z.infer<typeof SystemSnapshotSchema>;

export const WakeReasonSchema = z.enum(["mention", "name", "role", "everyone", "watch", "watch_timeout", "dm", "detector", "reminder", "plan", "morning", "owner", "followup", "wakeup_error"]);

/** One of her wakeups that fired (§30.4: several on one message are one wake, one line each). */
export const FiredWakeupSchema = z.object({
  id: z.string().min(1),
  /** What matched (a word, "any message", her function's string), when anything is shown. */
  matched: z.string().optional(),
  note: z.string().optional()
});
export type FiredWakeupRecord = z.infer<typeof FiredWakeupSchema>;
export type WakeReason = z.infer<typeof WakeReasonSchema>;

/**
 * One message a wake is about (§20: one notification line per message). `reasons` are this
 * message's own (absent: the wake's; empty: none, a message of the burst that woke her for nothing).
 */
export const WakeMessageSchema = z.object({
  id: z.string().min(1),
  fromUserId: z.string().min(1).optional(),
  fromName: z.string().optional(),
  /** ~60 characters, rendered once when the wake was queued. */
  preview: z.string(),
  reasons: z.array(WakeReasonSchema).optional(),
  /** watch: what matched in this message, and her note. */
  matched: z.string().optional(),
  note: z.string().optional(),
  /** watch: every wakeup that fired for this message (the first is also `matched`/`note`). */
  wakeups: z.array(FiredWakeupSchema).optional()
});
export type WakeMessage = z.infer<typeof WakeMessageSchema>;

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
  /** watch, watch_timeout, wakeup_error: the wakeup id and what matched. reminder: when she set it. */
  watchId: z.string().optional(),
  matched: z.string().optional(),
  /** watch: every wakeup that fired (§30.4; the first is also `watchId`/`matched`/`note`). */
  wakeups: z.array(FiredWakeupSchema).optional(),
  /** watch from a page wakeup (§30.2 `page`): the page polled. */
  url: z.string().optional(),
  /** watch_timeout: the places the ended watch named (their keys; none for "everywhere"), for her unanswered line (§34). */
  watchedPlaces: z.array(z.string().min(1)).max(10).optional(),
  setAt: IsoDateStringSchema.optional(),
  /** Every message of the burst or the merged wakes, oldest first (the newest `MAX_WAKE_MESSAGES`). */
  messages: z.array(WakeMessageSchema).optional(),
  /** Messages older than `messages` that were left out of it. */
  earlier: z.number().int().positive().optional(),
  /** How many wakes were merged into this entry. */
  count: z.number().int().positive().optional(),
  /** plan: the plans of her day (`~/life/schedule.json`) whose time came at one tick (§29). */
  plans: z.array(z.object({ at: z.string(), what: z.string() })).optional(),
  /** morning: the rendered batch (built when her bed time ends). */
  batch: z.array(z.string()).optional(),
  /** morning: the batch shows something from a DM (a DM's lines, a DM watch, an earlier batch that did): her turn is a DM turn (D14). */
  dm: z.boolean().optional(),
  /** detector: the detector said the burst is for the whole cast (`all`), not just maybe for her. */
  forAll: z.boolean().optional(),
  /** detector: the burst was for another person; she might chime in (§4.3 `chime_in`). */
  chimeIn: z.boolean().optional(),
  /** The wake came from a message written by another waifu (room loop guard, §4.4). */
  waifuAuthored: z.boolean().optional(),
  /** morning: the local date (`2026-10-27`) whose day this wake opens (§21.3); her turn is compacted after it. */
  day: z.string().optional(),
  /** Held while she is busy (§21.4): released at this time (her next phone check, else the block's end). */
  heldUntil: IsoDateStringSchema.optional(),
  /** Held: the busy block's `why`. */
  heldFor: z.string().optional(),
  /** Released from a busy hold: at a phone check while still busy, or when the block ended. */
  released: z.object({ kind: z.enum(["phone", "free"]), why: z.string() }).optional(),
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
  /** Message ids returned by `ReadMessages` this epoch (kept turns' ids carry over). */
  readMessageIds: z.array(z.string()),
  /** Folded into the next turn's notifications; never start a turn (§10.3). */
  pendingNotices: z.array(z.string()),
  /** Read messages deleted since (§10.3): listed for omission at the next compaction. */
  deletedReadIds: z.array(z.string()),
  tokenCalibration: TokenCalibrationSchema.optional(),
  /** The estimated size of the newest request (the time line's memory warning, §5.4). */
  lastRequestTokens: z.number().int().nonnegative().optional(),
  /** When her newest life request was sent: her prompt cache lives from it (§25). */
  lastRequestAt: IsoDateStringSchema.optional(),
  lastCompaction: z
    .object({ at: IsoDateStringSchema, reason: z.string(), summarized: z.boolean(), fromEpoch: z.number().int().positive() })
    .optional(),
  compactionPausedUntil: IsoDateStringSchema.optional(),
  /**
   * The rest turn she had in this epoch (§19.2: at most one per epoch). Should the compaction after
   * an ignored one be interrupted, the next cycle compacts, leaving this turn out.
   */
  restTurn: z.object({ epoch: z.number().int().positive(), turnId: z.string() }).optional(),
  /** The quiet-time rest turn before her prompt cache went cold (§25: at most one per epoch). */
  cacheRest: z.object({ epoch: z.number().int().positive(), turnId: z.string() }).optional(),
  /** Why her quiet-time rest summary was not used (§25): said once, on her next time line. */
  cacheRestIgnored: z.string().optional(),
  /** A forget scrub wrote the summary; the new epoch starts after the scrub (§7.5 step 2). */
  pendingEpochStart: z.boolean().optional(),
  /**
   * Why the pending epoch starts: `forget` (absent too) drops every old log; `reset` (an owner reset
   * without a model, §14.4) keeps them the usual 7 days.
   */
  pendingEpochReason: z.enum(["forget", "reset", "tools"]).optional(),
  /** Thinking blocks stripped from the kept turns at epoch start, reported on the epoch's first call (§12). */
  epochStrippedThinkingBlocks: z.number().int().nonnegative().optional(),
  /** §5.2 errors: the failed turn, and whether its one follow-up turn has run. */
  failedTurn: z.object({ at: IsoDateStringSchema, followUpDone: z.boolean() }).optional(),
  lastTurnEndedAt: IsoDateStringSchema.optional(),
  /** Last nightly maintenance (§7.3). */
  lastMaintenanceAt: IsoDateStringSchema.optional(),
  /** The start of the last day whose morning wake was queued (§21.3: one per day). */
  lastDayStart: IsoDateStringSchema.optional(),
  /** Why her last `<summary>` was not used (§21.6b): said once, on her next time line. */
  selfSummaryRefused: z.string().optional(),
  /** The morning turn ended: the next cycle compacts with reason `day` (§21.3), once. */
  dayCompactionDue: z.boolean().optional(),
  /**
   * Places open while she is busy (§21.4): a wake that gets through woke her there and she sent a
   * message there; open until `until` (her latest send there + `life.busyEngagedMinutes`) and never
   * past the busy block's end (`blockEnd`). Keyed by place.
   */
  busyOpen: z.record(z.string(), z.object({ until: IsoDateStringSchema, blockEnd: IsoDateStringSchema })).optional(),
  /** Her last send anywhere (§21.6c): up late, dozing or asleep in her bed time count from it. */
  lastSentAt: IsoDateStringSchema.optional(),
  /** Her latest send per place within `life.busyEngagedMinutes` (§21.6c: open while up late or dozing). */
  recentSends: z.record(z.string(), IsoDateStringSchema).optional(),
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
  /** A Discord image (logs from before §16): where it was shown. */
  placeKey: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  /** A file she opened with Read (§16.3.3): its path then; the bytes are cached under `file:<sha256>`. */
  file: z.string().min(1).optional(),
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
  /**
   * tool_results written by the life loop: the calls that resolved to a DM place (their input or what
   * they returned), recorded as the tools ran; present (maybe empty) means every call was recorded
   * (D14, spec §14.4). Never sent to the model.
   */
  dmCalls: z.array(z.string()).optional(),
  /** Lines that carry wakes (a turn's notifications, folded wakes): whether any is about a DM place. */
  dmWakes: z.boolean().optional(),
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
  /** done lines: what the tool returned (send: the Discord message ids, comma-separated). */
  resultRef: z.string().optional(),
  /**
   * SendMessage, written just before the Discord call: a digest of the final outgoing content
   * (after mentions and emoji were resolved), so boot repair recognises the message (§5.7).
   */
  contentDigest: z.string().optional(),
  /**
   * SendMessage scripts (§27.1): the script line one message starts on. A line's own intent (with
   * `contentDigest`) is written just before its Discord call and its `lineDone` line (with the message
   * id as `resultRef`) right after, so boot repair knows each message on its own.
   */
  line: z.number().int().min(1).optional(),
  lineDone: z.literal(true).optional(),
  /**
   * SendMessage scripts since §32: one `tools.send_message` call's sends, written once every check
   * passed and before its first Discord call (`line` numbers its messages across the whole script),
   * so boot repair knows what each call meant to send; `callDone` (the call's number) after it ran,
   * with what it sent as `resultRef`.
   */
  plan: z
    .object({
      call: z.number().int().min(1),
      place: z.string(),
      sends: z.array(z.object({ line: z.number().int().min(1), text: z.string(), files: z.array(z.string()).default([]) }))
    })
    .optional(),
  callDone: z.number().int().min(1).optional()
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
  names: z.record(z.string(), z.string()).default({}),
  /**
   * The morning summary's message lines (§23): every message of a deferred DM wake, and of a room
   * wake the messages that addressed her (a mention or reply, her name, a role or `@everyone`), each
   * with its reasons; oldest first, the newest `MAX_WAKE_MESSAGES`.
   */
  lines: z.array(WakeMessageSchema).optional(),
  /** Lines older than `lines` that were left out of it. */
  earlier: z.number().int().positive().optional()
});
export type DeferredPlace = z.infer<typeof DeferredPlaceSchema>;

export const WakeQueueSchema = RevisionedRecordSchema.extend({
  immediate: z.array(WakeSchema).default([]),
  /**
   * Wakes held while she is busy (§21.4), each with `heldUntil`; released together into `immediate`
   * at her next phone check or the block's end. They never start a turn while held.
   */
  held: z.array(WakeSchema).default([]),
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

// ---- her wakeups: what the app keeps beside them (§30.3) ---------------------------------------------
//
// The file itself is hers (`home/life/wakeups.json`, a JSON array she edits; src/life/wakeups/file.ts
// checks it). The side file below, outside her folder, keeps what she must not edit.

/** One object filter of a watch with its place and `from` resolved. */
export const ResolvedWatchBindingSchema = z.object({
  placeKey: z.string().min(1).optional(),
  fromUserId: z.string().min(1).optional(),
  fromName: z.string().optional(),
  words: z.array(z.string().min(1)).max(10).optional(),
  anyMessage: z.boolean().optional()
});
export type ResolvedWatchBinding = z.infer<typeof ResolvedWatchBindingSchema>;

/**
 * `life/wakeup-ids.json` (§30.3): what the app keeps beside her `~/life/wakeups.json`, outside her
 * folder: the id counters per kind, how each watch's places and names resolved and when it fired,
 * when each `every` started counting, each page's last check, her code's errors in a row, and the
 * occurrences already routed (so a file the app cannot rewrite never fires twice).
 */
export const WakeupSideSchema = z.object({
  nextId: z.object({ t: z.number().int().positive().default(1), w: z.number().int().positive().default(1), p: z.number().int().positive().default(1) }).default({ t: 1, w: 1, p: 1 }),
  /** sha256 of the wakeups.json text these resolutions belong to. */
  sourceHash: z.string().default(""),
  watches: z
    .record(
      z.string(),
      z.object({
        /** The places' conversation keys; absent: everywhere (her places). */
        placeKeys: z.array(z.string()).optional(),
        /** Object filters with their names resolved; absent: a function filter. */
        filters: z.array(ResolvedWatchBindingSchema).optional(),
        /** Fire times in the last day (the daily cap) and the last fire (the 10-minute spacing). */
        fires: z.array(IsoDateStringSchema).default([]),
        /**
         * The latest room match the 10-minute spacing held back (§30.2, 2026-10-30), ids only: the
         * scheduler fires it once the spacing allows, reading the message from the transcript.
         */
        held: z
          .object({
            messageId: z.string().min(1),
            placeKey: z.string().min(1),
            at: IsoDateStringSchema,
            fromUserId: z.string().optional(),
            matched: z.string().optional(),
            waifuAuthored: z.literal(true).optional()
          })
          .optional()
      })
    )
    .default({}),
  /** `every`: occurrences after `since` count (a new or changed one never fires a past time). */
  every: z.record(z.string(), z.object({ when: z.string(), since: IsoDateStringSchema })).default({}),
  /** `page`: the last check, the text's hash ("changes") and whether `contains` held. */
  pages: z.record(z.string(), z.object({ checkedAt: IsoDateStringSchema.optional(), hash: z.string().optional(), matched: z.boolean().optional() })).default({}),
  /**
   * Her page fetches of the last day (at most `PAGE_FETCHES_PER_DAY`) and the last fetch per URL:
   * an edit, a cancel and a new `page()` for the same URL never fetch it sooner (§30.6).
   */
  pageFetches: z.array(IsoDateStringSchema).default([]),
  pageUrls: z.record(z.string(), IsoDateStringSchema).default({}),
  /** Errors in a row per wakeup (3 disable it). */
  errors: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Wake ids already routed: timed occurrences, timeouts, once-watch matches (newest 200). */
  fired: z.array(z.string()).default([]),
  recoveredAt: IsoDateStringSchema.optional()
});
export type WakeupSide = z.infer<typeof WakeupSideSchema>;

/**
 * `life/plans-fired.json` (§29): today's timed plans of her day as the scheduler saw them, by key
 * `<at> <hash of what>` (no plan text): when each was first seen, and the ones that fired or were
 * skipped (too late). A record of another day is dropped.
 */
export const PlansFiredSchema = RevisionedRecordSchema.extend({
  date: z.string().optional(),
  seen: z.record(z.string(), IsoDateStringSchema).default({}),
  fired: z.array(z.string()).default([]),
  skipped: z.array(z.string()).default([])
});
export type PlansFired = z.infer<typeof PlansFiredSchema>;

// ---- files-index.json: where her downloads came from (§16.2 provenance) ------------------------------

export const ProvenanceEntrySchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  placeKey: z.string().min(1),
  messageId: z.string().min(1),
  authorId: z.string().min(1),
  attachmentId: z.string().min(1),
  downloadedAt: IsoDateStringSchema,
  /** Where ReadMessages saved it (`/tmp/...`), for the download dedupe. */
  path: z.string().min(1),
  size: z.number().int().nonnegative()
});
export type ProvenanceEntry = z.infer<typeof ProvenanceEntrySchema>;

export const FilesIndexSchema = z.object({
  entries: z.array(ProvenanceEntrySchema).default([])
});
export type FilesIndex = z.infer<typeof FilesIndexSchema>;

// ---- user/search/usage.json (host-wide web caps and recent queries, §6.8–§6.9, §14) --------------------

export const SearchUsageSchema = RevisionedRecordSchema.extend({
  /** Local day (YYYY-MM-DD) the counters belong to. */
  day: z.string().default(""),
  searches: z.number().int().nonnegative().default(0),
  fetches: z.number().int().nonnegative().default(0),
  /** The newest queries and fetched URLs (for the dashboard), newest last, at most 100. */
  recent: z
    .array(
      z.object({
        at: IsoDateStringSchema,
        waifuId: z.string(),
        kind: z.enum(["search", "fetch"]),
        query: z.string(),
        ok: z.boolean(),
        /** The turn that searched (marks its entries private if it becomes a DM turn). */
        turnId: z.string().optional(),
        /** Recorded in a DM turn (D14): its text is shown only on a local reveal. */
        dm: z.boolean().optional()
      })
    )
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
