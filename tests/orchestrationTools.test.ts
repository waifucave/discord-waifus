import { describe, expect, it } from "vitest";
import {
  DREAM_TOOL_NAME, OBSERVER_TOOL_NAME, ORCHESTRATOR_TOOL_NAME,
  PERSONA_DIGEST_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME, REVIEWER_TOOL_NAME,
  SHORT_TERM_MEMORY_TOOL_NAME,
  dreamToolParameters, flatDreamToolParameters, observerToolParameters,
  orchestratorToolParameters, personaDigestToolParameters,
  pickNextWaifuToolParameters, reviewerToolParameters, shortTermMemoryToolParameters,
  googleAiStudioSchema, ORCHESTRATOR_TOOL_PARAMETERS
} from "../src/orchestration/tools.js";

describe("orchestration/tools", () => {
  it("exports the canonical tool names", () => {
    expect(ORCHESTRATOR_TOOL_NAME).toBe("orchestrator_decision");
    expect(SHORT_TERM_MEMORY_TOOL_NAME).toBe("add_memory");
    expect(PICK_NEXT_WAIFU_TOOL_NAME).toBe("PickNextWaifu");
    expect(DREAM_TOOL_NAME).toBe("dream_memories");
    expect(OBSERVER_TOOL_NAME).toBe("record_observations");
    expect(PERSONA_DIGEST_TOOL_NAME).toBe("set_persona_digest");
    expect(REVIEWER_TOOL_NAME).toBe("review_message");
  });

  it("the pre-built orchestrator schema const matches a fresh build (single source)", () => {
    expect(ORCHESTRATOR_TOOL_PARAMETERS).toEqual(orchestratorToolParameters(undefined, false, true));
  });

  it("directive goal description demands destination-only phrasing", () => {
    const schema = JSON.stringify(orchestratorToolParameters(undefined, false, true));
    expect(schema).toContain("Never name the topic being left behind");
  });

  it("schema builders produce stable shapes", () => {
    const orch = orchestratorToolParameters(["yuki", "riko"], true, false);
    expect(orch.properties).toHaveProperty("respondingWaifus");
    expect(JSON.stringify(orch)).toContain("yuki");
    expect(pickNextWaifuToolParameters(["a"]).properties).toBeDefined();
    expect(dreamToolParameters().properties).toHaveProperty("ops");
    expect(flatDreamToolParameters()).not.toEqual(dreamToolParameters());
    expect(observerToolParameters(undefined).properties).toHaveProperty("observations");
    expect(shortTermMemoryToolParameters().properties).toBeDefined();
    expect(personaDigestToolParameters().properties).toHaveProperty("voice");
    expect(reviewerToolParameters().properties).toHaveProperty("hallucination");
  });

  it("googleAiStudioSchema strips additionalProperties and anyOf", () => {
    const cleaned = googleAiStudioSchema({
      type: "object",
      additionalProperties: false,
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } }
    } as Record<string, unknown>);
    expect(JSON.stringify(cleaned)).not.toContain("additionalProperties");
    expect(JSON.stringify(cleaned)).not.toContain("anyOf");
  });
});
