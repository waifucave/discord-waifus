import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { atomicWriteJson } from "../../storage/atomic.js";
import { loadAppConfig } from "../../config/appConfig.js";
import { processIsAlive } from "../../cli/processState.js";
import { PACKAGE_NAME, callUpdateControl, installationLock, npm, readUpdateLeases,
  updateInstallation, type UpdateLease, type UpdateInstallation } from "./control.js";
import { applyIdleUpdate, helperVerificationRequired, JournalSchema, newerPatch, verifyStagedUpdate } from "./runner.js";

const execute = promisify(execFile);
export const UpdateStatusSchema = z.object({
  state: z.enum(["disabled", "unsupported", "checking", "current", "waiting_idle", "installing", "updated", "rolled_back", "failed"]),
  currentVersion: z.string().regex(/^\d+\.\d+\.\d+$/), candidateVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
  lastCheckAt: z.string().datetime().nullable(),
  reason: z.enum(["none", "busy", "disabled", "credentials_locked", "check_failed", "update_failed", "restart_failed", "source_checkout"])
}).strict();
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
/** A manual install supersedes this in-memory worker; a new runtime must launch new code. */
export async function workerVersionIsCurrent(root: string, expectedVersion: string): Promise<boolean> {
  try {
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    return pkg.name === PACKAGE_NAME && pkg.version === expectedVersion && !pkg.private;
  } catch { return false; }
}
export async function automaticUpdateStatus(dataRoot?: string): Promise<UpdateStatus> {
  const pkg = JSON.parse(await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../package.json"), "utf8"));
  const installation = await updateInstallation();
  const base: UpdateStatus = { state: "unsupported", currentVersion: pkg.version,
    candidateVersion: null, lastCheckAt: null, reason: "source_checkout" };
  if (!installation) return base;
  try {
    const saved = UpdateStatusSchema.parse(JSON.parse(await readFile(path.join(installation.stateDir, "status.json"), "utf8")));
    // Only closed public fields; never return leases, capabilities, paths or child output.
    if (dataRoot && !(await loadAppConfig(dataRoot)).updates.enabled) return { ...base, state: "disabled", reason: "disabled" };
    return { ...saved, currentVersion: pkg.version };
  } catch { return { ...base, state: "disabled", reason: "disabled" }; }
}

async function restart(installation: UpdateInstallation, role: UpdateLease): Promise<void> {
  await execute(process.execPath, [path.join(installation.root, "bin/waifus.mjs"), ...role.args], {
    timeout: 45_000, maxBuffer: 1024 * 1024, windowsHide: true
  });
  const file = role.role === "host" ? "app/runtime.json" : "app/tmp/remote-gateway/runtime.json";
  const runtime = JSON.parse(await readFile(path.join(role.dataRoot, file), "utf8"));
  const pkg = JSON.parse(await readFile(path.join(installation.root, "package.json"), "utf8"));
  if (runtime.packageVersion !== pkg.version || !processIsAlive(runtime.pid)
    || (role.role === "host" && runtime.remoteAccess?.enabled && runtime.remoteAccess.helperState !== "ready")
    || (role.role === "remote" && runtime.helperState !== "ready")) throw new Error("restart_failed");
}

/** Recover only packages/processes, never rewrite or delete user configuration or trust. */
async function recover(installation: UpdateInstallation): Promise<void> {
  const file = path.join(installation.stateDir, "journal.json");
  const raw = await readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!raw) return;
  const journal = JournalSchema.parse(JSON.parse(raw));
  await installationLock(installation.stateDir, "transaction", async () => {
    const helper = await helperVerificationRequired(journal.roles);
    // A crash during replacement leaves an unverified package. Restore before any launch.
    if (journal.phase === "installing") {
      const registered = await readUpdateLeases(installation);
      if (registered.length || journal.roles.some(role => processIsAlive(role.pid))) throw new Error("recovery_busy");
      await npm(["install", "--global", "--prefix", installation.prefix,
        `${PACKAGE_NAME}@${journal.previous}`, "--ignore-scripts"], 180_000);
      await verifyStagedUpdate(installation.root, journal.previous, { helper });
      await atomicWriteJson(file, { ...journal, phase: "rolled_back" }, { privateMetadata: true });
    } else {
      const current = JSON.parse(await readFile(path.join(installation.root, "package.json"), "utf8"));
      await verifyStagedUpdate(installation.root, current.version, { helper });
    }
  });
  for (const role of journal.roles) {
    const file = role.role === "host" ? "app/pid.json" : "app/tmp/remote-gateway/pid.json";
    const current = await readFile(path.join(role.dataRoot, file), "utf8").then(JSON.parse).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current && processIsAlive(current.pid)) continue;
    await restart(installation, role);
  }
  await unlink(file);
}

