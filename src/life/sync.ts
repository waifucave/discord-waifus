// In-process coordination for lives (Living cast spec §5.1, §5.2): the per-waifu `life:<id>` lock
// that serialises turns, compaction, maintenance and forget scrubs, and the host-wide semaphore that
// bounds parallel turns (`life.maxConcurrentTurns`). The exclusive host lock already rules out a
// second process on the same data root.

/** A FIFO mutex per key. */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly held = new Set<string>();

  isHeld(key: string): boolean {
    return this.held.has(key);
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    this.held.add(key);
    try {
      return await task();
    } finally {
      this.held.delete(key);
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** A counting semaphore whose limit is read on every acquire. */
export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  get inUse(): number {
    return this.active;
  }

  /**
   * A slot, or a rejection with the signal's reason when `signal` aborts first (a waiter that gave
   * up leaves the queue; a slot handed to it after the abort is passed on).
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    if (this.active < Math.max(1, this.limit())) {
      this.active += 1;
      return this.releaser();
    }
    // The releasing holder hands its slot over directly (active stays counted).
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      this.waiting.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (this.waiting.length > 0 && this.active <= Math.max(1, this.limit())) {
        this.waiting.shift()!();
        return;
      }
      this.active -= 1;
    };
  }
}

/** A sleep that ends early (without throwing) when `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
