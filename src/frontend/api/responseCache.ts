// What a screen showed last, so a screen opened again shows it at once while it reloads (over Remote
// Access every request is a round trip to the host). Kept in memory for the page's lifetime only,
// keyed by the GET paths a fetcher asked for plus the fetcher itself (fetchers may reshape the
// response), and dropped wholesale after any change the dashboard makes.

const MAX_ENTRIES = 200;

let capturing: string[] | undefined;
let generation = 0;
const entries = new Map<string, { generation: number; value: unknown }>();

/** Called by the API client for every GET: records the path while a fetcher is being started. */
export function noteGet(path: string): void {
  capturing?.push(path);
}

/** Called by the API client after a successful change: nothing cached before it is shown again. */
export function noteMutation(): void {
  generation += 1;
  entries.clear();
}

/**
 * Starts a fetcher and returns its promise with the cache key for what it asked for: the GET paths
 * it requested before its first await, and its source. No GET (a constant fetcher) means no key.
 */
export function startCaptured<T>(fetcher: () => Promise<T>): { promise: Promise<T>; key: string | undefined; generation: number } {
  const previous = capturing;
  const paths: string[] = [];
  capturing = paths;
  let promise: Promise<T>;
  try {
    promise = fetcher();
  } finally {
    capturing = previous;
  }
  return { promise, key: paths.length > 0 ? `${paths.join("\n")}\n${fetcher.toString()}` : undefined, generation };
}

export function cachedValue(key: string | undefined): unknown {
  return key === undefined ? undefined : entries.get(key)?.value;
}

/** Stores a fetcher's result unless a change happened since it started (it may be stale). */
export function storeValue(key: string | undefined, startedAt: number, value: unknown): void {
  if (key === undefined || startedAt !== generation) return;
  entries.delete(key);
  entries.set(key, { generation, value });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}
