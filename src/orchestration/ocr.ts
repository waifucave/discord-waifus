import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Logger } from "../backend/logger.js";
import { appDataPath } from "../config/paths.js";
import { OcrConfig } from "../shared/schemas/config.js";
import { AttachmentImage, ContextMessage } from "./context.js";
import { buildBundledOcrEnv, resolveBundledOcrPackage } from "./ocrPackages.js";

const execFileAsync = promisify(execFile);

const CACHE_SCHEMA_VERSION = 1;
const TEMP_FILE_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const APPLE_VISION_HELPER_SOURCE = String.raw`import AppKit
import Foundation
import Vision

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write(Data("usage: ocr-helper <image-path> <max-chars>\n".utf8))
  exit(2)
}

let imagePath = args[1]
let maxChars = Int(args[2]) ?? 1500
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .fast
request.usesLanguageCorrection = false
if #available(macOS 11.0, *) {
  request.recognitionLanguages = ["en-US"]
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])
let text = (request.results ?? [])
  .compactMap { $0.topCandidates(1).first?.string }
  .joined(separator: "\n")

print(String(text.prefix(maxChars)))
`;

export type ImageOcrServiceOptions = {
  dataRoot: string;
  config: OcrConfig;
  logger: Logger;
};

type OcrCacheEntry = {
  schemaVersion: number;
  createdAt: string;
  expiresAt: string;
  engine: OcrEngine;
  text: string;
};

type OcrEngine = "apple-vision" | "bundled-tesseract" | "system-tesseract";

export class ImageOcrService {
  private helperPathPromise?: Promise<string>;
  private lastCleanupAt = 0;

  constructor(private readonly options: ImageOcrServiceOptions) {}

  async cleanupExpired(): Promise<void> {
    await Promise.all([
      removeExpiredCacheFiles(this.cacheResultsDir()),
      removeOldFiles(this.tmpOcrDir(), TEMP_FILE_TTL_MS)
    ]);
    this.lastCleanupAt = Date.now();
  }

  async enrichMessages(messages: ContextMessage[], options: { signal?: AbortSignal } = {}): Promise<ContextMessage[]> {
    if (!this.options.config.enabled || this.options.config.maxImagesPerModelCall <= 0) {
      return messages;
    }
    await this.cleanupIfDue();

    let remaining = this.options.config.maxImagesPerModelCall;
    let changed = false;
    const nextMessages: ContextMessage[] = [];
    for (const message of messages) {
      if (!message.images?.length || remaining <= 0) {
        nextMessages.push(message);
        continue;
      }

      const nextImages: AttachmentImage[] = [];
      for (const image of message.images) {
        if (remaining <= 0) {
          nextImages.push(image);
          continue;
        }
        remaining -= 1;
        const text = await this.extractImageText(image, options);
        if (text) {
          changed = true;
          nextImages.push({ ...image, ocrText: clipOcrText(text, this.options.config.maxTextCharsPerImage) });
        } else {
          nextImages.push(image);
        }
      }
      nextMessages.push({ ...message, images: nextImages });
    }
    return changed ? nextMessages : messages;
  }

