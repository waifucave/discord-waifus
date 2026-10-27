import { z } from "zod";
import { ServerDetectorOverrideSchema } from "./detector.js";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";
import { WaifuDmSettingsSchema, defaultWaifuDmSettings } from "./dm.js";
import { ChannelThreadsModeSchema } from "./threads.js";
import {
  DISCORD_BIO_MAX,
  DISCORD_NICKNAME_MAX,
  DISCORD_USERNAME_MAX,
  DISCORD_USERNAME_MIN,
  discordUsernameProblem
} from "../constants/discordProfile.js";

// A winter catalog provider id (`anthropic`, `openrouter`, …). Unknown ids are rejected at API
// write time — see src/api/writeValidation.ts's assertKnownProvider, which checks the installed
// winter catalog.
export const ProviderIdSchema = z.string().min(1);

/**
 * A model choice (Living cast spec §9.2): a curated winter route plus an optional reasoning effort
 * from the route's own list. The route is validated against the curated catalog at write time;
 * stored efforts are re-validated at every boot (src/backend/migrationSteps/modelEffortCheck.ts).
 */
export const ModelChoiceSchema = z.object({
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  effort: z.string().min(1).optional()
});
export type ModelChoice = z.infer<typeof ModelChoiceSchema>;

// Explicit `null` on write means "unset" (the PUT handlers delete the key from the merged object);
// plain `.optional()` alone cannot tell "send null to unset" from "field omitted, leave untouched".
const OptionalModelChoiceSchema = z.union([ModelChoiceSchema, z.null()]).optional().transform((value) => value ?? undefined);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm time.");
export type TimeOfDay = z.infer<typeof TimeOfDaySchema>;

const WaifuBedTimeSchema = z
  .object({
    enabled: z.boolean().default(false),
    start: TimeOfDaySchema.default("23:00"),
    end: TimeOfDaySchema.default("07:00")
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.start === value.end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end"],
        message: "Bed time end must differ from its start."
      });
    }
  })
  .default({
    enabled: false,
    start: "23:00",
    end: "07:00"
  });
export type WaifuBedTime = z.infer<typeof WaifuBedTimeSchema>;

// Only her bed time is the owner's (spec §21 S3, §21.6c): her busy times come from her own
// `~/life/schedule.json`. The owner-set busy blocks were archived and dropped by the
// `living-cast-drop-busy-v1` migration; a stray `busy` key is stripped. `bedTime` was `sleep`
// before `living-cast-bed-time-v1` renamed it.
export const WaifuAvailabilitySchema = z
  .object({
    bedTime: WaifuBedTimeSchema
  })
  .default({
    bedTime: {
      enabled: false,
      start: "23:00",
      end: "07:00"
    }
  });
export type WaifuAvailability = z.infer<typeof WaifuAvailabilitySchema>;

export const ProviderCredentialsSchema = z.object({
  providerId: ProviderIdSchema,
  apiKey: z.string().min(1),
  label: z.string().optional(),
  createdAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema
});
export type ProviderCredentials = z.infer<typeof ProviderCredentialsSchema>;

export const ProviderCredentialsFileSchema = RevisionedRecordSchema.extend({
  providers: z.record(z.string(), ProviderCredentialsSchema)
});
export type ProviderCredentialsFile = z.infer<typeof ProviderCredentialsFileSchema>;

export const DiscordBotConfigSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  applicationId: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
  // A missing flag means enabled: the runtime historically logged in every bot with a token.
  enabled: z.boolean().default(true)
});
export type DiscordBotConfig = z.infer<typeof DiscordBotConfigSchema>;

export const DiscordBotsFileSchema = RevisionedRecordSchema.extend({
  orchestrator: DiscordBotConfigSchema.nullable(),
  waifus: z.array(DiscordBotConfigSchema)
});
export type DiscordBotsFile = z.infer<typeof DiscordBotsFileSchema>;

