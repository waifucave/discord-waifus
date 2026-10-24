import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { atomicWriteText } from "../../storage/atomic.js";

// Step `ocr-cache-ttl-168-v1` (spec 8.4). The `ocr.cacheTtlHours` default moved from 24 to 168
// hours with the attachment-keyed OCR cache, but every saved config.toml was written with the old
// default spelled out, so the new default never applied. A value of exactly 24 is that old default
// and becomes 168; any other value is an owner choice and stays. Idempotent (168 is left alone);
// a missing or unparsable config is left for loadAppConfig to handle.

export const LEGACY_OCR_CACHE_TTL_HOURS = 24;
export const OCR_CACHE_TTL_HOURS = 168;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function migrateOcrCacheTtlDefault168(dataRoot: string): Promise<string | undefined> {
  const filePath = path.join(dataRoot, "config.toml");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || !isObject(parsed.ocr) || parsed.ocr.cacheTtlHours !== LEGACY_OCR_CACHE_TTL_HOURS) return undefined;
  parsed.ocr.cacheTtlHours = OCR_CACHE_TTL_HOURS;
  await atomicWriteText(filePath, stringifyToml(parsed) + "\n", { mode: 0o600 });
  return "ocr-cache-ttl-168-v1";
}
