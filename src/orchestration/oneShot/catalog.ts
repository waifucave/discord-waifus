import { z } from "zod";
import { OneShotTargetSchema } from "../../shared/schemas/oneShot.js";
export { OneShotTargetSchema } from "../../shared/schemas/oneShot.js";
import { readDecisionJson } from "./protocol.js";
export type OneShotModel = { target: string; label: string; provider: "openai" | "openrouter" | "laya"; local: boolean; contextLength?: number };
export const BUILTIN_DECISION_MODELS: OneShotModel[] = [
  { target: "openai:gpt-6-luna", label: "OpenAI GPT-6 Luna Decisions (direct)", provider: "openai", local: false },
  ...["english", "multilingual", "typed-decisions"].map((model): OneShotModel => ({ target: `laya:${model}`, label: `Laya ${model} (local, experimental)`, provider: "laya", local: true }))
];
const CatalogSchema = z.object({ data: z.array(z.object({ id: z.string().max(160), name: z.string().max(240).optional(),
  context_length: z.number().int().nonnegative().nullish(), architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }) })) });

// A separate modality catalog from the upstream Decisions API. Never insert these
// entries into the gateway's chat catalog or offer them as waifu generation models.
export class OneShotCatalog {
  private models: OneShotModel[] = [];
  private expires = 0;
  private unavailable = false;
  private pending?: Promise<{ models: OneShotModel[]; unavailable: boolean }>;
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async list(): Promise<{ models: OneShotModel[]; unavailable: boolean }> {
    if (Date.now() < this.expires) return { models: [...BUILTIN_DECISION_MODELS, ...this.models], unavailable: this.unavailable };
    if (this.pending) return this.pending;
    this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async load() {
    try {
      const response = await this.fetchImpl("https://openrouter.ai/api/v1/models?output_modalities=decisions", { redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("catalog_unavailable"); }
      const parsed = CatalogSchema.parse(await readDecisionJson(response, 2_000_000));
      this.models = parsed.data.filter((m) => m.architecture.input_modalities.includes("text") && m.architecture.output_modalities.includes("decisions") && OneShotTargetSchema.safeParse(`openrouter:${m.id}`).success)
        .map((m): OneShotModel => ({ target: `openrouter:${m.id}`, label: m.name ?? m.id, provider: "openrouter", local: false, contextLength: m.context_length ?? undefined }));
      this.expires = Date.now() + 15 * 60_000;
      this.unavailable = false;
      return { models: [...BUILTIN_DECISION_MODELS, ...this.models], unavailable: false };
    } catch {
      this.expires = Date.now() + 60_000; this.unavailable = true;
      return { models: [...BUILTIN_DECISION_MODELS, ...this.models], unavailable: true };
    }
  }
}
export const oneShotCatalog = new OneShotCatalog();
