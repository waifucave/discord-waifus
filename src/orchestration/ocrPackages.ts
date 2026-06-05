import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker, OEM } from "tesseract.js";

const require = createRequire(import.meta.url);

export const BUNDLED_OCR_LANGUAGE = "eng";
const BUNDLED_OCR_MODEL_FILE = `${BUNDLED_OCR_LANGUAGE}.traineddata`;

export type BundledOcrDiagnostics = {
  supported: boolean;
  engine: "tesseract.js";
  available: boolean;
  langPath?: string;
  version?: string;
  coreVersion?: string;
  error?: string;
};

/**
 * Directory that holds the bundled `eng.traineddata`. The path is identical
 * relative to this module in both a source checkout (`src/orchestration/...`)
 * and the published package (`dist/orchestration/...`): two levels up to the
 * package root, then `assets/ocr`.
 */
export function bundledOcrLangPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "assets", "ocr");
}

/**
 * Probe whether bundled (WASM) OCR can run fully offline on this machine: the
 * model ships in the package, the tesseract.js runtime resolves, and a worker
 * can initialize (loading the WASM core + the bundled model) without a recognize
 * pass. Bundled OCR is cross-platform now, so `supported` is always true.
 */
export async function diagnoseBundledOcr(): Promise<BundledOcrDiagnostics> {
  const langPath = bundledOcrLangPath();

  try {
    await access(path.join(langPath, BUNDLED_OCR_MODEL_FILE));
  } catch {
    return {
      supported: true,
      engine: "tesseract.js",
      available: false,
      langPath,
      error: `Bundled OCR model not found at ${path.join(langPath, BUNDLED_OCR_MODEL_FILE)}.`
    };
  }

  let version: string | undefined;
  let coreVersion: string | undefined;
  try {
    version = (require("tesseract.js/package.json") as { version?: string }).version;
    coreVersion = (require("tesseract.js-core/package.json") as { version?: string }).version;
  } catch (error) {
    return {
      supported: true,
      engine: "tesseract.js",
      available: false,
      langPath,
      error: `tesseract.js runtime is not resolvable: ${errorMessage(error)}`
    };
  }

  try {
    const worker = await createWorker(BUNDLED_OCR_LANGUAGE, OEM.LSTM_ONLY, {
      langPath,
      gzip: false,
      cacheMethod: "none"
    });
    await worker.terminate();
  } catch (error) {
    return {
      supported: true,
      engine: "tesseract.js",
      available: false,
      langPath,
      version,
      coreVersion,
      error: errorMessage(error)
    };
  }

  return {
    supported: true,
    engine: "tesseract.js",
    available: true,
    langPath,
    version,
    coreVersion
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
