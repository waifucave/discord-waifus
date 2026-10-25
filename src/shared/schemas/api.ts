import { z } from "zod";
import { IsoDateStringSchema } from "./common.js";
import { DetectorHistoryEntrySchema, ServerDetectorOverrideSchema } from "./detector.js";
import { WaifuDmSettingsSchema } from "./dm.js";
import {
  DiscordBotConfigSchema,
  DiscordBotsFileSchema,
  ModelChoiceSchema,
  ServerConfigSchema,
  WAIFU_VERBOSITIES,
  WaifuAvailabilitySchema,
  WaifuConfigSchema,
  WaifuLifeSettingsSchema
} from "./domain.js";
import { LifeLogKindSchema, WakeReasonSchema } from "./life.js";
import { partialWithoutDefaults } from "./partial.js";
import { ChannelThreadsModeSchema } from "./threads.js";
import { FORGET_JOB_PARTS } from "../constants/forget.js";

// Request bodies and response shapes of the HTTP API (Living cast spec §14.1). These schemas are the
// one source of the API's shapes: the routes parse bodies with them, tests parse responses with
// them, and the dashboard's types are derived from them (overhaul spec §10.6, I17).

// ---- request bodies ------------------------------------------------------------------------------

const RevisionField = z.number().int().nonnegative().optional();

/** `null` unsets the model; omitted leaves it untouched. */
export const ModelChoicePatchSchema = z.union([ModelChoiceSchema, z.null()]).optional();

// `model` is validated against the curated catalog on write (Living cast §9.2).
export const CreateWaifuBodySchema = WaifuConfigSchema.omit({
  schemaVersion: true,
  revision: true,
  updatedAt: true
})
  .partial({ id: true, enabled: true, persona: true })
  .required({ name: true, displayName: true });

// Every WaifuConfigSchema field carries a default; `.partial()` alone would still fill it in, so a
// PATCH-style update would reset stored values. Fields are re-declared without defaults: omitted
// means "leave it alone", nested settings objects are merged key by key.
export const UpdateWaifuBodySchema = WaifuConfigSchema.partial().extend({
  revision: RevisionField,
  enabled: z.boolean().optional(),
  persona: z.string().optional(),
  model: ModelChoicePatchSchema,
  availability: partialWithoutDefaults(WaifuAvailabilitySchema).optional(),
  verbosity: z.enum(WAIFU_VERBOSITIES).optional(),
  customInstructions: z.string().max(4000).optional(),
  scheduleInPrompt: z.boolean().optional(),
  dm: partialWithoutDefaults(WaifuDmSettingsSchema).optional(),
  // Living cast §4.1 / §4.4: kept when a PUT leaves them out; `life.dailyBudgetUsd: null` = no budget.
  wakeOnName: z.boolean().optional(),
  life: partialWithoutDefaults(WaifuLifeSettingsSchema).optional(),
  // Spec 8.6: the layout editor is gone. `promptLayout` is still accepted (any shape) for one
  // release so older dashboards/scripts do not fail, but it is ignored and never written.
  promptLayout: z.unknown().optional()
});

// Server writes are partial. Fields retired by Living cast are stripped like any unknown key.
export const UpdateServerBodySchema = ServerConfigSchema.partial().extend({
  revision: RevisionField,
  // Spec 9.7: the server `enabled` flag was removed. Accepted and ignored for one release (logged).
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  // Living cast §4.3: the per-server detector override; `null` removes it (inherit the global target).
  detector: ServerDetectorOverrideSchema.nullable().optional(),
  // channels is a documented wholesale replace; per-channel edits use the channel route.
  // `thread` marks the runtime-only overlay entries and is never accepted from a client.
  channels: z.record(z.string(), ServerConfigSchema.shape.channels.unwrap().valueType.omit({ thread: true })).optional()
});

export const UpdateChannelBodySchema = z.object({
  revision: RevisionField,
  name: z.string().optional(),
  // Spec 9.7: the channel `enabled` flag was removed. Accepted and ignored for one release (logged).
  enabled: z.boolean().optional(),
  enabledWaifuIds: z.array(z.string()).optional(),
  // "inherit" (default) lets threads and forum posts under this channel share its cast; "off"
  // silences them. Omitted keeps the stored value.
  threads: ChannelThreadsModeSchema.optional()
});

export const UpdateAssistantConfigBodySchema = z.object({
  revision: RevisionField,
  model: ModelChoicePatchSchema
});

