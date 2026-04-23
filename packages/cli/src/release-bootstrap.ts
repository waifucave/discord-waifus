import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const APP_RELEASE_ASSET_NAME = "discord-waifus-app.tar.gz";
export const APP_RELEASE_CHECKSUM_ASSET_NAME = "discord-waifus-app.sha256";
const INSTALLED_RELEASE_METADATA = ".waifus-release.json";

export interface BootstrapReleaseOptions {
  repo?: string | null;
  release?: string | null;
  onProgress?: ((message: string) => void) | null;
}

export interface BootstrapReleaseResult {
  projectRoot: string;
  sourceRepo: string;
  releaseTag: string;
  releaseName: string | null;
  publishedAt: string | null;
  assetName: string;
  bundleVersion: string | null;
}

export interface UpdateReleaseOptions {
  preserveEntries?: string[];
}

export interface InstalledReleaseMetadata {
  formatVersion?: unknown;
  bundleVersion?: unknown;
  sourceCommit?: unknown;
  generatedAt?: unknown;
  repository?: unknown;
}

interface GitHubReleaseAsset {
  name?: string;
  browser_download_url?: string;
}

interface GitHubReleasePayload {
  tag_name?: string;
  name?: string;
  published_at?: string;
  assets?: GitHubReleaseAsset[];
}

export async function bootstrapReleaseBundleFromGitHub(
  targetDir: string,
  options: BootstrapReleaseOptions = {}
): Promise<BootstrapReleaseResult> {
  const projectRoot = path.resolve(targetDir);
  await ensureTargetDirectoryIsEmpty(projectRoot);
  const snapshot = await prepareReleaseSnapshot(options);

  try {
    options.onProgress?.(`Installing release bundle into ${projectRoot}...`);
    await fs.mkdir(projectRoot, { recursive: true });
    await copyDirectoryContents(snapshot.extractedRoot, projectRoot);
    return snapshot.result(projectRoot);
  } finally {
    await snapshot.cleanup();
  }
}

export async function updateReleaseBundleFromGitHub(
  targetDir: string,
  options: BootstrapReleaseOptions = {},
  updateOptions: UpdateReleaseOptions = {}
): Promise<BootstrapReleaseResult> {
  const projectRoot = path.resolve(targetDir);
  const stats = await fs.stat(projectRoot).catch(() => null);
  if (!stats?.isDirectory()) {
    throw new Error(`Project directory does not exist: ${projectRoot}`);
  }

  const snapshot = await prepareReleaseSnapshot(options);
  const preserveEntries = new Set((updateOptions.preserveEntries ?? []).map((entry) => entry.trim()).filter(Boolean));

  try {
    options.onProgress?.(`Applying release bundle to ${projectRoot}...`);
    await replaceProjectContents(projectRoot, snapshot.extractedRoot, preserveEntries);
    return snapshot.result(projectRoot);
  } finally {
    await snapshot.cleanup();
  }
}

export async function readInstalledReleaseMetadata(projectRoot: string): Promise<{
  bundleVersion: string | null;
  sourceCommit: string | null;
  generatedAt: string | null;
  repository: string | null;
} | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(path.join(projectRoot, INSTALLED_RELEASE_METADATA), "utf8")
    ) as InstalledReleaseMetadata;

    return {
      bundleVersion: typeof raw.bundleVersion === "string" && raw.bundleVersion.trim()
        ? raw.bundleVersion.trim()
        : null,
      sourceCommit: typeof raw.sourceCommit === "string" && raw.sourceCommit.trim()
        ? raw.sourceCommit.trim()
        : null,
      generatedAt: typeof raw.generatedAt === "string" && raw.generatedAt.trim()
        ? raw.generatedAt.trim()
        : null,
      repository: typeof raw.repository === "string" && raw.repository.trim()
        ? raw.repository.trim()
        : null
    };
  } catch {
    return null;
  }
}

