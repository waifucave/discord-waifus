// The host's runtime state (`app/runtime.json`, `GET /api/status`, `GET /api/runtime`) without its
// Remote Access summary, which stays with the remote schemas (`src/backend/runtime.ts` adds it).
// Zod only, so the dashboard can derive its types from it (overhaul spec §10.6, I17).

import { z } from "zod";
import { CURRENT_SCHEMA_VERSION, IsoDateStringSchema } from "./common.js";

// Mirrors `DiscordBotConnectionStatus` in src/discord/client.ts (assignment there is type-checked).
export const DiscordBotConnectionStatusSchema = z.object({
  botId: z.string(),
  displayName: z.string(),
  kind: z.enum(["house", "waifu"]),
  state: z.enum(["connected", "connecting", "error", "disabled", "missing_token"]),
  errorCode: z
    .enum([
      "invalid_token",
      "disallowed_intents",
      "invalid_intents",
      "gateway_rejected",
      "network",
      "house_unavailable",
      "unknown"
    ])
    .optional(),
  error: z.string().optional(),
  closeCode: z.number().int().optional(),
  nextRetryAt: IsoDateStringSchema.optional(),
  updatedAt: IsoDateStringSchema
});

export const DiscordRuntimeStatusSchema = z.object({
  connected: z.boolean(),
  houseConnected: z.boolean(),
  waifuBotCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  connecting: z.boolean().optional(),
  retrying: z.boolean().optional(),
  retryAttempt: z.number().int().positive().optional(),
  nextRetryAt: IsoDateStringSchema.optional(),
  lastError: z.string().optional(),
  lastErrorAt: IsoDateStringSchema.optional(),
  bots: z.array(DiscordBotConnectionStatusSchema).optional()
});

export const QueueRuntimeSchema = z.object({
  active: z.number().int().nonnegative(),
  configuredGuilds: z.number().int().nonnegative()
});

export const RuntimeStateBaseSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  startedAt: IsoDateStringSchema,
  updatedAt: IsoDateStringSchema,
  packageVersion: z.string(),
  port: z.number().int().min(1).max(65_535),
  dataRoot: z.string(),
  mode: z.string(),
  paused: z.boolean().default(false),
  discord: DiscordRuntimeStatusSchema.default({
    connected: false,
    houseConnected: false,
    waifuBotCount: 0,
    warnings: []
  }),
  queues: QueueRuntimeSchema.default({
    active: 0,
    configuredGuilds: 0
  })
});
