import { z } from "zod";

export const OneShotTargetSchema = z.string().max(200).regex(/^(openai:gpt-6-luna|openrouter:[A-Za-z0-9~._\/-]+(?::free)?|laya:(english|multilingual|typed-decisions))$/)
  .refine((v) => !v.startsWith("openrouter:respan/span-"), "Yes/no-only models are not supported.");
export const OneShotConfigSchema = z.object({ target: OneShotTargetSchema }).default({ target: "openrouter:cloudflare/clef" });
