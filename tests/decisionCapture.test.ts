import { expect, it } from "vitest";
import { stripCaptureMedia } from "../scripts/decision-benchmark/capture.js";
import { redactSecrets } from "../src/backend/redaction.js";

it("drops embedded media and credentials while retaining text evidence", () => {
  const input = { token: "test-token", contents: [{ parts: [{ text: "ordinary dialogue" }, { inlineData: { data: "private-image" } }, { fileData: { fileUri: "private-file" } }] }] };
  const result = redactSecrets(stripCaptureMedia(input));
  expect(JSON.stringify(result)).not.toContain("private-image");
  expect(JSON.stringify(result)).not.toContain("private-file");
  expect(JSON.stringify(result)).not.toContain("test-token");
  expect(JSON.stringify(result)).toContain("ordinary dialogue");
});
