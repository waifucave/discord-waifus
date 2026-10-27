// The rest turn (Living cast spec §19): the notice that opens it and what it refuses, and her own
// fresh start (§21.6b): a turn whose final reply is only `<summary>…</summary>`. Its own module so the
// owner's views (lifeView.ts) can recognise both without importing the life loop.

/** The rest notice (spec §19.3): a turn of her own in which she writes the summary her new epoch starts from. */
export const REST_NOTICE =
  "[system] Your memory is almost full. When this turn ends, your context will be reset: everything you can see now goes away except the summary you write in this turn. Your computer stays exactly as you left it: your home, /tmp and /transcripts keep every file and you can still read and change them afterwards. If something should last, you can save it to your notes now. Then write your summary as your final reply: what is going on in each place, who you talked to and how it went, plans and promises, open threads, what you were about to do. Write it clearly and concretely, with names, places and times, so you can't misread it later. Write what happened and how you feel about it now, not rules for yourself. Don't message anyone in this turn.";
/** What reaching people returns in the rest turn (the tools stay offered: the cached prefix holds). */
export const REST_REFUSED_RESULT = "error: finish your summary first; you can do this after the reset";
/** Tools that reach people or the web: refused while she writes her rest summary. */
export const REST_REFUSED_TOOLS: ReadonlySet<string> = new Set(["SendMessage", "React", "WebSearch", "WebFetch"]);
/** How her own summary opens her new epoch's `<life_so_far>`. */
export const REST_SUMMARY_FRAME = "[your summary before the reset]";

/** A rest turn's notification line starts with this (the owner's views keep her summary private). */
export const REST_NOTICE_PREFIX = REST_NOTICE.slice(0, 60);

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
