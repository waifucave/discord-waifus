import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  lstat,
  readFile,
  readdir
} from "node:fs/promises";
import path from "node:path";
import {
  RemoteComponentCompatibilityError,
  type RemoteCompatibilityV1
} from "./componentCompatibility.js";
import {
  verifyHelperPackageBeforeExecution,
  verifyHelperPackageManifest
} from "./helperPackageManifest.js";
import {
  HelperManifestTrustError,
  type HelperEmbeddedBuildInfoV1,
  type HelperReleaseTrustEntryV1
} from "../shared/helperManifestTrust.js";
import {
  HELPER_PACKAGE_TARGETS,
  type HelperManifest,
  type HelperTarget
} from "../shared/schemas/remoteAccess.js";
import { SemVerSchema } from "../shared/schemas/remoteProtocol.js";
import {
  HelperSupervisorError,
  type HelperPackageResolver,
  type VerifiedHelperSelection
} from "./helperTypes.js";

const requireFromApp = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const MAX_PACKAGE_FILES = 32;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_NOTICES_BYTES = 16 * 1024 * 1024;
const MAX_LICENSE_BYTES = 1024 * 1024;
const MAX_SBOM_BYTES = 32 * 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 64 * 1024;
const SIGNATURE_NAME_PATTERN = /^signatures\/([a-z][a-z0-9-]{0,95})\.sig$/u;

export type ResolvedHelperBinary = VerifiedHelperSelection & Readonly<{
  packageName: HelperManifest["packageName"];
  packageRoot: string;
  binarySha256: string;
}>;

export type ResolveTsConnectBinaryOptions = Readonly<{
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  armVersion?: number;
  appVersion: string;
  compatibility: RemoteCompatibilityV1;
  trustRoots: readonly HelperReleaseTrustEntryV1[];
  resolvePackageJson?: (packageName: string) => string | Promise<string>;
  probeBinary?: (binaryPath: string) => Promise<HelperEmbeddedBuildInfoV1>;
  verifyPlatformSignature?: (binaryPath: string, target: HelperTarget) => Promise<void>;
}>;

function unsupported(platform: NodeJS.Platform, arch: NodeJS.Architecture): never {
  const detail = platform === "darwin" && arch === "x64"
    ? "Intel macOS remote mode is a later follow-up."
    : `Remote mode is not supported on ${platform}/${arch}.`;
  throw new HelperSupervisorError("unsupported_platform", detail);
}

export function supportedHelperTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  armVersion?: number
): HelperTarget {
  if (platform === "darwin" && arch === "arm64") return { os: "darwin", arch: "arm64" };
  if (platform === "win32" && arch === "x64") return { os: "win32", arch: "x64" };
  if (platform === "win32" && arch === "arm64") return { os: "win32", arch: "arm64" };
  if (platform === "linux" && arch === "x64") return { os: "linux", arch: "x64" };
  if (platform === "linux" && arch === "arm64") return { os: "linux", arch: "arm64" };
  if (platform === "linux" && arch === "arm" && armVersion === 7) {
    return { os: "linux", arch: "arm", goarm: 7 };
  }
  return unsupported(platform, arch);
}

function targetEqual(left: HelperTarget, right: HelperTarget): boolean {
  return left.os === right.os
    && left.arch === right.arch
    && ("goarm" in left ? left.goarm : undefined) === ("goarm" in right ? right.goarm : undefined);
}

function packageForTarget(target: HelperTarget): HelperManifest["packageName"] {
  const selected = HELPER_PACKAGE_TARGETS.find((entry) => targetEqual(entry.target, target));
  if (!selected) {
    throw new HelperSupervisorError("unsupported_platform", "Remote mode has no helper package for this target.");
  }
  return selected.packageName;
}

function armVersionForCurrentProcess(): number | undefined {
  const raw = (process.config.variables as Record<string, unknown>).arm_version;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^[0-9]+$/u.test(raw)) return Number(raw);
  return undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactStringArray(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function validatePackageJson(
  value: unknown,
  packageName: HelperManifest["packageName"],
  target: HelperTarget
): string {
  const pkg = plainObject(value);
  if (
    !pkg
    || pkg.name !== packageName
    || typeof pkg.version !== "string"
    || !SemVerSchema.safeParse(pkg.version).success
    || !exactStringArray(pkg.os, target.os)
    || !exactStringArray(pkg.cpu, target.arch)
    || pkg.license !== "SEE LICENSE IN LICENSE.txt"
    || "scripts" in pkg
    || "bin" in pkg
    || "main" in pkg
    || "exports" in pkg
  ) {
    throw new Error("Helper package metadata is invalid.");
  }
  return pkg.version;
}

async function readRegularFile(filePath: string, maximumBytes: number): Promise<Buffer> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximumBytes) {
    throw new Error("Helper package contains an invalid file.");
  }
  return readFile(filePath);
}

