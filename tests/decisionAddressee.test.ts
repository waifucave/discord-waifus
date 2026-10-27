// The addressee benchmark suite (Living cast spec §4.3, §12), offline: the cases, the production
// question and request, the production detector over a fake decisions endpoint, and the scores.
import { describe, expect, it } from "vitest";
import { ADDRESSEE_CASES, addresseeQuestion, expectedChimeChoices, expectedChoices, notAwakeChoices, summarizeAddressee, type AddresseeResult } from "../scripts/decision-benchmark/addressee.js";
import { AddresseeDetector } from "../src/life/detector/decider.js";
import { decisionRequest } from "../src/life/detector/protocol.js";
import type { UsageLedgerLine } from "../src/orchestration/usageLedger.js";

const GROUPS = ["addressed_by_name", "reply_to_waifu", "human_to_human", "open_question", "whole_cast", "follow_up", "link_dump", "multilingual", "ambiguous", "stale_human", "active_human", "joins_in", "waifu_author"];

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

  it("leave a waifu author and anyone not around out of the cast (§24); chime-in is offered to the rest", () => {
    const byId = (id: string) => ADDRESSEE_CASES.find((sample) => sample.id === id)!;
    const authored = addresseeQuestion("openrouter:typesafe/jev-1.14", byId("WA2"));
    expect(authored.candidates.map((member) => member.waifuId)).toEqual(["mina", "yuki"]);
    expect(expectedChoices(authored, byId("WA2"))).toEqual(["waifu_0"]);
    const asleep = addresseeQuestion("openrouter:typesafe/jev-1.14", byId("C04"));
    expect(asleep.candidates.map((member) => member.waifuId)).toEqual(["mina", "yuki"]);
    expect(Object.keys(asleep.questions["chime_in"]!.criteria)).toEqual(["waifu_0", "waifu_1", "nobody"]);
    expect(notAwakeChoices(asleep)).toEqual([]);
    expect(expectedChimeChoices(asleep, byId("C04"))).toEqual(["nobody"]);
    expect(addresseeQuestion("openrouter:typesafe/jev-1.14", byId("C06")).candidates.map((member) => member.waifuId)).toEqual(["aria", "yuki"]);
    expect(expectedChimeChoices(addresseeQuestion("openrouter:typesafe/jev-1.14", byId("C01")), byId("C01"))).toEqual(["waifu_0"]);
    for (const sample of ADDRESSEE_CASES) {
      const question = addresseeQuestion("openrouter:typesafe/jev-1.14", sample);
      for (const choice of expectedChimeChoices(question, sample) ?? []) expect(Object.keys(question.questions["chime_in"]!.criteria)).toContain(choice);
    }
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
        const answers = body.questions.map((question) => {
          const choices = question.choices.map((choice) => choice.value);
          const chosen = question.name === "addressee" ? answerWith(choices) : choices[choices.length - 1]!;
          const probabilities = choices.map((value) => ({ value, probability: value === chosen ? 0.9 : 0.1 / (choices.length - 1) }));
          return { name: question.name, type: "choice", choice: chosen, probabilities };
        });
        return new Response(JSON.stringify({ answers, usage: { input_tokens: 500, output_tokens: 1, cost: 0.00005 } }), { status: 200 });
      }) as typeof fetch
    });
    const results: AddresseeResult[] = [];
    for (const sample of ADDRESSEE_CASES) {
      const question = addresseeQuestion("openai:gpt-6-luna", sample);
      const expected = expectedChoices(question, sample);
      answerWith = () => expected[0]!;
      const answer = await detector.decide({ target: "openai:gpt-6-luna", question, signal: new AbortController().signal, attribution: {} });
      expect(answer.chimeIn?.choice).toBe("nobody");
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

describe("two questions in one call (§4.3 chime_in)", () => {
  const sample = ADDRESSEE_CASES.find((entry) => entry.id === "C01")!;
  const usage = { record: async () => undefined, flush: async () => undefined };
  const dist = (choices: string[], chosen: string) => Object.fromEntries(choices.map((value) => [value, value === chosen ? 0.7 : 0.3 / (choices.length - 1)]));

  it("reads both answers on the OpenRouter wire (answers keyed by name)", async () => {
    const question = addresseeQuestion("openrouter:typesafe/jev-1.14", sample);
    const addressee = Object.keys(question.questions["addressee"]!.criteria);
    const chime = Object.keys(question.questions["chime_in"]!.criteria);
    const detector = new AddresseeDetector({
      credentials: () => "test-key",
      usage,
      catalog: { list: async () => ({ models: [{ target: "openrouter:typesafe/jev-1.14", label: "Jev", provider: "openrouter", local: false }], unavailable: false }) } as never,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
        expect(Object.keys(body.questions)).toEqual(["addressee", "chime_in"]);
        return new Response(JSON.stringify({ answers: { addressee: { type: "choice", choice: "human", probabilities: dist(addressee, "human") }, chime_in: { type: "choice", choice: "waifu_0", probabilities: dist(chime, "waifu_0") } } }), { status: 200 });
      }) as typeof fetch
    });
    const answer = await detector.decide({ target: "openrouter:typesafe/jev-1.14", question, signal: new AbortController().signal, attribution: {} });
    expect(answer).toMatchObject({ choice: "human", chimeIn: { choice: "waifu_0" } });
  });

  it("keeps the addressee answer when the chime-in answer is malformed", async () => {
    const question = addresseeQuestion("openai:gpt-6-luna", sample);
    const addressee = Object.keys(question.questions["addressee"]!.criteria);
    const detector = new AddresseeDetector({
      credentials: () => "test-key",
      usage,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            answers: [
              { name: "addressee", type: "choice", choice: "human", probabilities: addressee.map((value) => ({ value, probability: value === "human" ? 0.7 : 0.3 / (addressee.length - 1) })) },
              { name: "chime_in", type: "choice", choice: "waifu_9", probabilities: [] }
            ]
          }),
          { status: 200 }
        )) as typeof fetch
    });
    const answer = await detector.decide({ target: "openai:gpt-6-luna", question, signal: new AbortController().signal, attribution: {} });
    expect(answer.choice).toBe("human");
    expect(answer.chimeIn).toBeUndefined();
  });
});
