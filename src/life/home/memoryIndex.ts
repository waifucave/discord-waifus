// Her `MEMORY.md` (Living cast spec §7.1, §16.2): the index of her notes, at the top of her home.
// A copy goes into system block B at each epoch start, cut at 200 lines / 8 KB with a note asking her
// to tidy it. A note the memories→notes migration wrote for one person carries `<!-- user:<id> -->`
// under its heading, so a forget deletes it whole (§7.5 step 5).

import type { HomeStore } from "./homeStore.js";
import { MEMORY_FILE } from "./pathRules.js";

export const MEMORY_INDEX = MEMORY_FILE;
/** The system prompt's copy of MEMORY.md is cut at 200 lines / 8 KB (§16.2). */
export const MEMORY_PROMPT_MAX_LINES = 200;
export const MEMORY_PROMPT_MAX_BYTES = 8 * 1024;
export const MEMORY_PROMPT_CUT_NOTE = "(…your index is longer than this; tidy MEMORY.md so it stays short, with links to the details.)";

/** The marker a person's own note carries (written by the memories→notes migration under the heading). */
export function personMarker(userId: string): string {
  return `<!-- user:${userId} -->`;
}

/** The user ids a note's person markers name. */
export function markedUserIds(text: string): string[] {
  return [...text.matchAll(/<!--\s*user:(\d{5,25})\s*-->/gu)].map((match) => match[1]!);
}

function bytesOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function cutMemoryIndex(text: string): string {
  const trimmed = text.replace(/\s+$/u, "");
  const lines = trimmed.split("\n");
  let cut = false;
  let kept = lines;
  if (kept.length > MEMORY_PROMPT_MAX_LINES) {
    kept = kept.slice(0, MEMORY_PROMPT_MAX_LINES);
    cut = true;
  }
  let joined = kept.join("\n");
  while (bytesOf(joined) > MEMORY_PROMPT_MAX_BYTES && kept.length > 0) {
    kept = kept.slice(0, -1);
    joined = kept.join("\n");
    cut = true;
  }
  return cut ? `${joined}\n${MEMORY_PROMPT_CUT_NOTE}` : joined;
}

/** The system prompt's copy of her MEMORY.md (empty when she has none, or it is not text). */
export async function memoryIndexForPrompt(store: HomeStore): Promise<string> {
  const text = await store.files.readText(store.home(MEMORY_FILE)).catch(() => undefined);
  return cutMemoryIndex(text ?? "");
}