async function packageInventory(
  directory: string,
  prefix = ""
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error("Helper package may not contain symbolic links.");
    if (info.isDirectory()) {
      result.push(...await packageInventory(absolute, relative));
    } else if (info.isFile()) {
      result.push(relative);
    } else {
      throw new Error("Helper package contains an unsupported filesystem entry.");
    }
    if (result.length > MAX_PACKAGE_FILES) throw new Error("Helper package contains too many files.");
  }
  return result;
}

function validateInventory(files: readonly string[], binaryRelativePath: string): void {
  const fixed = new Set([
    "LICENSE.txt",
    "THIRD_PARTY_NOTICES.txt",
    "manifest.json",
    "package.json",
    "sbom.spdx.json",
    binaryRelativePath
  ]);
  const signatures = files.filter((file) => SIGNATURE_NAME_PATTERN.test(file));
  if (
    signatures.length < 1
    || signatures.length > 8
    || files.some((file) => !fixed.has(file) && !SIGNATURE_NAME_PATTERN.test(file))
    || [...fixed].some((file) => !files.includes(file))
    || files.length !== fixed.size + signatures.length
  ) {
    throw new Error("Helper package inventory is invalid.");
  }
}

async function signaturesFromPackage(
  root: string,
  files: readonly string[]
): Promise<ReadonlyMap<string, Buffer>> {
  const signatures = new Map<string, Buffer>();
  for (const relative of files) {
    const match = relative.match(SIGNATURE_NAME_PATTERN);
    if (!match) continue;
    signatures.set(match[1], await readRegularFile(path.join(root, relative), 64));
  }
  return signatures;
}

async function defaultPlatformSignatureVerifier(
  binaryPath: string,
  target: HelperTarget
): Promise<void> {
  if (target.os === "darwin") {
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binaryPath], {
      timeout: 15_000,
      windowsHide: true
    });
    await execFileAsync("/usr/sbin/spctl", ["--assess", "--verbose=2", "--type", "execute", binaryPath], {
      timeout: 30_000,
      windowsHide: true
    });
    return;
  }
  if (target.os === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$signature=Get-AuthenticodeSignature -LiteralPath $env:WAIFUS_HELPER_VERIFY_PATH; if ($signature.Status -ne 'Valid') { exit 1 }"
    ], {
      env: { ...process.env, WAIFUS_HELPER_VERIFY_PATH: binaryPath },
      timeout: 20_000,
      windowsHide: true
    });
  }
}

async function defaultBinaryProbe(binaryPath: string): Promise<HelperEmbeddedBuildInfoV1> {
  const result = await execFileAsync(binaryPath, ["version", "--json"], {
    encoding: "utf8",
    maxBuffer: MAX_VERSION_OUTPUT_BYTES,
    timeout: 5_000,
    windowsHide: true
  });
  const output = String(result.stdout);
  if (Buffer.byteLength(output, "utf8") > MAX_VERSION_OUTPUT_BYTES) {
    throw new Error("Helper version output exceeds its limit.");
  }
  return JSON.parse(output) as HelperEmbeddedBuildInfoV1;
}

const INCOMPATIBLE_TRUST_CODES = new Set([
  "app_version_incompatible",
  "capability_mismatch",
  "helper_version_mismatch",
  "protocol_mismatch",
  "release_sequence_rollback",
  "worker_trust_ring_mismatch"
]);

function wrapResolutionError(error: unknown): HelperSupervisorError {
  if (error instanceof HelperSupervisorError) return error;
  if (error instanceof RemoteComponentCompatibilityError) {
    return new HelperSupervisorError("helper_incompatible", "The signed helper is incompatible with this Waifus version.");
  }
  if (error instanceof HelperManifestTrustError && INCOMPATIBLE_TRUST_CODES.has(error.code)) {
    return new HelperSupervisorError("helper_incompatible", "The signed helper is incompatible with this Waifus version.");
  }
  return new HelperSupervisorError("helper_signature_invalid", "The installed helper package failed verification.");
}

