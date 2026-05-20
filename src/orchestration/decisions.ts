import { z } from "zod";

export const REPLY_STYLE_VALUES = ["normal", "short", "long", "sleepy"] as const;
export type ReplyStyle = (typeof REPLY_STYLE_VALUES)[number];
export const ReplyStyleSchema = z.enum(REPLY_STYLE_VALUES);

export const ORCHESTRATOR_ACTION_VALUES = ["reply", "no_reply"] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTION_VALUES)[number];
export const OrchestratorActionSchema = z.enum(ORCHESTRATOR_ACTION_VALUES);

export const RETRIGGER_MIN_SECONDS = 100;
export const RETRIGGER_MAX_SECONDS = 7200;

export const RespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0),
  replyStyle: ReplyStyleSchema,
  replyToMessageId: z.string().min(1).optional(),
  sceneDirection: z.string().min(1).optional()
});
export type RespondingWaifu = z.infer<typeof RespondingWaifuSchema>;

export const OrchestratorDecisionSchema = z
  .object({
    action: OrchestratorActionSchema,
    respondingWaifus: z.array(RespondingWaifuSchema).default([]),
    retriggerAfterSeconds: z
      .number()
      .min(RETRIGGER_MIN_SECONDS)
      .max(RETRIGGER_MAX_SECONDS)
      .optional(),
    reasoning: z.string().min(1)
  })
  .superRefine((value, ctx) => {
    if (value.action === "reply") {
      if (value.respondingWaifus.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["respondingWaifus"],
          message: "respondingWaifus must be non-empty when action is reply."
        });
      }
      if (value.retriggerAfterSeconds !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retriggerAfterSeconds"],
          message: "retriggerAfterSeconds must be omitted when action is reply."
        });
      }
    } else {
      if (value.respondingWaifus.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["respondingWaifus"],
          message: "respondingWaifus must be empty when action is no_reply."
        });
      }
      if (value.retriggerAfterSeconds === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["retriggerAfterSeconds"],
          message: "retriggerAfterSeconds is required when action is no_reply."
        });
      }
    }
  });

export type OrchestratorDecision = z.infer<typeof OrchestratorDecisionSchema>;
