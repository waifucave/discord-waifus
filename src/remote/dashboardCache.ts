import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  utimes
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  DASHBOARD_ASSET_MAX_BYTES,
  DASHBOARD_MANIFEST_FILENAME,
  DashboardManifestSchema,
  type DashboardAsset,
  type DashboardManifest
} from "../shared/schemas/remoteAccess.js";
import {
  Base64Url32BytesSchema,
  Uint64DecimalSchema
} from "../shared/schemas/remoteProtocol.js";
import {
  dashboardContentTypeForPath,
  parseDashboardManifestBytes,
  serializeDashboardManifest
} from "./dashboardManifest.js";
import { remoteStatePaths } from "./paths.js";

export const DASHBOARD_BUILD_MAX_BYTES = 64 * 1024 * 1024;
export const DASHBOARD_CACHE_MAX_BYTES = 256 * 1024 * 1024;
export const DASHBOARD_BUILDS_PER_HOST = 2;

const BUILD_ID_PATTERN = /^[0-9a-f]{64}$/u;

const DashboardCacheHostKeySchema = z.object({
  hostId: Base64Url32BytesSchema,
  trustEpoch: Uint64DecimalSchema.refine((value) => BigInt(value) > 0n)
}).strict();

export type DashboardCacheHostKey = z.infer<typeof DashboardCacheHostKeySchema>;

export type DashboardAssetSource = {
  readonly contentType: string;
  readonly body: Uint8Array | AsyncIterable<Uint8Array>;
};

export type DashboardAssetReader = (
  asset: DashboardAsset,
  signal?: AbortSignal
) => Promise<DashboardAssetSource>;

export type VerifiedDashboardBuild = {
  readonly directory: string;
  readonly manifest: DashboardManifest;
};

export type DashboardCacheLimits = {
  readonly buildMaxBytes: number;
  readonly cacheMaxBytes: number;
  readonly buildsPerHost: number;
};

export type DashboardCacheOptions = {
  readonly dataRoot: string;
  readonly limits?: Partial<DashboardCacheLimits>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
};

export type DashboardCacheErrorCode =
  | "dashboard_cache_path_invalid"
  | "dashboard_cache_entry_invalid"
  | "dashboard_asset_symlink"
  | "dashboard_asset_not_regular"
  | "dashboard_asset_set_mismatch"
  | "dashboard_asset_content_type_mismatch"
  | "dashboard_asset_size_mismatch"
  | "dashboard_asset_hash_mismatch"
  | "dashboard_asset_too_large"
  | "dashboard_build_too_large"
  | "dashboard_download_cancelled"
  | "dashboard_download_failed";

export class DashboardCacheError extends Error {
  constructor(
    readonly code: DashboardCacheErrorCode,
    detail: string
  ) {
    super(`${code}: ${detail}`);
    this.name = "DashboardCacheError";
  }
}

type CacheBuild = {
  readonly hostId: string;
  readonly directory: string;
  readonly byteSize: number;
  readonly lastAccessMs: number;
};

