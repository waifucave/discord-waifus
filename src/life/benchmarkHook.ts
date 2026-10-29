// A seam for the life benchmark (spec §33.2, a developer tool in scripts/life-benchmark/): its
// prompt variants replace or add paragraphs of block A for one run. The app never sets it; unset,
// block A is the shipped text. Not a setting and not reachable from the API, the CLI or config.

export type BlockATransform = (blockA: string) => string;

let transform: BlockATransform | undefined;

/** Benchmark only: rewrite every block A built from now on (undefined restores the shipped text). */
export function setBenchmarkBlockATransform(next: BlockATransform | undefined): void {
  transform = next;
}

/** Block A as the benchmark's variant wants it; the text unchanged when no benchmark is running. */
export function benchmarkBlockA(blockA: string): string {
  return transform ? transform(blockA) : blockA;
}
