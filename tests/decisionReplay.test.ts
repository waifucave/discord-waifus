import { expect, it } from "vitest";
import { replayCases } from "../scripts/decision-benchmark/replay.js";
import { requestBody, summarize, type Answers } from "../scripts/decision-benchmark/core.js";

it("uses independent labels and excludes historical model answers from replay evidence", () => {
  const sample = { id: "live-1", request: {
    tools: [{ parameters: { properties: { waifuId: { enum: ["actor-a", "actor-b"] } } } }],
    systemInstruction: { parts: [{ text: "Room policy" }] },
    contents: [ { role: "model", parts: [{ text: "DO_NOT_REPLAY_OLD_DECISION" }] },
      { role: "user", parts: [{ text: "Real conversation evidence" }] } ]
  } };
  Object.defineProperty(sample, "referenceResponse", { get: () => { throw new Error("must not read old answer"); } });
  const cases = replayCases({ samples: [sample] }, [{ id: "live-1", allowedPause: ["farewell"], allowFreshTopic: true }]);
  expect(cases[0].state).toContain("Real conversation evidence");
  expect(cases[0].state).not.toContain("DO_NOT_REPLAY_OLD_DECISION");
  expect(JSON.stringify(requestBody("model", cases[0]))).not.toContain("acceptableTuples");
  const answers: Answers = { next: { choice: "actor-a" }, pause: { choice: "now" }, steering: { choice: "none" } };
  // Individual labels all look allowed, but plain replies to this spent beat fail
  // the independent joint constraint; a genuine topic-change intent passes.
  expect(summarize([{ caseId: "live-1", group: cases[0].group, run: 0, latencyMs: 1, answers }], cases).exactCaseAccuracy).toBe(0);
  answers.steering.choice = "change_topic";
  expect(summarize([{ caseId: "live-1", group: cases[0].group, run: 0, latencyMs: 1, answers }], cases).exactCaseAccuracy).toBe(1);
});
