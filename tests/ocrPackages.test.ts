import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildBundledOcrEnv,
  bundledOcrPackageName,
  npmPackTarballPrefix,
  readBundledOcrPackage,
  resolveBundledOcrPackage
} from "../src/orchestration/ocrPackages.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

let roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map(removeTempRoot));
  roots = [];
});

describe("bundled OCR packages", () => {
  it("maps supported platforms to platform-specific package names", () => {
    expect(bundledOcrPackageName({ platform: "darwin", arch: "arm64" })).toBe(
      "@starlight-ai/discord-waifus-ocr-darwin-arm64"
    );
    expect(bundledOcrPackageName({ platform: "darwin", arch: "x64" })).toBe(
      "@starlight-ai/discord-waifus-ocr-darwin-x64"
    );
    expect(bundledOcrPackageName({ platform: "win32", arch: "x64" })).toBe(
      "@starlight-ai/discord-waifus-ocr-win32-x64"
    );
    expect(bundledOcrPackageName({ platform: "linux", arch: "x64", libc: "glibc" })).toBe(
      "@starlight-ai/discord-waifus-ocr-linux-x64-gnu"
    );
    expect(bundledOcrPackageName({ platform: "linux", arch: "x64", libc: "musl" })).toBeUndefined();
  });

  it("matches npm pack tarball names for scoped packages", () => {
    expect(npmPackTarballPrefix("@starlight-ai/discord-waifus")).toBe("starlight-ai-discord-waifus-");
    expect(npmPackTarballPrefix("@starlight-ai/discord-waifus-ocr-win32-x64")).toBe(
      "starlight-ai-discord-waifus-ocr-win32-x64-"
    );
  });

  it("resolves repo-local OCR packages for source checkouts", async () => {
    const bundle = await resolveBundledOcrPackage({ platform: "darwin", arch: "arm64" });
    expect(bundle.packageRoot).toContain(path.join("packages", "ocr-darwin-arm64"));
    expect(bundle.binaryPath).toContain(path.join("packages", "ocr-darwin-arm64", "bin", "tesseract"));
  });

  it("resolves package-relative paths and builds a local OCR environment", async () => {
    const root = await makeTempRoot();
    roots.push(root);
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "lib"), { recursive: true });
    await mkdir(path.join(root, "share", "tessdata"), { recursive: true });
    await writeFile(path.join(root, "bin", "tesseract"), "");
    await writeFile(path.join(root, "share", "tessdata", "eng.traineddata"), "");
    await writeFile(
      path.join(root, "ocr-manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          engine: "tesseract",
          platform: "darwin",
          arch: "arm64",
          binary: "bin/tesseract",
          tessdata: "share/tessdata",
          env: {
            DYLD_LIBRARY_PATH: ["lib"]
          }
        },
        null,
        2
      )
    );

    const bundle = await readBundledOcrPackage("@starlight-ai/discord-waifus-ocr-darwin-arm64", root);
    expect(bundle.binaryPath).toBe(path.join(root, "bin", "tesseract"));
    expect(bundle.tessdataPath).toBe(path.join(root, "share", "tessdata"));
    expect(bundle.envPaths.DYLD_LIBRARY_PATH).toEqual([path.join(root, "lib")]);

    const env = buildBundledOcrEnv(bundle, { DYLD_LIBRARY_PATH: "/usr/lib" });
    expect(env.TESSDATA_PREFIX).toBe(path.join(root, "share", "tessdata"));
    expect(env.DYLD_LIBRARY_PATH).toBe(`${path.join(root, "lib")}${path.delimiter}/usr/lib`);
  });
});
