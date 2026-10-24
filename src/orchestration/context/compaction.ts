// Compaction helpers kept from the Phase 4 compaction service (Living cast spec §15 keep table):
// token calibration, the summary output cap, the thinking check, the overflow check and the failure
// backoff. The conversation compaction service itself is gone; the life planner (L2) builds on these
// and on `summarizeWithModel` (src/models/summarize.ts).

import type { CuratedModel } from "../../models/catalog.js";

export { isContextOverflowError } from "../../models/errors.js";

/** After a failed compaction, triggers stay quiet this long. */
export const COMPACTION_FAILURE_BACKOFF_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------------
// Calibration (spec 8.9): EMA α = 0.3 of usage.inputTokens / estimate, clamped [0.5, 2.5].

export const CALIBRATION_ALPHA = 0.3;
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 2.5;
export const CALIBRATION_IMAGE_TOKENS = 1_000;

export type TokenCalibration = { ratio: number; samples: number; updatedAt: string };

const clampRatio = (r: number) => Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, r));

/**
 * One EMA step of the per-model token calibration. The ratio scales the TEXT estimate only (images
 * are estimated at a flat 1,000 tokens each), so it is fitted on text only: the image estimate is
 * subtracted from both the observed prompt size and the raw estimate. The first sample seeds the
 * ratio with the (clamped) observation; later samples move it by α. Undefined when the numbers are
 * unusable. `promptTokens` is the whole prompt: winter's input + cache reads + cache writes.
 */
export function emaTokenCalibration(i: {
  previous?: Pick<TokenCalibration, "ratio" | "samples">;
  promptTokens: number;
  rawEstimate: number;
  imageCount?: number;
  now: Date;
}): TokenCalibration | undefined {
  const images = (i.imageCount ?? 0) * CALIBRATION_IMAGE_TOKENS;
  const input = i.promptTokens - images;
  const text = i.rawEstimate - images;
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(text) || text <= 0) return undefined;
  const observed = clampRatio(input / text);
  const ratio = i.previous ? clampRatio(i.previous.ratio + CALIBRATION_ALPHA * (observed - i.previous.ratio)) : observed;
  return { ratio, samples: (i.previous?.samples ?? 0) + 1, updatedAt: i.now.toISOString() };
}

// ---------------------------------------------------------------------------------------------
// Summary output cap

type CapModel = Pick<CuratedModel, "efforts"> & { maxOutputTokens?: number };

/**
 * Whether the summarize call may spend output on thinking: a model with reasoning control, unless
 * the call's effort turns it off (`none`). Without model info only the effort decides.
 */
export function thinkingMayRun(effort: string | undefined, model?: CapModel): boolean {
  if (effort === "none") return false;
  if (model) return model.efforts.length > 0;
  return effort !== undefined;
}

const DEFAULT_OUTPUT_CAP = 8_192;

/**
 * Summary output cap (max_tokens is not part of the cache key, so it may differ from the reply call):
 * - no thinking: max(1500, reply cap);
 * - thinking may run: max(reply cap or min(model limit, 8192), 4000) — a 1500 cap would be eaten by thinking;
 * always clamped to the model's output limit.
 */
export function compactionMaxOutputTokens(o: { effort?: string; model?: CapModel; replyMaxOutputTokens?: number } = {}): number {
  const reply = typeof o.replyMaxOutputTokens === "number" && o.replyMaxOutputTokens > 0 ? o.replyMaxOutputTokens : undefined;
  const limit = o.model?.maxOutputTokens;
  let cap: number;
  if (thinkingMayRun(o.effort, o.model)) {
    const modelDefault = limit ? Math.min(limit, DEFAULT_OUTPUT_CAP) : DEFAULT_OUTPUT_CAP;
    cap = Math.max(reply ?? modelDefault, 4000);
  } else {
    cap = Math.max(1500, reply ?? 0);
  }
  return limit ? Math.min(cap, limit) : cap;
}
