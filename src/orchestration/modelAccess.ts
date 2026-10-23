// Resolves model targets into gateway pipelines and enriches context with OCR text for models
// without image input.

import { ModelPipeline } from "../providers/types.js";
import { resolveModelTarget, sharedRegistry } from "./pipeline/resolveTarget.js";
import { QueryRole } from "../shared/queryLog.js";
import type { ContextMessage } from "./contextMessages.js";
import type { RuntimeOrchestratorOptions } from "./runtimeShared.js";

type CreatePipeline = (target: { providerId: string; modelId: string; queryRole: QueryRole }) => ModelPipeline;

export class ModelAccess {
  constructor(
    private readonly options: Pick<RuntimeOrchestratorOptions, "logger" | "ocr">,
    private readonly createPipeline: CreatePipeline
  ) {}

  pipelineFor(
    config: { providerId?: string; modelId: string },
    queryRole: QueryRole
  ): ModelPipeline {
    const target = resolveModelTarget(config);
    if (target.remapped) {
      this.options.logger.warn("Legacy model id remapped", {
        from: config.modelId,
        to: target.modelId
      });
    }
    return this.createPipeline({
      providerId: target.providerId,
      modelId: target.modelId,
      queryRole
    });
  }

  async messagesForModel(
    messages: ContextMessage[],
    config: { providerId?: string; modelId: string },
    signal?: AbortSignal
  ): Promise<ContextMessage[]> {
    const target = resolveModelTarget(config);
    const supportsImageInput =
      sharedRegistry().resolve(target.providerId, target.modelId)?.modalities.input.includes("image") ?? false;
    if (supportsImageInput || !this.options.ocr) {
      return messages;
    }
    try {
      return await this.options.ocr.enrichMessages(messages, { signal });
    } catch (error) {
      this.options.logger.warn("OCR enrichment failed; continuing without OCR text", {
        modelId: config.modelId,
        message: error instanceof Error ? error.message : String(error)
      });
      return messages;
    }
  }
}
