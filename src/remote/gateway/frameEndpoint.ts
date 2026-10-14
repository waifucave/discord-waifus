import { createHash } from "node:crypto";
import { readFile, lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { remoteStatePaths } from "../paths.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { validatePrivateMetadataFile } from "../../storage/privateMetadataFile.js";

/** A port conflict fails closed; never serve a remembered browser origin through another listener. */
export function frameEndpoint(dataRoot: string, dashboardOrigin: string) {
  const directory = path.join(remoteStatePaths(dataRoot).remoteGatewayStateRoot, "browser-sessions");
  const file = path.join(directory, `frame-${createHash("sha256").update(dashboardOrigin).digest("hex")}.json`);
  const schema = z.object({ version: z.literal(1), dashboardOrigin: z.literal(dashboardOrigin), port: z.number().int().min(1).max(65535) }).strict();
  return {
    load: async (): Promise<number | undefined> => {
      try { await validatePrivateMetadataFile(file, 4096); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
      return schema.parse(JSON.parse(await readFile(file, "utf8"))).port;
    },
    save: async (port: number) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()
        || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) throw new Error("Untrusted browser directory.");
      await atomicWriteJson(file, schema.parse({ version: 1, dashboardOrigin, port }), { privateMetadata: true });
    }
  };
}
