import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../storage/atomic.js";
import { ResourceLockManager } from "../../storage/locks.js";
import { validatePrivateMetadataFile } from "../../storage/privateMetadataFile.js";
import { remoteStatePaths } from "../paths.js";
import { Base64Url32BytesSchema } from "../../shared/schemas/remoteProtocol.js";

export const SavedBrowserSessionsSchema = z.object({
  version: z.literal(1),
  browserKeys: z.array(z.object({ keyId: z.string().regex(/^[a-f0-9]{64}$/),
    publicKey: z.object({ kty: z.literal("EC"), crv: z.literal("P-256"),
      x: Base64Url32BytesSchema, y: Base64Url32BytesSchema }).strict() }).strict()).max(1024)
}).strict().superRefine((state, ctx) => {
  const secrets = new Set<string>();
  for (const entry of state.browserKeys) {
    if (secrets.has(entry.keyId)) ctx.addIssue({ code: "custom", message: "Duplicate browser key." });
    secrets.add(entry.keyId);
  }
});
export type SavedBrowserSessions = z.infer<typeof SavedBrowserSessionsSchema>;
export type BrowserPersistence = {
  load: (origin: string) => Promise<SavedBrowserSessions | undefined>;
  save: (origin: string, state: SavedBrowserSessions) => Promise<void>;
  clear: (origin: string) => Promise<void>;
};
const locks = new ResourceLockManager();

/** Public reconnect keys only: never persist cookies, private keys, launches or bootstrap links. */
export function browserPersistence(dataRoot: string, scope: string): BrowserPersistence {
  const directory = path.join(remoteStatePaths(dataRoot).remoteGatewayStateRoot, "browser-sessions");
  const file = (origin: string) => path.join(directory,
    `${createHash("sha256").update(scope).update("\0").update(origin).digest("hex")}.json`);
  const validate = async (target: string) => {
    try { await validatePrivateMetadataFile(target, 512 * 1024); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error; throw new Error("Untrusted browser-session state."); }
  };
  const validateDirectory = async () => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))) throw new Error("Untrusted browser-session directory.");
  };
  return {
    load: async origin => {
      const target = file(origin);
      return locks.withLock(target, async () => {
        try { await validateDirectory(); await validate(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
        const saved = z.object({ origin: z.literal(origin), state: SavedBrowserSessionsSchema }).strict();
        return saved.parse(JSON.parse(await readFile(target, "utf8"))).state;
      });
    },
    save: async (origin, state) => {
      const target = file(origin);
      await locks.withLock(target, async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await validateDirectory();
        try { await validate(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await atomicWriteJson(target, { origin, state: SavedBrowserSessionsSchema.parse(state) }, { privateMetadata: true });
      });
    },
    clear: async origin => {
      const target = file(origin);
      await locks.withLock(target, async () => {
        try { await validateDirectory(); await validate(target); await unlink(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      });
    }
  };
}