  private async extractImageText(image: AttachmentImage, options: { signal?: AbortSignal }): Promise<string | undefined> {
    const key = cacheKeyForImage(image);
    const cached = await this.readCache(key);
    if (cached !== undefined) {
      return cached || undefined;
    }

    const tempPath = await this.downloadImage(image, key, options.signal).catch((error) => {
      this.options.logger.warn("OCR image download failed", { message: errorMessage(error) });
      return undefined;
    });
    if (!tempPath) return undefined;

    try {
      const result = await this.runConfiguredEngine(tempPath);
      await this.writeCache(key, result.text, result.engine);
      return result.text || undefined;
    } catch (error) {
      this.options.logger.warn("OCR extraction failed", { message: errorMessage(error) });
      return undefined;
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async runConfiguredEngine(imagePath: string): Promise<{ text: string; engine: OcrEngine }> {
    const engine = this.options.config.engine;
    if (engine === "apple-vision") {
      return {
        engine,
        text: await this.runAppleVision(imagePath)
      };
    }
    if (engine === "bundled-tesseract") {
      return {
        engine,
        text: await this.runBundledTesseract(imagePath)
      };
    }
    if (engine === "system-tesseract") {
      return {
        engine,
        text: await this.runSystemTesseract(imagePath)
      };
    }

    const errors: string[] = [];
    if (process.platform === "darwin") {
      try {
        return {
          engine: "apple-vision",
          text: await this.runAppleVision(imagePath)
        };
      } catch (error) {
        errors.push(`apple-vision: ${errorMessage(error)}`);
      }
    }
    try {
      return {
        engine: "bundled-tesseract",
        text: await this.runBundledTesseract(imagePath)
      };
    } catch (error) {
      errors.push(`bundled-tesseract: ${errorMessage(error)}`);
    }
    try {
      return {
        engine: "system-tesseract",
        text: await this.runSystemTesseract(imagePath)
      };
    } catch (error) {
      errors.push(`system-tesseract: ${errorMessage(error)}`);
    }
    throw new Error(errors.join("; ") || "No OCR engine is available.");
  }

  private async runAppleVision(imagePath: string): Promise<string> {
    const helperPath = await this.ensureAppleVisionHelper();
    const { stdout } = await execFileAsync(helperPath, [imagePath, String(this.options.config.maxTextCharsPerImage)], {
      timeout: this.options.config.timeoutMs,
      maxBuffer: 512 * 1024
    });
    return sanitizeOcrText(stdout, this.options.config.maxTextCharsPerImage);
  }

  private async runBundledTesseract(imagePath: string): Promise<string> {
    const bundle = await resolveBundledOcrPackage();
    const { stdout } = await execFileAsync(bundle.binaryPath, [
      imagePath,
      "stdout",
      "-l",
      "eng",
      "--psm",
      "11",
      "--tessdata-dir",
      bundle.tessdataPath
    ], {
      env: buildBundledOcrEnv(bundle),
      timeout: this.options.config.timeoutMs,
      maxBuffer: 512 * 1024
    });
    return sanitizeOcrText(stdout, this.options.config.maxTextCharsPerImage);
  }

  private async runSystemTesseract(imagePath: string): Promise<string> {
    await ensureCommandAvailable("tesseract");
    const { stdout } = await execFileAsync("tesseract", [imagePath, "stdout", "-l", "eng", "--psm", "11"], {
      timeout: this.options.config.timeoutMs,
      maxBuffer: 512 * 1024
    });
    return sanitizeOcrText(stdout, this.options.config.maxTextCharsPerImage);
  }

  private async ensureAppleVisionHelper(): Promise<string> {
    if (process.platform !== "darwin") {
      throw new Error("Apple Vision OCR is only available on macOS.");
    }
    if (this.helperPathPromise) {
      const helperPath = await this.helperPathPromise;
      try {
        await access(helperPath);
        return helperPath;
      } catch {
        this.helperPathPromise = undefined;
      }
    }
    this.helperPathPromise ??= this.buildAppleVisionHelper();
    return this.helperPathPromise;
  }

  private async buildAppleVisionHelper(): Promise<string> {
    const binDir = this.cacheBinDir();
    const moduleCacheDir = this.swiftModuleCacheDir();
    await Promise.all([
      mkdir(binDir, { recursive: true }),
      mkdir(moduleCacheDir, { recursive: true })
    ]);
    const helperPath = path.join(binDir, "apple-vision-ocr");
    const sourcePath = path.join(binDir, "apple-vision-ocr.swift");
    await writeFile(sourcePath, APPLE_VISION_HELPER_SOURCE, { mode: 0o600 });
    await execFileAsync("xcrun", [
      "swiftc",
      "-module-cache-path",
      moduleCacheDir,
      "-o",
      helperPath,
      sourcePath
    ], {
      timeout: Math.max(this.options.config.timeoutMs * 4, 10_000),
      maxBuffer: 512 * 1024,
      env: {
        ...process.env,
        CLANG_MODULE_CACHE_PATH: moduleCacheDir,
        SWIFT_MODULE_CACHE_PATH: moduleCacheDir,
        TMPDIR: appDataPath(this.options.dataRoot, "tmp")
      }
    });
    return helperPath;
  }

  private async downloadImage(
    image: AttachmentImage,
    key: string,
    signal: AbortSignal | undefined
  ): Promise<string> {
    await mkdir(this.tmpOcrDir(), { recursive: true });
    const contentLength = Number(image.contentLengthBytes ?? 0);
    if (contentLength > this.options.config.maxImageBytes) {
      throw new Error("Image exceeds OCR size limit.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("OCR image download timed out.")), this.options.config.timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(image.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Image download returned HTTP ${response.status}.`);
      }
      const buffer = await readLimitedResponse(response, this.options.config.maxImageBytes);
      const tempPath = path.join(this.tmpOcrDir(), `${key}-${randomUUID()}${extensionForImage(image, response)}`);
      await writeFile(tempPath, buffer, { mode: 0o600 });
      return tempPath;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async readCache(key: string): Promise<string | undefined> {
    try {
      const raw = await readFile(this.cachePath(key), "utf8");
      const parsed = JSON.parse(raw) as Partial<OcrCacheEntry>;
      if (
        parsed.schemaVersion !== CACHE_SCHEMA_VERSION ||
        typeof parsed.text !== "string" ||
        typeof parsed.expiresAt !== "string"
      ) {
        return undefined;
      }
      if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
        await rm(this.cachePath(key), { force: true });
        return undefined;
      }
      return parsed.text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.options.logger.warn("OCR cache read failed", { message: errorMessage(error) });
      }
      return undefined;
    }
  }

  private async writeCache(key: string, text: string, engine: OcrEngine): Promise<void> {
    await mkdir(this.cacheResultsDir(), { recursive: true });
    const now = new Date();
    const entry: OcrCacheEntry = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.options.config.cacheTtlHours * 60 * 60 * 1000).toISOString(),
      engine,
      text
    };
    await writeFile(this.cachePath(key), JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    await this.cleanupIfDue();
  }

  private async cleanupIfDue(): Promise<void> {
    if (Date.now() - this.lastCleanupAt < CLEANUP_INTERVAL_MS) return;
    await this.cleanupExpired().catch((error) => {
      this.options.logger.warn("OCR cleanup failed", { message: errorMessage(error) });
    });
  }

  private cacheBinDir(): string {
    return appDataPath(this.options.dataRoot, "cache", "ocr", "bin");
  }

  private cacheResultsDir(): string {
    return appDataPath(this.options.dataRoot, "cache", "ocr", "results");
  }

  private cachePath(key: string): string {
    return path.join(this.cacheResultsDir(), `${key}.json`);
  }

  private tmpOcrDir(): string {
    return appDataPath(this.options.dataRoot, "tmp", "ocr");
  }

  private swiftModuleCacheDir(): string {
    return appDataPath(this.options.dataRoot, "tmp", "swift-module-cache");
  }
}

export async function clearOcrArtifacts(dataRoot: string): Promise<{ cleared: true }> {
  await Promise.all([
    rm(appDataPath(dataRoot, "cache", "ocr"), { recursive: true, force: true }),
    rm(appDataPath(dataRoot, "tmp", "ocr"), { recursive: true, force: true })
  ]);
  await Promise.all([
    mkdir(appDataPath(dataRoot, "cache", "ocr", "bin"), { recursive: true }),
    mkdir(appDataPath(dataRoot, "cache", "ocr", "results"), { recursive: true }),
    mkdir(appDataPath(dataRoot, "tmp", "ocr"), { recursive: true })
  ]);
  return { cleared: true };
}

function cacheKeyForImage(image: AttachmentImage): string {
  return createHash("sha256").update(image.url).digest("hex");
}

function clipOcrText(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function sanitizeOcrText(text: string, maxChars: number): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, maxChars)
    .trim();
}

