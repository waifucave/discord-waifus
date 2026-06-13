import { Registry } from "@waifucave/gateway";
import { GatewayPipelineError } from "./params.js";

/** §7.3: stored ids whose models left the catalog — conservative substitutes. */
export const LEGACY_MODEL_MAP: Record<string, { providerId: string; modelId: string }> = {
  "gpt-4o": { providerId: "openai", modelId: "gpt-5-mini" },
  "gpt-4o-mini": { providerId: "openai", modelId: "gpt-5-nano" },
  "glm-5-turbo": { providerId: "zai", modelId: "glm-5" },
  "gemini-3.5-flash": { providerId: "google-ai-studio", modelId: "gemini-3-flash-preview" },
};

let _registry: Registry | undefined;
export function sharedRegistry(): Registry {
  _registry ??= Registry.load();
  return _registry;
}

export type ModelTarget = { providerId: string; modelId: string; remapped: boolean };

/**
 * Stored config → gateway route. Explicit (providerId, modelId) wins when the
 * pair resolves; bare modelId derives its provider from the registry with
 * native routes preferred over openrouter; retired ids remap per §7.3 (callers
 * should log when `remapped` — P4 migrates storage and removes this shim).
 */
export function resolveModelTarget(config: { providerId?: string; modelId: string }): ModelTarget {
  const mapped = LEGACY_MODEL_MAP[config.modelId];
  if (mapped) return { ...mapped, remapped: true };

  const reg = sharedRegistry();

  if (config.providerId && reg.resolve(config.providerId, config.modelId)) {
    return { providerId: config.providerId, modelId: config.modelId, remapped: false };
  }

  const candidates = reg.listModels().filter((ref) => ref.modelId === config.modelId);
  const preferred = candidates.find((ref) => ref.providerId !== "openrouter") ?? candidates[0];
  if (!preferred) throw new GatewayPipelineError(`Unknown model ${config.modelId}`);
  return { providerId: preferred.providerId, modelId: preferred.modelId, remapped: false };
}
