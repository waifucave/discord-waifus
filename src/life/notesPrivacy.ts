// DM content in her notes (D14) for every view that is not a local reveal: `/print notes`, the
// index copy in `/print system_prompt`, and the files API (Remote Access, the dashboard assistant,
// any request without `includePrivate=1`). A note line that links to one of her files from a
// private chat (files-index provenance, or under `/tmp/dm/`) or names a DM place or path
// (`lifeView.ts` `notesLineNamesDm`) reads `[private chat redacted]`. A line she wrote about a DM
// without either cannot be attributed and is shown.

import { markdownLinks, type HomeStore } from "./home/homeStore.js";
import { isDmFolderPath, type HerPath } from "./home/pathRules.js";
import { redactNotesLines } from "./lifeView.js";

/** A notes file whose lines are checked: Markdown (`.md`, any case). */
export function isNotesFile(p: Pick<HerPath, "segments">): boolean {
  return /\.md$/iu.test(p.segments.at(-1) ?? "");
}

/**
 * Which lines of a notes text link to one of her files from a private chat. An unreadable files
 * index counts every link as private; with `missingIsPrivate` (an older copy, such as the system
 * prompt's snapshot of `MEMORY.md`) so does a link that no longer resolves to a file.
 */
export async function privateNoteLines(store: HomeStore, text: string, o: { missingIsPrivate?: boolean } = {}): Promise<(line: string) => boolean> {
  const filesIndex = await store.readIndex().catch(() => undefined);
  const privateTargets = new Set<string>();
  for (const target of new Set(markdownLinks(text))) {
    const resolved = await store.resolveExisting(target.startsWith("/") || target.startsWith("~") ? target : `~/${target}`).catch(() => undefined);
    if (!resolved?.ok) {
      if (o.missingIsPrivate) privateTargets.add(target);
      continue;
    }
    if (o.missingIsPrivate && (await store.files.inspect(resolved.path).catch(() => undefined))?.kind !== "file") {
      privateTargets.add(target);
      continue;
    }
    const origin = !filesIndex ? "unknown" : isDmFolderPath(resolved.path) ? "dm" : await store.dmOrigin(resolved.path, filesIndex).catch(() => "unknown");
    if (origin !== undefined) privateTargets.add(target);
  }
  return (line) => privateTargets.size > 0 && markdownLinks(line).some((target) => privateTargets.has(target));
}

/** A notes text without its private lines; undefined when nothing in it is private. */
export async function redactedNotesText(store: HomeStore, text: string): Promise<string | undefined> {
  const { text: redacted, redacted: count } = redactNotesLines(text, await privateNoteLines(store, text));
  return count > 0 ? redacted : undefined;
}
