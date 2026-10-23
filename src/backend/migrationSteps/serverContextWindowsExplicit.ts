import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LEGACY_SERVER_CONTEXT_WINDOWS, type ContextCapKind } from "../../orchestration/contextWindows.js";
import { atomicWriteJson } from "../../storage/atomic.js";

// Step `server-context-windows-explicit-v1` (spec 6.8 B29, 8.7). Before B29 every server file was
// filled with `contextWindows: { orchestrator: 20, waifu: 50, stageManager: 80 }`, which silently
// shadowed the agent/waifu `contextWindow`. The keys are now optional overrides, so a key whose
// value equals that old default is dropped (the agent/waifu value then applies); any other value
// is an explicit owner choice and stays. Idempotent; tolerant of hand-edited files (raw JSON, no
// zod parse, unparsable files are left for the loader to report).

const KINDS = Object.keys(LEGACY_SERVER_CONTEXT_WINDOWS) as ContextCapKind[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/** Returns the number of server files rewritten. */
export async function dropDefaultServerContextWindows(dataRoot: string): Promise<number> {
  const serversRoot = path.join(dataRoot, "user", "servers");
  let entries: string[];
  try {
    entries = await readdir(serversRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    const filePath = path.join(serversRoot, entry, "server.json");
    const data = await readJson(filePath);
    if (!isObject(data) || !isObject(data.contextWindows)) continue;
    const windows = data.contextWindows;
    const legacy = KINDS.filter((kind) => windows[kind] === LEGACY_SERVER_CONTEXT_WINDOWS[kind]);
    if (legacy.length === 0) continue;
    for (const kind of legacy) delete windows[kind];
    await atomicWriteJson(filePath, data);
    count += 1;
  }
  return count;
}

export async function migrateServerContextWindowsExplicit(dataRoot: string): Promise<string | undefined> {
  const count = await dropDefaultServerContextWindows(dataRoot);
  return count > 0 ? `server-context-windows-explicit-${count}` : undefined;
}
