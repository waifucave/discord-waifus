import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** A fresh temp directory under `base` (default: the OS temp directory). */
export async function makeTempRoot(prefix = "dc-waifus-test-", base = os.tmpdir()): Promise<string> {
  return mkdtemp(path.join(base, prefix));
}

export async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
