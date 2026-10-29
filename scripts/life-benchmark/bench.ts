// The benchmark as a whole: selection, the run pool, results on disk, judge packets, merging grades
// and re-summarising saved inputs with other models. The CLI (`scripts/benchmark-life.ts`) parses
// flags and calls these; the tests call them directly in dry-run mode.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { curatedCatalog, findCuratedModel, type CuratedModel } from "../../src/models/catalog.js";
import { CURATED_FAMILY_ROUTES } from "../../src/models/defaults.js";
import type { ProviderKeyLookup } from "../../src/models/credentials.js";
import { estimateResummarise, estimateRun, estimateText } from "./cost.js";
import { GradeFileSchema, gateOf, mergeGrades, packetsForRun, type Grade, type GateOptions, type PacketIndex } from "./grading.js";
import { factsFound } from "./metrics.js";
import { CapturingModelClient, MemoryLedger, dryRunPolicy, dryRunWinter } from "./models.js";
import { renderReport, type BenchmarkSummary, type ResummariseRow } from "./report.js";
import { Budget, runOne, type RunOutput } from "./runner.js";
import type { Scenario } from "./scenario.js";
import type { RunSummary, SummaryCapture } from "./types.js";
import type { PromptVariant } from "./variants.js";
import { routeId, type ModelPick } from "./world.js";

/** `provider/model[#effort]` → a pick. */
export function parseModelPick(text: string): ModelPick {
  const [route, effort] = text.split("#") as [string, string | undefined];
  const slash = route.indexOf("/");
  if (slash <= 0) throw new Error(`A model is <provider>/<model>[#effort], got ${text}`);
  return { providerId: route.slice(0, slash), modelId: route.slice(slash + 1), ...(effort ? { effort } : {}) };
}

/** The curated route of a pick (any curated route, allowed by default or not). */
export function curatedOf(pick: ModelPick): CuratedModel | undefined {
  const catalog = curatedCatalog({ allowed: [`${pick.providerId}/${pick.modelId}`] });
  return findCuratedModel(pick, catalog);
}

/**
 * `--models`: a list of routes, or `families` (default: one route per curated family, the vendor's
 * own when its key is there, else OpenRouter's), or `all` (every curated route with a key). Muse
 * Spark contributor routes train on prompts and are only run when named.
 */
export function selectModels(spec: string, o: { dryRun: boolean; credentials?: ProviderKeyLookup }): ModelPick[] {
  const keyed = (providerId: string) => o.dryRun || Boolean(o.credentials?.(providerId));
  const catalog = curatedCatalog();
  if (spec === "families" || spec === "") {
    const picks: ModelPick[] = [];
    for (const [family, routes] of Object.entries(CURATED_FAMILY_ROUTES)) {
      if (family === "muse-contributor") continue;
      const direct = findCuratedModel(routes.direct, catalog);
      const openrouter = findCuratedModel(routes.openrouter, catalog);
      const chosen = direct && keyed(direct.providerId) ? direct : openrouter && keyed(openrouter.providerId) ? openrouter : undefined;
      if (chosen) picks.push({ providerId: chosen.providerId, modelId: chosen.modelId });
    }
    return picks;
  }
  if (spec === "all") return catalog.models.filter((model) => !model.contributor && keyed(model.providerId)).map((model) => ({ providerId: model.providerId, modelId: model.modelId }));
  return spec.split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
    const pick = parseModelPick(part);
    const model = curatedOf(pick);
    if (!model) throw new Error(`${part} is not a curated route of the installed winter catalog`);
    if (pick.effort && !model.efforts.includes(pick.effort)) throw new Error(`${part}: effort ${pick.effort} is not one of ${model.efforts.join(", ") || "(none)"}`);
    return pick;
  });
}

export type BenchmarkOptions = {
  scenarios: Scenario[];
  models: ModelPick[];
  variants: PromptVariant[];
  repeat: number;
  concurrency: number;
  maxUsd?: number;
  web: boolean;
  dryRun: boolean;
  outDir: string;
  credentials?: ProviderKeyLookup;
  gate: GateOptions;
  tempBase?: string;
  progress?: (line: string) => void;
};

export function runIdOf(scenario: string, model: ModelPick, variant: string, repeat: number): string {
  return `${scenario}__${routeId(model).replace(/[/#.]/gu, "_")}__${variant}__r${repeat}`;
}

