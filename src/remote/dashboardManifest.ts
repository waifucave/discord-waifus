import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import {
  DASHBOARD_ASSET_MAX_BYTES,
  DASHBOARD_ASSET_MAX_COUNT,
  DASHBOARD_MANIFEST_FILENAME,
  DashboardAssetSchema,
  DashboardManifestSchema,
  type DashboardAsset,
  type DashboardManifest
} from "../shared/schemas/remoteAccess.js";
import { INITIAL_REQUIRED_CAPABILITIES } from "../shared/schemas/remoteProtocol.js";
import {
  serializeCanonicalContractJson,
  type ContractJson
} from "../shared/schemas/remoteProtocolContract.js";

export {
  DASHBOARD_ASSET_MAX_BYTES,
  DASHBOARD_MANIFEST_FILENAME
} from "../shared/schemas/remoteAccess.js";

export const DASHBOARD_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const DASHBOARD_CONTENT_TYPES = new Map<string, DashboardAsset["contentType"]>([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

export type DashboardManifestErrorCode =
  | "dashboard_manifest_too_large"
  | "invalid_dashboard_manifest"
  | "noncanonical_dashboard_manifest"
  | "dashboard_build_id_mismatch"
  | "dashboard_asset_symlink"
  | "dashboard_asset_not_regular"
  | "dashboard_asset_too_large"
  | "dashboard_asset_count"
  | "dashboard_asset_content_type"
  | "dashboard_asset_set_mismatch"
  | "dashboard_asset_size_mismatch"
  | "dashboard_asset_hash_mismatch"
  | "dashboard_asset_content_type_mismatch";

export class DashboardManifestError extends Error {
  constructor(
    readonly code: DashboardManifestErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "DashboardManifestError";
  }
}

function fail(code: DashboardManifestErrorCode, detail: string): never {
  throw new DashboardManifestError(code, detail);
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return serializeCanonicalContractJson(value as ContractJson);
}

function contentTypeForAsset(relativePath: string): DashboardAsset["contentType"] {
  const extension = path.posix.extname(relativePath).toLowerCase();
  const contentType = DASHBOARD_CONTENT_TYPES.get(extension);
  if (!contentType) {
    return fail(
      "dashboard_asset_content_type",
      `dashboard asset ${relativePath} has an unsupported extension.`
    );
  }
  return contentType;
}

async function readVerifiedRegularFile(
  filePath: string,
  displayPath: string,
  before: Awaited<ReturnType<typeof lstat>>,
  maximumBytes: number,
  sizeErrorCode: "dashboard_manifest_too_large" | "dashboard_asset_too_large"
): Promise<Buffer> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return fail("dashboard_asset_symlink", `${displayPath} is a symlink.`);
    }
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      return fail("dashboard_asset_not_regular", `${displayPath} changed before verification.`);
    }
    if (opened.size < 1 || opened.size > maximumBytes) {
      return fail(sizeErrorCode, `${displayPath} is outside its allowed byte size.`);
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    if (
      bytes.byteLength !== opened.size
      || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.ctimeMs !== opened.ctimeMs
    ) {
      return fail("dashboard_asset_not_regular", `${displayPath} changed during verification.`);
    }
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
    ) {
      return fail(
        afterPath.isSymbolicLink() ? "dashboard_asset_symlink" : "dashboard_asset_not_regular",
        `${displayPath} changed after verification.`
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

interface ScannedDashboardAsset {
  path: string;
  byteSize: string;
  sha256: string;
  contentType: DashboardAsset["contentType"];
}

interface DashboardScanState {
  count: number;
}

async function validateDashboardBundleDirectory(bundleDirectory: string): Promise<void> {
  const metadata = await lstat(bundleDirectory);
  if (metadata.isSymbolicLink()) {
    return fail("dashboard_asset_symlink", "dashboard bundle root is a symlink.");
  }
  if (!metadata.isDirectory()) {
    return fail("dashboard_asset_not_regular", "dashboard bundle root is not a directory.");
  }
}

async function scanDashboardAssetDirectory(
  bundleDirectory: string,
  relativeDirectory = "",
  state: DashboardScanState = { count: 0 }
): Promise<ScannedDashboardAsset[]> {
  const directory = relativeDirectory === ""
    ? bundleDirectory
    : path.join(bundleDirectory, ...relativeDirectory.split("/"));
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);

  const assets: ScannedDashboardAsset[] = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory === ""
      ? entry.name
      : `${relativeDirectory}/${entry.name}`;
    const filePath = path.join(directory, entry.name);
    const metadata = await lstat(filePath);
    if (metadata.isSymbolicLink()) {
      return fail("dashboard_asset_symlink", `dashboard path ${relativePath} is a symlink.`);
    }
    if (metadata.isDirectory()) {
      assets.push(...await scanDashboardAssetDirectory(bundleDirectory, relativePath, state));
      continue;
    }
    if (!metadata.isFile()) {
      return fail("dashboard_asset_not_regular", `dashboard path ${relativePath} is not a regular file.`);
    }
    if (relativePath === DASHBOARD_MANIFEST_FILENAME) {
      continue;
    }
    state.count += 1;
    if (state.count > DASHBOARD_ASSET_MAX_COUNT) {
      return fail(
        "dashboard_asset_count",
        `dashboard bundles must not exceed ${DASHBOARD_ASSET_MAX_COUNT} assets.`
      );
    }
    if (metadata.size < 1 || metadata.size > DASHBOARD_ASSET_MAX_BYTES) {
      return fail(
        "dashboard_asset_too_large",
        `dashboard asset ${relativePath} must contain 1-${DASHBOARD_ASSET_MAX_BYTES} bytes.`
      );
    }
    const contentType = contentTypeForAsset(relativePath);
    const bytes = await readVerifiedRegularFile(
      filePath,
      `dashboard asset ${relativePath}`,
      metadata,
      DASHBOARD_ASSET_MAX_BYTES,
      "dashboard_asset_too_large"
    );
    assets.push({
      path: relativePath,
      byteSize: bytes.byteLength.toString(10),
      sha256: sha256Hex(bytes),
      contentType
    });
  }
  return assets;
}

