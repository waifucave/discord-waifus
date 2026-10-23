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

export class DataPathEscapeError extends Error {}

// Every data path is joined under the root; refuse any result that escapes it (e.g. a ".."
// segment that slipped past request-id validation) instead of handing it to fs calls.
export function resolveDataPath(dataRoot: string, ...segments: string[]): string {
  const resolved = path.join(dataRoot, ...segments);
  const relative = path.relative(path.resolve(dataRoot), path.resolve(resolved));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DataPathEscapeError("Refusing a data path outside the data root.");
  }
  return resolved;
}

export function userDataPath(dataRoot: string, ...segments: string[]): string {
  return resolveDataPath(dataRoot, "user", ...segments);
}

export function appDataPath(dataRoot: string, ...segments: string[]): string {
  return resolveDataPath(dataRoot, "app", ...segments);
}
