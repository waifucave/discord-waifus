// Refs for messages she is shown (Living cast spec §22.1, §23): `refs.json` first, then the ref
// stored on a message's transcript line (one `refs.json` pruned), and only then a new one (never for
// a message whose line has one, and never for one past the age limit). Used by ReadMessages pages
// and searches and by the morning summary.

import { assignConversationRefs, readConversationRefs } from "../discord/refStore.js";
import type { StorageService } from "../storage/storageService.js";
import { transcriptRefsOf } from "./transcripts/store.js";

export async function refsForMessages(
  env: { storage: StorageService; timeZone: string },
  key: string,
  messages: ReadonlyArray<{ id: string; at: string }>,
  now: Date
): Promise<Map<string, string>> {
  const current = await readConversationRefs(env.storage, key as never);
  const missing = messages.filter((message) => current.refs[message.id] === undefined);
  const stored = await transcriptRefsOf({ dataRoot: env.storage.dataRoot, timeZone: env.timeZone }, key, missing).catch(() => new Map<string, string>());
  const assign = missing.filter((message) => !stored.has(message.id)).map((message) => message.id);
  const assigned = assign.length > 0 ? await assignConversationRefs(env.storage, key as never, assign, now) : new Map(Object.entries(current.refs));
  return new Map([...assigned, ...stored]);
}
