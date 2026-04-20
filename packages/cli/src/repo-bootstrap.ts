import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface BootstrapRepoOptions {
  repo?: string | null;
  ref?: string | null;
}

export interface BootstrapRepoResult {
  projectRoot: string;
  sourceRepo: string;
  sourceRef: string | null;
}

export async function bootstrapRepoFromGitHubArchive(
  targetDir: string,
  options: BootstrapRepoOptions = {}
): Promise<BootstrapRepoResult> {
  const projectRoot = path.resolve(targetDir);
  await ensureTargetDirectoryIsEmpty(projectRoot);

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

  const ref = options.ref?.trim() || null;
  const archiveUrl = buildGitHubArchiveUrl(githubRepo.owner, githubRepo.repo, ref);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "waifus-init-"));
  const archivePath = path.join(tempRoot, "repo.tar.gz");
  const extractRoot = path.join(tempRoot, "extract");

  try {
    await fs.mkdir(extractRoot, { recursive: true });
    await downloadFile(archiveUrl, archivePath);
    await extractTarGz(archivePath, extractRoot);

    const extractedRoot = await findSingleExtractedRoot(extractRoot);
    await fs.mkdir(projectRoot, { recursive: true });
    await copyDirectoryContents(extractedRoot, projectRoot);

    return {
      projectRoot,
      sourceRepo: `https://github.com/${githubRepo.owner}/${githubRepo.repo}`,
      sourceRef: ref
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
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

function buildGitHubArchiveUrl(owner: string, repo: string, ref: string | null): string {
  const encodedRef = ref ? `/${encodeURIComponent(ref)}` : "";
  return `https://api.github.com/repos/${owner}/${repo}/tarball${encodedRef}`;
}

async function downloadFile(url: string, destinationPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "@discord-waifus/cli"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Failed to download repository archive: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destinationPath, buffer);
}

async function extractTarGz(archivePath: string, extractRoot: string): Promise<void> {
  await spawnQuiet("tar", ["-xzf", archivePath, "-C", extractRoot]);
}

async function findSingleExtractedRoot(extractRoot: string): Promise<string> {
  const entries = await fs.readdir(extractRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1) {
    throw new Error("Repository archive extraction did not produce a single root directory.");
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
