import { z } from "zod";
import { CURRENT_SCHEMA_VERSION } from "./common.js";

export const HttpConfigSchema = z
  .object({
    host: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535).default(3888)
  })
  .default({ host: "127.0.0.1", port: 3888 });

export const RuntimeConfigSchema = z
  .object({
    autoConnectDiscord: z.boolean().default(false),
    paused: z.boolean().default(false)
  })
  .default({ autoConnectDiscord: false, paused: false });

export const FrontendConfigSchema = z
  .object({
    staticDir: z.string().optional()
  })
  .default({});

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  http: HttpConfigSchema,
  runtime: RuntimeConfigSchema,
  frontend: FrontendConfigSchema
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