/**
 * `user/assistant/config.json`: the dashboard assistant's own model (Living cast spec §9.3). When
 * unset, the assistant uses the first configured waifu's model.
 */
export const AssistantConfigSchema = RevisionedRecordSchema.extend({
  model: OptionalModelChoiceSchema
});
export type AssistantConfig = z.infer<typeof AssistantConfigSchema>;

/** Per-waifu life settings (Living cast §4.4, §11.3). */
export const WaifuLifeSettingsSchema = z.object({
  dailyBudgetUsd: z.number().positive().max(10_000).nullable().default(null)
});
export type WaifuLifeSettings = z.infer<typeof WaifuLifeSettingsSchema>;


/** Her bot's Discord username (Living cast §17): trimmed, 2–32 characters, Discord's word rules. */
export const DiscordUsernameSchema = z
  .string()
  .trim()
  .min(DISCORD_USERNAME_MIN, `A Discord username is ${DISCORD_USERNAME_MIN} to ${DISCORD_USERNAME_MAX} characters.`)
  .max(DISCORD_USERNAME_MAX, `A Discord username is ${DISCORD_USERNAME_MIN} to ${DISCORD_USERNAME_MAX} characters.`)
  .superRefine((value, ctx) => {
    const problem = discordUsernameProblem(value);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

/** Per-server nickname overrides of her bot: guild id → nickname (1–32 characters). */
export const WaifuNicknamesSchema = z
  .record(
    z.string(),
    z
      .string()
      .trim()
      .min(1, `A server nickname is 1 to ${DISCORD_NICKNAME_MAX} characters.`)
      .max(DISCORD_NICKNAME_MAX, `A server nickname is 1 to ${DISCORD_NICKNAME_MAX} characters.`)
  )
  .superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!/^\d{17,20}$/u.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Nickname keys are Discord server (guild) ids; "${key.slice(0, 40)}" is not one.` });
      }
    }
  });

export const WaifuConfigSchema = RevisionedRecordSchema.extend({
  id: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  persona: z.string().default(""),
  // Living cast §9.2: nested model choice (living-cast-models-v1 converted the flat gateway
  // providerId/modelId/params). Explicit `null` on write unsets it.
  model: OptionalModelChoiceSchema,
  botId: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => value ?? undefined),
  // Living cast §17: her Discord profile, synced to her own bot. `username` is only her Discord
  // account name (unset: left alone on Discord); her `name` stays the identity in prompts, wake on
  // name and the detector. `bio` becomes the application description (About Me). `nicknames`
  // overrides her nickname per server. Explicit `null` on write unsets each.
  username: z
    .union([DiscordUsernameSchema, z.null()])
    .optional()
    .transform((value) => value ?? undefined),
  bio: z
    .union([z.string().max(DISCORD_BIO_MAX, `Her bio is at most ${DISCORD_BIO_MAX} characters (Discord's limit).`), z.null()])
    .optional()
    .transform((value) => value ?? undefined),
  nicknames: z
    .union([WaifuNicknamesSchema, z.null()])
    .optional()
    .transform((value) => value ?? undefined),
  availability: WaifuAvailabilitySchema,
  // Prompt settings the life harness reads (Living cast §8).
  customInstructions: z.string().max(4000).default(""),
  scheduleInPrompt: z.boolean().default(true),
  // Her name, display name and server nicknames wake her as whole words (Living cast §4.1 `name`);
  // off for names that are common words.
  wakeOnName: z.boolean().default(true),
  // Living cast §4.4: her daily budget (local day, USD); null = none.
  life: WaifuLifeSettingsSchema.default(() => ({ dailyBudgetUsd: null })),
  // Phase 5 DM settings (spec 9.1); Living cast adds `sleepNotice` (§4.5).
  dm: WaifuDmSettingsSchema.default(() => defaultWaifuDmSettings())
});
export type WaifuConfig = z.infer<typeof WaifuConfigSchema>;

export const ServerConfigSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  name: z.string().optional(),
  // The addressee detector's per-server override of `[detector] target` (Living cast §4.3); absent
  // inherits, "" turns the detector off for this server.
  detector: ServerDetectorOverrideSchema.optional(),
  // Temporary per-guild mute: messages are observed but they wake nobody until unpaused (Living
  // cast §4.4). This is the server's kill switch (spec 9.7): the old server/channel `enabled` flags
  // are gone, a channel is live when it has an enabled waifu.
  paused: z.boolean().default(false),
  channels: z.record(
    z.string(),
    z.object({
      channelId: z.string().min(1),
      name: z.string().optional(),
      enabledWaifuIds: z.array(z.string()).default([]),
      // Spec 9.5 / O2: do this channel's threads and forum posts inherit its cast ("inherit") or
      // stay silent ("off")? Absent means "inherit" (kept optional, not defaulted, so older writers
      // and partial PUTs never manufacture or reset it). A thread with an explicit entry of its own
      // is not affected.
      threads: ChannelThreadsModeSchema.optional(),
      // Runtime-only (ensureServer's thread overlay, stores/threads.ts): marks a virtual entry for
      // a thread that inherits `parentId`'s cast. Never persisted; the API never returns it.
      thread: z
        .object({
          parentId: z.string().min(1),
          lastActivityAt: IsoDateStringSchema.optional(),
          /** The thread has an entry (and cast) of its own; the overlay only adds its state. */
          explicit: z.boolean().optional(),
          /** Archived or locked: the entry keeps its cast but takes no part until unarchived. */
          silenced: z.boolean().optional()
        })
        .optional()
    })
  ).default({})
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const GuildMemberCacheEntrySchema = z.object({
  userId: z.string().min(1),
  username: z.string().min(1).optional(),
  globalDisplayName: z.string().optional(),
  guildDisplayName: z.string().optional(),
  bot: z.boolean().default(false),
  lastSeenAt: IsoDateStringSchema.optional(),
  perChannelLastSeenAt: z.record(z.string(), IsoDateStringSchema).default({})
});
export type GuildMemberCacheEntry = z.infer<typeof GuildMemberCacheEntrySchema>;

export const GuildMembersFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  members: z.array(GuildMemberCacheEntrySchema)
});
export type GuildMembersFile = z.infer<typeof GuildMembersFileSchema>;

