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
    autoConnectDiscord: z.boolean().default(true),
    paused: z.boolean().default(false)
  })
  .default({ autoConnectDiscord: true, paused: false });

export const FrontendConfigSchema = z
  .object({
    staticDir: z.string().optional()
  })
  .default({});

export const OcrConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    engine: z
      .preprocess(
        (value) => value === "tesseract" ? "system-tesseract" : value,
        z.enum(["auto", "apple-vision", "bundled-tesseract", "system-tesseract"])
      )
      .default("auto"),
    cacheTtlHours: z.number().int().min(1).max(24 * 30).default(24),
    timeoutMs: z.number().int().min(250).max(30_000).default(1_500),
    maxImageBytes: z.number().int().min(1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
    maxImagesPerModelCall: z.number().int().min(0).max(20).default(4),
    maxTextCharsPerImage: z.number().int().min(100).max(10_000).default(1_500)
  })
  .default({
    enabled: true,
    engine: "auto",
    cacheTtlHours: 24,
    timeoutMs: 1_500,
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerModelCall: 4,
    maxTextCharsPerImage: 1_500
  });

export const AppConfigSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION).default(CURRENT_SCHEMA_VERSION),
  http: HttpConfigSchema,
  runtime: RuntimeConfigSchema,
  frontend: FrontendConfigSchema,
  ocr: OcrConfigSchema
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type OcrConfig = z.infer<typeof OcrConfigSchema>;

export const DEFAULT_APP_CONFIG: AppConfig = AppConfigSchema.parse({});
