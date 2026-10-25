// The addressee benchmark suite (Living cast spec §4.3, §12), offline: the cases, the production
// question and request, the production detector over a fake decisions endpoint, and the scores.
import { describe, expect, it } from "vitest";
import { ADDRESSEE_CASES, addresseeQuestion, expectedChoices, summarizeAddressee, type AddresseeResult } from "../scripts/decision-benchmark/addressee.js";
import { AddresseeDetector } from "../src/life/detector/decider.js";
import { decisionRequest } from "../src/life/detector/protocol.js";
import type { UsageLedgerLine } from "../src/orchestration/usageLedger.js";

const GROUPS = ["addressed_by_name", "reply_to_waifu", "human_to_human", "open_question", "whole_cast", "follow_up", "link_dump", "multilingual", "ambiguous"];

describe("addressee cases", () => {
  it("cover the spec's groups with unique ids and labels every target can answer", () => {
    expect(new Set(ADDRESSEE_CASES.map((sample) => sample.group))).toEqual(new Set(GROUPS));
    expect(new Set(ADDRESSEE_CASES.map((sample) => sample.id)).size).toBe(ADDRESSEE_CASES.length);
    for (const target of ["laya:english", "openrouter:cloudflare/clef", "openai:gpt-6-luna"]) {
      for (const sample of ADDRESSEE_CASES) {
        const question = addresseeQuestion(target, sample);
        for (const choice of expectedChoices(question, sample)) expect(Object.keys(question.questions["addressee"]!.criteria)).toContain(choice);
      }
    }
    expect(expectedChoices(addresseeQuestion("laya:english", ADDRESSEE_CASES[1]!), ADDRESSEE_CASES[1]!)).toEqual(["waifu_1"]);
  });

  it("never send the expected answer, the case id or the group", () => {
    for (const sample of ADDRESSEE_CASES) {
      const question = addresseeQuestion("openrouter:cloudflare/clef", sample);
      for (const openai of [false, true]) {
        const body = JSON.stringify(decisionRequest("model", question.state, question.questions, openai));
        expect(body).not.toContain('"expected"');
        expect(body).not.toContain(`"${sample.id}"`);
        expect(body).not.toContain(sample.group);
      }
    }
  });
});

describe("the production detector on the suite", () => {
  it("answers every case through AddresseeDetector and scores it", async () => {
    const lines: UsageLedgerLine[] = [];
    let answerWith: (choices: string[]) => string = (choices) => choices[0]!;
    const detector = new AddresseeDetector({
      credentials: () => "test-key",
      usage: { record: async (line) => void lines.push(line), flush: async () => undefined },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { questions: Array<{ name: string; choices: Array<{ value: string }> }> };
        const choices = body.questions[0]!.choices.map((choice) => choice.value);
        const chosen = answerWith(choices);
        const probabilities = choices.map((value) => ({ value, probability: value === chosen ? 0.9 : 0.1 / (choices.length - 1) }));
        return new Response(JSON.stringify({ answers: [{ name: "addressee", type: "choice", choice: chosen, probabilities }], usage: { input_tokens: 500, output_tokens: 1, cost: 0.00005 } }), { status: 200 });
      }) as typeof fetch
    });
    const results: AddresseeResult[] = [];
    for (const sample of ADDRESSEE_CASES) {
      const question = addresseeQuestion("openai:gpt-6-luna", sample);
      const expected = expectedChoices(question, sample);
      answerWith = () => expected[0]!;
      const answer = await detector.decide({ target: "openai:gpt-6-luna", question, signal: new AbortController().signal, attribution: {} });
      results.push({ caseId: sample.id, group: sample.group, run: 0, latencyMs: 5, expected, choice: answer.choice, probabilities: answer.probabilities, costUsd: lines.at(-1)!.costUsd });
    }
    detector.close();
    const summary = summarizeAddressee(results);
    expect(summary).toMatchObject({ requests: ADDRESSEE_CASES.length, failures: 0, exactChoiceAccuracyIncludingFailures: 1, misses: [] });
    expect(summary.brier).toBeGreaterThan(0);
    expect(summary.brier).toBeLessThan(0.05);
    expect(summary.ece).toBeCloseTo(0.1, 5);
    expect(summary.costUsd).toBeCloseTo(0.00005 * ADDRESSEE_CASES.length, 8);
    expect(lines.every((line) => line.purpose === "detector")).toBe(true);
  });
});

describe("addressee scores", () => {
  it("count failures as wrong and score calibration only where one answer is right", () => {
    const rows: AddresseeResult[] = [
      { caseId: "N01", group: "addressed_by_name", run: 0, latencyMs: 10, expected: ["waifu_0"], choice: "waifu_0", probabilities: { waifu_0: 1, human: 0 } },
      { caseId: "H01", group: "human_to_human", run: 0, latencyMs: 30, expected: ["human"], choice: "waifu_0", probabilities: { waifu_0: 1, human: 0 } },
      { caseId: "A03", group: "ambiguous", run: 0, latencyMs: 20, expected: ["anyone", "none"], choice: "none", probabilities: { anyone: 0.4, none: 0.6 } },
      { caseId: "O01", group: "open_question", run: 0, latencyMs: 0, expected: ["anyone"], error: "detector_http_500" }
    ];
    const summary = summarizeAddressee(rows);
    expect(summary).toMatchObject({ requests: 4, succeeded: 3, failures: 1, exactChoiceAccuracyIncludingFailures: 0.5, brier: 1, ece: 0.5, p50Ms: 20, errors: { detector_http_500: 1 } });
    expect(summary.byGroup).toMatchObject({ addressed_by_name: { requests: 1, correct: 1 }, human_to_human: { requests: 1, correct: 0 }, ambiguous: { correct: 1 }, open_question: { correct: 0 } });
    expect(summary.misses.map((miss) => miss.id)).toEqual(["H01", "O01"]);
  });
});
