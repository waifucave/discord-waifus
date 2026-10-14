import { readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../storage/atomic.js";
import { remoteRolePaths } from "./paths.js";
import { ConnectionShellOriginSchema } from "../shared/schemas/remoteLifecycle.js";
import { Base64Url32BytesSchema } from "../shared/schemas/remoteProtocol.js";
import type { RemoteDaemonState } from "../shared/schemas/remoteRuntime.js";
import { validatePrivateMetadataFile } from "../storage/privateMetadataFile.js";

const LauncherSchema = z.object({ pid: z.number().int().positive(), startedAt: z.string().datetime(),
  origin: ConnectionShellOriginSchema, token: Base64Url32BytesSchema }).strict();
const file = (root: string) => path.join(path.dirname(remoteRolePaths(root, "remote").runtimePid), "browser-launcher.json");
export async function publishBrowserLauncher(root: string, runtime: RemoteDaemonState, token: string): Promise<void> {
  await atomicWriteJson(file(root), LauncherSchema.parse({ pid: runtime.pid, startedAt: runtime.startedAt,
    origin: runtime.connectionShellOrigin, token }), { privateMetadata: true });
}
/** The CLI reads owner-only authority; browser scripts can neither read it nor mint sessions. */
export async function reopenRemoteBrowser(root: string, runtime: RemoteDaemonState, setup: boolean): Promise<string | undefined> {
  try { await validatePrivateMetadataFile(file(root), 4096); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const saved = LauncherSchema.parse(JSON.parse(await readFile(file(root), "utf8")));
  if (saved.pid !== runtime.pid || saved.startedAt !== runtime.startedAt || saved.origin !== runtime.connectionShellOrigin) {
    throw new Error("Browser launcher belongs to a different daemon.");
  }
  const origin = new URL(saved.origin);
  // Recent Node fetch implementations discard custom Host headers. Use a literal
  // loopback socket with the isolated authority, never DNS or a redirect.
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: Number(origin.port),
      path: "/_waifus_remote/launcher", method: "POST",
      headers: { host: origin.host, "x-waifus-launcher": saved.token, "content-type": "application/json" },
      signal: AbortSignal.timeout(5000)
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) res.destroy(new Error("Invalid browser launcher response."));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ setup }));
  });
  if (response.status !== 200) throw new Error(`Remote browser launcher is unavailable (HTTP ${response.status}).`);
  const { url } = z.object({ url: z.string().url() }).strict().parse(JSON.parse(response.body));
  const target = new URL(url);
  if (target.origin !== saved.origin || !/^\/_waifus_remote\/bootstrap\/[A-Za-z0-9_-]{43}$/.test(target.pathname)
    || target.search || target.hash || target.href !== url) throw new Error("Invalid browser launch URL.");
  return url;
}
