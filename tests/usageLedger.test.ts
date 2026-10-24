import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUsageLedger, usageFields, usageLedgerDay } from "../src/orchestration/usageLedger.js";
import { UsageLedgerEntrySchema, type UsageLedgerEntry } from "../src/shared/schemas/usage.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const entry = (over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry => ({
  at: "2026-10-23T23:59:59.000Z",
  purpose: "waifu_reply",
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  status: "ok",
  usageKnown: true,
  inputTokens: 10,
  outputTokens: 2,
  durationMs: 5,
  ...over
});

async function readLines(root: string, day: string): Promise<unknown[]> {
  const text = await readFile(path.join(root, "user", "usage", `${day}.jsonl`), "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("usageLedger", () => {
  it("appends one schema-valid line per call to the UTC-day file", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const ledger = createUsageLedger(root);
    await ledger.record(entry());
    await ledger.record(entry({ at: "2026-10-24T00:00:01.000Z", status: "failed", errorKind: "server", ...usageFields(undefined) }));
    expect(await readdir(path.join(root, "user", "usage"))).toEqual(["2026-10-23.jsonl", "2026-10-24.jsonl"]);
    const [first] = await readLines(root, "2026-10-23");
    expect(UsageLedgerEntrySchema.parse(first)).toMatchObject({ purpose: "waifu_reply", inputTokens: 10 });
    const [second] = await readLines(root, "2026-10-24");
    expect(second).toMatchObject({ status: "failed", usageKnown: false, inputTokens: 0, outputTokens: 0, errorKind: "server" });
  });

  it("uses the UTC day, not the local day", () => {
    expect(usageLedgerDay("2026-10-23T23:30:00-05:00")).toBe("2026-10-24");
  });

  it("never interleaves partial lines under concurrency (including across instances)", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const ledgers = [createUsageLedger(root), createUsageLedger(root)];
    const big = "x".repeat(20_000);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 60; i++) {
      writes.push(ledgers[i % 2]!.record(entry({ conversationKey: `${i}-${big}` })));
    }
    await Promise.all(writes);
    const lines = await readLines(root, "2026-10-23");
    expect(lines).toHaveLength(60);
    for (const line of lines) UsageLedgerEntrySchema.parse(line);
  });

  it("reports write failures to onError without rejecting", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    const errors: unknown[] = [];
    const ledger = createUsageLedger(root, { onError: (error) => errors.push(error) });
    await expect(ledger.record(entry({ inputTokens: -1 }))).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    await ledger.flush();
  });

  it("maps gateway usage including cache, reasoning and cost fields", () => {
    expect(usageFields({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5, costUsd: 0.0123 }))
      .toEqual({ usageKnown: true, inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5, costUsd: 0.0123 });
    expect(usageFields({ inputTokens: 0, outputTokens: 0 }).usageKnown).toBe(false);
    expect(usageFields(undefined)).toEqual({ usageKnown: false, inputTokens: 0, outputTokens: 0 });
  });
});
