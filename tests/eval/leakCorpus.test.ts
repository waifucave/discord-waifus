// Tier 1 — always-on corpus suite (no network, deterministic).
//
// Asserts:
// - Every LEAK_CORPUS entry produces the expected verdict (pass/retry/block).
// - Every LEAK_CORPUS entry produces at least one violation (the validator isn't silent).
// - Every CLEAN_CORPUS entry produces verdict "pass" with ZERO violations.

import { describe, expect, it } from "vitest";
import { validateWaifuOutput } from "../../src/orchestration/outputValidator.js";
import { CLEAN_CORPUS, LEAK_CORPUS, defaultCtx } from "./fixtures/synthetic/corpus.js";

describe("leak corpus — tier 1", () => {
  describe("LEAK_CORPUS: every entry must flag with its expected verdict", () => {
    for (const entry of LEAK_CORPUS) {
      it(entry.name, () => {
        const ctx = entry.ctx ?? defaultCtx();
        const result = validateWaifuOutput(entry.text, ctx);
        expect(result.verdict).toBe(entry.expectVerdict);
        expect(result.violations.length).toBeGreaterThanOrEqual(1);
      });
    }
  });

  describe("CLEAN_CORPUS: every entry must pass with zero violations", () => {
    for (const entry of CLEAN_CORPUS) {
      it(entry.name, () => {
        const ctx = entry.ctx ?? defaultCtx();
        const result = validateWaifuOutput(entry.text, ctx);
        expect(result.verdict).toBe("pass");
        expect(result.violations).toEqual([]);
      });
    }
  });
});
