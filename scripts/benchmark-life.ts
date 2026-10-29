// The life benchmark (Living cast spec §33): runs one waifu's real life in a fake server on a
// simulated clock, per scenario × model × prompt variant, and reports. A developer tool, not part of
// the npm package. See scripts/life-benchmark/README.md.
//
//   npm run bench:life -- [run] [--scenarios=…] [--models=…] [--variants=…] [--repeat=N]
//                         [--concurrency=N] [--max-usd=X] [--web] [--dry-run] [--yes] [--out=DIR]
//   npm run bench:life -- merge-grades --out=DIR
//   npm run bench:life -- repack --out=DIR
//   npm run bench:life -- resummarise --out=DIR --models=… [--max-usd=X] [--dry-run] [--yes]
//   npm run bench:life -- list
//
// Provider keys are read from the data root (DC_WAIFUS_HOME or ~/.dc-waifus, or --data-root) only
// for a live run after --yes, and are never printed, logged or written into results.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDataRoot } from "../src/config/paths.js";
import { createProviderCredentialsLookup } from "../src/models/credentials.js";
import { curatedCatalog } from "../src/models/catalog.js";
import { mergeGradesInto, planEstimate, readSummary, repackSummaries, replayableSummaries, resummariseEstimate, resummariseInto, runBenchmark, selectModels } from "./life-benchmark/bench.js";
import { SCENARIOS, selectScenarios } from "./life-benchmark/scenarios/index.js";
import { BUILT_IN_VARIANTS, checkVariants, loadVariants } from "./life-benchmark/variants.js";
import { routeId } from "./life-benchmark/world.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "run";
const flags = new Set(args.filter((arg) => arg.startsWith("--") && !arg.includes("=")));
const value = (key: string, fallback: string) => args.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const KNOWN_FLAGS = new Set(["--web", "--dry-run", "--yes", "--help"]);
const KNOWN_VALUES = new Set(["scenarios", "models", "variants", "repeat", "concurrency", "max-usd", "out", "data-root", "gate-first-try", "gate-probes"]);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function int(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value(key, String(fallback)));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--${key} must be an integer from ${min} to ${max}`);
  return parsed;
}

function ratio(key: string, fallback: number): number {
  const parsed = Number(value(key, String(fallback)));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`--${key} must be from 0 to 1`);
  return parsed;
}

function maxUsd(): number | undefined {
  const raw = value("max-usd", "");
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--max-usd must be a positive number");
  return parsed;
}

function defaultOut(): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  return path.join(repoRoot, "bench-results", `life-${stamp}`);
}

function help(): void {
  console.log(`Life benchmark (spec §33). Commands: run (default), merge-grades, repack, resummarise, list.
  --scenarios=default|all|id,id    (default: ${SCENARIOS.filter((s) => s.id !== "tiny").map((s) => s.id).join(", ")})
  --models=families|all|route[#effort],…   (default families: one route per curated family with a key; contributor routes only when named)
  --variants=baseline,brief,./file.json    (built-ins: ${BUILT_IN_VARIANTS.map((v) => v.id).join(", ")})
  --repeat=N  --concurrency=N  --max-usd=X  --web  --dry-run  --yes  --out=DIR  --data-root=PATH
  --gate-first-try=0.8  --gate-probes=0.6  (runs past both get judge packets)`);
}

function checkFlags(): void {
  for (const arg of args.slice(command === args[0] ? 1 : 0)) {
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    if (arg.includes("=")) {
      if (!KNOWN_VALUES.has(arg.slice(2, arg.indexOf("=")))) throw new Error(`Unknown option ${arg.slice(0, arg.indexOf("="))}`);
    } else if (!KNOWN_FLAGS.has(arg)) throw new Error(`Unknown flag ${arg}`);
  }
}

async function run(): Promise<void> {
  const dryRun = flags.has("--dry-run");
  const web = flags.has("--web");
  if (dryRun && web) throw new Error("--web needs a live run (a dry run never touches the network)");
  const scenarios = selectScenarios(value("scenarios", "default"));
  const variants = await loadVariants(value("variants", "baseline"));
  const repeat = int("repeat", 1, 1, 20);
  const concurrency = int("concurrency", 2, 1, 8);
  const cap = maxUsd();
  const gate = { minFirstTry: ratio("gate-first-try", 0.8), minProbes: ratio("gate-probes", 0.6) };
  const dataRoot = path.resolve(value("data-root", getDataRoot()));
  // Key presence only decides which routes the default selection offers; the keys stay in the lookup.
  const credentials = dryRun ? undefined : createProviderCredentialsLookup(dataRoot);
  const models = selectModels(value("models", "families"), { dryRun, ...(credentials ? { credentials } : {}) });
  if (models.length === 0) throw new Error("No model selected (no provider key for any curated family in the data root?). Name routes with --models=…");
  if (!dryRun) {
    const missing = models.filter((model) => !credentials!(model.providerId));
    if (missing.length > 0) throw new Error(`No key in the data root for: ${missing.map(routeId).join(", ")}`);
  }
  // Every variant edit is tried on the shipped texts first: a broken one stops here, before the plan.
  checkVariants(variants, scenarios, { model: models[0]!, web });
  const estimate = planEstimate({ scenarios, models, variants, repeat, concurrency });
  console.log(`${scenarios.length} scenario(s) × ${models.length} model(s) × ${variants.length} variant(s) × ${repeat} = ${scenarios.length * models.length * variants.length * repeat} run(s)${dryRun ? " (dry run: scripted fake model, no network; its dollars are the fake usage at list prices)" : ""}`);
  console.log(`Models: ${models.map(routeId).join(", ")}`);
  console.log(`Web: ${web ? "ON (Exa search and page fetches cost money)" : "off"}${cap !== undefined ? `; stops new turns at $${cap}` : ""}`);
  console.log(estimate.text);
  if (!dryRun && !flags.has("--yes")) {
    console.log("\nNothing was run. Add --yes to make these model calls.");
    process.exitCode = 2;
    return;
  }
  const outDir = path.resolve(value("out", defaultOut()));
  console.log(`Results: ${outDir}`);
  const summary = await runBenchmark({ scenarios, models, variants, repeat, concurrency, ...(cap !== undefined ? { maxUsd: cap } : {}), web, dryRun, outDir, ...(credentials ? { credentials } : {}), gate, progress: (line) => console.log(line) });
  const spent = summary.runs.reduce((total, entry) => total + entry.metrics.usd, 0);
  const packets = summary.runs.reduce((total, entry) => total + (entry.packets?.length ?? 0), 0);
  console.log(`\nDone: ${summary.runs.length} run(s), $${spent.toFixed(4)} spent, ${packets} judge packet(s) in ${path.join(outDir, "judge", "packets")}.`);
  console.log(`Report: ${path.join(outDir, "report.md")}`);
}

async function resummarise(): Promise<void> {
  const out = value("out", "");
  if (!out) throw new Error("resummarise needs --out=<a results folder>");
  const outDir = path.resolve(out);
  const dryRun = flags.has("--dry-run");
  const summary = await readSummary(outDir);
  const dataRoot = path.resolve(value("data-root", getDataRoot()));
  const credentials = dryRun ? undefined : createProviderCredentialsLookup(dataRoot);
  const models = selectModels(value("models", "families"), { dryRun, ...(credentials ? { credentials } : {}) });
  const inputs = await replayableSummaries(outDir);
  console.log(`${inputs.length} saved summary input(s) from ${summary.runs.length} run(s); models: ${models.map(routeId).join(", ")}`);
  const estimate = resummariseEstimate(inputs, models);
  console.log(estimate.text);
  if (!dryRun && !flags.has("--yes")) {
    console.log("\nNothing was run. Add --yes to make these model calls.");
    process.exitCode = 2;
    return;
  }
  const cap = maxUsd();
  const rows = await resummariseInto({ outDir, models, scenarios: [...SCENARIOS], dryRun, ...(credentials ? { credentials } : {}), ...(cap !== undefined ? { maxUsd: cap } : {}), progress: (line) => console.log(line) });
  console.log(`Done: ${rows.length} summaries. Report: ${path.join(outDir, "report.md")}`);
}

async function mergeGrades(): Promise<void> {
  const out = value("out", "");
  if (!out) throw new Error("merge-grades needs --out=<a results folder>");
  const result = await mergeGradesInto(path.resolve(out));
  console.log(`Merged ${result.grades} grade(s) into ${result.runs} run(s).`);
  if (result.unknown.length > 0) console.log(`Unknown packets: ${result.unknown.join(", ")}`);
  for (const problem of result.problems) console.log(`Problem: ${problem}`);
  console.log(`Report: ${path.join(path.resolve(out), "report.md")}`);
}

async function repack(): Promise<void> {
  const out = value("out", "");
  if (!out) throw new Error("repack needs --out=<a results folder>");
  const ids = await repackSummaries({ outDir: path.resolve(out), scenarios: [...SCENARIOS] });
  console.log(`Rebuilt ${ids.length} summary packet(s) in place. Grades written for them before are now stale: move them out of grades/ and grade again.`);
}

function list(): void {
  console.log("Scenarios:");
  for (const scenario of SCENARIOS) console.log(`  ${scenario.id.padEnd(14)} ${scenario.title} (${scenario.events.length} events, ${scenario.probes.length} probes)`);
  console.log("Variants:");
  for (const variant of BUILT_IN_VARIANTS) console.log(`  ${variant.id.padEnd(14)} ${variant.description}`);
  const dataRoot = path.resolve(value("data-root", getDataRoot()));
  const credentials = createProviderCredentialsLookup(dataRoot);
  console.log("Curated routes (key present in the data root?):");
  for (const model of curatedCatalog().models) console.log(`  ${model.id.padEnd(42)} ${credentials(model.providerId) ? "key" : "no key"}${model.contributor ? "  (contributor: trains on prompts; only when named)" : ""}`);
}

async function main(): Promise<void> {
  if (flags.has("--help")) {
    help();
    return;
  }
  checkFlags();
  if (command === "run") await run();
  else if (command === "merge-grades") await mergeGrades();
  else if (command === "repack") await repack();
  else if (command === "resummarise") await resummarise();
  else if (command === "list") list();
  else throw new Error(`Unknown command ${command}`);
}

main()
  .catch((error: unknown) => {
    // Our own messages only; a provider error never reaches here with its body (runs record kinds).
    console.error(`bench:life: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  // Sandbox workers and timers of the app stay alive after a run; the benchmark is done.
  .finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50));
