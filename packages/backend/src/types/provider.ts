import { z } from "zod";

export const providerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["openai-compatible", "anthropic"]),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  enabled: z.boolean().default(true),
  models: z.array(z.string()).default([])
});

export const providersFileSchema = z.object({
  providers: z.array(providerSchema).default([])
});

export type ProviderConfig = z.infer<typeof providerSchema>;
export type ProvidersFile = z.infer<typeof providersFileSchema>;
