import { z } from "zod";
import { IsoDateStringSchema, RevisionedRecordSchema } from "./common.js";

// Threads and forum posts (spec 9.5). Each is its own conversation (`g_<guild>_<threadId>`) but is
// never auto-created as a channel entry: `user/servers/<guildId>/threads.json` records what the
// bot has seen, and the runtime overlays virtual channel entries that inherit the parent's cast.

export const THREAD_KINDS = ["public_thread", "private_thread", "announcement_thread", "forum_post"] as const;
export const ThreadKindSchema = z.enum(THREAD_KINDS);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

/** Per parent channel: do its threads inherit the cast ("inherit") or stay silent ("off")? */
export const ChannelThreadsModeSchema = z.enum(["inherit", "off"]);
export type ChannelThreadsMode = z.infer<typeof ChannelThreadsModeSchema>;

export const ThreadRecordSchema = z.object({
  threadId: z.string().min(1),
  parentId: z.string().min(1),
  name: z.string(),
  kind: ThreadKindSchema.default("public_thread"),
  archived: z.boolean().default(false),
  locked: z.boolean().default(false),
  lastActivityAt: IsoDateStringSchema
});
export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;

export const ThreadsFileSchema = RevisionedRecordSchema.extend({
  guildId: z.string().min(1),
  threads: z.record(z.string(), ThreadRecordSchema).default({})
});
export type ThreadsFile = z.infer<typeof ThreadsFileSchema>;

/** Threads idle longer than this are pruned from threads.json. */
export const THREAD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Restart resume only revisits threads active within this window. */
export const THREAD_RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
