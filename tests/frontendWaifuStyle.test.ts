import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_INSTRUCTIONS_MAX,
  VERBOSITY_OPTIONS,
  WaifuStyleFields,
  customInstructionsStatus,
  verbosityExample,
  waifuStyleBlocksSave
} from "../src/frontend/components/WaifuStyleFields.js";
import { WAIFU_VERBOSITIES, WaifuConfigSchema } from "../src/shared/schemas/domain.js";

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

describe("verbosity options", () => {
  it("offers exactly the schema's values, each with a one-line example", () => {
    expect(VERBOSITY_OPTIONS.map((option) => option.value)).toEqual([...WAIFU_VERBOSITIES]);
    for (const option of VERBOSITY_OPTIONS) {
      expect(option.example.length).toBeGreaterThan(10);
      expect(option.example).not.toContain("\n");
    }
  });

  it("falls back to the terse example when unset", () => {
    expect(verbosityExample(undefined)).toBe(verbosityExample("terse"));
    expect(verbosityExample("expressive")).not.toBe(verbosityExample("terse"));
  });
});

describe("WaifuStyleFields", () => {
  it("renders the select, the selected example and the live counter", () => {
    const html = renderToStaticMarkup(
      createElement(WaifuStyleFields, {
        verbosity: "chatty",
        customInstructions: "Be kind.",
        onChange: () => undefined
      })
    );
    expect(html).toContain("Terse");
    expect(html).toContain("Chatty");
    expect(html).toContain("Expressive");
    expect(html).toContain(verbosityExample("chatty"));
    expect(html).toContain("8 / 4000");
    expect(html).toContain('aria-invalid="false"');
  });

  it("flags an over-limit value", () => {
    const html = renderToStaticMarkup(
      createElement(WaifuStyleFields, {
        verbosity: undefined,
        customInstructions: "x".repeat(4005),
        onChange: () => undefined
      })
    );
    expect(html).toContain("4005 / 4000");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("too long");
  });
});