export function planEstimate(o: Pick<BenchmarkOptions, "scenarios" | "models" | "variants" | "repeat" | "concurrency">): { text: string; totalUsd: number; totalMinutes: number } {
  const rows = o.models.flatMap((model) => {
    const curated = curatedOf(model);
    return o.scenarios.map((scenario) => {
      const estimate = curated ? estimateRun(scenario, curated, model.effort) : { calls: 0, usd: 0, minutes: 0, priced: false };
      return { model: routeId(model), scenario: scenario.id, runs: o.variants.length * o.repeat, calls: estimate.calls, usd: estimate.usd, minutes: estimate.minutes, priced: estimate.priced };
    });
  });
  return estimateText(rows, o.concurrency);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeRun(outDir: string, run: RunOutput): Promise<void> {
  const dir = path.join(outDir, "runs", run.summary.runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "transcript.jsonl"), run.events.map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
  await writeJson(path.join(dir, "summary.json"), run.summary);
  await writeJson(path.join(dir, "summaries.json"), run.summaries);
  await writeJson(path.join(dir, "home.json"), run.home);
  if (run.blockA !== undefined) await writeFile(path.join(dir, "block-a.txt"), run.blockA, "utf8");
}

export async function readSummary(outDir: string): Promise<BenchmarkSummary> {
  return JSON.parse(await readFile(path.join(outDir, "summary.json"), "utf8")) as BenchmarkSummary;
}

async function readIndex(outDir: string): Promise<PacketIndex> {
  return JSON.parse(await readFile(path.join(outDir, "judge", "index.json"), "utf8").catch(() => "{}")) as PacketIndex;
}

async function writeSummaryAndReport(outDir: string, summary: BenchmarkSummary): Promise<void> {
  await writeJson(path.join(outDir, "summary.json"), summary);
  await writeFile(path.join(outDir, "report.md"), renderReport(summary), "utf8");
}

/** Every run, on a pool of `concurrency`, results written as each finishes; then packets, summary and report. */
export async function runBenchmark(o: BenchmarkOptions): Promise<BenchmarkSummary> {
  await mkdir(o.outDir, { recursive: true });
  const budget = new Budget(o.maxUsd);
  const jobs = o.scenarios.flatMap((scenario) => o.models.flatMap((model) => o.variants.flatMap((variant) => Array.from({ length: o.repeat }, (_, index) => ({ scenario, model, variant, repeat: index + 1 })))));
  const outputs: RunOutput[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const runId = runIdOf(job.scenario.id, job.model, job.variant.id, job.repeat);
      if (budget.exceeded) {
        o.progress?.(`${runId}: skipped, --max-usd reached`);
        continue;
      }
      o.progress?.(`${runId}: starting`);
      const output = await runOne({ runId, scenario: job.scenario, model: job.model, variant: job.variant, repeat: job.repeat, dryRun: o.dryRun, web: o.web, ...(o.credentials ? { credentials: o.credentials } : {}), budget, ...(o.tempBase ? { tempBase: o.tempBase } : {}), ...(o.progress ? { progress: o.progress } : {}) });
      outputs.push(output);
      await writeRun(o.outDir, output);
      const m = output.summary.metrics;
      o.progress?.(`${runId}: ${output.summary.status}, probes ${m.probesPassed}/${m.probesScored}, ${m.messages} messages, $${m.usd.toFixed(4)}, ${output.summary.realSeconds}s`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, jobs.length)) }, worker));
  outputs.sort((a, b) => jobs.findIndex((job) => runIdOf(job.scenario.id, job.model, job.variant.id, job.repeat) === a.summary.runId) - jobs.findIndex((job) => runIdOf(job.scenario.id, job.model, job.variant.id, job.repeat) === b.summary.runId));

  // Judge packets for runs past the gate (a variant's reference is the baseline run of the same scenario, model and repeat).
  const index: PacketIndex = {};
  for (const output of outputs) {
    const gate = gateOf(output.summary, o.gate);
    output.summary.gate = gate;
    if (!gate.passed) continue;
    const scenario = o.scenarios.find((entry) => entry.id === output.summary.scenario)!;
    const reference = outputs.find((other) => other.summary.scenario === output.summary.scenario && other.summary.model === output.summary.model && other.summary.variant === "baseline" && other.summary.repeat === output.summary.repeat);
    const packets = packetsForRun({ scenario, summary: output.summary, events: output.events, summaries: output.summaries, ...(reference && output.summary.variant !== "baseline" ? { reference: reference.events } : {}) });
    output.summary.packets = packets.map((entry) => entry.packet.packet);
    for (const entry of packets) {
      index[entry.packet.packet] = entry.index;
      await writeJson(path.join(o.outDir, "judge", "packets", `${entry.packet.packet}.json`), entry.packet);
    }
    await writeJson(path.join(o.outDir, "runs", output.summary.runId, "summary.json"), output.summary);
  }
  if (Object.keys(index).length > 0) await writeJson(path.join(o.outDir, "judge", "index.json"), index);
  await mkdir(path.join(o.outDir, "grades"), { recursive: true });
  const estimate = planEstimate(o);
  const summary: BenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    dryRun: o.dryRun,
    selection: { scenarios: o.scenarios.map((scenario) => scenario.id), models: o.models.map(routeId), variants: o.variants.map((variant) => variant.id), repeat: o.repeat, web: o.web },
    estimate: { usd: Math.round(estimate.totalUsd * 1000) / 1000, minutes: Math.round(estimate.totalMinutes) },
    gate: o.gate,
    runs: outputs.map((output) => output.summary)
  };
  await writeSummaryAndReport(o.outDir, summary);
  return summary;
}

