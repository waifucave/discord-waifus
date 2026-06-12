#!/usr/bin/env node
// eval-report.mjs — run tier-2 orchestrator eval across models and print a comparison table.
//
// Usage:
//   node scripts/eval-report.mjs --models gemini-3.1-flash-lite,claude-haiku-4-5-20251001
//
// API keys:
//   WAIFUS_EVAL_API_KEY           used for all models (default)
//   WAIFUS_EVAL_API_KEY_GOOGLE    override for Google models
//   WAIFUS_EVAL_API_KEY_ANTHROPIC override for Anthropic models
//   WAIFUS_EVAL_API_KEY_OPENAI    override for OpenAI models
//   WAIFUS_EVAL_API_KEY_DEEPSEEK  override for DeepSeek models
//
// Other env vars:
//   WAIFUS_EVAL_RUNS   number of runs per scenario (default: 1)

import { execSync } from "node:child_process";
import process from "node:process";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const modelsFlag = args.find((a) => a.startsWith("--models="))?.slice("--models=".length) ??
  args[args.indexOf("--models") + 1];

if (!modelsFlag) {
  console.error("Usage: node scripts/eval-report.mjs --models <model1,model2,...>");
  process.exit(1);
}

const models = modelsFlag.split(",").map((m) => m.trim()).filter(Boolean);
if (models.length === 0) {
  console.error("No models specified.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function inferProvider(modelId) {
  if (modelId.startsWith("gemini")) return "GOOGLE";
  if (modelId.startsWith("claude")) return "ANTHROPIC";
  if (modelId.startsWith("gpt") || modelId.startsWith("o1") || modelId.startsWith("o3")) return "OPENAI";
  if (modelId.startsWith("deepseek")) return "DEEPSEEK";
  return "GOOGLE";
}

function apiKeyFor(modelId) {
  const provider = inferProvider(modelId);
  return (
    process.env[`WAIFUS_EVAL_API_KEY_${provider}`] ??
    process.env["WAIFUS_EVAL_API_KEY"]
  );
}

// ---------------------------------------------------------------------------
// Summary line extraction
// ---------------------------------------------------------------------------

const SUMMARY_PATTERN = /=== Orchestrator Eval Summary[\s\S]*?={10,}/;

function extractSummary(output) {
  const match = output.match(SUMMARY_PATTERN);
  return match ? match[0] : "(no summary found)";
}

// ---------------------------------------------------------------------------
// Run eval for a single model
// ---------------------------------------------------------------------------

function runModel(modelId) {
  const key = apiKeyFor(modelId);
  if (!key) {
    return { modelId, error: `Missing API key for ${modelId} (set WAIFUS_EVAL_API_KEY or WAIFUS_EVAL_API_KEY_${inferProvider(modelId)})` };
  }

  const env = {
    ...process.env,
    WAIFUS_EVAL_LIVE: "1",
    WAIFUS_EVAL_MODEL: modelId,
    WAIFUS_EVAL_API_KEY: key
  };

  const runs = process.env["WAIFUS_EVAL_RUNS"] ?? "1";
  if (runs !== "1") env["WAIFUS_EVAL_RUNS"] = runs;

  console.log(`\n▶ Running eval for model: ${modelId} (${runs} run(s) per scenario)...`);

  try {
    const output = execSync(
      "npx vitest run tests/eval/orchestrator.eval.test.ts --reporter=verbose",
      { env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return { modelId, output, summary: extractSummary(output) };
  } catch (err) {
    const output = (err.stdout ?? "") + (err.stderr ?? "");
    return { modelId, output, summary: extractSummary(output), error: `Exit code ${err.status}` };
  }
}

// ---------------------------------------------------------------------------
// Table printing
// ---------------------------------------------------------------------------

function printTable(results) {
  const SEP = "─".repeat(80);
  console.log(`\n${"═".repeat(80)}`);
  console.log("EVAL REPORT — SIDE BY SIDE");
  console.log(`${"═".repeat(80)}`);

  for (const result of results) {
    console.log(`\n${SEP}`);
    console.log(`Model: ${result.modelId}${result.error ? ` [ERROR: ${result.error}]` : ""}`);
    console.log(SEP);
    if (result.summary) {
      console.log(result.summary);
    } else {
      console.log("(no summary extracted)");
    }
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log("END OF REPORT");
  console.log(`${"═".repeat(80)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const results = models.map((modelId) => runModel(modelId));
printTable(results);

const anyFailed = results.some((r) => r.error);
process.exit(anyFailed ? 1 : 0);
