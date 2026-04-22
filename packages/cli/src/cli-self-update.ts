import { spawnPassthrough } from "./command-utils.js";

export interface CliSelfUpdateOptions {
  packageName: string;
  currentVersion: string;
  cwd: string;
  info: (message: string) => void;
  success: (message: string) => void;
  warn: (message: string) => void;
}

export async function maybeSelfUpdateCli(options: CliSelfUpdateOptions): Promise<void> {
  const latestVersion = await fetchLatestPackageVersion(options.packageName);
  if (!latestVersion) {
    options.warn("Could not check npm for a newer waifus CLI version. Continuing with app update.");
    return;
  }

  if (!isNewerVersion(latestVersion, options.currentVersion)) {
    return;
  }

  options.info(`CLI update available: ${options.currentVersion} -> ${latestVersion}`);
  options.info("Updating the global waifus CLI with npm...");

  try {
    await spawnPassthrough(
      "npm",
      ["install", "-g", `${options.packageName}@${latestVersion}`],
      options.cwd
    );
    options.success(`CLI updated to ${latestVersion}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.warn(`Failed to auto-update the global CLI: ${message}`);
    options.warn(`You can update it manually with: npm install -g ${options.packageName}`);
  }
}

async function fetchLatestPackageVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      headers: {
        Accept: "application/json",
        "User-Agent": packageName
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json() as { version?: unknown };
    return typeof payload.version === "string" && payload.version.trim()
      ? payload.version.trim()
      : null;
  } catch {
    return null;
  }
}

function isNewerVersion(candidate: string, current: string): boolean {
  const parsedCandidate = parseVersion(candidate);
  const parsedCurrent = parseVersion(current);
  if (!parsedCandidate || !parsedCurrent) {
    return false;
  }

  for (let index = 0; index < parsedCandidate.length; index += 1) {
    if (parsedCandidate[index] > parsedCurrent[index]) {
      return true;
    }
    if (parsedCandidate[index] < parsedCurrent[index]) {
      return false;
    }
  }

  return false;
}

function parseVersion(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  if (![major, minor, patch].every(Number.isFinite)) {
    return null;
  }

  return [major, minor, patch];
}
