import { z } from "zod";

export const SelectedWaifuSchema = z.object({
  waifuId: z.string().min(1),
  sceneDirection: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional()
});

export const OrchestratorDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("waifus"),
    selectedWaifus: z.array(SelectedWaifuSchema).min(1),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("stage_manager"),
    retriggerAfterSeconds: z.number().int().min(100).max(28_800),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("reviewer"),
    reasoning: z.string().min(1)
  }),
  z.object({
    action: z.literal("no_reply"),
    retriggerAfterSeconds: z.number().int().min(100).max(28_800),
    reasoning: z.string().min(1)
  })
]);

export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;
