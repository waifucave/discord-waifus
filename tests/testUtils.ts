import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function makeTempRoot(prefix = "dc-waifus-test-"): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
