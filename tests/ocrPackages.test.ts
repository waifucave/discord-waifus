import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_OCR_LANGUAGE,
  bundledOcrLangPath,
  diagnoseBundledOcr
} from "../src/orchestration/ocrPackages.js";

describe("bundled OCR (tesseract.js)", () => {
  it("resolves the bundled language directory and ships the model", async () => {
    const langPath = bundledOcrLangPath();
    expect(langPath.endsWith(path.join("assets", "ocr"))).toBe(true);
    await expect(
      access(path.join(langPath, `${BUNDLED_OCR_LANGUAGE}.traineddata`))
    ).resolves.toBeUndefined();
  });

  it("reports bundled OCR available by initializing a worker fully offline", async () => {
    const diagnostics = await diagnoseBundledOcr();
    expect(diagnostics.supported).toBe(true);
    expect(diagnostics.engine).toBe("tesseract.js");
    expect(diagnostics.available).toBe(true);
    expect(diagnostics.error).toBeUndefined();
    expect(diagnostics.version).toBeTruthy();
    expect(diagnostics.coreVersion).toBeTruthy();
  }, 30_000);
});
