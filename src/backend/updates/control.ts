import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { lstat, mkdir, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicWriteJson } from "../../storage/atomic.js";
import { loadAppConfig } from "../../config/appConfig.js";
import { processIsAlive } from "../../cli/processState.js";
import { protectNewPrivateMetadataFile } from "../../storage/privateMetadataFile.js";
import { UpdateActivity } from "./activity.js";

const execute = promisify(execFile);
export const PACKAGE_NAME = "@waifucave/discord-waifus";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const LeaseSchema = z.object({
  pid: z.number().int().positive(), id: z.string().regex(/^[a-f0-9]{32}$/),
  port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["host", "remote"]), dataRoot: z.string().min(1),
  args: z.array(z.string()).max(12), version: z.string().regex(/^\d+\.\d+\.\d+$/)
}).strict().superRefine((lease, context) => {
  let hasRoot = false;
  let valid = lease.args[0] === (lease.role === "host" ? "start" : "remote");
  const seen = new Set<string>();
  for (let i = 1; i < lease.args.length; i++) {
    const flag = lease.args[i];
    if (seen.has(flag)) { valid = false; break; }
    seen.add(flag);
    if (flag === "--no-open" && lease.role === "remote") continue;
    const value = lease.args[++i];
    if (value === undefined || value.includes("\0") || value.startsWith("--")) { valid = false; break; }
    if (flag === "--data-root") { hasRoot = value === lease.dataRoot && path.isAbsolute(value); }
    else if (flag === "--port") { valid &&= /^(?:0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 65535; }
    else if (flag === "--host") { valid &&= value.length > 0 && value.length <= 255; }
    else { valid = false; break; }
  }
  if (!valid || !hasRoot) context.addIssue({ code: "custom", message: "Invalid controlled restart arguments." });
});
export type UpdateLease = z.infer<typeof LeaseSchema>;
export type UpdateInstallation = { root: string; prefix: string; stateDir: string };

// Invoke npm through Node, including on Windows (no command shell/string interpolation).
async function npmCommand(): Promise<string> {
  const candidates = process.platform === "win32"
    ? [path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
        path.join(process.env.APPDATA ?? "", "npm/node_modules/npm/bin/npm-cli.js")]
    : [path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")];
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch { /* Try next known location. */ }
  }
  const output = await execute(process.platform === "win32" ? "where.exe" : "which", ["npm"], { timeout: 5000 });
  const executable = await realpath(output.stdout.trim().split(/\r?\n/)[0]);
  if (executable.endsWith("npm-cli.js")) return executable;
  throw new Error("npm_unavailable");
}

export async function npm(args: string[], timeout = 120_000): Promise<string> {
  const result = await execute(process.execPath, [await npmCommand(), ...args], {
    timeout, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, npm_config_update_notifier: "false" }
  });
  return result.stdout;
}

export async function updateInstallation(): Promise<UpdateInstallation | undefined> {
  // Source and project-local installs are never modified by the automatic worker.
  if (path.basename(path.dirname(PACKAGE_ROOT)) !== "@waifucave"
    || path.basename(path.dirname(path.dirname(PACKAGE_ROOT))) !== "node_modules") return undefined;
  try {
    const [root, globalRoot, prefix] = await Promise.all([
      realpath(PACKAGE_ROOT), npm(["root", "--global"]), npm(["prefix", "--global"])
    ]);
    if (await realpath(path.join(globalRoot.trim(), PACKAGE_NAME)) !== root) return undefined;
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (pkg.name !== PACKAGE_NAME || pkg.private || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(pkg.version)) return undefined;
    const id = createHash("sha256").update(root).digest("hex").slice(0, 24);
    return { root, prefix: prefix.trim(), stateDir: path.join(os.homedir(), ".dc-waifus", "app", "updates", id) };
  } catch { return undefined; }
}

export async function installationLock<T>(dir: string, name: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `${name}.lock`);
  const owner = randomBytes(16).toString("hex");
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await open(lock, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const reclaim = `${lock}.reclaim`;
      // Only one reclaimer may inspect/remove an abandoned lock. A crashed reclaimer fails
      // closed rather than letting competing processes remove a newly acquired lock.
      const recovery = await open(reclaim, "wx", 0o600).catch(() => undefined);
      if (!recovery) throw new Error("update_locked");
      try {
        const saved = JSON.parse(await readFile(lock, "utf8"));
        if (!Number.isInteger(saved.pid) || saved.pid <= 0 || !/^[a-f0-9]{32}$/.test(saved.owner)
          || processIsAlive(saved.pid)) throw new Error("update_locked");
        await unlink(lock);
      } finally { await recovery.close(); await unlink(reclaim); }
      continue;
    }
    try {
      try {
        await protectNewPrivateMetadataFile(lock);
        await handle.writeFile(JSON.stringify({ pid: process.pid, owner }));
      } finally { await handle.close(); }
      return await task();
    } finally {
      const saved = JSON.parse(await readFile(lock, "utf8"));
      if (saved.owner === owner) await unlink(lock);
    }
  }
  throw new Error("update_locked");
}

