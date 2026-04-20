import { z } from "zod";

export const orchestratorConfigSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().int().positive().default(500)
});

export const orchestratorFileSchema = z.object({
  orchestrator: orchestratorConfigSchema
});

export const orchestratorActionSchema = z.enum(["reply", "no_reply"]);

export const respondingWaifuSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  shouldReact: z.boolean().default(false),
  reactionEmoji: z.string().nullable().default(null),
  replyStyle: z.enum(["normal", "short", "long", "sleepy"]).default("normal"),
  replyToMessageId: z.string().nullable().optional(),
  sceneDirection: z.string().nullable().default(null)
});

export const directInteractionSchema = z.object({
  waifuId: z.string().min(1),
  delaySeconds: z.number().min(0).default(0),
  emoji: z.string().min(1)
});

export const orchestratorDecisionSchema = z.object({
  action: orchestratorActionSchema,
  respondingWaifus: z.array(respondingWaifuSchema).default([]),
  directInteraction: directInteractionSchema.nullable().default(null),
  reasoning: z.string().default(""),
  retriggerAfterSeconds: z.number().min(100).max(7200).nullable().default(null)
});

export const orchestratorDecisionToolInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: ["reply", "no_reply"]
    },
    respondingWaifus: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          waifuId: { type: "string" },
          delaySeconds: { type: "number", minimum: 0 },
          shouldReact: { type: "boolean" },
          reactionEmoji: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          replyStyle: {
            type: "string",
            enum: ["normal", "short", "long", "sleepy"]
          },
          replyToMessageId: {
            anyOf: [{ type: "string" }, { type: "null" }]
          },
          sceneDirection: {
            anyOf: [{ type: "string" }, { type: "null" }]
          }
        },
        required: [
          "waifuId",
          "delaySeconds",
          "shouldReact",
          "reactionEmoji",
          "replyStyle",
          "replyToMessageId",
          "sceneDirection"
        ]
      }
    },
    directInteraction: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            waifuId: { type: "string" },
            delaySeconds: { type: "number", minimum: 0 },
            emoji: { type: "string" }
          },
          required: ["waifuId", "delaySeconds", "emoji"]
        },
        { type: "null" }
      ]
    },
    reasoning: { type: "string" },
    retriggerAfterSeconds: {
      anyOf: [
        { type: "number", minimum: 100, maximum: 7200 },
        { type: "null" }
      ]
    }
  },
  required: [
    "action",
    "respondingWaifus",
    "directInteraction",
    "reasoning",
    "retriggerAfterSeconds"
  ]
} as const;

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
export type OrchestratorFile = z.infer<typeof orchestratorFileSchema>;
export type DirectInteractionDecision = z.infer<typeof directInteractionSchema>;
export type RespondingWaifuDecision = z.infer<typeof respondingWaifuSchema>;
export type OrchestratorDecision = z.infer<typeof orchestratorDecisionSchema>;
