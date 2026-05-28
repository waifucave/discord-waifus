#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const FONT = {
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"]
};

export async function validateOcrPackage(packageDir, options = {}) {
  const manifest = await readManifest(packageDir);
  const binaryPath = resolvePackagePath(packageDir, manifest.binary, "binary");
  const tessdataPath = resolvePackagePath(packageDir, manifest.tessdata, "tessdata");
  const engPath = path.join(tessdataPath, "eng.traineddata");

  await assertFile(binaryPath, "OCR binary");
  await assertFile(engPath, "English traineddata");

  const env = buildOcrEnv(packageDir, manifest);
  const { stdout: version } = await execFileAsync(binaryPath, ["--version"], {
    env,
    timeout: 5_000,
    maxBuffer: 256 * 1024
  });
  const versionLine = version.split(/\r?\n/u)[0]?.trim();
  if (!versionLine?.toLowerCase().includes("tesseract")) {
    throw new Error(`OCR binary did not report a Tesseract version: ${versionLine ?? "[empty]"}`);
  }

  const { stdout: languages } = await execFileAsync(binaryPath, ["--list-langs", "--tessdata-dir", tessdataPath], {
    env,
    timeout: 5_000,
    maxBuffer: 256 * 1024
  });
  if (!languages.split(/\r?\n/u).some((line) => line.trim() === "eng")) {
    throw new Error("OCR package does not expose the eng traineddata language.");
  }

  if (!options.skipSmoke) {
    await runImageSmokeTest(binaryPath, tessdataPath, env);
  }

  console.log(JSON.stringify({
    ok: true,
    packageDir,
    binaryPath,
    tessdataPath,
    version: versionLine
  }, null, 2));
}

async function runImageSmokeTest(binaryPath, tessdataPath, env) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "waifus-ocr-smoke-"));
  const imagePath = path.join(tmpDir, "smoke.png");
  try {
    await writeFile(imagePath, createSmokePng("WAIFUS OCR 123"));
    const { stdout } = await execFileAsync(binaryPath, [
      imagePath,
      "stdout",
      "-l",
      "eng",
      "--psm",
      "7",
      "--tessdata-dir",
      tessdataPath
    ], {
      env,
      timeout: 10_000,
      maxBuffer: 256 * 1024
    });
    const normalized = stdout.toUpperCase().replace(/[^A-Z0-9]+/gu, "").trim();
    if (normalized.length < 2) {
      throw new Error(`OCR smoke test did not recognize text from the generated image. Output: ${JSON.stringify(stdout.trim())}`);
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function readManifest(packageDir) {
  const raw = await readFile(path.join(packageDir, "ocr-manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1 || manifest.engine !== "tesseract") {
    throw new Error("Unsupported OCR manifest.");
  }
  if (!manifest.binary || !manifest.tessdata) {
    throw new Error("OCR manifest is missing binary or tessdata.");
  }
  return manifest;
}

function buildOcrEnv(packageDir, manifest) {
  const env = { ...process.env };
  env.TESSDATA_PREFIX = resolvePackagePath(packageDir, manifest.tessdata, "tessdata");
  for (const [key, values] of Object.entries(manifest.env ?? {})) {
    const envKey = key.toLowerCase() === "path" ? existingPathKey(env) : key;
    const paths = values.map((value) => resolvePackagePath(packageDir, value, `env.${key}`));
    env[envKey] = env[envKey] ? [...paths, env[envKey]].join(path.delimiter) : paths.join(path.delimiter);
  }
  return env;
}

async function assertFile(filePath, label) {
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
}

function resolvePackagePath(packageDir, relativePath, label) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes("..")) {
    throw new Error(`OCR manifest ${label} path must be package-relative.`);
  }
  return path.join(packageDir, relativePath);
}

function createSmokePng(text) {
  const scale = 12;
  const margin = 24;
  const glyphWidth = 5;
  const glyphHeight = 7;
  const glyphGap = 2;
  const width = margin * 2 + text.length * glyphWidth * scale + (text.length - 1) * glyphGap * scale;
  const height = margin * 2 + glyphHeight * scale;
  const rgba = Buffer.alloc(width * height * 4, 255);

  let cursorX = margin;
  for (const char of text) {
    const glyph = FONT[char] ?? FONT[" "];
    for (let y = 0; y < glyphHeight; y += 1) {
      for (let x = 0; x < glyphWidth; x += 1) {
        if (glyph[y][x] !== "1") continue;
        fillRect(rgba, width, cursorX + x * scale, margin + y * scale, scale, scale, [0, 0, 0, 255]);
      }
    }
    cursorX += (glyphWidth + glyphGap) * scale;
  }

  const rowLength = 1 + width * 4;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
    rgba.copy(raw, y * rowLength + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function fillRect(rgba, width, x, y, rectWidth, rectHeight, color) {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let col = x; col < x + rectWidth; col += 1) {
      const offset = (row * width + col) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function existingPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package") {
      result.package = argv[++index];
    } else if (arg === "--skip-smoke") {
      result.skipSmoke = true;
    } else if (arg === "--help") {
      console.log("Usage: node scripts/validate-ocr-package.mjs --package packages/ocr-darwin-arm64 [--skip-smoke]");
      process.exit(0);
    }
  }
  return result;
}

export { buildOcrEnv, createSmokePng, readManifest };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const packageDir = path.resolve(args.package ?? ".");
  const skipSmoke = Boolean(args.skipSmoke);

  try {
    await validateOcrPackage(packageDir, { skipSmoke });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