export async function readUpdateLeases(installation: UpdateInstallation): Promise<UpdateLease[]> {
  const dir = path.join(installation.stateDir, "runtimes");
  const names = await readdir(dir).catch(error => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  if (names.length > 256) throw new Error("runtime_capacity");
  const results: UpdateLease[] = [];
  for (const name of names.filter(n => /^[a-f0-9]{32}\.json$/.test(n))) {
    const file = path.join(dir, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16384
      || (process.platform !== "win32" && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()))) {
      throw new Error("runtime_invalid");
    }
    const record = LeaseSchema.parse(JSON.parse(await readFile(file, "utf8")));
    if (name !== `${record.id}.json` || !path.isAbsolute(record.dataRoot)) throw new Error("runtime_invalid");
    if (processIsAlive(record.pid)) results.push(record);
    else await unlink(path.join(dir, name));
  }
  return results;
}

/** Catch pre-updater CLI daemons in other, as-yet unregistered data roots. Output only PIDs. */
export async function liveGlobalRuntimePids(installation: UpdateInstallation): Promise<number[]> {
  const entries = [path.join(installation.root, "bin/waifus.mjs"), path.join(installation.prefix, "bin/waifus"),
    path.join(installation.prefix, "waifus")];
  if (process.platform === "win32") {
    const script = '$ErrorActionPreference="Stop"; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $paths=ConvertFrom-Json ([Console]::In.ReadToEnd()); @(' +
      'Get-CimInstance Win32_Process -Filter "Name = \'node.exe\'" | Where-Object {' +
      '$line=$_.CommandLine; ($line -match "--foreground") -and @($paths | Where-Object {$line.Contains($_)}).Count -gt 0' +
      '} | ForEach-Object {[int]$_.ProcessId}) | ConvertTo-Json -Compress';
    const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!root) throw new Error("process_inventory_unavailable");
    return new Promise((resolve, reject) => {
      const child = execFile(path.join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, output) => {
          if (error) { reject(new Error("process_inventory_unavailable")); return; }
          try {
            const parsed = output.trim() ? JSON.parse(output) : [];
            const pids = Array.isArray(parsed) ? parsed : [parsed];
            if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error();
            resolve(pids);
          } catch { reject(new Error("process_inventory_unavailable")); }
        });
      child.stdin?.end(JSON.stringify(entries));
    });
  }
  const result = await execute("ps", ["-ax", "-o", "pid=,command="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return result.stdout.split("\n").filter(line => line.includes("--foreground") && entries.some(entry => line.includes(entry)))
    .map(line => Number(line.trim().split(/\s+/, 1)[0])).filter(pid => Number.isInteger(pid) && pid > 0);
}

async function nativeCredentialsReady(platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return true;
  try {
    const result = await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e",
      'ObjC.import("Security");var k=Ref();var r=$.SecKeychainCopyDefault(k);var s=Ref();var q=r===0?$.SecKeychainGetStatus(k[0],s):r;JSON.stringify({ready:q===0&&(Number(s[0])&1)!==0});'],
    { timeout: 5000, maxBuffer: 4096 });
    return JSON.parse(result.stdout).ready === true;
  } catch { return false; }
}