function publicAssets(assets: readonly ScannedDashboardAsset[]): DashboardAsset[] {
  return assets.map((asset) => DashboardAssetSchema.parse(asset));
}

export interface CreateDashboardManifestOptions {
  bundleDirectory: string;
  discordWaifusVersion: string;
  minimumHelperVersion: string;
  minimumRemoteGatewayVersion: string;
  requiredCapabilities?: readonly string[];
}

type DashboardManifestBuildInput = Omit<DashboardManifest, "buildId"> & { buildId?: string };

export function deriveDashboardBuildId(manifest: DashboardManifestBuildInput): string {
  const { buildId: _buildId, ...payload } = manifest;
  return sha256Hex(canonicalJson(payload));
}

export async function createDashboardManifest(
  options: CreateDashboardManifestOptions
): Promise<DashboardManifest> {
  const bundleDirectory = path.resolve(options.bundleDirectory);
  await validateDashboardBundleDirectory(bundleDirectory);
  const scanned = await scanDashboardAssetDirectory(bundleDirectory);
  scanned.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const input: DashboardManifestBuildInput = {
    schemaVersion: 1,
    discordWaifusVersion: options.discordWaifusVersion,
    apiVersion: { major: 1, minor: 0 },
    transportVersion: { major: 1, minor: 0 },
    minimumHelperVersion: options.minimumHelperVersion,
    minimumRemoteGatewayVersion: options.minimumRemoteGatewayVersion,
    requiredCapabilities: [
      ...(options.requiredCapabilities ?? INITIAL_REQUIRED_CAPABILITIES)
    ],
    assets: publicAssets(scanned)
  };
  const value = {
    ...input,
    buildId: deriveDashboardBuildId(input)
  };
  const parsed = DashboardManifestSchema.safeParse(value);
  if (!parsed.success) {
    return fail("invalid_dashboard_manifest", "generated dashboard metadata violates the V1 schema.");
  }
  return parsed.data;
}

export function serializeDashboardManifest(manifest: DashboardManifest): string {
  const parsed = DashboardManifestSchema.safeParse(manifest);
  if (!parsed.success) {
    return fail("invalid_dashboard_manifest", "dashboard metadata violates the V1 schema.");
  }
  if (deriveDashboardBuildId(parsed.data) !== parsed.data.buildId) {
    return fail(
      "dashboard_build_id_mismatch",
      "dashboard build ID does not authenticate its canonical metadata."
    );
  }
  return canonicalJson(parsed.data);
}

