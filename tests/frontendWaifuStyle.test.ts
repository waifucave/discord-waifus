import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_INSTRUCTIONS_MAX,
  WaifuStyleFields,
  customInstructionsStatus,
  waifuStyleBlocksSave
} from "../src/frontend/components/WaifuStyleFields.js";
import { WaifuConfigSchema } from "../src/shared/schemas/domain.js";

describe("custom instructions counter and validation", () => {
  it("matches the server limit", () => {
    const ok = WaifuConfigSchema.shape.customInstructions.safeParse("x".repeat(CUSTOM_INSTRUCTIONS_MAX));
    const tooLong = WaifuConfigSchema.shape.customInstructions.safeParse("x".repeat(CUSTOM_INSTRUCTIONS_MAX + 1));
    expect(CUSTOM_INSTRUCTIONS_MAX).toBe(4000);
    expect(ok.success).toBe(true);
    expect(tooLong.success).toBe(false);
  });

  it("formats 'n / 4000' and flags only values above the limit", () => {
    expect(customInstructionsStatus(undefined)).toEqual({ length: 0, label: "0 / 4000", over: false });
    expect(customInstructionsStatus("hello")).toEqual({ length: 5, label: "5 / 4000", over: false });
    expect(customInstructionsStatus("x".repeat(4000)).over).toBe(false);
    expect(customInstructionsStatus("x".repeat(4001))).toMatchObject({ label: "4001 / 4000", over: true });
  });

  it("blocks saving above 4000 characters only", () => {
    expect(waifuStyleBlocksSave({})).toBe(false);
    expect(waifuStyleBlocksSave({ customInstructions: "x".repeat(4000) })).toBe(false);
    expect(waifuStyleBlocksSave({ customInstructions: "x".repeat(4001) })).toBe(true);
  });
});

describe("WaifuStyleFields", () => {
  it("renders the custom instructions and the live counter, and no message length setting", () => {
    const html = renderToStaticMarkup(
      createElement(WaifuStyleFields, {
        customInstructions: "Be kind.",
        onChange: () => undefined
      })
    );
    expect(html).not.toContain("Message length");
    expect(html).toContain("8 / 4000");
    expect(html).toContain('aria-invalid="false"');
  });

  it("flags an over-limit value", () => {
    const html = renderToStaticMarkup(
      createElement(WaifuStyleFields, {
        customInstructions: "x".repeat(4005),
        onChange: () => undefined
      })
    );
    expect(html).toContain("4005 / 4000");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("too long");
  });
});
