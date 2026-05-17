import os from "node:os";
import path from "node:path";

export const DATA_ROOT_ENV = "DC_WAIFUS_HOME";

export function getDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[DATA_ROOT_ENV]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".dc-waifus");
}

export function resolveDataPath(dataRoot: string, ...segments: string[]): string {
  return path.join(dataRoot, ...segments);
}

export function userDataPath(dataRoot: string, ...segments: string[]): string {
  return resolveDataPath(dataRoot, "user", ...segments);
}

export function appDataPath(dataRoot: string, ...segments: string[]): string {
  return resolveDataPath(dataRoot, "app", ...segments);
}
