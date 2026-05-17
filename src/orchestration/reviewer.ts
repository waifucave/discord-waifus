import { z } from "zod";

export const ReviewerDecisionSchema = z.object({
  hallucination: z.boolean()
});

export type ReviewerDecision = z.infer<typeof ReviewerDecisionSchema>;
