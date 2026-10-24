import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { userDataPath } from "../config/paths.js";
import { UsageLedgerEntrySchema, type UsageLedgerEntry, type UsageLedgerLine } from "../shared/schemas/usage.js";

// Append-only per-model-call usage ledger (spec 8.10): `user/usage/YYYY-MM-DD.jsonl`, one JSON
// line per call, file date = UTC day of the call. Writes go through one in-process queue per file
// so concurrent calls can never interleave partial lines; the exclusive host lock covers the
// cross-process case. Recording is best-effort: a ledger failure is reported to `onError` and
// never fails (or delays) the model call that produced it.

export type { UsageLedgerEntry, UsageLedgerLine };

export interface UsageLedger {
  /** Queue one line. Never rejects; resolves once the line is on disk (or the write failed). */
  record(entry: UsageLedgerLine): Promise<void>;
  /** Resolves when every line queued so far has been written. */
  flush(): Promise<void>;
}

export type UsageLedgerOptions = {
  onError?: (error: unknown, entry: UsageLedgerEntry) => void;
};

/** UTC day (YYYY-MM-DD) a ledger line belongs to. */
export function usageLedgerDay(at: string | Date): string {
  const date = typeof at === "string" ? new Date(at) : at;
  return date.toISOString().slice(0, 10);
}

export function usageLedgerPath(dataRoot: string, day: string): string {
  return userDataPath(dataRoot, "usage", `${day}.jsonl`);
}

// One chain per absolute file path, shared by every ledger instance in the process, so two
// ledgers pointed at the same data root still serialize their appends.
const fileQueues = new Map<string, Promise<void>>();

function enqueue(filePath: string, task: () => Promise<void>): Promise<void> {
  const previous = fileQueues.get(filePath) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.then(() => undefined, () => undefined);
  fileQueues.set(filePath, tail);
  void tail.then(() => {
    if (fileQueues.get(filePath) === tail) fileQueues.delete(filePath);
  });
  return next;
}

class FileUsageLedger implements UsageLedger {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly dataRoot: string, private readonly options: UsageLedgerOptions) {}

  record(entry: UsageLedgerLine): Promise<void> {
    const done = this.write(entry).catch((error) => {
      try {
        this.options.onError?.(error, entry);
      } catch {
        // an error hook must never turn a best-effort write into a failure
      }
    });
    this.pending.add(done);
    void done.then(() => this.pending.delete(done));
    return done;
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async write(entry: UsageLedgerEntry): Promise<void> {
    const parsed = UsageLedgerEntrySchema.parse(entry);
    const filePath = usageLedgerPath(this.dataRoot, usageLedgerDay(parsed.at));
    const line = `${JSON.stringify(parsed)}\n`;
    await enqueue(filePath, async () => {
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
    });
  }
}

export function createUsageLedger(dataRoot: string, options: UsageLedgerOptions = {}): UsageLedger {
  return new FileUsageLedger(dataRoot, {
    onError:
      options.onError ??
      ((error) => console.warn("Usage ledger write failed", error instanceof Error ? error.message : String(error)))
  });
}

const sharedLedgers = new Map<string, UsageLedger>();

/** The process-wide ledger for a data root (pipelines built without an explicit ledger use it). */
export function sharedUsageLedger(dataRoot: string): UsageLedger {
  const key = path.resolve(dataRoot);
  let ledger = sharedLedgers.get(key);
  if (!ledger) {
    ledger = createUsageLedger(key);
    sharedLedgers.set(key, ledger);
  }
  return ledger;
}

/** A ledger that drops everything (pipelines with neither a data root nor an explicit ledger). */
export const NoopUsageLedger: UsageLedger = { record: async () => undefined, flush: async () => undefined };

const tokens = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

/** The usage numbers winter reports for one call (its `usage` stream event, minus the tag). */
export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  thinkingBlocksDropped?: number;
};

/**
 * winter usage (+ the call's cost) -> ledger token fields. `usageKnown` is false when there is no
 * usage at all (aborted/failed call) or the provider reported nothing (zero input and output).
 * winter's convention: `inputTokens` is the non-cached prompt, disjoint from the cache counts.
 * `costUsd` is absent for an unpriced route (it counts as 0 toward budgets).
 */
export function usageFields(
  usage: ModelUsage | undefined,
  costUsd?: number
): Pick<
  UsageLedgerEntry,
  | "usageKnown"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "reasoningTokens"
  | "thinkingBlocksDropped"
  | "costUsd"
> {
  if (!usage) return { usageKnown: false, inputTokens: 0, outputTokens: 0 };
  const inputTokens = tokens(usage.inputTokens);
  const outputTokens = tokens(usage.outputTokens);
  const fields: ReturnType<typeof usageFields> = {
    usageKnown: inputTokens > 0 || outputTokens > 0,
    inputTokens,
    outputTokens
  };
  if (typeof usage.cacheReadTokens === "number") fields.cacheReadTokens = tokens(usage.cacheReadTokens);
  if (typeof usage.cacheWriteTokens === "number") fields.cacheWriteTokens = tokens(usage.cacheWriteTokens);
  if (typeof usage.reasoningTokens === "number") fields.reasoningTokens = tokens(usage.reasoningTokens);
  if (typeof usage.thinkingBlocksDropped === "number") fields.thinkingBlocksDropped = tokens(usage.thinkingBlocksDropped);
  if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0) fields.costUsd = costUsd;
  return fields;
}
