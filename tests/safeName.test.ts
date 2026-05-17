import { describe, expect, it } from "vitest";
import { safeName } from "../src/providers/pipelines.js";

describe("safeName", () => {
  it("passes plain ASCII through unchanged", () => {
    expect(safeName("Aria")).toBe("Aria");
    expect(safeName("kj_5678943")).toBe("kj_5678943");
    expect(safeName("with-hyphen")).toBe("with-hyphen");
  });

  it("maps mathematical script alphabet to ASCII via NFKD", () => {
    expect(safeName("𝓐𝓻𝓲𝓪")).toBe("Aria");
  });

  it("maps fullwidth Latin to ASCII via NFKD", () => {
    expect(safeName("Ａｒｉａ")).toBe("Aria");
  });

  it("maps bold/italic mathematical variants", () => {
    expect(safeName("𝐀𝐫𝐢𝐚")).toBe("Aria"); // mathematical bold
    expect(safeName("𝐴𝑟𝑖𝑎")).toBe("Aria"); // mathematical italic
  });

  it("strips diacritics", () => {
    expect(safeName("Áríã")).toBe("Aria");
    expect(safeName("naïve")).toBe("naive");
  });

  it("collapses runs of non-allowed characters into a single underscore", () => {
    expect(safeName("Aria!!!Bee")).toBe("Aria_Bee");
    expect(safeName("foo bar baz")).toBe("foo_bar_baz");
  });

  it("strips decorative emoji bookends", () => {
    expect(safeName("✨Aria✨")).toBe("Aria");
    expect(safeName("🐱 Aria 🐱")).toBe("Aria");
  });

  it("falls back to 'user' when input is empty or fully stripped", () => {
    expect(safeName("")).toBe("user");
    expect(safeName("✨✨✨")).toBe("user");
    expect(safeName("   ")).toBe("user");
  });

  it("truncates to 64 chars", () => {
    expect(safeName("a".repeat(100))).toBe("a".repeat(64));
  });
});
