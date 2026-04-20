import { promises as fs } from "node:fs";
import path from "node:path";
import { loadCliConfig } from "./config-store.js";

const projectMarkers = [
  "package.json",
  "pnpm-workspace.yaml",
  path.join("packages", "backend"),
  path.join("packages", "dashboard"),
  "defaults"
];

export interface ResolveProjectRootOptions {
  cwd?: string;
  explicitProjectRoot?: string | null;
}

export async function isValidProjectRoot(projectRoot: string): Promise<boolean> {
  const resolvedRoot = path.resolve(projectRoot);

  for (const marker of projectMarkers) {
    try {
      await fs.access(path.join(resolvedRoot, marker));
    } catch {
      return false;
    }
  }

  return true;
}

export async function resolveProjectRoot(
  options: ResolveProjectRootOptions = {}
): Promise<string | null> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const explicitProjectRoot = options.explicitProjectRoot ? path.resolve(options.explicitProjectRoot) : null;

  if (explicitProjectRoot && (await isValidProjectRoot(explicitProjectRoot))) {
    return explicitProjectRoot;
  }

  const config = await loadCliConfig();
  if (config.defaultProjectRoot && (await isValidProjectRoot(config.defaultProjectRoot))) {
    return path.resolve(config.defaultProjectRoot);
  }

  for (const candidate of walkParentDirectories(cwd)) {
    if (await isValidProjectRoot(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function assertProjectRoot(projectRoot: string): Promise<string> {
  const resolvedRoot = path.resolve(projectRoot);
  if (!(await isValidProjectRoot(resolvedRoot))) {
    throw new Error(
      `Invalid Discord Waifus project root: ${resolvedRoot}\nExpected: package.json, pnpm-workspace.yaml, packages/backend/, packages/dashboard/, and defaults/`
    );
  }
  return resolvedRoot;
}

function* walkParentDirectories(start: string): Generator<string> {
  let current = start;

  while (true) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}
