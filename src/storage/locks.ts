export type LockWaitObserver = (resourceKey: string, waitMs: number) => void;

export class ResourceLockManager {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly waitWarnThresholdMs = 250,
    private readonly onWait?: LockWaitObserver
  ) {}

  async withLock<T>(resourceKey: string, task: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(resourceKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => current);
    this.tails.set(resourceKey, next);

    const startedWaitingAt = Date.now();
    await previous.catch(() => undefined);
    const waitMs = Date.now() - startedWaitingAt;
    if (waitMs >= this.waitWarnThresholdMs) {
      this.onWait?.(resourceKey, waitMs);
    }

    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(resourceKey) === next) {
        this.tails.delete(resourceKey);
      }
    }
  }

  async withLocks<T>(resourceKeys: string[], task: () => Promise<T> | T): Promise<T> {
    const uniqueSortedKeys = [...new Set(resourceKeys)].sort((a, b) => a.localeCompare(b));
    const run = uniqueSortedKeys
      .slice()
      .reverse()
      .reduce<() => Promise<T>>(
        (nextTask, key) => () => this.withLock(key, nextTask),
        async () => task()
      );
    return run();
  }
}