async function ensureTargetDirectoryIsEmpty(targetDir: string): Promise<void> {
  try {
    const stats = await fs.stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Target path exists and is not a directory: ${targetDir}`);
    }

    const entries = await fs.readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${targetDir}`);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function prepareReleaseSnapshot(
  options: BootstrapReleaseOptions
): Promise<{
  extractedRoot: string;
  result: (projectRoot: string) => BootstrapReleaseResult;
  cleanup: () => Promise<void>;
}> {
  const reportProgress = (message: string): void => {
    options.onProgress?.(message);
  };
  const repositoryUrl = options.repo?.trim() || (await resolveRepositoryFromPackageMetadata());
  if (!repositoryUrl) {
    throw new Error(
      "No GitHub repository was provided.\nUse: waifus init <target-dir> --repo https://github.com/<owner>/<repo>"
    );
  }

  const githubRepo = parseGitHubRepository(repositoryUrl);
  if (!githubRepo) {
    throw new Error(
      `Unsupported repository: ${repositoryUrl}\nOnly GitHub repositories are supported by waifus init.`
    );
  }

  const releaseTag = options.release?.trim() || null;
  reportProgress(
    `Resolving GitHub Release metadata${releaseTag ? ` for ${releaseTag}` : " for latest release"}...`
  );
  const release = await fetchGitHubRelease(githubRepo.owner, githubRepo.repo, releaseTag);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const bundleAsset = assets.find((asset) => asset.name === APP_RELEASE_ASSET_NAME);
  if (!bundleAsset?.browser_download_url) {
    throw new Error(
      `GitHub release ${release.tag_name ?? releaseTag ?? "latest"} is missing ${APP_RELEASE_ASSET_NAME}.`
    );
  }

  const checksumAsset = assets.find((asset) => asset.name === APP_RELEASE_CHECKSUM_ASSET_NAME);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "waifus-release-"));
  const archivePath = path.join(tempRoot, APP_RELEASE_ASSET_NAME);
  const extractRoot = path.join(tempRoot, "extract");

  try {
    await fs.mkdir(extractRoot, { recursive: true });
    reportProgress(`Downloading ${APP_RELEASE_ASSET_NAME}...`);
    await downloadFile(bundleAsset.browser_download_url, archivePath);

    if (checksumAsset?.browser_download_url) {
      reportProgress(`Downloading ${APP_RELEASE_CHECKSUM_ASSET_NAME}...`);
      const checksumText = await downloadTextFile(checksumAsset.browser_download_url);
      reportProgress(`Verifying ${APP_RELEASE_ASSET_NAME} checksum...`);
      const expectedChecksum = parseChecksum(checksumText);
      const actualChecksum = await computeSha256(archivePath);
      if (expectedChecksum !== actualChecksum) {
        throw new Error(
          `Release asset checksum mismatch for ${APP_RELEASE_ASSET_NAME}. Expected ${expectedChecksum}, got ${actualChecksum}.`
        );
      }
    }

    reportProgress(`Extracting ${APP_RELEASE_ASSET_NAME}...`);
    await extractTarGz(archivePath, extractRoot);
    const extractedRoot = await findSingleExtractedRoot(extractRoot);
    reportProgress("Preparing updated project files...");
    const installedMetadata = await readInstalledReleaseMetadata(extractedRoot);
    const tagName =
      typeof release.tag_name === "string" && release.tag_name.trim()
        ? release.tag_name.trim()
        : releaseTag ?? "latest";
    const releaseName =
      typeof release.name === "string" && release.name.trim()
        ? release.name.trim()
        : null;
    const publishedAt =
      typeof release.published_at === "string" && release.published_at.trim()
        ? release.published_at.trim()
        : null;
    const sourceRepo = `https://github.com/${githubRepo.owner}/${githubRepo.repo}`;

    return {
      extractedRoot,
      result: (projectRoot: string) => ({
        projectRoot,
        sourceRepo,
        releaseTag: tagName,
        releaseName,
        publishedAt,
        assetName: APP_RELEASE_ASSET_NAME,
        bundleVersion: installedMetadata?.bundleVersion ?? null
      }),
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function resolveRepositoryFromPackageMetadata(): Promise<string | null> {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const raw = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
      repository?: string | { url?: string };
    };
    if (typeof raw.repository === "string" && raw.repository.trim()) {
      return raw.repository.trim();
    }
    if (
      raw.repository &&
      typeof raw.repository === "object" &&
      typeof raw.repository.url === "string" &&
      raw.repository.url.trim()
    ) {
      return raw.repository.url.trim();
    }
    return null;
  } catch {
    return null;
  }
}

function parseGitHubRepository(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim();
  const normalized = trimmed
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  const slugMatch = normalized.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (slugMatch) {
    return { owner: slugMatch[1], repo: slugMatch[2] };
  }

  try {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") {
      return null;
    }
    const segments = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (segments.length < 2 || !segments[0] || !segments[1]) {
      return null;
    }
    return {
      owner: segments[0],
      repo: segments[1]
    };
  } catch {
    return null;
  }
}

async function fetchGitHubRelease(owner: string, repo: string, releaseTag: string | null): Promise<GitHubReleasePayload> {
  const releasePath = releaseTag
    ? `releases/tags/${encodeURIComponent(releaseTag)}`
    : "releases/latest";
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/${releasePath}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "@starlight-ai/discord-waifus"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    if (response.status === 404 && releaseTag) {
      throw new Error(`GitHub release tag not found: ${releaseTag}`);
    }
    throw new Error(`Failed to resolve GitHub release metadata: HTTP ${response.status}`);
  }

  return await response.json() as GitHubReleasePayload;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "@starlight-ai/discord-waifus"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Failed to download release asset: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
}

async function downloadTextFile(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "@starlight-ai/discord-waifus"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Failed to download release checksum asset: HTTP ${response.status}`);
  }

  return await response.text();
}

function parseChecksum(value: string): string {
  const match = value.trim().match(/^([a-f0-9]{64})\b/i);
  if (!match) {
    throw new Error(`Invalid checksum format in ${APP_RELEASE_CHECKSUM_ASSET_NAME}.`);
  }
  return match[1].toLowerCase();
}

async function computeSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

async function extractTarGz(archivePath: string, extractRoot: string): Promise<void> {
  await spawnQuiet("tar", ["-xzf", archivePath, "-C", extractRoot]);
}

async function findSingleExtractedRoot(extractRoot: string): Promise<string> {
  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    throw new Error("Release asset extraction did not produce a single root directory.");
  }
  return path.join(extractRoot, directories[0].name);
}

async function copyDirectoryContents(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir);
  await Promise.all(
    entries.map((entry) =>
      fs.cp(path.join(sourceDir, entry), path.join(targetDir, entry), {
        recursive: true
      })
    )
  );
}

async function replaceProjectContents(
  targetDir: string,
  sourceDir: string,
  preserveEntries: Set<string>
): Promise<void> {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });

  for (const entry of entries) {
    if (preserveEntries.has(entry.name)) {
      continue;
    }
    await fs.rm(path.join(targetDir, entry.name), { recursive: true, force: true });
  }

  await copyDirectoryContents(sourceDir, targetDir);
}

async function spawnQuiet(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      if (code && code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
        return;
      }
      resolve();
    });
  });
}