export const ProviderCredentialsBodySchema = z.object({
  apiKey: z.string().min(1),
  label: z.string().optional(),
  revision: RevisionField
});

// `enabled` is required (not defaulted) in write bodies: a missing flag is a malformed request.
const DiscordBotBodySchema = DiscordBotConfigSchema.extend({ enabled: z.boolean() });

export const UpdateDiscordBotsBodySchema = DiscordBotsFileSchema.partial().extend({
  revision: RevisionField,
  orchestrator: DiscordBotBodySchema.nullable().optional(),
  waifus: z.array(DiscordBotBodySchema).optional()
});

/** `POST /api/people/:userId/forget` (§14.1; replaces `/api/memories/forget-user`). */
export const PeopleForgetBodySchema = z.object({
  confirm: z.literal(true),
  dryRun: z.boolean().optional()
});

/** `POST /api/waifus/:id/wake`. */
export const WakeBodySchema = z.object({ note: z.string().max(500).optional() });

/** `POST /api/waifus/:id/life/reset`: the owner confirms. */
export const LifeResetBodySchema = z.object({ confirm: z.literal(true) });

export const DetectorConfigBodySchema = z.object({
  target: z.string().max(200)
});

// ---- responses: lives (§14.1) ---------------------------------------------------------------------

export const LifeAvailabilitySchema = z.object({
  state: z.enum(["awake", "busy", "asleep"]),
  /** busy: the block's reason. */
  reason: z.string().optional(),
  /** busy: when the block ends ("12:00"). asleep: when her sleep window ends (ISO). */
  until: z.string().optional()
});

/** One queued wake as the dashboard shows it. DM previews are hidden unless the request may see DM content. */
export const LifeWakeViewSchema = z.object({
  id: z.string(),
  reason: WakeReasonSchema,
  reasons: z.array(WakeReasonSchema).optional(),
  /** The place the wake is about (a conversation key; `dm: true` marks a DM). */
  place: z.string().optional(),
  from: z.string().optional(),
  preview: z.string().optional(),
  note: z.string().optional(),
  /** The wake is about a DM: its preview is DM content (D14). */
  dm: z.boolean().optional(),
  count: z.number().int().positive().optional(),
  at: IsoDateStringSchema
});

export const LifeStatusResponseSchema = z.object({
  waifuId: z.string(),
  displayName: z.string(),
  enabled: z.boolean(),
  model: ModelChoiceSchema.nullable(),
  hasBot: z.boolean(),
  /** `running`: a live cast runtime hosts her life (Discord connected). `busy`: a turn cycle runs now. */
  runtime: z.object({ running: z.boolean(), busy: z.boolean(), paused: z.boolean() }),
  availability: LifeAvailabilitySchema,
  /** Her life has started (its first epoch's system prompt was built). */
  started: z.boolean(),
  status: z.enum(["idle", "turn"]),
  currentTurn: z.object({ id: z.string(), startedAt: IsoDateStringSchema, rounds: z.number().int().nonnegative(), wakes: z.number().int().nonnegative() }).nullable(),
  epoch: z.number().int().positive(),
  epochStartedAt: IsoDateStringSchema,
  logLines: z.number().int().nonnegative(),
  lastTurnEndedAt: IsoDateStringSchema.nullable(),
  lastCompaction: z.object({ at: IsoDateStringSchema, reason: z.string(), summarized: z.boolean(), fromEpoch: z.number().int().positive() }).nullable(),
  lastMaintenanceAt: IsoDateStringSchema.nullable(),
  compactionPausedUntil: IsoDateStringSchema.nullable(),
  failedTurnAt: IsoDateStringSchema.nullable(),
  queue: z.object({
    immediate: z.number().int().nonnegative(),
    deferred: z.object({ reason: z.enum(["sleep", "budget"]).nullable(), since: IsoDateStringSchema.nullable(), places: z.number().int().nonnegative(), items: z.number().int().nonnegative() }),
    quiet: z.number().int().nonnegative(),
    wakes: z.array(LifeWakeViewSchema)
  }),
  today: z.object({
    day: z.string(),
    costUsd: z.number().nonnegative(),
    calls: z.number().int().nonnegative(),
    budgetUsd: z.number().nullable(),
    searches: z.number().int().nonnegative(),
    fetches: z.number().int().nonnegative()
  }),
  /** Her compaction summary (`<life_so_far>`): DM content, shown only with `includePrivate=1` (local). */
  summary: z.object({ text: z.string().nullable(), hidden: z.boolean() }),
  counts: z.object({
    needsReview: z.number().int().nonnegative(),
    pendingScrubs: z.number().int().nonnegative()
  }),
  includePrivate: z.boolean()
});

