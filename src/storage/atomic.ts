import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

export type AtomicWriteOptions = {
  mode?: number;
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
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${base}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );

  const handle = await open(tmpPath, "w", options.mode ?? 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  await rename(tmpPath, filePath);
  await syncDirectoryBestEffort(dir);
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
