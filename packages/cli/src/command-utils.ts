import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import pc from "picocolors";
import { resolveProjectRoot } from "./project-root.js";
import { defaultSeedFiles, localRuntimeFiles } from "./runtime-layout.js";

export interface GlobalOptions {
  project?: string;
}

export async function requireProjectRoot(options: GlobalOptions): Promise<string> {
  const projectRoot = await resolveProjectRoot({
    cwd: process.cwd(),
    explicitProjectRoot: options.project ?? null
  });

  if (!projectRoot) {
    throw new Error("No project root is configured.\nRun: waifus use /path/to/Discord-Waifus");
  }

  return projectRoot;
}

export function runtimeConfigFiles(projectRoot: string): string[] {
  return [...defaultSeedFiles(projectRoot), ...localRuntimeFiles(projectRoot)];
}

export function requiredBuildArtifacts(projectRoot: string): string[] {
  return [
    path.join(projectRoot, "packages", "backend", "dist", "index.js"),
    path.join(projectRoot, "packages", "dashboard", ".next", "BUILD_ID")
  ];
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function spawnPassthrough(
  command: string,
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ...envOverrides
      }
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

export function info(message: string): void {
  console.log(pc.cyan(message));
}

export function success(message: string): void {
  console.log(pc.green(message));
}

export function warn(message: string): void {
  console.log(pc.yellow(message));
}