export async function startUpdateControl(options: {
  installation: UpdateInstallation; activity: UpdateActivity; dataRoot: string;
  role: "host" | "remote"; version: string; args: string[];
  busy: () => boolean; requiresCredentials: () => boolean;
  stop?: () => void; credentialsReady?: () => Promise<boolean>;
}) {
  const { installation, activity } = options;
  const id = randomBytes(16).toString("hex");
  const token = randomBytes(32).toString("hex");
  const args = [...options.args];
  if (!args.includes("--data-root")) args.push("--data-root", path.resolve(options.dataRoot));
  const restartArgs = args.map((arg, index) => index > 0 && args[index - 1] === "--data-root" ? path.resolve(arg) : arg);
  const planned = LeaseSchema.parse({ pid: process.pid, id, port: 1, token,
    role: options.role, dataRoot: path.resolve(options.dataRoot), args: restartArgs, version: options.version });
  let preparedId: string | undefined;
  const requestSchema = z.object({ action: z.enum(["probe", "prepare", "cancel", "stop"]),
    transaction: z.string().regex(/^[a-f0-9]{32}$/).optional(), idleMs: z.number().int().min(60000).max(7200000).optional() }).strict();
  const server = createServer(async (request, response) => {
    const auth = request.headers.authorization;
    if (request.method !== "POST" || request.url !== "/" || request.headers.origin !== undefined
      || request.headers["sec-fetch-site"] !== undefined || typeof auth !== "string"
      || !/^[a-f0-9]{64}$/.test(auth) || !timingSafeEqual(Buffer.from(auth), Buffer.from(token))) {
      response.writeHead(403).end(); return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("cache-control", "no-store");
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2048) throw new Error("request_size");
      }
      const input = requestSchema.parse(JSON.parse(body));
      const config = await loadAppConfig(options.dataRoot);
      const base = () => ({ id, enabled: config.updates.enabled, ...activity.snapshot(), busy: options.busy() });
      if (input.action === "probe") { response.end(JSON.stringify(base())); return; }
      if (input.action === "cancel") {
        if (preparedId === input.transaction) { activity.cancel(); preparedId = undefined; }
        response.end(JSON.stringify(base())); return;
      }
      const credentials = !options.requiresCredentials()
        || await (options.credentialsReady ?? nativeCredentialsReady)();
      if (!input.transaction || !config.updates.enabled || !credentials) {
        response.end(JSON.stringify({ ...base(), accepted: false,
          reason: !credentials ? "credentials_locked" : "disabled" })); return;
      }
      if (input.action === "prepare") {
        if (!activity.snapshot().prepared) preparedId = undefined;
        const accepted = !preparedId && activity.prepare(config.updates.idleMinutes * 60000, options.busy());
        if (accepted) preparedId = input.transaction;
        response.end(JSON.stringify({ ...base(), accepted })); return;
      }
      const accepted = preparedId === input.transaction && activity.commit(options.busy());
      response.end(JSON.stringify({ ...base(), accepted }));
      if (accepted) setTimeout(options.stop ?? (() => process.kill(process.pid, "SIGTERM")), 50);
    } catch { response.writeHead(400).end(JSON.stringify({ error: "InvalidUpdateRequest" })); }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("control_start_failed");
  const record = LeaseSchema.parse({ ...planned, port: address.port });
  const file = path.join(installation.stateDir, "runtimes", `${id}.json`);
  try {
    await installationLock(installation.stateDir, "transaction", async () => {
      const pkg = JSON.parse(await readFile(path.join(installation.root, "package.json"), "utf8"));
      if (pkg.version !== options.version) throw new Error("installation_changed");
      await atomicWriteJson(file, record, { privateMetadata: true });
    });
  } catch (error) { server.close(); throw error; }
  return {
    record,
    close: async () => {
      await unlink(file).catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

export async function callUpdateControl(lease: UpdateLease, action: "probe" | "prepare" | "cancel" | "stop", transaction?: string) {
  const response = await fetch(`http://127.0.0.1:${lease.port}/`, {
    method: "POST", headers: { authorization: lease.token, "content-type": "application/json" },
    body: JSON.stringify({ action, ...(transaction ? { transaction } : {}) }),
    signal: AbortSignal.timeout(7000), redirect: "error"
  });
  if (!response.ok) throw new Error("runtime_unavailable");
  const result = await response.json() as { id: string; active: number; idleMs: number;
    busy: boolean; enabled: boolean; accepted?: boolean; reason?: string };
  if (result.id !== lease.id || !Number.isInteger(result.active) || !Number.isFinite(result.idleMs)
    || typeof result.busy !== "boolean" || typeof result.enabled !== "boolean") throw new Error("runtime_invalid");
  return result;
}

export function launchUpdateWorker(installation: UpdateInstallation): void {
  const child = spawn(process.execPath, [path.join(installation.root, "dist/backend/updates/worker.js")], {
    detached: true, stdio: "ignore", windowsHide: true, env: process.env
  });
  child.on("error", () => undefined);
  child.unref();
}

export async function registerAutomaticUpdates(options: Omit<Parameters<typeof startUpdateControl>[0], "installation">) {
  const installation = await updateInstallation();
  if (!installation) return undefined;
  const deadline = Date.now() + 240_000;
  let control: Awaited<ReturnType<typeof startUpdateControl>> | undefined;
  while (!control) {
    try { control = await startUpdateControl({ ...options, installation }); }
    catch (error) {
      if ((error as Error).message !== "update_locked" || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      if (!(await loadAppConfig(options.dataRoot)).updates.enabled) return;
      const lock = await readFile(path.join(installation.stateDir, "worker.lock"), "utf8").then(JSON.parse).catch(() => undefined);
      if (!lock || !Number.isInteger(lock.pid) || !processIsAlive(lock.pid)) launchUpdateWorker(installation);
    } catch { /* Optional updating must not log credentials or interrupt normal runtime work. */ }
    finally { checking = false; }
  };
  const timer = setInterval(() => void check(), 30_000);
  timer.unref();
  void check();
  return { close: async () => { clearInterval(timer); await control.close(); } };
}