export async function runUpdateWorker(installation: UpdateInstallation): Promise<void> {
  await installationLock(installation.stateDir, "worker", async () => {
    const pkg = JSON.parse(await readFile(path.join(installation.root, "package.json"), "utf8"));
    const status: UpdateStatus = { state: "checking", currentVersion: pkg.version,
      candidateVersion: null, lastCheckAt: null, reason: "none" };
    let previousEvent = "";
    const save = async () => {
      await atomicWriteJson(path.join(installation.stateDir, "status.json"), status, { privateMetadata: true });
      const eventKey = JSON.stringify([status.state, status.reason, status.currentVersion, status.candidateVersion]);
      if (eventKey === previousEvent) return;
      previousEvent = eventKey;
      const file = path.join(installation.stateDir, "history.json");
      const old = await readFile(file, "utf8").then(JSON.parse).catch(() => []);
      const history = Array.isArray(old) ? old.filter(entry => UpdateStatusSchema.safeParse(entry.status).success).slice(-49) : [];
      history.push({ at: new Date().toISOString(), status: { ...status } });
      await atomicWriteJson(file, history, { privateMetadata: true });
    };
    try { await recover(installation); }
    catch { status.state = "failed"; status.reason = "update_failed"; await save(); return; }
    let nextCheck = 0;
    let staged: { dir: string; archives: Map<string, string> } | undefined;
    const failedFile = path.join(installation.stateDir, "failed-version.json");
    const failedSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), retryAfter: z.number().finite() }).strict();
    let failed = await readFile(failedFile, "utf8").then(raw => failedSchema.parse(JSON.parse(raw))).catch(() => undefined);
    const backoff = async (version: string) => {
      failed = { version, retryAfter: Date.now() + 60 * 60000 };
      await atomicWriteJson(failedFile, failed, { privateMetadata: true });
    };
    try {
      while (true) {
        if (!(await workerVersionIsCurrent(installation.root, pkg.version))) return;
        const roles = await readUpdateLeases(installation);
        if (!roles.length) return;
        const configs = await Promise.all(roles.map(r => loadAppConfig(r.dataRoot)));
        if (configs.some(c => !c.updates.enabled)) {
          status.state = "disabled"; status.reason = "disabled"; await save(); return;
        }
        if (Date.now() >= nextCheck && !staged) {
          status.state = "checking"; status.reason = "none"; await save();
          try {
            const metadata = JSON.parse(await npm(["view", `${PACKAGE_NAME}@latest`, "version", "deprecated", "--json", "--registry=https://registry.npmjs.org"], 15_000));
            const latest = typeof metadata === "string" ? metadata : metadata.version;
            if (typeof latest !== "string" || (typeof metadata === "object" && metadata.deprecated)) throw new Error("candidate_invalid");
            status.lastCheckAt = new Date().toISOString();
            status.candidateVersion = newerPatch(status.currentVersion, latest) ? latest : null;
            status.state = status.candidateVersion ? "waiting_idle" : "current";
            if (failed?.version === latest && Date.now() < failed.retryAfter) {
              status.candidateVersion = null; status.state = "failed"; status.reason = "update_failed";
            }
          } catch { status.state = "failed"; status.reason = "check_failed"; }
          nextCheck = Date.now() + Math.max(...configs.map(c => c.updates.checkIntervalMinutes)) * 60000;
          await save();
        }
        if (status.candidateVersion && status.reason !== "check_failed") {
          try {
            const probes = await Promise.all(roles.map(r => callUpdateControl(r, "probe")));
            if (probes.some((p, i) => !p.enabled || p.busy || p.active > 0 || p.idleMs < configs[i].updates.idleMinutes * 60000)) {
              status.state = "waiting_idle"; status.reason = "busy"; await save();
            } else {
              if (!staged) {
                const dir = await mkdtemp(path.join(os.tmpdir(), "waifus-idle-update-"));
                staged = { dir, archives: new Map() };
                for (const version of [status.currentVersion, status.candidateVersion]) {
                  const packed = JSON.parse(await npm(["pack", `${PACKAGE_NAME}@${version}`, "--pack-destination", dir,
                    "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org"]));
                  const filename = packed[0]?.filename;
                  if (filename !== `waifucave-discord-waifus-${version}.tgz`) throw new Error("archive_invalid");
                  const archive = path.join(dir, filename);
                  staged.archives.set(version, archive);
                  const prefix = path.join(dir, version);
                  await npm(["install", "--global=false", "--prefix", prefix, archive, "--ignore-scripts"]);
                  await verifyStagedUpdate(path.join(prefix, "node_modules", PACKAGE_NAME), version, {
                    helper: await helperVerificationRequired(roles)
                  });
                }
              }
              status.state = "installing"; status.reason = "none"; await save();
              const archives = staged.archives;
              const result = await applyIdleUpdate(status.currentVersion, status.candidateVersion, {
                installation,
                onWait: reason => { status.reason = reason === "credentials_locked" ? reason : reason === "disabled" ? reason : "busy"; },
                install: async version => {
                  const archive = archives.get(version);
                  if (!archive) throw new Error("archive_missing");
                  await npm(["install", "--global", "--prefix", installation.prefix, archive,
                    "--offline", "--ignore-scripts"], 180_000);
                },
                verify: async (version, lockedRoles) => verifyStagedUpdate(installation.root, version, {
                  helper: await helperVerificationRequired(lockedRoles)
                }),
                restart: async role => {
                  try { await restart(installation, role); }
                  catch { throw new Error("restart_failed"); }
                }
              });
              if (result === "busy") {
                status.state = "waiting_idle";
                if (status.reason === "none") status.reason = "busy";
                await save();
              } else {
                if (result === "updated") status.currentVersion = status.candidateVersion;
                status.state = result; status.reason = result === "rolled_back" ? "update_failed" : "none";
                if (result === "rolled_back") await backoff(status.candidateVersion);
                await save();
                await unlink(path.join(installation.stateDir, "journal.json"));
                return; // Restarted roles launch the new worker code, not this old in-memory copy.
              }
            }
          } catch (error) {
            status.state = "failed";
            status.reason = error instanceof Error && error.message === "restart_failed" ? "restart_failed" : "update_failed";
            if (status.candidateVersion) await backoff(status.candidateVersion);
            await save();
            // A durable journal is a recovery requirement, not permission to repeat a failed update.
            const journal = await readFile(path.join(installation.stateDir, "journal.json"), "utf8").catch(() => undefined);
            if (journal) return;
            if (staged) { await rm(staged.dir, { recursive: true, force: true }); staged = undefined; }
            status.candidateVersion = null;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
    } finally {
      if (staged) await rm(staged.dir, { recursive: true, force: true });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const installation = await updateInstallation();
  if (installation) await runUpdateWorker(installation).catch(() => { process.exitCode = 1; });
}
