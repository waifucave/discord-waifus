// Seams for the life benchmark (spec §33.2, a developer tool in scripts/life-benchmark/): its prompt
// variants edit, for one run, block A, the tool definitions her model is offered, and the
// instructions she (or her memory keeper) gets when summarising. The app never sets them; unset,
// every text is the shipped one, unchanged. Not a setting and not reachable from the API, the CLI or
// config.

export type BlockATransform = (blockA: string) => string;

/** A tool as her model is offered it (`modelTools`). */
export type BenchmarkTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolTransform = (tool: BenchmarkTool) => BenchmarkTool;

/**
 * The summary instructions a variant can edit: `rest` the rest notice (also the quiet-time one,
 * `CACHE_REST_NOTICE`), `compaction` `COMPACTION_INSTRUCTION`, `dream` `DREAM_INSTRUCTION` and
 * `dreamSystem` the memory keeper's system block (`dreamSystem`).
 */
export const SUMMARY_PROMPTS = ["rest", "compaction", "dream", "dreamSystem"] as const;
export type SummaryPrompt = (typeof SUMMARY_PROMPTS)[number];
export type SummaryPromptTransform = (prompt: SummaryPrompt, text: string) => string;

let blockATransform: BlockATransform | undefined;
let toolTransform: ToolTransform | undefined;
let summaryTransform: SummaryPromptTransform | undefined;

/** Benchmark only: rewrite every block A built from now on (undefined restores the shipped text). */
export function setBenchmarkBlockATransform(next: BlockATransform | undefined): void {
  blockATransform = next;
}

/** Block A as the benchmark's variant wants it; the text unchanged when no benchmark is running. */
export function benchmarkBlockA(blockA: string): string {
  return blockATransform ? blockATransform(blockA) : blockA;
}

/** Benchmark only: rewrite every tool definition offered from now on (undefined restores the shipped ones). */
export function setBenchmarkToolTransform(next: ToolTransform | undefined): void {
  toolTransform = next;
}

/** A tool definition as the benchmark's variant wants it; the same object when no benchmark is running. */
export function benchmarkTool(tool: BenchmarkTool): BenchmarkTool {
  return toolTransform ? toolTransform(tool) : tool;
}

/** Benchmark only: rewrite every summary instruction sent from now on (undefined restores the shipped ones). */
export function setBenchmarkSummaryPromptTransform(next: SummaryPromptTransform | undefined): void {
  summaryTransform = next;
}

/** A summary instruction as the benchmark's variant wants it; the text unchanged when no benchmark is running. */
export function benchmarkSummaryPrompt(prompt: SummaryPrompt, text: string): string {
  return summaryTransform ? summaryTransform(prompt, text) : text;
}
