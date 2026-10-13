import { describe, expect, it } from "vitest";
import { LOOP_CASES, LOOP_RUBRICS, lexicalLoopBaseline, loopReplayCases, summarizeLoops } from "../scripts/decision-benchmark/loops.js";
import { requestBody, type Result } from "../scripts/decision-benchmark/core.js";

describe("blind loop benchmark", () => {
  it("has balanced loops and healthy controls plus insufficient evidence", () => {
    expect(LOOP_CASES.filter((c) => c.id.startsWith("L"))).toHaveLength(15);
    expect(LOOP_CASES.filter((c) => c.id.startsWith("H"))).toHaveLength(15);
    expect(new Set(LOOP_CASES.map((c) => c.id)).size).toBe(32);
    for (const c of LOOP_CASES) for (const q of ["next", "pause", "steering"] as const)
      for (const label of c.expected[q]) expect(Object.hasOwn(LOOP_RUBRICS[q].criteria, label)).toBe(true);
  });
  it("never sends the expected answer, group or case identity", () => {
    for (const openai of [false, true]) {
      const body = requestBody("model", LOOP_CASES[3], openai);
      expect(JSON.stringify(body)).not.toContain('"expected"');
      expect(JSON.stringify(body)).not.toContain(LOOP_CASES[3].id);
      expect(body).not.toHaveProperty("group");
      expect(LOOP_CASES[3].state).not.toContain("loop detected");
    }
  });
  it("does not count unknown or failed calls as correct healthy negatives", () => {
    const rows: Result[] = [
      { caseId: "L01", group: "literal", run: 0, latencyMs: 2, error: "http_500" },
      { caseId: "H01", group: "progress_topic", run: 0, latencyMs: 2,
        answers: { next: { choice: "unknown" }, pause: { choice: "unknown" }, steering: { choice: "insufficient" } } }
    ];
    expect(summarizeLoops(rows, LOOP_CASES)).toMatchObject({ failures: 1, loopRecallIncludingFailures: 0, healthyFalseAlarmRate: 0, detectionAccuracyIncludingFailures: 0, healthyCorrect: 0 });
  });
  it("compares the real production lexical function rather than a substitute", () => {
    const baseline = lexicalLoopBaseline(LOOP_CASES);
    expect(baseline.results.find((r) => r.caseId === "L01")?.answers?.steering.choice).toBe("repeated_beat");
    expect(baseline.summary.requests).toBe(32);
    expect(baseline.summary.insufficientCorrect).toBe(0);
  });
  it("extracts only chat from a private capture, not loop notices or old answers", () => {
    const captured = { id: "private", request: { contents: [
      { role: "user", parts: [{ text: "[2m] Actor: Let's leave." }, { text: "<task_instructions>loop detected</task_instructions>" }] },
      { role: "model", parts: [{ text: "loop detected" }] },
      { role: "user", parts: [{ text: "[1m] Human: Ready." }] }
    ] }, get referenceResponse(): never { throw new Error("old_decision_read"); } };
    const cases = loopReplayCases({ samples: [captured] }, [{ id: "private", diagnosis: ["insufficient"], humanNames: ["Human"] }]);
    expect(cases[0].dialogue).toEqual(["A: [2m ago] Let's leave.", "H: [1m ago] Ready."]);
    expect(cases[0].state).not.toContain("loop detected");
    expect(cases[0].state).not.toContain("Actor");
  });
});
