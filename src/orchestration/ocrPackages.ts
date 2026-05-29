import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const OCR_PACKAGE_PREFIX = "@starlight-ai/discord-waifus-ocr";
const MANIFEST_FILE = "ocr-manifest.json";
const DIAGNOSTIC_TIMEOUT_MS = 10_000;

export type LibcFlavor = "glibc" | "musl";

export type OcrPackageTarget = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  libc?: LibcFlavor;
};

export type BundledOcrManifest = {
  schemaVersion: 1;
  engine: "tesseract";
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  libc?: LibcFlavor;
  binary: string;
  tessdata: string;
  env?: Record<string, string[]>;
};

export type BundledOcrPackage = {
  packageName: string;
  packageRoot: string;
  binaryPath: string;
  tessdataPath: string;
  envPaths: Record<string, string[]>;
  manifest: BundledOcrManifest;
};

export type BundledOcrDiagnostics = {
  supported: boolean;
  packageName?: string;
  packageRoot?: string;
  binaryPath?: string;
  tessdataPath?: string;
  available: boolean;
  version?: string;
  error?: string;
};

export function bundledOcrPackageName(target: OcrPackageTarget = {}): string | undefined {
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const libc = target.libc ?? detectLibc();

  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return `${OCR_PACKAGE_PREFIX}-darwin-${arch}`;
  }
  if (platform === "win32" && arch === "x64") {
    return `${OCR_PACKAGE_PREFIX}-win32-x64`;
  }
  if (platform === "linux" && arch === "x64" && libc === "glibc") {
    return `${OCR_PACKAGE_PREFIX}-linux-x64-gnu`;
  }
  return undefined;
}

export function npmPackTarballPrefix(packageName: string): string {
  return `${packageName.replace(/^@/u, "").replace(/\//gu, "-")}-`;
}

export function detectLibc(): LibcFlavor | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const header = report?.header;
  if (header?.glibcVersionRuntime) return "glibc";
  return "musl";
}

export async function resolveBundledOcrPackage(target: OcrPackageTarget = {}): Promise<BundledOcrPackage> {
  const packageName = bundledOcrPackageName(target);
  if (!packageName) {
    throw new Error(`No bundled OCR package is defined for ${target.platform ?? process.platform}/${target.arch ?? process.arch}.`);
  }
  const packageRoot = resolvePackageRoot(packageName);
  return readBundledOcrPackage(packageName, packageRoot);
}

export async function readBundledOcrPackage(packageName: string, packageRoot: string): Promise<BundledOcrPackage> {
  const manifestPath = path.join(packageRoot, MANIFEST_FILE);
  const manifest = parseBundledOcrManifest(await readFile(manifestPath, "utf8"));
  const binaryPath = resolveManifestPath(packageRoot, manifest.binary, "binary");
  const tessdataPath = resolveManifestPath(packageRoot, manifest.tessdata, "tessdata");
  const envPaths = Object.fromEntries(
    Object.entries(manifest.env ?? {}).map(([key, values]) => [
      key,
      values.map((value) => resolveManifestPath(packageRoot, value, `env.${key}`))
    ])
  );
  return {
    packageName,
    packageRoot,
    binaryPath,
    tessdataPath,
    envPaths,
    manifest
  };
}

export function buildBundledOcrEnv(bundle: BundledOcrPackage, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  env.TESSDATA_PREFIX = bundle.tessdataPath;

  for (const [key, values] of Object.entries(bundle.envPaths)) {
    const envKey = key.toLowerCase() === "path" ? existingPathKey(env) : key;
    const current = env[envKey];
    env[envKey] = current ? [...values, current].join(path.delimiter) : values.join(path.delimiter);
  }
  return env;
}

export async function diagnoseBundledOcr(target: OcrPackageTarget = {}): Promise<BundledOcrDiagnostics> {
  const packageName = bundledOcrPackageName(target);
  if (!packageName) {
    return {
      supported: false,
      available: false,
      error: `No bundled OCR package is defined for ${target.platform ?? process.platform}/${target.arch ?? process.arch}.`
    };
  }

  try {
    const bundle = await resolveBundledOcrPackage(target);
    await access(bundle.binaryPath);
    await access(path.join(bundle.tessdataPath, "eng.traineddata"));
    const { stdout } = await execFileAsync(bundle.binaryPath, ["--version"], {
      env: buildBundledOcrEnv(bundle),
      timeout: DIAGNOSTIC_TIMEOUT_MS,
      maxBuffer: 64 * 1024
    });
    return {
      supported: true,
      packageName,
      packageRoot: bundle.packageRoot,
      binaryPath: bundle.binaryPath,
      tessdataPath: bundle.tessdataPath,
      available: true,
      version: stdout.split(/\r?\n/u)[0]?.trim()
    };
  } catch (error) {
    return {
      supported: true,
      packageName,
      available: false,
      error: errorMessage(error)
    };
  }
}

function resolvePackageRoot(packageName: string): string {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const folderName = packageName.split("/").at(-1)?.replace(/^discord-waifus-/u, "");
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const candidates = folderName
      ? [
          path.join(repoRoot, "packages", folderName),
          path.join(process.cwd(), "packages", folderName)
        ]
      : [];
    for (const candidate of candidates) {
      if (existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
    }
    throw new Error(`${packageName} is not installed. Reinstall without --omit=optional or install the matching OCR release asset.`);
  }
}

function parseBundledOcrManifest(raw: string): BundledOcrManifest {
  const parsed = JSON.parse(raw) as Partial<BundledOcrManifest>;
  if (parsed.schemaVersion !== 1) {
    throw new Error("Bundled OCR manifest has an unsupported schemaVersion.");
  }
  if (parsed.engine !== "tesseract") {
    throw new Error("Bundled OCR manifest engine must be tesseract.");
  }
  if (!parsed.platform || !parsed.arch || !parsed.binary || !parsed.tessdata) {
    throw new Error("Bundled OCR manifest is missing required fields.");
  }
  if (parsed.env !== undefined) {
    for (const values of Object.values(parsed.env)) {
      if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
        throw new Error("Bundled OCR manifest env entries must be string arrays.");
      }
    }
  }
  return parsed as BundledOcrManifest;
}

function resolveManifestPath(packageRoot: string, relativePath: string, label: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/u).includes("..")) {
    throw new Error(`Bundled OCR manifest ${label} path must be package-relative.`);
  }
  return path.join(packageRoot, relativePath);
}

function existingPathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details: string[] = [];
  const processError = error as Error & {
    code?: string | number | null;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  if (processError.killed) details.push("killed=true");
  if (processError.signal) details.push(`signal=${processError.signal}`);
  if (processError.code !== undefined && processError.code !== null) details.push(`code=${processError.code}`);
  return details.length > 0 ? `${error.message.trim()} (${details.join(", ")})` : error.message;
}
