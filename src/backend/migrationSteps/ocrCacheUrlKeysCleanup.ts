import { lstat, rm } from "node:fs/promises";
import { appDataPath } from "../../config/paths.js";
import { LEGACY_OCR_RESULTS_DIR } from "../../orchestration/ocr.js";

// Step `ocr-cache-url-keys-cleanup-v1` (spec 8.4). OCR results used to be keyed by sha256 of the
// full signed URL, which Discord re-signs, so they missed on every rotation. Results now live in
// app/cache/ocr/results-v2/ keyed by attachmentKey; the old URL-keyed directory is only a cache,
// so it is deleted outright. Idempotent: a missing directory is a no-op.
export async function migrateOcrCacheUrlKeysCleanup(dataRoot: string): Promise<string | undefined> {
  const legacy = appDataPath(dataRoot, "cache", "ocr", LEGACY_OCR_RESULTS_DIR);
  try {
    await lstat(legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  await rm(legacy, { recursive: true, force: true });
  return "ocr-cache-url-keys-cleanup-v1";
}
