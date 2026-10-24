import { z } from "zod";
import { RevisionedRecordSchema } from "./common.js";

// Per-conversation message refs (spec 6.3/8.1, Living cast §3, §6.2): one table per conversation,
// shared by every waifu, so `#k3` names the same message for everyone. Stored at
// user/conversations/<key>/refs.json (src/orchestration/context/keys.ts); src/discord/refStore.ts
// holds the ref arithmetic. The Phase 4 ledger and per-agent context states retired with the
// context engine (Living cast L1); their files are archived by L2's `living-cast-archive-director-v1`.

/** First message ref is "a0" (base 36): the counter starts at 360. */
export const REF_COUNTER_START = 360;

export const ConversationRefsSchema = RevisionedRecordSchema.extend({
  conversationKey: z.string().min(1),
  counter: z.number().int().nonnegative().default(REF_COUNTER_START),
  refs: z.record(z.string(), z.string()).default({}) // messageId -> ref
});
export type ConversationRefs = z.infer<typeof ConversationRefsSchema>;
