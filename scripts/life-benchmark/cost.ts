// The cost estimate printed before any model call (spec §33.2). Rough on purpose and stated with its
// assumptions: turns from the scenario's timeline (what wakes her, a rest and a dream a day), calls
// per turn, prompt and output sizes, and each route's list prices from winter's catalog with its
// cache-read price when it caches prompts.

import type { CuratedModel } from "../../src/models/catalog.js";
import { defaultPick } from "./detector.js";
import { scenarioStartMs, scenarioTimeMs, type Scenario } from "./scenario.js";

export const ESTIMATE_ASSUMPTIONS = {
  callsPerTurn: 2.5,
  /** System blocks + tool definitions, tokens. */
  basePromptTokens: 9_000,
  /** Her log grows through an epoch; this is its average weight per call. */
  averageLogTokens: 7_000,
  outputTokensPerCall: 350,
  /** Extra output when the route reasons (an effort is set or defaulted). */
  reasoningTokensPerCall: 600,
  /** With prompt caching: share of the prompt read from cache, and written to it. */
  cacheReadShare: 0.8,
  cacheWriteShare: 0.1,
  /** Per simulated day: one compaction or rest summary, one dream of a few calls. */
  summaryInputTokens: 30_000,
  summaryOutputTokens: 1_200,
  dreamCallsPerNight: 4,
  dreamInputTokens: 12_000,
  /** Real seconds per model call (typing-speed models; reasoning ones are slower). */
  secondsPerCall: 7
};

/** How many turns the timeline should cause: messages that reach her, plus her days. */
export function expectedTurns(scenario: Scenario): { turns: number; days: number } {
  const days = Math.max(1, Math.ceil((scenarioTimeMs(scenario, scenario.end) - scenarioStartMs(scenario)) / 86_400_000));
  let wakers = 0;
  let lastPlace = "";
  let lastMs = -Infinity;
  for (const event of scenario.events) {
    if (event.kind !== "message") continue;
    const at = scenarioTimeMs(scenario, event.at);
    const forHer = event.place.startsWith("dm:") || event.mentions.includes("her") || event.everyone || event.replyTo?.startsWith("her:") || new RegExp(`\\b${scenario.waifu.name}\\b`, "iu").test(event.text) || ["her", "anyone", "all", "chime"].includes(defaultPick(event));
    if (!forHer) continue;
    // Messages a few minutes apart in one place fold into one turn.
    if (event.place === lastPlace && at - lastMs < 3 * 60_000) continue;
    wakers += 1;
    lastPlace = event.place;
    lastMs = at;
  }
  // Her own wakeups (about two a day; until §38 also her morning).
  return { turns: wakers + days * 2, days };
}

export type RunEstimate = { model: string; runs: number; callsPerRun: number; usdPerRun: number; usd: number; minutesPerRun: number; priced: boolean };

export function estimateRun(scenario: Scenario, model: CuratedModel, effort: string | undefined): { calls: number; usd: number; minutes: number; priced: boolean } {
  const a = ESTIMATE_ASSUMPTIONS;
  const { turns, days } = expectedTurns(scenario);
  const lifeCalls = turns * a.callsPerTurn;
  const maxContext = Number((scenario.config as { life?: { maxContextTokens?: unknown } }).life?.maxContextTokens ?? 96_000);
  const prompt = Math.min(a.basePromptTokens + a.averageLogTokens, maxContext * 0.6);
  const reasoning = effort ?? model.defaultEffort;
  const output = a.outputTokensPerCall + (reasoning && reasoning !== "none" && reasoning !== "minimal" ? a.reasoningTokensPerCall : 0);
  const p = model.pricing;
  if (!p) return { calls: lifeCalls, usd: 0, minutes: (lifeCalls * a.secondsPerCall) / 60, priced: false };
  const perM = (tokens: number, price: number | undefined) => (tokens * (price ?? 0)) / 1_000_000;
  const promptCost = (tokens: number) =>
    model.promptCaching
      ? perM(tokens * a.cacheReadShare, p.cacheReadPerMTokUsd ?? p.inputPerMTokUsd) + perM(tokens * a.cacheWriteShare, p.cacheWritePerMTokUsd ?? p.inputPerMTokUsd) + perM(tokens * (1 - a.cacheReadShare - a.cacheWriteShare), p.inputPerMTokUsd)
      : perM(tokens, p.inputPerMTokUsd);
  const life = lifeCalls * (promptCost(prompt) + perM(output, p.outputPerMTokUsd));
  const summaries = days * (promptCost(a.summaryInputTokens) + perM(a.summaryOutputTokens, p.outputPerMTokUsd));
  const dreams = days * a.dreamCallsPerNight * (perM(a.dreamInputTokens, p.inputPerMTokUsd) + perM(output, p.outputPerMTokUsd));
  const calls = lifeCalls + days * (1 + a.dreamCallsPerNight);
  return { calls: Math.round(calls), usd: life + summaries + dreams, minutes: (calls * a.secondsPerCall) / 60, priced: true };
}

/** The table printed before a run (and saved as plan.json). */
export function estimateText(rows: Array<{ model: string; scenario: string; runs: number; calls: number; usd: number; minutes: number; priced: boolean }>, concurrency: number): { text: string; totalUsd: number; totalMinutes: number } {
  const totalUsd = rows.reduce((sum, row) => sum + row.usd * row.runs, 0);
  const runMinutes = rows.reduce((sum, row) => sum + row.minutes * row.runs, 0);
  const totalMinutes = runMinutes / Math.max(1, concurrency);
  const lines = [
    "Estimate (rough; see ESTIMATE_ASSUMPTIONS in scripts/life-benchmark/cost.ts):",
    "  model                                      scenario        runs  calls/run  $/run     $ total",
    ...rows.map((row) => `  ${row.model.padEnd(42)} ${row.scenario.padEnd(15)} ${String(row.runs).padStart(4)}  ${String(row.calls).padStart(9)}  ${row.priced ? `$${row.usd.toFixed(3)}`.padEnd(8) : "unpriced"}  $${(row.usd * row.runs).toFixed(3)}`),
    `  total ≈ $${totalUsd.toFixed(2)} and ≈ ${Math.round(totalMinutes)} min wall time at concurrency ${concurrency} (${Math.round(runMinutes)} min of model time).`
  ];
  return { text: lines.join("\n"), totalUsd, totalMinutes };
}

/** Replaying saved summary inputs through a model: their own sizes, one call each. */
export function estimateResummarise(inputs: Array<{ inputChars: number }>, model: CuratedModel): { usd: number; priced: boolean } {
  const p = model.pricing;
  if (!p) return { usd: 0, priced: false };
  const usd = inputs.reduce((sum, input) => sum + ((input.inputChars / 3.5 + 5_000) * p.inputPerMTokUsd + ESTIMATE_ASSUMPTIONS.summaryOutputTokens * p.outputPerMTokUsd) / 1_000_000, 0);
  return { usd, priced: true };
}
