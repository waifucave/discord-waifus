// Moving retired data into the Living cast archive (spec §7.4, §11.2): `user/.archive/living-cast/`,
// which the schema-version stamp never walks. A move is a rename; a directory whose archive target
// already exists (a re-run after a crash halfway) is merged entry by entry, a file replaces the
// archived copy of the same path. Missing sources are a no-op, so every caller stays idempotent.

import { lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import path from "node:path";
import { LIVING_CAST_ARCHIVE_DIR } from "./livingCastModels.js";

export { LIVING_CAST_ARCHIVE_DIR };

/** `user/.archive/living-cast/<relative>` under the data root. */
export function archivePath(dataRoot: string, ...relative: string[]): string {
  return path.join(dataRoot, LIVING_CAST_ARCHIVE_DIR, ...relative);
}

async function kindOf(target: string): Promise<"dir" | "file" | undefined> {
  try {
    const info = await lstat(target);
    return info.isDirectory() ? "dir" : "file";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Moves `source` (absolute) to `destination` (absolute). Returns false when there was nothing to move. */
export async function moveInto(source: string, destination: string): Promise<boolean> {
  const sourceKind = await kindOf(source);
  if (!sourceKind) return false;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const destinationKind = await kindOf(destination);
  if (sourceKind === "dir" && destinationKind === "dir") {
    for (const entry of await readdir(source)) await moveInto(path.join(source, entry), path.join(destination, entry));
    await rmdir(source);
    return true;
  }
  await rename(source, destination);
  return true;
}

/** Moves a data-root-relative path to the same relative place under the archive (without `user/`). */
export async function moveToArchive(dataRoot: string, relativeSource: string, relativeDestination?: string): Promise<boolean> {
  const destination = relativeDestination ?? path.relative("user", relativeSource);
  return moveInto(path.join(dataRoot, relativeSource), archivePath(dataRoot, destination));
}
