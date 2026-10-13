import { RUBRICS, type BenchmarkCase, type DecisionRubrics, type QuestionName } from "./cases.js";

export const QUESTION_NAMES = Object.keys(RUBRICS) as QuestionName[];
export type Answer = { choice: string; probabilities?: Record<string, number> };
export type Answers = Record<QuestionName, Answer>;
export type Result = {
  caseId: string; group: string; run: number; latencyMs: number;
  answers?: Answers; error?: string; inputTokens?: number; outputTokens?: number;
  billedUsd?: number; estimatedUsd?: number; truncated?: boolean; cachedInputTokens?: number;
};

export function isPredicateOnlyTarget(target: string): boolean {
  // Respan's API rejects choice questions; do not emulate them with yes/no ranks.
  return /^openrouter:respan\/span-/.test(target);
}

export function selectBenchmarkTargets(
  controls: string[],
  catalog: { id: string; architecture?: { input_modalities?: string[]; output_modalities?: string[] } }[],
  includeOpenRouter: boolean
): string[] {
  const discovered = includeOpenRouter ? catalog
    .filter((m) => m.id && m.architecture?.output_modalities?.includes("decisions") && m.architecture?.input_modalities?.includes("text"))
    .map((m) => `openrouter:${m.id}`).sort() : [];
  return [...new Set([...controls, ...discovered])].filter((target) => !isPredicateOnlyTarget(target));
}

export function requestBody(model: string, sample: BenchmarkCase, openai = false): object {
  const rubrics = sample.rubrics ?? RUBRICS;
  if (openai) return {
    model, input: sample.state,
    questions: QUESTION_NAMES.map((name) => ({
      name, type: "choice", instructions: rubrics[name].instructions,
      choices: Object.entries(rubrics[name].criteria).map(([value, description]) => ({ value, description }))
    }))
  };
  return { model, state: sample.state, questions: Object.fromEntries(QUESTION_NAMES.map((name) => [name, { type: "choice", ...rubrics[name] }])) };
}

export function parseAnswers(payload: unknown, openai = false, chat = false, rubrics: DecisionRubrics = RUBRICS): Answers {
  if (!payload || typeof payload !== "object") throw new Error("invalid_response");
  const source = (payload as { answers?: unknown }).answers;
  const out = {} as Answers;
  for (const name of QUESTION_NAMES) {
    let raw: unknown;
    if (openai) {
      if (!Array.isArray(source) || source.filter((v) => v?.name === name).length !== 1) throw new Error("missing_or_duplicate_answer");
      raw = source.find((v) => v?.name === name);
    } else raw = (source as Record<string, unknown> | undefined)?.[name];
    if (!raw || typeof raw !== "object") throw new Error("missing_answer");
    const a = raw as { type?: string; choice?: unknown; probabilities?: unknown };
    if (a.type === "refusal") throw new Error("refusal");
    if (a.type !== "choice" || typeof a.choice !== "string" || !Object.hasOwn(rubrics[name].criteria, a.choice)) throw new Error("invalid_choice");
    if (chat) { out[name] = { choice: a.choice }; continue; }
    let probabilities: Record<string, number>;
    if (openai) {
      if (!Array.isArray(a.probabilities)) throw new Error("invalid_probabilities");
      const rows = a.probabilities as { value: string; probability: number }[];
      if (new Set(rows.map((v) => v.value)).size !== rows.length) throw new Error("duplicate_probability");
      probabilities = Object.fromEntries(rows.map((v) => [v.value, v.probability]));
    } else probabilities = a.probabilities as Record<string, number>;
    const allowed = Object.keys(rubrics[name].criteria);
    if (!probabilities || Object.keys(probabilities).length !== allowed.length
      || !allowed.every((key) => Object.hasOwn(probabilities, key) && Number.isFinite(probabilities[key]) && probabilities[key] >= 0 && probabilities[key] <= 1)
      || Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.015) throw new Error("invalid_probabilities");
    if (probabilities[a.choice] + 1e-5 < Math.max(...Object.values(probabilities))) throw new Error("choice_not_argmax");
    out[name] = { choice: a.choice, probabilities };
  }
  return out;
}

