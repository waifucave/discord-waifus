import { describe, expect, it } from "vitest";
import { CASES, RUBRICS } from "../scripts/decision-benchmark/cases.js";
import { estimateTokenCost, parseAnswers, requestBody, selectBenchmarkTargets, summarize, type Answers, type Result } from "../scripts/decision-benchmark/core.js";

const perfect = (): Answers => Object.fromEntries(Object.entries(RUBRICS).map(([name, rubric]) => {
  const chosen = CASES[0].expected[name as keyof typeof RUBRICS][0];
  return [name, { choice: chosen, probabilities: Object.fromEntries(Object.keys(rubric.criteria).map((key) => [key, Number(key === chosen)])) }];
})) as Answers;
const systemOne = () => ({ answers: Object.fromEntries(Object.entries(perfect()).map(([k, v]) => [k, { type: "choice", ...v }])) });

describe("decision benchmark measurement", () => {
  it("excludes yes/no-only models even when explicitly requested", () => {
    const catalog = [{ id: "respan/span-01", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] } }];
    expect(selectBenchmarkTargets(["openai:gpt-6-luna", "openrouter:respan/span-01-lite:free"], catalog, true)).toEqual(["openai:gpt-6-luna"]);
  });
  it("discovers new decision models without admitting chat-only or image-only targets", () => {
    const catalog = [
      { id: "new/decider", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] } },
      { id: "new/chat", architecture: { input_modalities: ["text"], output_modalities: ["text"] } },
      { id: "new/vision", architecture: { input_modalities: ["image"], output_modalities: ["decisions"] } }
    ];
    expect(selectBenchmarkTargets(["openai:gpt-6-luna"], catalog, true)).toEqual(["openai:gpt-6-luna", "openrouter:new/decider"]);
    expect(selectBenchmarkTargets(["openrouter:new/decider"], catalog, true)).toEqual(["openrouter:new/decider"]);
    expect(selectBenchmarkTargets(["openai:gpt-6-luna"], catalog, false)).toEqual(["openai:gpt-6-luna"]);
  });
  it("keeps labels and case identifiers out of both provider request formats", () => {
    for (const openai of [false, true]) {
      const body = JSON.stringify(requestBody("model", CASES[0], openai));
      expect(body).not.toContain('"expected"');
      expect(body).not.toContain(CASES[0].id);
    }
  });
  it("uses OpenAI's choice array contract and System One's question map", () => {
    expect(requestBody("m", CASES[0], true)).toMatchObject({ input: CASES[0].state, questions: expect.arrayContaining([expect.objectContaining({ name: "next", choices: expect.any(Array) })]) });
    expect(requestBody("m", CASES[0])).toMatchObject({ state: CASES[0].state, questions: { next: { type: "choice", criteria: RUBRICS.next.criteria } } });
  });
  it("accepts valid probability maps and OpenAI typed probability arrays", () => {
    expect(parseAnswers(systemOne())).toEqual(perfect());
    const answers = Object.entries(perfect()).map(([name, a]) => ({ name, type: "choice", choice: a.choice, probabilities: Object.entries(a.probabilities!).map(([value, probability]) => ({ value, probability })) }));
    expect(parseAnswers({ answers }, true)).toEqual(perfect());
    expect(() => parseAnswers({ answers: [...answers, answers[0]] }, true)).toThrow("duplicate");
  });
  it("rejects unknown choices, refusals, missing probabilities and inconsistent argmax", () => {
    const invalid = systemOne();
    invalid.answers.next.choice = "unknown";
    expect(() => parseAnswers(invalid)).toThrow("invalid_choice");
    expect(() => parseAnswers({ answers: { ...systemOne().answers, next: { type: "refusal" } } })).toThrow("refusal");
    expect(() => parseAnswers({ answers: { ...systemOne().answers, next: { type: "choice", choice: "yuki" } } })).toThrow("invalid_probabilities");
    const contradicted = systemOne();
    contradicted.answers.next.choice = "mika";
    expect(() => parseAnswers(contradicted)).toThrow("choice_not_argmax");
  });
  it("counts errors as incorrect and excludes them from successful latency", () => {
    const rows: Result[] = [
      { caseId: CASES[0].id, group: CASES[0].group, run: 0, latencyMs: 100, answers: perfect() },
      { caseId: CASES[0].id, group: CASES[0].group, run: 1, latencyMs: 60000, error: "http_500" }
    ];
    expect(summarize(rows, CASES)).toMatchObject({ requests: 2, failures: 1, accuracyIncludingFailures: 0.5, exactCaseAccuracy: 0.5, p95Ms: 100, nextBrier: 0, billedUsd: null, estimatedUsd: null });
  });
  it("does not manufacture probabilities for the chat control or overclaim zero cost", () => {
    const payload = { answers: Object.fromEntries(Object.entries(perfect()).map(([k, v]) => [k, { type: "choice", choice: v.choice }])) };
    const answers = parseAnswers(payload, false, true);
    expect(summarize([{ caseId: CASES[0].id, group: "addressed", run: 0, latencyMs: 1, answers }], CASES)).toMatchObject({ nextBrier: null, ece: null, costCoverage: 0 });
  });
  it("accepts labelled ambiguous choices but excludes them from calibration targets", () => {
    const sample = CASES.find((c) => c.id === "ambiguous-invite")!;
    expect(sample.expected.next).toEqual(["yuki", "mika", "riko"]);
    const result = summarize([{ caseId: sample.id, group: sample.group, run: 0, latencyMs: 5, answers: perfect() }], CASES);
    expect(result.exactCaseAccuracy).toBe(1);
    expect(result.nextBrier).toBeNull();
  });
  it("validates all synthetic labels against the frozen option sets", () => {
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
    for (const sample of CASES) for (const name of Object.keys(RUBRICS) as (keyof typeof RUBRICS)[])
      for (const label of sample.expected[name]) expect(Object.hasOwn(RUBRICS[name].criteria, label)).toBe(true);
  });
  it("uses per-million prices and cached discounts without inventing missing cost", () => {
    expect(estimateTokenCost({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 500 }, { inputPerMTok: 1.25, outputPerMTok: 2.5, cachedInputPerMTok: 0.2 })).toBeCloseTo(0.000975);
    expect(estimateTokenCost({ inputTokens: 1000 }, { inputPerMTok: 1.25 })).toBeUndefined();
    expect(estimateTokenCost({ inputTokens: 1, outputTokens: 1, cachedInputTokens: 5 }, { inputPerMTok: 1, outputPerMTok: 1 })).toBeUndefined();
  });
});