export const LifeLogBlockSchema = z.object({
  type: z.enum(["text", "tool_use", "tool_result", "image", "reasoning", "other"]),
  text: z.string().optional(),
  /** tool_use: the call id and tool name; tool_result: the call it answers. */
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  toolUseId: z.string().optional(),
  isError: z.boolean().optional(),
  /** The content is DM content and was left out (D14): reveal it locally with `includePrivate=1`. */
  redacted: z.boolean().optional()
});

export const LifeLogLineViewSchema = z.object({
  seq: z.number().int().nonnegative(),
  at: IsoDateStringSchema,
  kind: LifeLogKindSchema,
  turnId: z.string().optional(),
  role: z.enum(["user", "assistant"]).optional(),
  blocks: z.array(LifeLogBlockSchema),
  /** The line's turn touched a DM place: its content may include things from private chats. */
  dm: z.boolean(),
  origin: z.object({ providerId: z.string().optional(), modelId: z.string().optional() }).optional(),
  boundary: z.object({ fromEpoch: z.number().int().positive(), reason: z.string(), keptTurns: z.number().int().nonnegative() }).optional()
});

export const LifeLogResponseSchema = z.object({
  waifuId: z.string(),
  epoch: z.number().int().positive(),
  /** Epochs with a log on disk (old ones are kept 7 days). */
  epochs: z.array(z.number().int().positive()),
  lines: z.array(LifeLogLineViewSchema),
  /** Older lines exist: pass `before` = the first line's `seq`. */
  hasMore: z.boolean(),
  includePrivate: z.boolean(),
  /** Blocks left out as DM content in this page. */
  redactedBlocks: z.number().int().nonnegative()
});

export const NeedsReviewItemSchema = z.object({
  /** Stable id of the line (a hash of where + line), for dismissing it. */
  id: z.string(),
  at: z.string(),
  source: z.string(),
  where: z.string(),
  /** `[private chat redacted]` for a private line unless the request said `includePrivate=1` (local). */
  line: z.string(),
  /** From a private chat (her summary, a DM wake or watch, a DM place): D14. */
  private: z.literal(true).optional()
});

export const NeedsReviewResponseSchema = z.object({ waifuId: z.string(), includePrivate: z.boolean(), items: z.array(NeedsReviewItemSchema) });

/** `DELETE …/life/needs-review/:itemId`: only the id (the response is kept by Remote Access's ledger). */
export const NeedsReviewDismissResponseSchema = z.object({ waifuId: z.string(), dismissed: z.string() });

export const WakeResponseSchema = z.object({
  waifuId: z.string(),
  /** queued: a turn starts shortly. deferred: she is asleep or over budget. quiet: merged into a queued line. dropped: paused or disabled. queued_offline: Discord is offline; it waits in her queue. */
  outcome: z.enum(["queued", "deferred", "quiet", "dropped", "queued_offline"]),
  wakeId: z.string().optional()
});

export const LifeCompactResponseSchema = z.object({
  waifuId: z.string(),
  /** done: the new epoch started. running: still summarising after the wait (it finishes on its own). */
  state: z.enum(["done", "running"]),
  epoch: z.number().int().positive().optional(),
  summarized: z.boolean().optional()
});

export const LifeResetResponseSchema = z.object({
  waifuId: z.string(),
  epoch: z.number().int().positive(),
  /** The fresh epoch starts at her next turn (she has no model to build its prompt with now). */
  deferred: z.boolean()
});

// ---- responses: search, usage, detector -------------------------------------------------------------

export const SearchUsageResponseSchema = z.object({
  day: z.string(),
  searches: z.number().int().nonnegative(),
  fetches: z.number().int().nonnegative(),
  limits: z.object({
    maxPerSecond: z.number().int(),
    maxPerDay: z.number().int(),
    maxPerWaifuPerDay: z.number().int(),
    fetchMaxPerWaifuPerDay: z.number().int(),
    fetchMaxPerTurn: z.number().int()
  }),
  /** An Exa key is saved (`exa` provider credential); search also works keyless. */
  exaKeyConfigured: z.boolean(),
  recent: z.array(z.object({ at: IsoDateStringSchema, waifuId: z.string(), kind: z.enum(["search", "fetch"]), query: z.string(), ok: z.boolean() }))
});

