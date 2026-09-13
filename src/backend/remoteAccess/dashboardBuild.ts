import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  DASHBOARD_ASSET_MAX_BYTES,
  DASHBOARD_MANIFEST_FILENAME,
  type DashboardAsset,
  type DashboardManifest
} from "../../shared/schemas/remoteAccess.js";
import {
  DASHBOARD_MANIFEST_MAX_BYTES,
  dashboardContentTypeForPath,
  loadBundledDashboardManifest,
  serializeDashboardManifest
} from "../../remote/dashboardManifest.js";
import { DASHBOARD_BUILD_MAX_BYTES } from "../../remote/dashboardCache.js";

export type DashboardBuildErrorCode =
  | "dashboard_asset_cancelled"
  | "dashboard_asset_not_found"
  | "dashboard_build_changed"
  | "dashboard_build_too_large"
  | "dashboard_build_unavailable";

export class DashboardBuildError extends Error {
  constructor(readonly code: DashboardBuildErrorCode) {
    const message = code === "dashboard_asset_not_found"
      ? "The requested dashboard asset is not part of the current build."
      : code === "dashboard_asset_cancelled"
        ? "The dashboard asset request was cancelled."
        : code === "dashboard_build_too_large"
          ? "The dashboard build exceeds the supported size."
          : code === "dashboard_build_changed"
            ? "The pinned dashboard build changed after validation."
            : "The bundled dashboard build is unavailable.";
    super(message);
    this.name = "DashboardBuildError";
  }
}

export type DashboardBuildLoadOptions = {
  readonly bundleDirectory: string;
  readonly expectedBuildId?: string;
};

export type OpenedDashboardAsset = {
  readonly asset: DashboardAsset;
  readonly stream: Readable;
};

type FileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
};

type DirectoryIdentity = Omit<FileIdentity, "size">;

type PinnedDashboardAsset = {
  readonly asset: DashboardAsset;
  readonly filePath: string;
  readonly identity: FileIdentity;
};

function fail(code: DashboardBuildErrorCode): never {
  throw new DashboardBuildError(code);
}

function fileIdentity(metadata: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs
  });
}

