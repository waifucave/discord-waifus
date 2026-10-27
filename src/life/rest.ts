// The rest turn (Living cast spec §19): the notice that opens it and what it refuses, and her own
// fresh start (§21.6b): a turn whose final reply is only `<summary>…</summary>`. Its own module so the
// owner's views (lifeView.ts) can recognise both without importing the life loop.

/** The rest notice (spec §19.3, owner rewording 2026-10-27): a turn of her own in which she writes the summary her new epoch starts from. */
export const REST_NOTICE =
  "[system] Your memory is almost full. When this turn ends your context resets: everything you can see now goes away except what you write as your final reply. Your computer stays exactly as you left it (your home, /tmp and /transcripts), so anything that should last can go into your notes now. Then write, in your own way, whatever you want to carry forward. Write it clearly, so you won't misunderstand it later without what you can see now. Write what happened and how you feel, not rules for yourself. Don't message anyone in this turn.";
/**
 * The quiet-time rest before her prompt cache goes cold (§25): the same notice plus one sentence,
 * appended so it starts like every rest notice (`REST_NOTICE_PREFIX`).
 */
export const CACHE_REST_NOTICE = `${REST_NOTICE} You've been quiet a while; this is a good moment to rest.`;
/** What reaching people returns in the rest turn (the tools stay offered: the cached prefix holds). */
export const REST_REFUSED_RESULT = "error: finish your summary first; you can do this after the reset";
/** Tools that reach people or the web: refused while she writes her rest summary. */
export const REST_REFUSED_TOOLS: ReadonlySet<string> = new Set(["SendMessage", "React", "WebSearch", "WebFetch"]);
/** How her own summary opens her new epoch's `<life_so_far>`. */
export const REST_SUMMARY_FRAME = "[your summary before the reset]";

/** A rest turn's notification line starts with this (the owner's views keep her summary private). */
export const REST_NOTICE_PREFIX = REST_NOTICE.slice(0, 60);
/** How rest turns logged before the owner's rewording (2026-10-27) begin: still recognised in old logs. */
export const LEGACY_REST_NOTICE_PREFIX = "[system] Your memory is almost full. When this turn ends, yo";

/** A notification text that opens a rest turn (§19, §25), in today's wording or the earlier one. */
export function isRestNotice(text: string): boolean {
  return text.startsWith(REST_NOTICE_PREFIX) || text.startsWith(LEGACY_REST_NOTICE_PREFIX);
}

// ---- a fresh start when she wants one (§21.6b) --------------------------------------------------

/** A final reply that is only `<summary>…</summary>` (whitespace around it allowed). */
const SELF_SUMMARY = /^\s*<summary>([\s\S]*)<\/summary>\s*$/u;

/** The summary inside a reply that is only `<summary>…</summary>`, else undefined. */
export function selfSummaryOf(text: string | undefined): string | undefined {
  const match = text === undefined ? null : SELF_SUMMARY.exec(text);
  if (!match || match[1]!.includes("<summary>") || match[1]!.includes("</summary>")) return undefined;
  return match[1]!.trim();
}

/** The next time line's one-time note when a summary she wrote was not used (§21.6b). */
export function selfSummaryRefusedNote(reason: string): string {
  return `(your summary was not used: ${reason})`;
}
