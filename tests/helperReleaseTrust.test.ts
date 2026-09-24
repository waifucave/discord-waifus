import { describe, expect, it } from "vitest";
import { HELPER_RELEASE_TRUST_ROOTS } from "../src/remote/helperReleaseTrust.js";

describe("production helper release trust", () => {
  it("remains explicitly fail-closed until the production release key is provisioned", () => {
    expect(HELPER_RELEASE_TRUST_ROOTS).toEqual([]);
    expect(Object.isFrozen(HELPER_RELEASE_TRUST_ROOTS)).toBe(true);
  });
});
