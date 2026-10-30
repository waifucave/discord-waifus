// The rest turn (Living cast spec §19): the notice that opens it and what it refuses, and her own
// fresh start (§21.6b): a turn whose final reply is only `<summary>…</summary>`. Its own module so the
// owner's views (lifeView.ts) can recognise both without importing the life loop.

/**
 * How a summary she writes for herself should read (spec §19.8, shipped 2026-10-29 from the life
 * benchmark's `own-voice` variant): her own memory, in her voice. The last line of the rest notices
 * and of the compaction instruction.
 */
export const SUMMARY_VOICE =
  "Write it as your own memory: in the first person, in your own voice and style (your casing, your tone), not as a neutral report or a log. Keep names, times and facts exact.";
/**
 * What a summary she writes for herself may say as fact (spec §35.1): only what was said or done, a
 * guess as hers, a plan as a plan, open threads kept. The line after `SUMMARY_VOICE` in the rest
 * notices and the compaction instruction, and the end of block A's summary paragraph.
 */
export const SUMMARY_FACTS =
  "Write only what someone actually said or did, and who said it: a guess stays your guess, a plan stays a plan (with its date) until someone says it happened, a maybe stays a maybe, teasing stays teasing. Keep open threads open: questions nobody answered, plans nobody confirmed, someone who didn't reply.";
/** The rest notice's first line (spec §19.3, owner rewording 2026-10-27). */
const REST_NOTICE_TEXT =
  "[system] Your memory is almost full. When this turn ends your context resets: everything you can see now goes away except what you write as your final reply. Your computer stays exactly as you left it (your home, /tmp and /transcripts), so anything that should last can go into your notes now. Then write, in your own way, whatever you want to carry forward. Write it clearly, so you won't misunderstand it later without what you can see now. Write what happened and how you feel, not rules for yourself. Don't message anyone in this turn.";
/** The rest notice: a turn of her own in which she writes the summary her new epoch starts from. */
export const REST_NOTICE = `${REST_NOTICE_TEXT}\n${SUMMARY_VOICE}\n${SUMMARY_FACTS}`;
/**
 * The quiet-time rest before her prompt cache goes cold (§25): the notice's first line plus one
 * sentence, so it starts like every rest notice (`REST_NOTICE_PREFIX`), then the voice and facts lines.
 */
export const CACHE_REST_NOTICE = `${REST_NOTICE_TEXT} You've been quiet a while; this is a good moment to rest.\n${SUMMARY_VOICE}\n${SUMMARY_FACTS}`;
/** What reaching people returns in the rest turn (the tools stay offered: the cached prefix holds). */
export const REST_REFUSED_RESULT = "error: finish your summary first; you can do this after the reset";
/** Tools that reach people or the web: refused while she writes her rest summary. */
export const REST_REFUSED_TOOLS: ReadonlySet<string> = new Set(["SendMessage", "React", "Web"]);
/** How her own summary opens her new epoch's `<life_so_far>`. */
export const REST_SUMMARY_FRAME = "[your summary before the reset]";

/** A rest turn's notification line starts with this (the owner's views keep her summary private). */
export const REST_NOTICE_PREFIX = REST_NOTICE.slice(0, 60);
/** How rest turns logged before the owner's rewording (2026-10-27) begin: still recognised in old logs. */
export const LEGACY_REST_NOTICE_PREFIX = "[system] Your memory is almost full. When this turn ends, yo";

/**
 * A notification text that opens a rest turn (§19, §25), in today's wording or the earlier one. The
 * voice line (§19.8) came after the first 60 characters, so notices logged without it match too.
 */
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

/** The next time line's one-time note after an ignored quiet-time rest (§25): the notice said her context would reset; it did not. */
export function cacheRestIgnoredNote(reason: string): string {
  return `(your summary was not used and nothing was reset: ${reason})`;
}

/** The next time line's one-time note when a summary she wrote was not used (§21.6b). */
export function selfSummaryRefusedNote(reason: string): string {
  return `(your summary was not used: ${reason})`;
}
