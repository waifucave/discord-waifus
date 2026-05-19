import { z } from "zod";

export const IDLE_TRIGGER_VALUES = [180, 300, 900, 1800, 3600, 7200, 14400] as const;
export type IdleTriggerSeconds = (typeof IDLE_TRIGGER_VALUES)[number];

export const IdleTriggerSchema = z.union([
  z.literal(180),
  z.literal(300),
  z.literal(900),
  z.literal(1800),
  z.literal(3600),
  z.literal(7200),
  z.literal(14400)
]);

export const NO_REPLY_STEP_KIND = "no_reply" as const;

export const OrchestratorStepSchema = z.object({
  kind: z.string().min(1),
  sceneDirection: z.string().min(1).optional(),
  replyToMessageId: z.string().min(1).optional()
});
export type OrchestratorStep = z.infer<typeof OrchestratorStepSchema>;

export const OrchestratorDecisionSchema = z
  .object({
    steps: z.array(OrchestratorStepSchema).min(1),
    idleTrigger: IdleTriggerSchema.optional(),
    reasoning: z.string().min(1)
  })
  .superRefine((value, ctx) => {
    const hasNoReply = value.steps.some((step) => step.kind === NO_REPLY_STEP_KIND);
    if (hasNoReply && value.idleTrigger === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idleTrigger"],
        message: "idleTrigger is required when any step is no_reply."
      });
    }
    if (!hasNoReply && value.idleTrigger !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["idleTrigger"],
        message: "idleTrigger must be omitted when steps contain no no_reply."
      });
    }
    for (let index = 0; index < value.steps.length; index += 1) {
      const step = value.steps[index];
      if (step.kind === NO_REPLY_STEP_KIND) {
        if (step.sceneDirection !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "sceneDirection"],
            message: "sceneDirection is only valid on waifu steps."
          });
        }
        if (step.replyToMessageId !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["steps", index, "replyToMessageId"],
            message: "replyToMessageId is only valid on waifu steps."
          });
        }
      }
    }
  });

export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;