export function estimateTokenCost(
  usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  pricing: { inputPerMTok?: number | null; outputPerMTok?: number | null; cachedInputPerMTok?: number | null }
): number | undefined {
  const { inputTokens, outputTokens, cachedInputTokens = 0 } = usage;
  const { inputPerMTok, outputPerMTok } = pricing;
  const cachedInputPerMTok = pricing.cachedInputPerMTok ?? inputPerMTok;
  if (![inputTokens, outputTokens, cachedInputTokens, inputPerMTok, outputPerMTok, cachedInputPerMTok]
    .every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    || cachedInputTokens > inputTokens!) return undefined;
  return ((inputTokens! - cachedInputTokens) * inputPerMTok! + cachedInputTokens * cachedInputPerMTok! + outputTokens! * outputPerMTok!) / 1_000_000;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
export function summarize(results: Result[], cases: BenchmarkCase[]) {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const passes = (r: Result) => {
    if (!r.answers) return false;
    const sample = byId.get(r.caseId)!;
    return sample.acceptableTuples ? sample.acceptableTuples.some((tuple) => QUESTION_NAMES.every((q) => tuple[q] === r.answers![q].choice))
      : QUESTION_NAMES.every((q) => sample.expected[q].includes(r.answers![q].choice));
  };
  const successful = results.filter((r) => r.answers);
  const judgments = successful.flatMap((r) => QUESTION_NAMES.map((name) => {
    const expected = byId.get(r.caseId)!.expected[name];
    const answer = r.answers![name];
    return { name, correct: expected.includes(answer.choice), expected, ...answer };
  }));
  const calibrated = judgments.filter((j) => j.probabilities && j.expected.length === 1);
  const selected = calibrated.filter((j) => j.probabilities![j.choice] >= 0.8);
  let ece = 0;
  for (let bin = 0; bin < 10; bin++) {
    const rows = calibrated.filter((j) => Math.min(9, Math.floor(j.probabilities![j.choice] * 10)) === bin);
    if (rows.length) ece += rows.length / calibrated.length * Math.abs(
      rows.filter((j) => j.correct).length / rows.length - rows.reduce((s, j) => s + j.probabilities![j.choice], 0) / rows.length);
  }
  const contradictions = successful.filter((r) => (r.answers!.next.choice === "nobody") !== (r.answers!.pause.choice !== "now")).length;
  const comparableBrier = calibrated.filter((j) => j.name === "next");
  const sumKnown = (field: "billedUsd" | "estimatedUsd") => results.some((r) => r[field] !== undefined)
    ? results.reduce((s, r) => s + (r[field] ?? 0), 0) : null;
  return {
    requests: results.length, succeeded: successful.length, failures: results.length - successful.length,
    // Failed requests are incorrect in the headline, not silently removed.
    accuracyIncludingFailures: results.length ? judgments.filter((j) => j.correct).length / (results.length * QUESTION_NAMES.length) : null,
    exactCaseAccuracy: results.length ? successful.filter(passes).length / results.length : null,
    perQuestion: Object.fromEntries(QUESTION_NAMES.map((q) => [q, results.length ? judgments.filter((j) => j.name === q && j.correct).length / results.length : null])),
    p50Ms: percentile(successful.map((r) => r.latencyMs), 0.5), p95Ms: percentile(successful.map((r) => r.latencyMs), 0.95),
    nextBrier: comparableBrier.length ? comparableBrier.reduce((s, j) => s + Object.entries(j.probabilities!).reduce((b, [v, p]) => b + (p - Number(v === j.expected[0])) ** 2, 0), 0) / comparableBrier.length : null,
    ece: calibrated.length ? ece : null,
    coverageAtPoint8: calibrated.length ? selected.length / calibrated.length : null,
    accuracyAtPoint8: selected.length ? selected.filter((j) => j.correct).length / selected.length : null,
    contradictoryCases: contradictions, truncatedRequests: results.filter((r) => r.truncated).length,
    billedUsd: sumKnown("billedUsd"), estimatedUsd: sumKnown("estimatedUsd"),
    costCoverage: results.filter((r) => r.billedUsd !== undefined || r.estimatedUsd !== undefined).length,
    byGroup: Object.fromEntries([...new Set(cases.map((c) => c.group))].map((group) => {
      const rows = results.filter((r) => r.group === group);
      return [group, rows.length ? rows.filter(passes).length / rows.length : null];
    }))
  };
}
