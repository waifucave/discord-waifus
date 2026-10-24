// The native-choice decision protocol and the decision-model catalog, kept from One shot for the
// Living cast addressee detector (src/life/detector/, spec §4.3). The decider itself was retired
// in L1; L3 builds the detector on these.
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionModelCatalog, DetectorTargetSchema } from "../src/life/detector/catalog.js";
import { decisionAnswers, decisionRequest, readDecisionJson, type ChoiceQuestions } from "../src/life/detector/protocol.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const QUESTIONS: ChoiceQuestions = {
  turn: { instructions: "Who speaks next?", criteria: { speaker_0: "Yuki", pause: "Nobody" } },
  loop: { instructions: "Is the room looping?", criteria: { healthy: "No", looping: "Yes" } }
};

function payload(questions: ChoiceQuestions, choices: Record<string, string>, openai = true) {
  const rows = Object.entries(questions).map(([name, q]) => ({
    name,
    type: "choice",
    choice: choices[name],
    probabilities: openai
      ? Object.keys(q.criteria).map((value) => ({ value, probability: Number(value === choices[name]) }))
      : Object.fromEntries(Object.keys(q.criteria).map((v) => [v, Number(v === choices[name])]))
  }));
  return { answers: openai ? rows : Object.fromEntries(rows.map((r) => [r.name, r])) };
}

describe("detector decision protocol", () => {
  it("rejects predicate-only models and arbitrary endpoints or executables", () => {
    for (const t of ["openrouter:respan/span-01", "openrouter:respan/span-01-lite:free", "https://evil.test", "laya:/tmp/executable", "openai:unknown"])
      expect(DetectorTargetSchema.safeParse(t).success).toBe(false);
    expect(DetectorTargetSchema.safeParse("openai:gpt-6-luna").success).toBe(true);
  });

  it("uses native OpenAI choice arrays and router choice maps", () => {
    expect(decisionRequest("m", "STATE", QUESTIONS, true)).toHaveProperty("input", "STATE");
    expect(decisionRequest("m", "STATE", QUESTIONS, false)).toHaveProperty("questions.turn.type", "choice");
    for (const openai of [false, true]) {
      expect(decisionAnswers(payload(QUESTIONS, { turn: "speaker_0", loop: "healthy" }, openai), QUESTIONS, openai).turn.choice).toBe("speaker_0");
    }
  });

  it("rejects invalid choices, malformed probabilities, refusals and missing answers", () => {
    for (const mutation of [
      (r: any) => { r.answers[0].choice = "other"; },
      (r: any) => { r.answers[0].probabilities[0].probability = 0.7; },
      (r: any) => { r.answers[0].type = "refusal"; },
      (r: any) => { r.answers.pop(); },
      (r: any) => { r.answers.push(r.answers[0]); }
    ]) {
      const result = payload(QUESTIONS, { turn: "speaker_0", loop: "healthy" });
      mutation(result);
      expect(() => decisionAnswers(result, QUESTIONS, true)).toThrow();
    }
  });

  it("bounds provider responses and never forwards parse errors or response contents", async () => {
    await expect(readDecisionJson(new Response('"' + "x".repeat(100) + '"'), 50)).rejects.toThrow(/^one_shot_invalid_response$/);
    await expect(readDecisionJson(new Response("private invalid content"))).rejects.toThrow(/^one_shot_invalid_response$/);
  });
});

describe("detector model catalog", () => {
  it("discovers choice candidates without exposing chat-only or known predicate-only models, caching concurrent reads", async () => {
    const model = (id: string, output: string[]) => ({ id, context_length: id.startsWith("respan/") ? 0 : 32768, architecture: { input_modalities: ["text"], output_modalities: output } });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [model("typesafe/jev-1.13", ["decisions"]), model("respan/span-01", ["decisions"]), model("chat/model", ["text"])] })));
    const catalog = new DecisionModelCatalog(fetchImpl);
    const [a, b] = await Promise.all([catalog.list(), catalog.list()]);
    expect(a).toEqual(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.models.filter((m) => m.provider === "openrouter").map((m) => m.target)).toEqual(["openrouter:typesafe/jev-1.13"]);
  });

  it("preserves built-in entries and reports catalog failures explicitly", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("private network detail");
    });
    const catalog = new DecisionModelCatalog(fetchImpl);
    const result = await catalog.list();
    expect(result.unavailable).toBe(true);
    expect(result.models).toHaveLength(4);
    await catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
