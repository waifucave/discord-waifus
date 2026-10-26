// Zod-free forget constants (Living cast spec §7.5): shared by the backend, the CLI, the assistant
// and the dashboard (which may import this module at runtime).

/** The parts of one owner forget, in the order they run. */
export const FORGET_JOB_PARTS = ["record", "floors", "dms", "dm-directory", "member-lists", "archive", "transcripts", "record-copies"] as const;
export type ForgetJobPart = (typeof FORGET_JOB_PARTS)[number];

/** A part that failed this many times (the request's run plus boots) is no longer retried. */
export const FORGET_PART_MAX_FAILURES = 3;

/**
 * What a forget cannot remove (§7.5 "Limits of the scrub"), stated to the owner wherever a forget is
 * started: the dashboard, `waifus forget` and the assistant's confirmation card.
 */
export const FORGET_LIMITS = [
  "Discord history itself is not deleted (the bot can't delete other people's messages), and whatever she already said in rooms stays there.",
  "Usage-ledger lines and app logs stay (they hold ids only, never text).",
  "Cached guild images, and any DM image no image index recorded, stay until the disk cache expires them (discord.images.diskCacheTtlHours, 168 hours by default).",
  "Anything outside this host, and the web page cache (life.webFetch.cacheMinutes, 15 minutes by default), are not touched.",
  "Name matching is best effort: a name someone else also has is only listed for review, never removed.",
  "Files she downloaded from them, and exact copies, are deleted; files she made from someone's attachment (for example a cropped copy) can't be traced back to them."
] as const;

export const FORGET_LIMITS_TEXT = `Forget is a best-effort scrub. ${FORGET_LIMITS.join(" ")}`;