export const ActiveChatParticipantSchema = z.object({
  userId: z.string().min(1),
  displayName: z.string().min(1),
  lastSeenAt: IsoDateStringSchema,
  expiresAt: IsoDateStringSchema
});
export type ActiveChatParticipant = z.infer<typeof ActiveChatParticipantSchema>;

export const ActiveChatParticipantsFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  participants: z.array(ActiveChatParticipantSchema)
});
export type ActiveChatParticipantsFile = z.infer<typeof ActiveChatParticipantsFileSchema>;

export const GuildEmojiCacheEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  animated: z.boolean().default(false),
  available: z.boolean().default(true),
  roles: z.array(z.string()).default([]),
  fetchedAt: IsoDateStringSchema
});
export type GuildEmojiCacheEntry = z.infer<typeof GuildEmojiCacheEntrySchema>;

export const GuildEmojisFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  emojis: z.array(GuildEmojiCacheEntrySchema)
});
export type GuildEmojisFile = z.infer<typeof GuildEmojisFileSchema>;

export const GuildRoleCacheEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: z.number().int().nonnegative().default(0),
  hoist: z.boolean().default(false),
  mentionable: z.boolean().default(false),
  managed: z.boolean().default(false),
  fetchedAt: IsoDateStringSchema
});
export type GuildRoleCacheEntry = z.infer<typeof GuildRoleCacheEntrySchema>;

export const GuildRolesFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  roles: z.array(GuildRoleCacheEntrySchema)
});
export type GuildRolesFile = z.infer<typeof GuildRolesFileSchema>;

export function createEmptyRevisionedFile<T extends Record<string, unknown>>(extra: T) {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now,
    ...extra
  };
}
