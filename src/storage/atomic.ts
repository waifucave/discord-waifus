import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { discardOwnedEmptyMetadataFile, protectNewPrivateMetadataFile } from "./privateMetadataFile.js";

export type AtomicWriteOptions = {
  mode?: number;
  privateMetadata?: boolean;
};

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(value, null, 2) + "\n", options);
}

export async function atomicWriteText(
  filePath: string,
  content: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await atomicWriteFile(filePath, content, options);
}

/** Temp names atomic writes use (`.<name>.<pid>.<ms>.<hex>.tmp`): listings of user folders skip them. */
export const ATOMIC_TEMP_NAME = /^\..+\.\d+\.\d+\.[0-9a-f]*\.tmp$/u;

/** Text or bytes, written to a temp file in the same folder and renamed over the target. */
export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  const handle = await open(tmpPath, "wx", options.mode ?? 0o600);
  let protectedTemp = false;
  try {
    try {
      if (options.privateMetadata) {
        try { await protectNewPrivateMetadataFile(tmpPath); }
        catch (error) { await discardOwnedEmptyMetadataFile(tmpPath, handle); throw error; }
      }
      protectedTemp = true;
      if (typeof content === "string") await handle.writeFile(content, "utf8");
      else await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(tmpPath, filePath);
  } catch (error) {
    // Never leave our own temp behind: same-pid temps are skipped by recoverAtomicWriteTemps,
    // so a failed write in a long-lived process would otherwise linger until restart. A failed
    // private-metadata protection keeps its narrower identity-checked discard above.
    if (protectedTemp) await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await syncDirectoryBestEffort(dir);
}

// Windows reports a destination briefly held open by another reader, an antivirus scanner or
// the search indexer as EPERM/EBUSY/EACCES; those clear within milliseconds. POSIX rename has no
// such transient failure, so retries are Windows-only and bounded (~800 ms total).
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 250, 250];

export async function renameWithRetry(
  from: string,
  to: string,
  options: {
    platform?: NodeJS.Platform;
    rename?: (from: string, to: string) => Promise<void>;
    delaysMs?: readonly number[];
  } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const renameFile = options.rename ?? rename;
  const delays = options.delaysMs ?? RENAME_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || !code || !WINDOWS_TRANSIENT_RENAME_CODES.has(code) || attempt >= delays.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

export async function recoverAtomicWriteTemps(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const removed: string[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`.${base}.`) && entry.endsWith(".tmp"))
      // Never touch this process's own temps: a lockless reader running concurrently with a
      // writer used to delete the writer's in-flight temp, ENOENT-ing its rename (live repro:
      // two guilds dreaming concurrently). Same-pid temps are in-flight by definition —
      // crash leftovers always carry a dead process's pid.
      .filter((entry) => !entry.includes(`.${process.pid}.`))
      .map(async (entry) => {
        const fullPath = path.join(dir, entry);
        await rm(fullPath, { force: true });
        removed.push(fullPath);
      })
  );
  return removed.sort();
}

async function syncDirectoryBestEffort(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported on every filesystem. The file write and
    // rename above still provide same-directory atomic replacement semantics.
  }
}
