// Typing-aware holds (Living cast spec §4.2): the intake's per-place timer for a pending burst.
//
// A burst fires `quietMs` after its last message, unless an author of the burst is still typing in
// that place: a typing event counts as "still typing" for `typingHoldMs`, or until a message from
// that author arrives (the message is what they were typing). It never waits longer than `maxWaitMs`
// from the burst's first message. Typing by anyone who has no message in the burst is ignored, so a
// third person typing in a busy room never holds someone else's wake.
//
//   due = min(firstAt + max(quietMs, maxWaitMs), max(lastMessageAt + quietMs, latest typing end))
//
// `quietMs = 0` with nobody typing fires synchronously (as the plain debouncer did).

export type HoldTiming = { quietMs: number; maxWaitMs: number; typingHoldMs: number };

type Entry = {
  firstAt: number;
  lastMessageAt: number;
  /** The people whose messages are pending in this burst (typing by anyone else is ignored). */
  authors: Set<string>;
  /** Per author: when their latest typing event stops counting. */
  typingUntil: Map<string, number>;
  timing: HoldTiming;
  fire: () => unknown;
  timer?: ReturnType<typeof setTimeout>;
};

export class TypingHolds<K> {
  private readonly pending = new Map<K, Entry>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * A message joins the burst for `key` (arming it, or re-arming it with the newest callback). Its
   * author, when given, is now part of the burst and no longer typing.
   */
  message(key: K, o: { authorId?: string; timing: HoldTiming }, fire: () => unknown): void {
    const now = this.now();
    const entry = this.pending.get(key) ?? { firstAt: now, lastMessageAt: now, authors: new Set<string>(), typingUntil: new Map<string, number>(), timing: o.timing, fire };
    entry.lastMessageAt = now;
    entry.timing = o.timing;
    entry.fire = fire;
    if (o.authorId) {
      entry.authors.add(o.authorId);
      entry.typingUntil.delete(o.authorId);
    }
    this.pending.set(key, entry);
    this.arm(key, entry);
  }

  /**
   * `userId` is typing in the place of `key`. Holds the burst only when they have a message in it;
   * returns whether it did.
   */
  typing(key: K, userId: string): boolean {
    const entry = this.pending.get(key);
    if (!entry || !entry.authors.has(userId) || entry.timing.typingHoldMs <= 0) return false;
    entry.typingUntil.set(userId, this.now() + entry.timing.typingHoldMs);
    this.arm(key, entry);
    return true;
  }

  /** When the burst for `key` fires (epoch ms), or undefined when none is pending. */
  dueAt(key: K): number | undefined {
    const entry = this.pending.get(key);
    return entry ? this.due(entry) : undefined;
  }

  private due(entry: Entry): number {
    const { quietMs, maxWaitMs } = entry.timing;
    const quiet = Math.max(0, quietMs);
    let typingEnd = 0;
    for (const until of entry.typingUntil.values()) typingEnd = Math.max(typingEnd, until);
    return Math.min(entry.firstAt + Math.max(quiet, maxWaitMs), Math.max(entry.lastMessageAt + quiet, typingEnd));
  }

  private arm(key: K, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const delay = this.due(entry) - this.now();
    if (delay <= 0) {
      this.pending.delete(key);
      entry.fire();
      return;
    }
    const timer = setTimeout(() => {
      if (this.pending.get(key) !== entry || entry.timer !== timer) return;
      this.pending.delete(key);
      entry.fire();
    }, delay);
    timer.unref?.();
    entry.timer = timer;
  }

  has(key: K): boolean {
    return this.pending.has(key);
  }

  /** Drop a pending fire. Returns whether one was pending. */
  cancel(key: K): boolean {
    const entry = this.pending.get(key);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);
    return true;
  }

  cancelAll(): void {
    for (const entry of this.pending.values()) if (entry.timer) clearTimeout(entry.timer);
    this.pending.clear();
  }

  keys(): K[] {
    return [...this.pending.keys()];
  }
}