function cacheError(code: DashboardCacheErrorCode, detail: string): never {
  throw new DashboardCacheError(code, detail);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function validateLimits(options: DashboardCacheOptions["limits"]): DashboardCacheLimits {
  const limits = {
    buildMaxBytes: options?.buildMaxBytes ?? DASHBOARD_BUILD_MAX_BYTES,
    cacheMaxBytes: options?.cacheMaxBytes ?? DASHBOARD_CACHE_MAX_BYTES,
    buildsPerHost: options?.buildsPerHost ?? DASHBOARD_BUILDS_PER_HOST
  };
  if (
    !Number.isSafeInteger(limits.buildMaxBytes)
    || limits.buildMaxBytes < 1
    || limits.buildMaxBytes > DASHBOARD_BUILD_MAX_BYTES
    || !Number.isSafeInteger(limits.cacheMaxBytes)
    || limits.cacheMaxBytes < 1
    || limits.cacheMaxBytes > DASHBOARD_CACHE_MAX_BYTES
    || !Number.isSafeInteger(limits.buildsPerHost)
    || limits.buildsPerHost < 1
    || limits.buildsPerHost > DASHBOARD_BUILDS_PER_HOST
  ) {
    throw new RangeError("Dashboard cache limits must be positive and cannot exceed V1 caps.");
  }
  return Object.freeze(limits);
}

function expectedBuildBytes(manifest: DashboardManifest, limit: number): number {
  let total = 0;
  for (const asset of manifest.assets) {
    const byteSize = Number(asset.byteSize);
    if (!Number.isSafeInteger(byteSize) || byteSize < 1 || byteSize > DASHBOARD_ASSET_MAX_BYTES) {
      return cacheError("dashboard_asset_too_large", "Dashboard asset size is outside the V1 cap.");
    }
    total += byteSize;
    if (!Number.isSafeInteger(total) || total > limit) {
      return cacheError("dashboard_build_too_large", "Dashboard build exceeds the V1 cache cap.");
    }
  }
  return total;
}

function parentDirectories(relativePath: string): string[] {
  const directories: string[] = [];
  let current = path.posix.dirname(relativePath);
  while (current !== ".") {
    directories.push(current);
    current = path.posix.dirname(current);
  }
  return directories;
}

function validateManifest(value: DashboardManifest, buildLimit: number): DashboardManifest {
  const manifest = DashboardManifestSchema.parse(value);
  serializeDashboardManifest(manifest);
  for (const asset of manifest.assets) {
    if (dashboardContentTypeForPath(asset.path) !== asset.contentType) {
      return cacheError(
        "dashboard_asset_content_type_mismatch",
        "Dashboard asset content type does not match its normalized path."
      );
    }
  }
  expectedBuildBytes(manifest, buildLimit);
  return manifest;
}

function validateHostKey(value: DashboardCacheHostKey): DashboardCacheHostKey {
  return DashboardCacheHostKeySchema.parse(value);
}

async function ownedDirectory(
  directory: string,
  create: boolean,
  enforceMode = true
): Promise<void> {
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (missing(error)) {
      return cacheError("dashboard_cache_path_invalid", "Dashboard cache directory is missing.");
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return cacheError("dashboard_cache_path_invalid", "Dashboard cache path is not a real directory.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    return cacheError("dashboard_cache_path_invalid", "Dashboard cache path has the wrong owner.");
  }
  if (enforceMode) await chmod(directory, 0o700);
}

async function safeFileBytes(
  filePath: string,
  maximumBytes: number,
  symlinkCode: DashboardCacheErrorCode = "dashboard_asset_symlink"
): Promise<Buffer> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink()) {
    return cacheError(symlinkCode, "Dashboard cache file is a symlink.");
  }
  if (!before.isFile()) {
    return cacheError("dashboard_asset_not_regular", "Dashboard cache file is not regular.");
  }
  if (
    typeof process.getuid === "function"
    && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0)
  ) {
    return cacheError("dashboard_asset_not_regular", "Dashboard cache file permissions are unsafe.");
  }
  if (before.size < 1 || before.size > maximumBytes) {
    return cacheError("dashboard_asset_size_mismatch", "Dashboard cache file size is invalid.");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      return cacheError(symlinkCode, "Dashboard cache file is a symlink.");
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
      return cacheError("dashboard_asset_not_regular", "Dashboard cache file changed before reading.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== opened.size
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      return cacheError("dashboard_asset_not_regular", "Dashboard cache file changed while reading.");
    }
    const afterPath = await lstat(filePath);
    if (
      afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || afterPath.dev !== opened.dev
      || afterPath.ino !== opened.ino
    ) {
      return cacheError(
        afterPath.isSymbolicLink() ? symlinkCode : "dashboard_asset_not_regular",
        "Dashboard cache file path changed while reading."
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function scanBuildDirectory(directory: string): Promise<{
  readonly files: readonly string[];
  readonly directories: readonly string[];
}> {
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (currentDirectory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const filePath = path.join(currentDirectory, entry.name);
      const metadata = await lstat(filePath);
      if (metadata.isSymbolicLink()) {
        return cacheError("dashboard_asset_symlink", "Dashboard cache contains a symlink.");
      }
      if (metadata.isDirectory()) {
        if (
          typeof process.getuid === "function"
          && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)
        ) {
          return cacheError("dashboard_cache_entry_invalid", "Dashboard cache directory permissions are unsafe.");
        }
        directories.push(relativePath);
        await visit(filePath, relativePath);
      } else if (metadata.isFile()) {
        files.push(relativePath);
      } else {
        return cacheError("dashboard_asset_not_regular", "Dashboard cache contains a special file.");
      }
    }
  };
  await visit(directory, "");
  return { files, directories };
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) {
      return cacheError("dashboard_download_failed", "Dashboard cache write made no progress.");
    }
    offset += result.bytesWritten;
  }
}

