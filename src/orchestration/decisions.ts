import { z } from "zod";

export const ORCHESTRATOR_ACTION_VALUES = ["reply", "no_reply"] as const;
export type OrchestratorAction = (typeof ORCHESTRATOR_ACTION_VALUES)[number];
export const OrchestratorActionSchema = z.enum(ORCHESTRATOR_ACTION_VALUES);

export const RETRIGGER_MIN_SECONDS = 100;
export const RETRIGGER_MAX_SECONDS = 28800;
export const MAX_WAIFU_DELAY_SECONDS = 30;
export const DIRECTIVE_GOAL_MAX_CHARS = 100;
export const WAKE_PLAN_MAX_CHARS = 200;

// "manual" carries /run scene directions; it is never offered to the model and is
// exempt from the runtime directive budget and goal cap.
export const DIRECTIVE_INTENTS = [
  "break_loop",
  "change_topic",
  "include_person",
  "close_beat",
  "interrupt",
  "spotlight",
  "manual"
] as const;
export type DirectiveIntent = (typeof DIRECTIVE_INTENTS)[number];
export const MODEL_DIRECTIVE_INTENTS = DIRECTIVE_INTENTS.filter(
  (intent): intent is Exclude<DirectiveIntent, "manual"> => intent !== "manual"
);

export const DirectiveSchema = z.object({
  intent: z.enum(DIRECTIVE_INTENTS),
  // The goal cap (DIRECTIVE_GOAL_MAX_CHARS) is enforced by the runtime guardrail so an
  // over-cap goal parses and is stripped gracefully instead of failing the whole decision.
  goal: z.string().trim().min(1)
});
export type Directive = z.infer<typeof DirectiveSchema>;

// A malformed directive degrades to undefined — never a failed decision.
const LenientDirectiveSchema = DirectiveSchema.nullish()
  .catch(null)
  .transform((value) => value ?? undefined);

export const RespondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  directive: LenientDirectiveSchema.optional(),
  replyToMessageId: z.string().min(1).optional()
});
export type RespondingWaifu = z.infer<typeof RespondingWaifuSchema>;

const WakePlanSchema = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed.slice(0, WAKE_PLAN_MAX_CHARS) : undefined;
  });

export const OrchestratorDecisionSchema = z
  .object({
    action: OrchestratorActionSchema,
    respondingWaifus: z.array(RespondingWaifuSchema).default([]),
    retriggerAfterSeconds: z
      .number()
      .min(RETRIGGER_MIN_SECONDS)
      .max(RETRIGGER_MAX_SECONDS)
      .optional(),
    wakePlan: WakePlanSchema.optional(),
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