export async function resolveTsConnectBinary(
  options: ResolveTsConnectBinaryOptions
): Promise<ResolvedHelperBinary> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = supportedHelperTarget(
    platform,
    arch,
    options.armVersion ?? (arch === "arm" ? armVersionForCurrentProcess() : undefined)
  );
  const packageName = packageForTarget(target);
  let packageJsonPath: string;
  try {
    packageJsonPath = await (options.resolvePackageJson ?? ((name) => (
      requireFromApp.resolve(`${name}/package.json`)
    )))(packageName);
  } catch {
    throw new HelperSupervisorError(
      "helper_missing",
      `The verified helper package ${packageName} is not installed for this target.`
    );
  }

  try {
    if (!path.isAbsolute(packageJsonPath) || path.basename(packageJsonPath) !== "package.json") {
      throw new Error("Helper package resolver returned an invalid package location.");
    }
    const packageRoot = path.dirname(path.normalize(packageJsonPath));
    const packageRootInfo = await lstat(packageRoot);
    if (!packageRootInfo.isDirectory() || packageRootInfo.isSymbolicLink()) {
      throw new Error("Helper package root is invalid.");
    }
    const rawPackageJson = await readRegularFile(packageJsonPath, MAX_PACKAGE_JSON_BYTES);
    const packageVersion = validatePackageJson(
      JSON.parse(rawPackageJson.toString("utf8")),
      packageName,
      target
    );
    const manifestBytes = await readRegularFile(path.join(packageRoot, "manifest.json"), 32_768);
    const untrustedManifest = JSON.parse(manifestBytes.toString("utf8")) as { binary?: { relativePath?: unknown } };
    const binaryRelativePath = untrustedManifest.binary?.relativePath;
    if (binaryRelativePath !== "bin/ts-connect" && binaryRelativePath !== "bin/ts-connect.exe") {
      throw new Error("Helper manifest binary path is invalid.");
    }
    const files = await packageInventory(packageRoot);
    validateInventory(files, binaryRelativePath);
    const binaryPath = path.join(packageRoot, binaryRelativePath);
    const [binaryBytes, noticesBytes, signatures] = await Promise.all([
      readRegularFile(binaryPath, MAX_BINARY_BYTES),
      readRegularFile(path.join(packageRoot, "THIRD_PARTY_NOTICES.txt"), MAX_NOTICES_BYTES),
      signaturesFromPackage(packageRoot, files)
    ]);
    await Promise.all([
      readRegularFile(path.join(packageRoot, "LICENSE.txt"), MAX_LICENSE_BYTES),
      readRegularFile(path.join(packageRoot, "sbom.spdx.json"), MAX_SBOM_BYTES)
    ]);
    const beforeExecution = verifyHelperPackageBeforeExecution({
      manifestBytes,
      signatures,
      binaryBytes,
      noticesBytes,
      trustRoots: options.trustRoots,
      packageName,
      packageVersion,
      target,
      appVersion: options.appVersion,
      compatibility: options.compatibility
    });
    if (target.os !== "win32") {
      const binaryInfo = await lstat(binaryPath);
      if ((binaryInfo.mode & 0o111) === 0) throw new Error("Helper binary is not executable.");
    }
    await (options.verifyPlatformSignature ?? defaultPlatformSignatureVerifier)(binaryPath, target);
    const embeddedBuildInfo = await (options.probeBinary ?? defaultBinaryProbe)(binaryPath);
    const verified = verifyHelperPackageManifest({
      manifestBytes,
      signatures,
      binaryBytes,
      noticesBytes,
      embeddedBuildInfo,
      trustRoots: options.trustRoots,
      packageName,
      packageVersion,
      target,
      appVersion: options.appVersion,
      compatibility: options.compatibility
    });
    return Object.freeze({
      packageName,
      packageRoot,
      binaryPath,
      binarySha256: verified.manifest.binary.sha256,
      helperVersion: verified.manifest.helperVersion,
      releaseSequence: verified.manifest.releaseSequence,
      forkCommit: verified.manifest.forkCommit,
      target: verified.manifest.target,
      capabilities: Object.freeze([...verified.manifest.capabilities]),
      ipcProtocol: Object.freeze({
        minimum: Object.freeze({
          major: verified.manifest.protocols.ipc.major,
          minor: verified.manifest.protocols.ipc.minimumMinor
        }),
        maximum: Object.freeze({
          major: verified.manifest.protocols.ipc.major,
          minor: verified.manifest.protocols.ipc.maximumMinor
        })
      })
    });
  } catch (error) {
    throw wrapResolutionError(error);
  }
}

export function createTsConnectPackageResolver(
  options: Omit<ResolveTsConnectBinaryOptions, "appVersion">
): HelperPackageResolver {
  return Object.freeze({
    resolve: async (input) => resolveTsConnectBinary({
      ...options,
      appVersion: input.appVersion
    })
  });
}
