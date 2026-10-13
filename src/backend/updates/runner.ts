import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createRequire } from "node:module";
import { createProductionHelperPackageResolver, HELPER_RELEASE_TRUST_ROOTS } from "../../remote/productionHelper.js";
import { loadRemoteCompatibilityV1 } from "../../remote/componentCompatibility.js";
import { atomicWriteJson } from "../../storage/atomic.js";
import { processIsAlive } from "../../cli/processState.js";
import { callUpdateControl, installationLock, LeaseSchema, readUpdateLeases, liveGlobalRuntimePids,
  type UpdateInstallation, type UpdateLease, PACKAGE_NAME } from "./control.js";

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function newerPatch(current: string, next: string): boolean {
  if (!versionPattern.test(current) || !versionPattern.test(next)) return false;
  const a = current.split(".").map(Number), b = next.split(".").map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) return false;
  return a[0] === b[0] && a[1] === b[1] && b[2] > a[2];
}

export async function verifyStagedUpdate(root: string, version: string): Promise<void> {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== PACKAGE_NAME || pkg.version !== version || pkg.private
    || !versionPattern.test(version)) throw new Error("candidate_invalid");
  for (const target of ["darwin-arm64", "win32-x64", "win32-arm64", "linux-x64", "linux-arm64"]) {
    if (!versionPattern.test(pkg.optionalDependencies?.[`@waifucave/ts-connect-${target}`] ?? "")) {
      throw new Error("candidate_invalid");
    }
  }
  const compatibility = await loadRemoteCompatibilityV1(version, path.join(root, "remote-compatibility.json"));
  const require = createRequire(path.join(root, "package.json"));
  const resolver = await createProductionHelperPackageResolver({
    appVersion: version, trustRoots: HELPER_RELEASE_TRUST_ROOTS, compatibility,
    resolvePackageJson: name => require.resolve(`${name}/package.json`)
  });
  await resolver.resolve({ role: "host", dataRoot: root, appVersion: version });
  for (const required of ["bin/waifus.mjs", "dist/cli/main.js", "dist-frontend/index.html", "dist-remote-shell/index.html"]) {
    if (!(await readFile(path.join(root, required))).length) throw new Error("candidate_invalid");
  }
}

export const JournalSchema = z.object({
  previous: z.string().regex(versionPattern), target: z.string().regex(versionPattern),
  roles: z.array(LeaseSchema).min(1).max(256), phase: z.enum(["stopping", "installing", "installed", "rolled_back"])
}).strict();
export type UpdateJournal = z.infer<typeof JournalSchema>;

export type UpdateRunnerDeps = {
  installation: UpdateInstallation;
  list?: () => Promise<UpdateLease[]>;
  control?: typeof callUpdateControl;
  alive?: (pid: number) => boolean;
  install: (version: string) => Promise<void>;
  verify: (version: string) => Promise<void>;
  restart: (lease: UpdateLease) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (reason: string) => void;
  inventory?: () => Promise<number[]>;
};

/** Already staged/verified bytes only; transaction lock also excludes new runtime registrations. */
export async function applyIdleUpdate(previous: string, target: string, deps: UpdateRunnerDeps): Promise<"busy" | "updated" | "rolled_back"> {
  if (!newerPatch(previous, target)) throw new Error("candidate_invalid");
  const control = deps.control ?? callUpdateControl;
  const alive = deps.alive ?? processIsAlive;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const transaction = randomBytes(16).toString("hex");
  const restart: UpdateLease[] = [];
  let result: "busy" | "updated" | "rolled_back" = "busy";
  let safeToRestart = true;
  const journalPath = path.join(deps.installation.stateDir, "journal.json");
  await installationLock(deps.installation.stateDir, "transaction", async () => {
    const roles = await (deps.list ?? (() => readUpdateLeases(deps.installation)))();
    if (!roles.length || roles.some(role => role.version !== previous)) return;
    const inventory = await (deps.inventory ?? (() => liveGlobalRuntimePids(deps.installation)))();
    if (inventory.some(pid => !roles.some(role => role.pid === pid))) return;
    // A running old/unregistered sibling cannot be safely stopped. Fail closed, not guessed idle.
    for (const root of new Set(roles.map(role => role.dataRoot))) {
      for (const [role, file] of [["host", "app/pid.json"], ["remote", "app/tmp/remote-gateway/pid.json"]] as const) {
        const state = await readFile(path.join(root, file), "utf8").then(JSON.parse).catch(error => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (state && alive(state.pid) && !roles.some(r => r.role === role && r.pid === state.pid && r.dataRoot === root)) return;
      }
    }
    const prepared: UpdateLease[] = [];
    try {
      for (const role of roles) {
        const status = await control(role, "prepare", transaction);
        if (!status.accepted) { deps.onWait?.(status.reason ?? "busy"); return; }
        prepared.push(role);
      }
      // Durable journal precedes the first stop/install, including partially committed shutdown.
      await atomicWriteJson(journalPath, { previous, target, roles, phase: "stopping" }, { privateMetadata: true });
      for (const role of roles) {
        const status = await control(role, "stop", transaction);
        if (!status.accepted) throw new Error("commit_rejected");
        restart.push(role);
      }
      const deadline = Date.now() + 60_000;
      while (roles.some(role => alive(role.pid)) && Date.now() < deadline) await sleep(250);
      if (roles.some(role => alive(role.pid))) throw new Error("shutdown_timeout");
      await atomicWriteJson(journalPath, { previous, target, roles, phase: "installing" }, { privateMetadata: true });
      safeToRestart = false;
      try {
        await deps.install(target);
        await deps.verify(target);
        result = "updated";
        safeToRestart = true;
      } catch {
        await deps.install(previous);
        await deps.verify(previous);
        result = "rolled_back";
        safeToRestart = true;
      }
      await atomicWriteJson(journalPath, { previous, target, roles,
        phase: result === "updated" ? "installed" : "rolled_back" }, { privateMetadata: true });
    } finally {
      await Promise.allSettled(prepared.filter(role => !restart.includes(role)).map(role => control(role, "cancel", transaction)));
    }
  }).finally(async () => {
    if (!safeToRestart) throw new Error("restore_failed");
    // Never launch a duplicate over a process that refused to stop, and release the transaction
    // lock before restarted processes register their control endpoints.
    const failures: unknown[] = [];
    for (const role of restart) {
      const deadline = Date.now() + 60_000;
      while (alive(role.pid) && Date.now() < deadline) await sleep(250);
      if (alive(role.pid)) { failures.push(new Error("shutdown_timeout")); continue; }
      try { await deps.restart(role); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new Error("restart_failed");
  });
  return result;
}