export const USAGE_GROUP_KEYS = ["day", "waifu", "purpose", "model", "provider", "turn", "place", "server"] as const;
export type UsageGroupKey = (typeof USAGE_GROUP_KEYS)[number];

export const UsageTotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  costKnownCalls: z.number().int().nonnegative(),
  unpricedCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative()
});

export const UsageResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  timeZone: z.string(),
  groupBy: z.array(z.enum(USAGE_GROUP_KEYS)),
  totals: UsageTotalsSchema,
  groups: z.array(UsageTotalsSchema.extend({ key: z.array(z.string()), label: z.string().optional() })),
  skippedLines: z.number().int().nonnegative()
});

export const DetectorConfigResponseSchema = z.object({
  /** The global native-choice target ("" = no detector: the §4.3 fallback rule decides). */
  target: z.string(),
  default: z.string()
});

export const DetectorHistoryResponseSchema = z.object({ guildId: z.string(), entries: z.array(DetectorHistoryEntrySchema) });

// ---- responses: forget and owner notices ------------------------------------------------------------

export const ForgetPendingSchema = z.object({
  part: z.enum(FORGET_JOB_PARTS),
  error: z.string().optional(),
  failures: z.number().int().nonnegative(),
  /** false: given up after three failures (an owner notice lists it). */
  retried: z.boolean()
});

/** A forget's review line; a private one (D14) always arrives as `[private chat redacted]` here. */
export const ReviewLineSchema = z.object({ where: z.string(), line: z.string(), private: z.literal(true).optional() });

export const ForgetScrubResultSchema = z.object({
  waifuId: z.string(),
  removedLines: z.number().int().nonnegative(),
  removedSentences: z.number().int().nonnegative(),
  removedNotes: z.number().int().nonnegative().optional(),
  needsReview: z.array(ReviewLineSchema),
  /** Queued as a pending scrub: it runs at her next start or nightly maintenance. */
  queued: z.boolean().optional()
});

/** `POST /api/people/:userId/forget` (§7.5 result); HTTP 202 when `pending` is not empty. */
export const PeopleForgetResponseSchema = z.object({
  discordUserId: z.string(),
  dryRun: z.boolean(),
  dmContexts: z.number().int().nonnegative(),
  dmStates: z.number().int().nonnegative(),
  dmLimits: z.number().int().nonnegative(),
  cachedImages: z.number().int().nonnegative(),
  memberLists: z.number().int().nonnegative().optional(),
  archive: z.object({ files: z.number().int(), removed: z.number().int(), unreadable: z.number().int(), skipped: z.number().int() }).optional(),
  pending: z.array(ForgetPendingSchema).optional(),
  /** Each life scrubbed now (a cast runtime is live). */
  lives: z.array(ForgetScrubResultSchema).optional(),
  /** Waifus whose scrub waits for her next start (no cast runtime). */
  livesQueued: z.array(z.string()).optional()
});

export const ForgetJobViewSchema = z.object({
  userId: z.string(),
  at: z.string(),
  pending: z.array(ForgetPendingSchema)
});

export const ForgetJobsResponseSchema = z.object({ jobs: z.array(ForgetJobViewSchema) });

/** `GET /api/owner-notices` (and `waifus doctor` / `waifus status`): what needs the owner's attention. */
export const OwnerNoticesResponseSchema = z.object({
  /** `discord.warnings` of `/api/runtime`: permission warnings, Living cast notices, given-up forget parts. */
  notices: z.array(z.string()),
  forgetJobs: z.array(ForgetJobViewSchema),
  /** Migration steps that left unreadable data alone at the last start (they run again next start). */
  incompleteMigrations: z.array(z.object({ step: z.string(), detail: z.string(), at: z.string() })),
  /** Kept copies of unreadable forget records (deleted after 7 days). */
  corruptForgetCopies: z.number().int().nonnegative(),
  /** Forget scrubs still queued, per waifu. */
  pendingScrubs: z.array(z.object({ waifuId: z.string(), count: z.number().int().nonnegative() })),
  intake: z.object({ paused: z.boolean(), pausedAt: z.string().nullable(), marks: z.number().int().nonnegative() }),
  /** Enabled waifus linked to a bot that cannot log in for her: missing, turned off, or without a token. */
  waifusWithoutBot: z.array(z.object({ waifuId: z.string(), reason: z.enum(["bot_missing", "bot_disabled", "bot_no_token"]) }))
});