export function parseDashboardManifestBytes(bytes: Uint8Array): DashboardManifest {
  const encoded = Buffer.from(bytes);
  if (encoded.byteLength < 1 || encoded.byteLength > DASHBOARD_MANIFEST_MAX_BYTES) {
    return fail(
      "dashboard_manifest_too_large",
      `dashboard manifest must contain 1-${DASHBOARD_MANIFEST_MAX_BYTES} bytes.`
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(UTF8_DECODER.decode(encoded));
  } catch {
    return fail("invalid_dashboard_manifest", "dashboard manifest must be one UTF-8 JSON value.");
  }
  const parsed = DashboardManifestSchema.safeParse(decoded);
  if (!parsed.success) {
    return fail("invalid_dashboard_manifest", "dashboard manifest violates the strict V1 schema.");
  }
  if (canonicalJson(parsed.data) !== encoded.toString("utf8")) {
    return fail(
      "noncanonical_dashboard_manifest",
      "dashboard manifest bytes are not canonical JSON."
    );
  }
  if (deriveDashboardBuildId(parsed.data) !== parsed.data.buildId) {
    return fail(
      "dashboard_build_id_mismatch",
      "dashboard build ID does not authenticate its canonical metadata."
    );
  }
  return parsed.data;
}

export async function writeDashboardManifest(
  options: CreateDashboardManifestOptions
): Promise<DashboardManifest> {
  const manifest = await createDashboardManifest(options);
  const bundleDirectory = path.resolve(options.bundleDirectory);
  const destination = path.join(bundleDirectory, DASHBOARD_MANIFEST_FILENAME);
  const temporary = path.join(
    bundleDirectory,
    `.${DASHBOARD_MANIFEST_FILENAME}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await writeFile(temporary, serializeDashboardManifest(manifest), {
      encoding: "utf8",
      mode: 0o644
    });
    await rename(temporary, destination);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // Preserve the original atomic replace error.
    }
    throw error;
  }
  return manifest;
}

function compareAssetSets(
  declared: readonly DashboardAsset[],
  scanned: readonly ScannedDashboardAsset[]
): void {
  if (
    declared.length !== scanned.length
    || declared.some((asset, index) => asset.path !== scanned[index]?.path)
  ) {
    return fail(
      "dashboard_asset_set_mismatch",
      "dashboard directory does not contain exactly the declared asset set."
    );
  }
  for (let index = 0; index < declared.length; index += 1) {
    const expected = declared[index];
    const actual = scanned[index];
    if (expected.byteSize !== actual.byteSize) {
      return fail(
        "dashboard_asset_size_mismatch",
        `dashboard asset ${expected.path} size differs from its manifest.`
      );
    }
    if (expected.sha256 !== actual.sha256) {
      return fail(
        "dashboard_asset_hash_mismatch",
        `dashboard asset ${expected.path} hash differs from its manifest.`
      );
    }
    if (expected.contentType !== actual.contentType) {
      return fail(
        "dashboard_asset_content_type_mismatch",
        `dashboard asset ${expected.path} content type differs from its manifest.`
      );
    }
  }
}

export async function loadBundledDashboardManifest(
  packageRoot: string
): Promise<DashboardManifest> {
  try {
    const bundleDirectory = path.resolve(packageRoot, "dist-frontend");
    await validateDashboardBundleDirectory(bundleDirectory);
    const manifestPath = path.join(bundleDirectory, DASHBOARD_MANIFEST_FILENAME);
    const metadata = await lstat(manifestPath);
    if (metadata.isSymbolicLink()) {
      return fail("dashboard_asset_symlink", "dashboard manifest is a symlink.");
    }
    if (!metadata.isFile()) {
      return fail("dashboard_asset_not_regular", "dashboard manifest is not a regular file.");
    }
    if (metadata.size < 1 || metadata.size > DASHBOARD_MANIFEST_MAX_BYTES) {
      return fail(
        "dashboard_manifest_too_large",
        `dashboard manifest must contain 1-${DASHBOARD_MANIFEST_MAX_BYTES} bytes.`
      );
    }
    const manifestBytes = await readVerifiedRegularFile(
      manifestPath,
      "dashboard manifest",
      metadata,
      DASHBOARD_MANIFEST_MAX_BYTES,
      "dashboard_manifest_too_large"
    );
    const manifest = parseDashboardManifestBytes(manifestBytes);
    const scanned = await scanDashboardAssetDirectory(bundleDirectory);
    scanned.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    compareAssetSets(manifest.assets, scanned);
    return manifest;
  } catch (error) {
    if (error instanceof DashboardManifestError) {
      throw error;
    }
    return fail(
      "dashboard_asset_not_regular",
      "dashboard bundle filesystem state could not be verified."
    );
  }
}
