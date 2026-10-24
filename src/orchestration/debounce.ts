// I2 (spec 9.2): a keyed trailing debouncer with a maximum wait.
//
// The first `schedule` for a key records `firstAt`; every call re-arms the timer to
// `min(now + quietMs, firstAt + maxWaitMs)` and replaces the callback, so a burst fires once with
// the last caller's callback. `quietMs = 0` fires synchronously (no timer), which reproduces the
// behaviour before debouncing existed.

export type DebounceTiming = { quietMs: number; maxWaitMs: number };

type Pending = { firstAt: number; timer: NodeJS.Timeout; fire: () => unknown };

export class KeyedDebouncer<K> {
  private readonly pending = new Map<K, Pending>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Arm (or re-arm) `key`. Returns the callback's result when it fired synchronously
   * (`quietMs <= 0`), otherwise undefined.
   */
  schedule<T>(key: K, timing: DebounceTiming, fire: () => T): T | undefined {
    const quietMs = Math.max(0, timing.quietMs);
    if (quietMs === 0) {
      this.cancel(key);
      return fire();
    }
    const now = this.now();
    const existing = this.pending.get(key);
    const firstAt = existing?.firstAt ?? now;
    if (existing) clearTimeout(existing.timer);
    const maxWaitMs = Math.max(quietMs, timing.maxWaitMs);
    const at = Math.min(now + quietMs, firstAt + maxWaitMs);
    const timer = setTimeout(() => {
      const current = this.pending.get(key);
      if (!current || current.timer !== timer) return;
      this.pending.delete(key);
      current.fire();
    }, Math.max(0, at - now));
    timer.unref?.();
    this.pending.set(key, { firstAt, timer, fire });
    return undefined;
  }

  has(key: K): boolean {
    return this.pending.has(key);
  }

  /** Drop a pending fire. Returns whether one was pending. */
  cancel(key: K): boolean {
    const existing = this.pending.get(key);
    if (!existing) return false;
    clearTimeout(existing.timer);
    this.pending.delete(key);
    return true;
  }

  /** Cancel every pending fire without running it. */
  cancelAll(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  /** Cancel every pending fire and return their keys (shutdown persists them instead of firing). */
  drain(): K[] {
    const keys = [...this.pending.keys()];
    this.cancelAll();
    return keys;
  }

  get size(): number {
    return this.pending.size;
  }
}