async function readLimitedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error("Image exceeds OCR size limit.");
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("Image exceeds OCR size limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function extensionForImage(image: AttachmentImage, response: Response): string {
  const contentType = (image.contentType ?? response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return ".jpg";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  const match = new URL(image.url).pathname.match(/\.(png|jpe?g|webp|gif)$/iu);
  return match ? match[0].toLowerCase() : ".png";
}

async function ensureCommandAvailable(command: string): Promise<void> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 1_000, maxBuffer: 64 * 1024 });
  } catch {
    throw new Error(`${command} is not available.`);
  }
}

async function removeExpiredCacheFiles(dir: string): Promise<void> {
  const entries = await safeReaddir(dir);
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(dir, entry);
    if (!entry.endsWith(".json")) return;
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<OcrCacheEntry>;
      if (typeof parsed.expiresAt !== "string" || new Date(parsed.expiresAt).getTime() <= Date.now()) {
        await rm(filePath, { force: true });
      }
    } catch {
      await rm(filePath, { force: true });
    }
  }));
}

async function removeOldFiles(dir: string, maxAgeMs: number): Promise<void> {
  const entries = await safeReaddir(dir);
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(dir, entry);
    try {
      const info = await stat(filePath);
      if (info.isFile() && Date.now() - info.mtimeMs > maxAgeMs) {
        await rm(filePath, { force: true });
      }
    } catch {
      await rm(filePath, { force: true }).catch(() => undefined);
    }
  }));
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
