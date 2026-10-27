// Forget in the transcripts (Living cast spec §18.5): the person's own lines, the lines that mention
// them (their id, or a name only they have, matched as a whole word; a shared, weak or
// no-word-boundary name removes nothing), and their whole DM transcripts. Removed ids are remembered
// in the conversation's meta.json and a DM keeps its forget floor, so neither a REST catch-up nor a
// stale page ever writes them again.

import { conversationKey, parseConversationKey } from "../../orchestration/context/keys.js";
import { foldName, hasNoWordBoundaries, isWeakName, namesSomeone } from "../text.js";
import {
  dropAccessConversations,
  forgetTranscriptAtOrBelow,
  listTranscriptConversations,
  readTranscriptAccess,
  scrubTranscriptLines,
  type TranscriptEnv,
  type TranscriptLine
} from "./store.js";

export type TranscriptForgetResult = { removedLines: number; conversations: number };

/** The names that remove a line: unique, with word boundaries, not weak. */
export function transcriptRemovableNames(names: readonly string[] = []): string[] {
  return names.filter((name) => name.trim().length > 0 && !hasNoWordBoundaries(name) && !isWeakName(name));
}

/**
 * A line a forget record covers (§7.5): theirs, or one naming them by id, from before their forget.
 * Readers of the store leave it out even when the forget job's transcript part has not run (yet).
 */
export function forgottenLine(line: Pick<TranscriptLine, "at" | "authorId" | "mentions" | "text">, forgotten: ReadonlyArray<{ userId: string; at: string }>): boolean {
  const at = Date.parse(line.at);
  return forgotten.some((person) => at <= Date.parse(person.at) && (line.authorId === person.userId || line.mentions?.includes(person.userId) === true || line.text.includes(person.userId)));
}

/** A line that is theirs (written at or before `at`) or that mentions them. */
export function lineCarriesPerson(line: TranscriptLine, o: { userId: string; names: readonly string[]; at: Date }): boolean {
  if (line.authorId === o.userId && Date.parse(line.at) <= o.at.getTime()) return true;
  if (line.mentions?.includes(o.userId)) return true;
  if (line.text.includes(o.userId)) return true;
  // The text names them as a whole word (§7.5); an author only by the whole name ("Kevin's Mom" is not Kevin).
  return o.names.some((name) => namesSomeone(line.text, name) || foldName(line.author) === foldName(name));
}

/**
 * The owner's forget-user (a durable job part): every room loses the person's lines and the lines
 * naming them; every DM transcript with them loses everything at or below the floor.
 */
export async function forgetPersonInTranscripts(env: TranscriptEnv, o: { userId: string; names?: readonly string[]; at: Date; floor: string }): Promise<TranscriptForgetResult> {
  const names = transcriptRemovableNames(o.names);
  let removedLines = 0;
  let conversations = 0;
  const droppedDms = new Set<string>();
  for (const key of await listTranscriptConversations(env.dataRoot)) {
    const ref = parseConversationKey(key);
    if (!ref) continue;
    let removed: number;
    if (ref.kind === "dm" && ref.userId === o.userId) {
      removed = await forgetTranscriptAtOrBelow(env, key, o.floor);
      droppedDms.add(key);
    } else {
      removed = await scrubTranscriptLines(env, key, (line) => lineCarriesPerson(line, { userId: o.userId, names, at: o.at }));
    }
    removedLines += removed;
    if (removed > 0) conversations += 1;
  }
  if (droppedDms.size > 0) await dropAccessConversations(env.dataRoot, droppedDms);
  return { removedLines, conversations };
}

/**
 * One waifu's scrub (a DM `/forget everything`, or her part of the owner's): her DM transcript with
 * the person at or below the floor, and the person's lines in the rooms she can see.
 */
export async function forgetPersonInHerTranscripts(
  env: TranscriptEnv,
  o: { waifuId: string; userId: string; names?: readonly string[]; at: Date; floor?: string; dmOnly?: boolean }
): Promise<TranscriptForgetResult> {
  let removedLines = 0;
  let conversations = 0;
  const dmKey = conversationKey({ kind: "dm", waifuId: o.waifuId, userId: o.userId });
  if (o.floor !== undefined) {
    const removed = await forgetTranscriptAtOrBelow(env, dmKey, o.floor);
    removedLines += removed;
    if (removed > 0) conversations += 1;
  }
  if (o.dmOnly) return { removedLines, conversations };
  const names = transcriptRemovableNames(o.names);
  const access = await readTranscriptAccess(env.dataRoot, o.waifuId);
  for (const key of Object.keys(access.conversations).sort()) {
    const removed = await scrubTranscriptLines(env, key, (line) => lineCarriesPerson(line, { userId: o.userId, names, at: o.at }));
    removedLines += removed;
    if (removed > 0) conversations += 1;
  }
  return { removedLines, conversations };
}