function directoryIdentity(metadata: BigIntStats): DirectoryIdentity {
  const identity = fileIdentity(metadata);
  return Object.freeze({
    dev: identity.dev,
    ino: identity.ino,
    mtimeNs: identity.mtimeNs,
    ctimeNs: identity.ctimeNs
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function noFollowReadFlags(): number {
  return constants.O_RDONLY
    | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
}

function parentDirectories(manifest: DashboardManifest): string[] {
  const result = new Set<string>([""]);
  for (const asset of manifest.assets) {
    let current = path.posix.dirname(asset.path);
    while (current !== ".") {
      result.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...result].sort((left, right) => {
    const depth = (value: string) => value === "" ? 0 : value.split("/").length;
    return depth(left) - depth(right) || left.localeCompare(right);
  });
}

async function readPinnedFile(
  filePath: string,
  maximumBytes: number
): Promise<{ readonly bytes: Buffer; readonly identity: FileIdentity }> {
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      return fail("dashboard_build_unavailable");
    }
    if (before.size < 1n || before.size > BigInt(maximumBytes)) {
      return fail("dashboard_build_unavailable");
    }
    handle = await open(filePath, noFollowReadFlags());
    const opened = await handle.stat({ bigint: true });
    const openedIdentity = fileIdentity(opened);
    if (!opened.isFile() || !sameFileIdentity(fileIdentity(before), openedIdentity)) {
      return fail("dashboard_build_unavailable");
    }
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    if (
      bytes.byteLength !== Number(opened.size)
      || !sameFileIdentity(openedIdentity, fileIdentity(afterRead))
      || afterPath.isSymbolicLink()
      || !afterPath.isFile()
      || !sameFileIdentity(openedIdentity, fileIdentity(afterPath))
    ) {
      return fail("dashboard_build_unavailable");
    }
    return { bytes, identity: openedIdentity };
  } catch (error) {
    if (error instanceof DashboardBuildError) throw error;
    return fail("dashboard_build_unavailable");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotDirectory(directory: string): Promise<DirectoryIdentity> {
  try {
    const metadata = await lstat(directory, { bigint: true });
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return fail("dashboard_build_unavailable");
    }
    return directoryIdentity(metadata);
  } catch (error) {
    if (error instanceof DashboardBuildError) throw error;
    return fail("dashboard_build_unavailable");
  }
}

function assetFilePath(bundleDirectory: string, relativePath: string): string {
  return path.join(bundleDirectory, ...relativePath.split("/"));
}

export class DashboardBuild {
  readonly #bundleDirectory: string;
  readonly #manifest: DashboardManifest;
  readonly #manifestBytes: Buffer;
  readonly #manifestIdentity: FileIdentity;
  readonly #directories: ReadonlyMap<string, DirectoryIdentity>;
  readonly #assets: ReadonlyMap<string, PinnedDashboardAsset>;

  private constructor(input: {
    bundleDirectory: string;
    manifest: DashboardManifest;
    manifestBytes: Buffer;
    manifestIdentity: FileIdentity;
    directories: ReadonlyMap<string, DirectoryIdentity>;
    assets: ReadonlyMap<string, PinnedDashboardAsset>;
  }) {
    this.#bundleDirectory = input.bundleDirectory;
    this.#manifest = Object.freeze(structuredClone(input.manifest));
    this.#manifestBytes = Buffer.from(input.manifestBytes);
    this.#manifestIdentity = input.manifestIdentity;
    this.#directories = input.directories;
    this.#assets = input.assets;
  }

  static async load(options: DashboardBuildLoadOptions): Promise<DashboardBuild> {
    const bundleDirectory = path.resolve(options.bundleDirectory);
    const manifest = await loadBundledDashboardManifest(path.dirname(bundleDirectory));
    if (options.expectedBuildId !== undefined && manifest.buildId !== options.expectedBuildId) {
      return fail("dashboard_build_changed");
    }
    let buildBytes = 0;
    for (const asset of manifest.assets) {
      buildBytes += Number(asset.byteSize);
      if (!Number.isSafeInteger(buildBytes) || buildBytes > DASHBOARD_BUILD_MAX_BYTES) {
        return fail("dashboard_build_too_large");
      }
    }

    const directoryPaths = parentDirectories(manifest);
    const directories = new Map<string, DirectoryIdentity>();
    for (const relativePath of directoryPaths) {
      const directory = relativePath === ""
        ? bundleDirectory
        : assetFilePath(bundleDirectory, relativePath);
      directories.set(relativePath, await snapshotDirectory(directory));
    }

    const manifestFile = await readPinnedFile(
      path.join(bundleDirectory, DASHBOARD_MANIFEST_FILENAME),
      DASHBOARD_MANIFEST_MAX_BYTES
    );
    const canonicalManifest = serializeDashboardManifest(manifest);
    if (manifestFile.bytes.toString("utf8") !== canonicalManifest) {
      return fail("dashboard_build_changed");
    }

    const assets = new Map<string, PinnedDashboardAsset>();
    for (const asset of manifest.assets) {
      if (dashboardContentTypeForPath(asset.path) !== asset.contentType) {
        return fail("dashboard_build_unavailable");
      }
      const filePath = assetFilePath(bundleDirectory, asset.path);
      const verified = await readPinnedFile(filePath, DASHBOARD_ASSET_MAX_BYTES);
      if (
        verified.bytes.byteLength !== Number(asset.byteSize)
        || createHash("sha256").update(verified.bytes).digest("hex") !== asset.sha256
      ) {
        return fail("dashboard_build_changed");
      }
      assets.set(asset.path, Object.freeze({
        asset: Object.freeze(structuredClone(asset)),
        filePath,
        identity: verified.identity
      }));
    }

    for (const [relativePath, expected] of directories) {
      const directory = relativePath === ""
        ? bundleDirectory
        : assetFilePath(bundleDirectory, relativePath);
      if (!sameDirectoryIdentity(expected, await snapshotDirectory(directory))) {
        return fail("dashboard_build_changed");
      }
    }

    return new DashboardBuild({
      bundleDirectory,
      manifest,
      manifestBytes: Buffer.from(canonicalManifest, "utf8"),
      manifestIdentity: manifestFile.identity,
      directories,
      assets
    });
  }

  get buildId(): string {
    return this.#manifest.buildId;
  }

  async readManifest(): Promise<{
    readonly manifest: DashboardManifest;
    readonly bytes: Buffer;
  }> {
    await this.#assertDirectoriesUnchanged();
    await this.#assertPathIdentity(
      path.join(this.#bundleDirectory, DASHBOARD_MANIFEST_FILENAME),
      this.#manifestIdentity
    );
    return {
      manifest: structuredClone(this.#manifest),
      bytes: Buffer.from(this.#manifestBytes)
    };
  }

  async openAsset(
    buildId: string,
    relativePath: string,
    signal?: AbortSignal
  ): Promise<OpenedDashboardAsset> {
    if (buildId !== this.#manifest.buildId) return fail("dashboard_asset_not_found");
    const pinned = this.#assets.get(relativePath);
    if (!pinned) return fail("dashboard_asset_not_found");
    if (signal?.aborted) return fail("dashboard_asset_cancelled");
    await this.#assertDirectoriesUnchanged();
    await this.#assertPathIdentity(
      path.join(this.#bundleDirectory, DASHBOARD_MANIFEST_FILENAME),
      this.#manifestIdentity
    );

    let handle: FileHandle | undefined;
    try {
      const before = await lstat(pinned.filePath, { bigint: true });
      if (
        before.isSymbolicLink()
        || !before.isFile()
        || !sameFileIdentity(pinned.identity, fileIdentity(before))
      ) {
        return fail("dashboard_build_changed");
      }
      handle = await open(pinned.filePath, noFollowReadFlags());
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileIdentity(pinned.identity, fileIdentity(opened))) {
        return fail("dashboard_build_changed");
      }
      const afterPath = await lstat(pinned.filePath, { bigint: true });
      if (
        afterPath.isSymbolicLink()
        || !afterPath.isFile()
        || !sameFileIdentity(pinned.identity, fileIdentity(afterPath))
      ) {
        return fail("dashboard_build_changed");
      }
      if (signal?.aborted) return fail("dashboard_asset_cancelled");
      const stream = handle.createReadStream({ autoClose: true });
      handle = undefined;
      if (signal) {
        // The bridge separately destroys its consumer-facing response with the authenticated
        // cancellation reason. This stream only owns the host file descriptor, so a quiet destroy
        // closes it without asking Fastify to serialize a second error response after headers.
        const onAbort = () => stream.destroy();
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        stream.once("close", cleanup);
        if (signal.aborted) onAbort();
      }
      return { asset: structuredClone(pinned.asset), stream };
    } catch (error) {
      if (error instanceof DashboardBuildError) throw error;
      if (signal?.aborted) return fail("dashboard_asset_cancelled");
      return fail("dashboard_build_changed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #assertDirectoriesUnchanged(): Promise<void> {
    for (const [relativePath, expected] of this.#directories) {
      const directory = relativePath === ""
        ? this.#bundleDirectory
        : assetFilePath(this.#bundleDirectory, relativePath);
      try {
        const metadata = await lstat(directory, { bigint: true });
        if (
          metadata.isSymbolicLink()
          || !metadata.isDirectory()
          || !sameDirectoryIdentity(expected, directoryIdentity(metadata))
        ) {
          return fail("dashboard_build_changed");
        }
      } catch (error) {
        if (error instanceof DashboardBuildError) throw error;
        return fail("dashboard_build_changed");
      }
    }
  }

  async #assertPathIdentity(filePath: string, expected: FileIdentity): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      const before = await lstat(filePath, { bigint: true });
      if (
        before.isSymbolicLink()
        || !before.isFile()
        || !sameFileIdentity(expected, fileIdentity(before))
      ) {
        return fail("dashboard_build_changed");
      }
      handle = await open(filePath, noFollowReadFlags());
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFileIdentity(expected, fileIdentity(opened))) {
        return fail("dashboard_build_changed");
      }
    } catch (error) {
      if (error instanceof DashboardBuildError) throw error;
      return fail("dashboard_build_changed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}