async function* sourceChunks(
  body: DashboardAssetSource["body"]
): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  if (!body || typeof body[Symbol.asyncIterator] !== "function") {
    return cacheError("dashboard_download_failed", "Dashboard asset source is not a byte stream.");
  }
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      return cacheError("dashboard_download_failed", "Dashboard asset stream emitted non-byte data.");
    }
    yield chunk;
  }
}

export class DashboardCache {
  readonly #dataRoot: string;
  readonly #cacheRoot: string;
  readonly #limits: DashboardCacheLimits;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(options: DashboardCacheOptions) {
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#cacheRoot = remoteStatePaths(this.#dataRoot).dashboardCacheRoot;
    this.#limits = validateLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  async openVerified(
    hostKeyValue: DashboardCacheHostKey,
    manifestValue: DashboardManifest
  ): Promise<VerifiedDashboardBuild | null> {
    return this.#exclusive(async () => {
      await this.#initialize();
      const hostKey = validateHostKey(hostKeyValue);
      const manifest = validateManifest(
        manifestValue,
        Math.min(this.#limits.buildMaxBytes, this.#limits.cacheMaxBytes)
      );
      await this.#removeOtherTrustEpochs(hostKey);
      const opened = await this.#openVerified(hostKey, manifest, true);
      await this.#evict();
      return opened;
    });
  }

  async install(
    hostKeyValue: DashboardCacheHostKey,
    manifestValue: DashboardManifest,
    readAsset: DashboardAssetReader,
    options: { signal?: AbortSignal } = {}
  ): Promise<VerifiedDashboardBuild> {
    return this.#exclusive(async () => {
      await this.#initialize();
      const hostKey = validateHostKey(hostKeyValue);
      const manifest = validateManifest(
        manifestValue,
        Math.min(this.#limits.buildMaxBytes, this.#limits.cacheMaxBytes)
      );
      await this.#removeOtherTrustEpochs(hostKey);
      const existing = await this.#tryExisting(hostKey, manifest);
      if (existing) {
        await this.#evict();
        return existing;
      }
      this.#throwIfCancelled(options.signal);
      const staging = await this.#newStagingDirectory();
      let promoted = false;
      try {
        for (const asset of manifest.assets) {
          this.#throwIfCancelled(options.signal);
          const destination = path.join(staging, ...asset.path.split("/"));
          await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          const source = await this.#readSource(readAsset, asset, options.signal);
          if (source.contentType !== asset.contentType) {
            return cacheError(
              "dashboard_asset_content_type_mismatch",
              "Downloaded dashboard asset content type differs from its manifest."
            );
          }
          await this.#writeAsset(destination, asset, source.body, options.signal);
        }
        await this.#writeManifest(staging, manifest);
        await this.#verifyBuild(staging, manifest);
        const destination = this.#buildDirectory(hostKey, manifest.buildId);
        await this.#ensureBuildParent(hostKey);
        try {
          await lstat(destination);
          await rm(destination, { recursive: true, force: true });
        } catch (error) {
          if (!missing(error)) throw error;
        }
        await rename(staging, destination);
        promoted = true;
        await this.#touch(destination);
        await this.#evict();
        return { directory: destination, manifest };
      } catch (error) {
        if (options.signal?.aborted && !(error instanceof DashboardCacheError)) {
          return cacheError("dashboard_download_cancelled", "Dashboard download was cancelled.");
        }
        throw error;
      } finally {
        if (!promoted) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  async evict(): Promise<void> {
    await this.#exclusive(async () => {
      await this.#initialize();
      await this.#evict();
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prior = this.#operationTail;
    this.#operationTail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #initialize(): Promise<void> {
    const relative = path.relative(this.#dataRoot, this.#cacheRoot).split(path.sep);
    let current = this.#dataRoot;
    await mkdir(current, { recursive: true, mode: 0o700 });
    await ownedDirectory(current, false, false);
    for (const segment of relative) {
      current = path.join(current, segment);
      await ownedDirectory(current, true);
    }
    await ownedDirectory(path.join(this.#cacheRoot, "hosts"), true);
  }

  #buildDirectory(hostKey: DashboardCacheHostKey, buildId: string): string {
    return path.join(
      this.#cacheRoot,
      "hosts",
      hostKey.hostId,
      hostKey.trustEpoch,
      buildId
    );
  }

  async #ensureBuildParent(hostKey: DashboardCacheHostKey): Promise<void> {
    const hosts = path.join(this.#cacheRoot, "hosts");
    const host = path.join(hosts, hostKey.hostId);
    const epoch = path.join(host, hostKey.trustEpoch);
    await ownedDirectory(hosts, false);
    await ownedDirectory(host, true);
    await ownedDirectory(epoch, true);
  }

  async #newStagingDirectory(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = Buffer.from(this.#randomBytes(16));
      if (bytes.byteLength !== 16) {
        bytes.fill(0);
        return cacheError("dashboard_download_failed", "Dashboard staging entropy is invalid.");
      }
      const directory = path.join(this.#cacheRoot, `.staging-${bytes.toString("hex")}`);
      bytes.fill(0);
      try {
        await mkdir(directory, { mode: 0o700 });
        return directory;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return cacheError("dashboard_download_failed", "Dashboard staging name could not be allocated.");
  }

  async #readSource(
    readAsset: DashboardAssetReader,
    asset: DashboardAsset,
    signal?: AbortSignal
  ): Promise<DashboardAssetSource> {
    try {
      const source = await readAsset(asset, signal);
      if (
        !source
        || typeof source !== "object"
        || typeof source.contentType !== "string"
        || source.body === undefined
      ) {
        return cacheError("dashboard_download_failed", "Dashboard asset source is invalid.");
      }
      return source;
    } catch (error) {
      if (signal?.aborted) {
        return cacheError("dashboard_download_cancelled", "Dashboard download was cancelled.");
      }
      if (error instanceof DashboardCacheError) throw error;
      return cacheError("dashboard_download_failed", "Dashboard asset source failed.");
    }
  }

  async #writeAsset(
    destination: string,
    asset: DashboardAsset,
    body: DashboardAssetSource["body"],
    signal?: AbortSignal
  ): Promise<void> {
    const handle = await open(destination, "wx", 0o600);
    const hash = createHash("sha256");
    let byteSize = 0;
    try {
      for await (const chunk of sourceChunks(body)) {
        this.#throwIfCancelled(signal);
        byteSize += chunk.byteLength;
        if (byteSize > DASHBOARD_ASSET_MAX_BYTES || byteSize > Number(asset.byteSize)) {
          return cacheError(
            byteSize > DASHBOARD_ASSET_MAX_BYTES
              ? "dashboard_asset_too_large"
              : "dashboard_asset_size_mismatch",
            "Downloaded dashboard asset exceeded its declared size."
          );
        }
        hash.update(chunk);
        await writeAll(handle, chunk);
      }
      this.#throwIfCancelled(signal);
      if (byteSize !== Number(asset.byteSize)) {
        return cacheError(
          "dashboard_asset_size_mismatch",
          "Downloaded dashboard asset size differs from its manifest."
        );
      }
      if (hash.digest("hex") !== asset.sha256) {
        return cacheError(
          "dashboard_asset_hash_mismatch",
          "Downloaded dashboard asset hash differs from its manifest."
        );
      }
      await handle.sync();
    } catch (error) {
      if (signal?.aborted && !(error instanceof DashboardCacheError)) {
        return cacheError("dashboard_download_cancelled", "Dashboard download was cancelled.");
      }
      if (error instanceof DashboardCacheError) throw error;
      return cacheError("dashboard_download_failed", "Dashboard asset stream failed.");
    } finally {
      await handle.close();
    }
  }

  async #writeManifest(directory: string, manifest: DashboardManifest): Promise<void> {
    const filePath = path.join(directory, DASHBOARD_MANIFEST_FILENAME);
    const handle = await open(filePath, "wx", 0o600);
    try {
      await writeAll(handle, Buffer.from(serializeDashboardManifest(manifest), "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  #throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
      return cacheError("dashboard_download_cancelled", "Dashboard download was cancelled.");
    }
  }

  async #tryExisting(
    hostKey: DashboardCacheHostKey,
    manifest: DashboardManifest
  ): Promise<VerifiedDashboardBuild | null> {
    const directory = this.#buildDirectory(hostKey, manifest.buildId);
    try {
      await lstat(directory);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      await this.#verifyBuild(directory, manifest);
      await this.#touch(directory);
      return { directory, manifest };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (!(error instanceof DashboardCacheError)) throw error;
      return null;
    }
  }

  async #openVerified(
    hostKey: DashboardCacheHostKey,
    manifest: DashboardManifest,
    touch: boolean
  ): Promise<VerifiedDashboardBuild | null> {
    const directory = this.#buildDirectory(hostKey, manifest.buildId);
    try {
      await lstat(directory);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    await this.#verifyBuild(directory, manifest);
    if (touch) await this.#touch(directory);
    return { directory, manifest };
  }

  async #verifyBuild(directory: string, manifest: DashboardManifest): Promise<void> {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return cacheError("dashboard_cache_entry_invalid", "Dashboard build is not a real directory.");
    }
    if (
      typeof process.getuid === "function"
      && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0)
    ) {
      return cacheError("dashboard_cache_entry_invalid", "Dashboard build permissions are unsafe.");
    }
    const expectedFiles = [
      DASHBOARD_MANIFEST_FILENAME,
      ...manifest.assets.map((asset) => asset.path)
    ].sort();
    const expectedDirectories = new Set(
      manifest.assets.flatMap((asset) => parentDirectories(asset.path))
    );
    const before = await scanBuildDirectory(directory);
    if (
      before.files.length !== expectedFiles.length
      || before.files.some((file, index) => file !== expectedFiles[index])
      || before.directories.some((entry) => !expectedDirectories.has(entry))
    ) {
      return cacheError("dashboard_asset_set_mismatch", "Dashboard cache asset set differs from its manifest.");
    }
    const encodedManifest = await safeFileBytes(
      path.join(directory, DASHBOARD_MANIFEST_FILENAME),
      4 * 1024 * 1024
    );
    if (encodedManifest.toString("utf8") !== serializeDashboardManifest(manifest)) {
      return cacheError("dashboard_asset_hash_mismatch", "Cached dashboard manifest bytes differ.");
    }
    for (const asset of manifest.assets) {
      if (dashboardContentTypeForPath(asset.path) !== asset.contentType) {
        return cacheError(
          "dashboard_asset_content_type_mismatch",
          "Cached dashboard content type differs from its path."
        );
      }
      const bytes = await safeFileBytes(
        path.join(directory, ...asset.path.split("/")),
        DASHBOARD_ASSET_MAX_BYTES
      );
      if (bytes.byteLength !== Number(asset.byteSize)) {
        return cacheError("dashboard_asset_size_mismatch", "Cached dashboard asset size differs.");
      }
      if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
        return cacheError("dashboard_asset_hash_mismatch", "Cached dashboard asset hash differs.");
      }
    }
    const after = await scanBuildDirectory(directory);
    if (
      after.files.length !== before.files.length
      || after.files.some((file, index) => file !== before.files[index])
      || after.directories.length !== before.directories.length
      || after.directories.some((entry, index) => entry !== before.directories[index])
    ) {
      return cacheError("dashboard_asset_set_mismatch", "Dashboard cache changed during verification.");
    }
  }

  async #touch(directory: string): Promise<void> {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0) {
      return cacheError("dashboard_cache_entry_invalid", "Dashboard cache clock is invalid.");
    }
    const date = new Date(now);
    await utimes(directory, date, date);
  }

  async #removeOtherTrustEpochs(hostKey: DashboardCacheHostKey): Promise<void> {
    const hostDirectory = path.join(this.#cacheRoot, "hosts", hostKey.hostId);
    let entries;
    try {
      const metadata = await lstat(hostDirectory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        return cacheError("dashboard_cache_path_invalid", "Dashboard host cache is not a real directory.");
      }
      entries = await readdir(hostDirectory, { withFileTypes: true });
    } catch (error) {
      if (missing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name !== hostKey.trustEpoch) {
        await rm(path.join(hostDirectory, entry.name), { recursive: true, force: true });
      }
    }
  }

  async #evict(): Promise<void> {
    const rootEntries = await readdir(this.#cacheRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.name.startsWith(".staging-")) {
        await rm(path.join(this.#cacheRoot, entry.name), { recursive: true, force: true });
      }
    }
    const builds = await this.#scanBuilds();
    const retained = new Set(builds.map((build) => build.directory));
    const byHost = new Map<string, CacheBuild[]>();
    for (const build of builds) {
      const group = byHost.get(build.hostId) ?? [];
      group.push(build);
      byHost.set(build.hostId, group);
    }
    for (const group of byHost.values()) {
      group.sort((left, right) => (
        right.lastAccessMs - left.lastAccessMs
        || right.directory.localeCompare(left.directory)
      ));
      for (const build of group.slice(this.#limits.buildsPerHost)) {
        await rm(build.directory, { recursive: true, force: true });
        retained.delete(build.directory);
      }
    }
    const global = builds
      .filter((build) => retained.has(build.directory))
      .sort((left, right) => (
        left.lastAccessMs - right.lastAccessMs
        || left.directory.localeCompare(right.directory)
      ));
    let total = global.reduce((sum, build) => sum + build.byteSize, 0);
    for (const build of global) {
      if (total <= this.#limits.cacheMaxBytes) break;
      await rm(build.directory, { recursive: true, force: true });
      total -= build.byteSize;
    }
  }

  async #scanBuilds(): Promise<CacheBuild[]> {
    const hostsRoot = path.join(this.#cacheRoot, "hosts");
    const builds: CacheBuild[] = [];
    const hostEntries = await readdir(hostsRoot, { withFileTypes: true });
    for (const hostEntry of hostEntries) {
      const hostDirectory = path.join(hostsRoot, hostEntry.name);
      if (!hostEntry.isDirectory() || !Base64Url32BytesSchema.safeParse(hostEntry.name).success) {
        await rm(hostDirectory, { recursive: true, force: true });
        continue;
      }
      const epochEntries = await readdir(hostDirectory, { withFileTypes: true });
      for (const epochEntry of epochEntries) {
        const epochDirectory = path.join(hostDirectory, epochEntry.name);
        if (
          !epochEntry.isDirectory()
          || !Uint64DecimalSchema.safeParse(epochEntry.name).success
          || BigInt(epochEntry.name) < 1n
        ) {
          await rm(epochDirectory, { recursive: true, force: true });
          continue;
        }
        const buildEntries = await readdir(epochDirectory, { withFileTypes: true });
        for (const buildEntry of buildEntries) {
          const directory = path.join(epochDirectory, buildEntry.name);
          if (!buildEntry.isDirectory() || !BUILD_ID_PATTERN.test(buildEntry.name)) {
            await rm(directory, { recursive: true, force: true });
            continue;
          }
          try {
            const manifestBytes = await safeFileBytes(
              path.join(directory, DASHBOARD_MANIFEST_FILENAME),
              4 * 1024 * 1024
            );
            const manifest = validateManifest(
              parseDashboardManifestBytes(manifestBytes),
              this.#limits.buildMaxBytes
            );
            if (manifest.buildId !== buildEntry.name) {
              return cacheError("dashboard_cache_entry_invalid", "Dashboard cache build ID path differs.");
            }
            await this.#verifyBuild(directory, manifest);
            const metadata = await lstat(directory);
            builds.push({
              hostId: hostEntry.name,
              directory,
              byteSize: expectedBuildBytes(manifest, this.#limits.buildMaxBytes),
              lastAccessMs: metadata.mtimeMs
            });
          } catch {
            await rm(directory, { recursive: true, force: true });
          }
        }
      }
    }
    return builds;
  }
}