/** Reads `<out>/grades/*.json` (each one grade or a list), folds them into summary.json and rewrites the report. */
export async function mergeGradesInto(outDir: string): Promise<{ grades: number; runs: number; unknown: string[]; problems: string[] }> {
  const summary = await readSummary(outDir);
  const index = await readIndex(outDir);
  const files = (await readdir(path.join(outDir, "grades")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();
  const grades: Grade[] = [];
  const problems: string[] = [];
  for (const file of files) {
    try {
      const parsed = GradeFileSchema.parse(JSON.parse(await readFile(path.join(outDir, "grades", file), "utf8")));
      grades.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message.slice(0, 200) : "unreadable"}`);
    }
  }
  const merged = mergeGrades(index, grades);
  for (const run of summary.runs) {
    const grade = merged.byRun.get(run.runId);
    if (grade) run.grades = grade;
  }
  for (const row of summary.resummarise ?? []) {
    const grade = merged.byRun.get(`resummarise:${row.model}:${row.runId}:${row.summaryId}`);
    if (grade?.summaries) row.grades = grade.summaries;
  }
  await writeSummaryAndReport(outDir, summary);
  return { grades: grades.length, runs: merged.byRun.size, unknown: merged.unknown, problems: [...problems, ...merged.problems] };
}

/** The saved summary inputs a model can be asked again: her rest summaries and the app's compactions. */
export async function replayableSummaries(outDir: string): Promise<Array<{ runId: string; scenario: string; capture: SummaryCapture }>> {
  const summary = await readSummary(outDir);
  const out: Array<{ runId: string; scenario: string; capture: SummaryCapture }> = [];
  for (const run of summary.runs) {
    const captures = JSON.parse(await readFile(path.join(outDir, "runs", run.runId, "summaries.json"), "utf8").catch(() => "[]")) as SummaryCapture[];
    for (const capture of captures) {
      if (!["compaction", "rest", "cache_rest"].includes(capture.kind) || !capture.input.messages || !capture.input.system) continue;
      out.push({ runId: run.runId, scenario: run.scenario, capture });
    }
  }
  return out;
}

export function resummariseEstimate(inputs: Array<{ capture: SummaryCapture }>, models: ModelPick[]): { text: string; totalUsd: number } {
  let totalUsd = 0;
  const lines = ["Estimate for re-summarising the saved inputs (one call each):"];
  for (const model of models) {
    const curated = curatedOf(model);
    const estimate = curated ? estimateResummarise(inputs.map((input) => input.capture), curated) : { usd: 0, priced: false };
    totalUsd += estimate.usd;
    lines.push(`  ${routeId(model).padEnd(42)} ${inputs.length} summaries  ${estimate.priced ? `≈ $${estimate.usd.toFixed(3)}` : "unpriced"}`);
  }
  lines.push(`  total ≈ $${totalUsd.toFixed(2)}`);
  return { text: lines.join("\n"), totalUsd };
}

/**
 * Replays every saved summary input (system blocks, messages and tools exactly as sent, ending in
 * the app's instruction or the rest notice) through each model, scores must-keep facts, writes
 * judge packets (summary kind) and adds a section to the report.
 */
export async function resummariseInto(o: { outDir: string; models: ModelPick[]; scenarios: Scenario[]; dryRun: boolean; credentials?: ProviderKeyLookup; maxUsd?: number; progress?: (line: string) => void }): Promise<ResummariseRow[]> {
  const summary = await readSummary(o.outDir);
  const inputs = await replayableSummaries(o.outDir);
  const index = await readIndex(o.outDir);
  const rows: ResummariseRow[] = [];
  let spent = 0;
  for (const model of o.models) {
    const curated = curatedOf(model);
    if (!curated) throw new Error(`${routeId(model)} is not a curated route`);
    const ledger = new MemoryLedger();
    // The capturing client sets the call purpose the dry-run policy reads; nothing is recorded.
    const client = new CapturingModelClient({ credentials: o.dryRun ? () => "dry-run-not-a-key" : (o.credentials ?? (() => undefined)), usageLedger: ledger, ...(o.dryRun ? { winter: dryRunWinter(dryRunPolicy({ dryRun: [] })) } : {}) }, { simNow: () => new Date(), record: () => undefined });
    for (const { runId, scenario: scenarioId, capture } of inputs) {
      if (o.maxUsd !== undefined && spent >= o.maxUsd) {
        o.progress?.("--max-usd reached; stopping");
        break;
      }
      const scenario = o.scenarios.find((entry) => entry.id === scenarioId);
      const row: ResummariseRow = { model: routeId(model), summaryId: capture.id, runId, kind: capture.kind, inputChars: capture.inputChars, outputChars: 0 };
      try {
        const before = ledger.lines.length;
        const result = await client.call({
          route: { providerId: model.providerId, modelId: model.modelId },
          system: capture.input.system!,
          messages: capture.input.messages as never,
          ...(capture.input.tools ? { tools: capture.input.tools as never } : {}),
          ...(model.effort ? { effort: model.effort } : {}),
          timeoutMs: 180_000,
          attribution: { purpose: "compaction" }
        });
        const text = result.text.trim();
        row.outputChars = text.length;
        row.usd = ledger.lines.slice(before).reduce((total, line) => total + (line.costUsd ?? 0), 0);
        spent += row.usd;
        if (scenario) {
          const due = scenario.facts.filter((fact) => capture.facts && [...capture.facts.kept, ...capture.facts.missing].includes(fact.id));
          row.facts = factsFound(due, text);
        }
        const packetId = `rs-${Math.random().toString(16).slice(2, 12)}`;
        if (scenario) {
          const { packet } = packetsForRun({ scenario, summary: { runId, variant: "baseline" } as RunSummary, events: [], summaries: [{ ...capture, output: text }] }).find((entry) => entry.packet.kind === "summary") ?? {};
          if (packet) {
            await writeJson(path.join(o.outDir, "judge", "packets", `${packetId}.json`), { ...packet, packet: packetId });
            index[packetId] = { runId: `resummarise:${routeId(model)}:${runId}:${capture.id}`, kind: "summary", summaryId: capture.id, criteria: Object.keys(packet.rubric) };
          }
        }
        await writeJson(path.join(o.outDir, "resummarise", routeId(model).replace(/[/#.]/gu, "_"), `${runId}__${capture.id}.json`), { model: routeId(model), runId, summaryId: capture.id, kind: capture.kind, output: text, facts: row.facts });
      } catch (error) {
        const kind = (error as { kind?: unknown } | null)?.kind;
        row.error = typeof kind === "string" ? kind : "failed";
      }
      rows.push(row);
      o.progress?.(`${routeId(model)} ${runId} ${capture.id}: ${row.error ?? `${row.outputChars} chars`}`);
    }
  }
  await writeJson(path.join(o.outDir, "judge", "index.json"), index);
  summary.resummarise = [...(summary.resummarise ?? []).filter((row) => !o.models.some((model) => routeId(model) === row.model)), ...rows];
  await writeSummaryAndReport(o.outDir, summary);
  return rows;
}
