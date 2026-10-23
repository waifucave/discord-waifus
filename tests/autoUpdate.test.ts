import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import fastify from "fastify";
import { UpdateActivity, installUpdateActivity, passiveUpdateRequest } from "../src/backend/updates/activity.js";
import { callUpdateControl, installationLock, readUpdateLeases, startUpdateControl,
  type UpdateInstallation, type UpdateLease } from "../src/backend/updates/control.js";
import { applyIdleUpdate, newerPatch } from "../src/backend/updates/runner.js";
import { UpdateStatusSchema, workerVersionIsCurrent } from "../src/backend/updates/worker.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { loadAppConfig, mergeAppConfigPatch, updateAppConfig } from "../src/config/appConfig.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});
async function fixture() {
  const root = await makeTempRoot(); roots.push(root);
  await ensureDataLayout(root);
  const installation: UpdateInstallation = { root: path.join(root, "installed"), prefix: root, stateDir: path.join(root, "updates") };
  await mkdir(installation.stateDir, { recursive: true });
  await mkdir(installation.root, { recursive: true });
  await writeFile(path.join(installation.root, "package.json"), JSON.stringify({ version: "1.5.206" }));
  return { root, installation };
}

describe("idle update admission", () => {
  it("waits for active work and for the quiet window after work finishes", () => {
    let now = 0;
    const gate = new UpdateActivity(() => now);
    now = 60000;
    const done = gate.begin()!;
    now += 120000;
    expect(gate.prepare(60000, false)).toBe(false);
    done(); done();
    expect(gate.snapshot().active).toBe(0);
    expect(gate.prepare(60000, false)).toBe(false);
    now += 60000;
    expect(gate.prepare(60000, true)).toBe(false);
    expect(gate.prepare(60000, false)).toBe(true);
    expect(gate.begin()).toBeUndefined();
    expect(gate.commit(false)).toBe(true);
    now += 999999;
    expect(gate.begin()).toBeUndefined();
  });

  it("expires abandoned preparation and allows explicit cancellation", () => {
    let now = 0; const gate = new UpdateActivity(() => now);
    now = 60000; expect(gate.prepare(60000, false)).toBe(true);
    gate.cancel(); expect(gate.begin()).toBeTypeOf("function");
    const second = new UpdateActivity(() => now);
    now += 60000; expect(second.prepare(60000, false)).toBe(true);
    now += 15001; expect(second.commit(false)).toBe(false);
    expect(second.begin()).toBeTypeOf("function");
  });

  it("counts passive finite requests without extending quiet time", () => {
    let now = 0; const gate = new UpdateActivity(() => now);
    now = 60000; const done = gate.begin(false)!;
    expect(gate.prepare(60000, false)).toBe(false);
    now += 10000; done();
    expect(gate.snapshot().idleMs).toBe(70000);
    expect(passiveUpdateRequest("GET", "/api/status?poll=1")).toBe(true);
    expect(passiveUpdateRequest("POST", "/api/assistant/conversations/a/messages")).toBe(false);
    expect(passiveUpdateRequest("GET", "/api/remote-access/pairing-requests")).toBe(false);
  });

  it("does not treat a returned response as the end of an ongoing async handler", async () => {
    let now = 0; const gate = new UpdateActivity(() => now);
    const app = fastify(); closers.push(() => app.close());
    installUpdateActivity(app, gate);
    let done!: () => void;
    const pending = new Promise<void>(resolve => { done = resolve; });
    app.post("/work", async (_request, reply) => { reply.send({ ok: true }); await pending; });
    const reply = await app.inject({ method: "POST", url: "/work" });
    expect(reply.statusCode).toBe(200);
    now = 60000; expect(gate.snapshot().active).toBe(1);
    expect(gate.prepare(60000, false)).toBe(false);
    done(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(gate.snapshot().active).toBe(0);
  });

  it("rejects new mutations while sealed and resumes after cancellation", async () => {
    let now = 0; const gate = new UpdateActivity(() => now);
    const app = fastify(); closers.push(() => app.close()); installUpdateActivity(app, gate);
    const handler = vi.fn(() => ({ ok: true })); app.post("/write", handler);
    now = 60000; expect(gate.prepare(60000, false)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/write" })).statusCode).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    gate.cancel(); expect((await app.inject({ method: "POST", url: "/write" })).statusCode).toBe(200);
  });
});

describe("automatic update control and configuration", () => {
  it("defaults off and preserves partial settings and unrelated runtime configuration", async () => {
    const { root } = await fixture();
    const current = await loadAppConfig(root);
    expect(current.updates).toEqual({ enabled: false, checkIntervalMinutes: 60, idleMinutes: 5 });
    const next = mergeAppConfigPatch(current, { updates: { idleMinutes: 9 } });
    expect(next.updates).toEqual({ enabled: false, checkIntervalMinutes: 60, idleMinutes: 9 });
    expect(next.runtime).toEqual(current.runtime);
    expect(mergeAppConfigPatch(next, { ocr: { enabled: false } }).updates).toEqual(next.updates);
    expect(() => mergeAppConfigPatch(next, { updates: { idleMinutes: 0 } })).toThrow();
    expect(() => mergeAppConfigPatch(next, { updates: { checkIntervalMinutes: 1 } })).toThrow();
  });

  it("requires a private capability and forbids browser-origin requests", async () => {
    const { root, installation } = await fixture();
    const control = await startUpdateControl({ installation, activity: new UpdateActivity(), dataRoot: root,
      role: "host", version: "1.5.206", args: ["start"], busy: () => false,
      requiresCredentials: () => false, stop: () => undefined });
    closers.push(() => control.close());
    const url = `http://127.0.0.1:${control.record.port}/`;
    expect((await fetch(url, { method: "POST", body: '{"action":"probe"}' })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { authorization: "é".repeat(64) }, body: '{"action":"probe"}' })).status).toBe(403);
    expect((await fetch(url, { method: "POST", headers: { authorization: control.record.token, origin: "https://evil.invalid" }, body: '{"action":"probe"}' })).status).toBe(403);
    expect((await callUpdateControl(control.record, "probe")).enabled).toBe(false);
    expect(await readUpdateLeases(installation)).toEqual([control.record]);
    const lock = JSON.parse(await readFile(path.join(installation.stateDir, "runtimes", `${control.record.id}.json`), "utf8"));
    expect(lock).toEqual(control.record);
  });

  it("postpones locked native credentials and never stops the process", async () => {
    const { root, installation } = await fixture();
    await updateAppConfig(root, { updates: { enabled: true, idleMinutes: 1 } });
    let now = 0; const activity = new UpdateActivity(() => now); now = 60000;
    const stop = vi.fn();
    const control = await startUpdateControl({ installation, activity, dataRoot: root,
      role: "remote", version: "1.5.206", args: ["remote"], busy: () => false,
      requiresCredentials: () => true, credentialsReady: async () => false, stop });
    closers.push(() => control.close());
    expect(await callUpdateControl(control.record, "prepare", "a".repeat(32))).toMatchObject({ accepted: false, reason: "credentials_locked" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects arbitrary restart commands before opening any control listener", async () => {
    const { root, installation } = await fixture();
    await expect(startUpdateControl({ installation, activity: new UpdateActivity(), dataRoot: root,
      role: "host", version: "1.5.206", args: ["clean", "--force"], busy: () => false,
      requiresCredentials: () => false })).rejects.toThrow("Invalid controlled restart arguments");
  });

  it("rechecks new work after asynchronous credential inspection", async () => {
    const { root, installation } = await fixture();
    await updateAppConfig(root, { updates: { enabled: true, idleMinutes: 1 } });
    let now = 0; const activity = new UpdateActivity(() => now); now = 60000;
    let complete!: () => void;
    const pending = new Promise<void>(resolve => { complete = resolve; });
    const control = await startUpdateControl({ installation, activity, dataRoot: root,
      role: "host", version: "1.5.206", args: ["start"], busy: () => false,
      requiresCredentials: () => true, credentialsReady: async () => { await pending; return true; }, stop: () => undefined });
    closers.push(() => control.close());
    const preparation = callUpdateControl(control.record, "prepare", "a".repeat(32));
    const finish = activity.begin()!; complete();
    expect((await preparation).accepted).toBe(false); finish();
  });

  it("requires the matching prepare transaction and honors disable before commit", async () => {
    const { root, installation } = await fixture();
    await updateAppConfig(root, { updates: { enabled: true, idleMinutes: 1 } });
    let now = 0; const activity = new UpdateActivity(() => now); now = 60000;
    const stop = vi.fn();
    const control = await startUpdateControl({ installation, activity, dataRoot: root,
      role: "host", version: "1.5.206", args: ["start"], busy: () => false, requiresCredentials: () => false, stop });
    closers.push(() => control.close());
    expect((await callUpdateControl(control.record, "stop", "b".repeat(32))).accepted).toBe(false);
    expect((await callUpdateControl(control.record, "prepare", "a".repeat(32))).accepted).toBe(true);
    expect((await callUpdateControl(control.record, "stop", "b".repeat(32))).accepted).toBe(false);
    await updateAppConfig(root, { updates: { enabled: false } });
    expect((await callUpdateControl(control.record, "stop", "a".repeat(32))).accepted).toBe(false);
    expect(stop).not.toHaveBeenCalled();
    await callUpdateControl(control.record, "cancel", "a".repeat(32));
    expect(activity.begin()).toBeTypeOf("function");
  });

  it("does not accept arbitrary diagnostic contents", () => {
    expect(UpdateStatusSchema.safeParse({ state: "failed", currentVersion: "1.5.206", candidateVersion: null, lastCheckAt: null,
      reason: "secret token", token: "private" }).success).toBe(false);
  });
});

describe("coordinated installation", () => {
  it("retires old worker code after a manual version transition", async () => {
    const { installation } = await fixture();
    const pkg = path.join(installation.root, "package.json");
    await writeFile(pkg, JSON.stringify({ name: "@waifucave/discord-waifus", version: "2.111.1" }));
    expect(await workerVersionIsCurrent(installation.root, "2.111.1")).toBe(true);
    expect(await workerVersionIsCurrent(installation.root, "1.5.207")).toBe(false);
    await writeFile(pkg, "incomplete install");
    expect(await workerVersionIsCurrent(installation.root, "2.111.1")).toBe(false);
  });
  it.each([
    ["1.5.206", "1.5.207", true], ["1.5.206", "1.5.206", false], ["1.5.206", "1.5.205", false],
    ["1.5.206", "1.6.0", false], ["1.5.206", "2.0.0", false], ["1.5.206", "1.5.207-beta.1", false],
    ["1.5.206", "1.5.0207", false],
    ["1.5.207", "2.111.1", false], ["2.111.1", "2.111.2", true],
    ["2.111.1", "2.112.0", false], ["2.111.1", "3.0.0", false],
    ["2.111.1", "2.111.01", false]
  ])("selects only newer plain patch versions: %s → %s", (a, b, expected) => expect(newerPatch(a, b)).toBe(expected));

  async function setup() {
    const { root, installation } = await fixture();
    const leases: UpdateLease[] = ["host", "remote"].map((role, i) => ({
      pid: 900000 + i, id: String(i).repeat(32), token: "a".repeat(64), port: 5000 + i,
      role: role as "host" | "remote", dataRoot: root, args: [role === "host" ? "start" : "remote"], version: "1.5.206"
    }));
    const install = vi.fn(async () => undefined), verify = vi.fn(async () => undefined), restart = vi.fn(async () => undefined);
    const control = vi.fn(async (role: UpdateLease, action: string) => ({ id: role.id, active: 0, idleMs: 600000,
      enabled: true, busy: false, accepted: action !== "cancel" }));
    return { root, leases, installation, install, verify, restart, control,
      deps: { installation, list: async () => leases, control: control as typeof callUpdateControl,
        alive: () => false, install, verify, restart } };
  }

  it("stops both idle roles before installing and restores their exact launch arguments", async () => {
    const f = await setup();
    expect(await applyIdleUpdate("1.5.206", "1.5.207", f.deps)).toBe("updated");
    expect(f.control.mock.calls.map(call => call[1])).toEqual(["prepare", "prepare", "stop", "stop"]);
    expect(f.install).toHaveBeenCalledExactlyOnceWith("1.5.207");
    expect(f.verify).toHaveBeenCalledExactlyOnceWith("1.5.207", f.leases);
    expect(f.restart.mock.calls.map(call => call[0])).toEqual(f.leases);
    const journal = JSON.parse(await readFile(path.join(f.installation.stateDir, "journal.json"), "utf8"));
    expect(journal.phase).toBe("installed");
  });

  it("does not replace files when any sibling is busy; cancels already prepared roles", async () => {
    const f = await setup();
    f.control.mockImplementation(async (role, action) => ({ id: role.id, active: 0, idleMs: 600000,
      enabled: true, busy: role.role === "remote", accepted: role.role !== "remote" }));
    expect(await applyIdleUpdate("1.5.206", "1.5.207", f.deps)).toBe("busy");
    expect(f.install).not.toHaveBeenCalled(); expect(f.restart).not.toHaveBeenCalled();
    expect(f.control.mock.calls.at(-1)?.[1]).toBe("cancel");
  });

  it("restores the previous package when installation or verification fails", async () => {
    const f = await setup(); f.verify.mockRejectedValueOnce(new Error("invalid helper signature"));
    expect(await applyIdleUpdate("1.5.206", "1.5.207", f.deps)).toBe("rolled_back");
    expect(f.install.mock.calls.map(call => call[0])).toEqual(["1.5.207", "1.5.206"]);
    // Both verifications use the role list read under the transaction lock.
    expect(f.verify.mock.calls).toEqual([["1.5.207", f.leases], ["1.5.206", f.leases]]);
    expect(f.restart).toHaveBeenCalledTimes(2);
  });

  it("blocks an old live sibling with no control lease", async () => {
    const f = await setup();
    await writeFile(path.join(f.root, "app/pid.json"), JSON.stringify({ pid: 700001 }));
    f.deps.alive = pid => pid === 700001;
    expect(await applyIdleUpdate("1.5.206", "1.5.207", f.deps)).toBe("busy");
    expect(f.control).not.toHaveBeenCalled(); expect(f.install).not.toHaveBeenCalled();
  });

  it("blocks pre-updater CLI daemons in unregistered data roots", async () => {
    const f = await setup();
    expect(await applyIdleUpdate("1.5.206", "1.5.207", { ...f.deps, inventory: async () => [700001] })).toBe("busy");
    expect(f.install).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled();
  });

  it("never launches an unverified replacement if restoring the old package also fails", async () => {
    const f = await setup(); f.verify.mockRejectedValue(new Error("unverified package"));
    await expect(applyIdleUpdate("1.5.206", "1.5.207", f.deps)).rejects.toThrow("restore_failed");
    expect(f.install.mock.calls.map(call => call[0])).toEqual(["1.5.207", "1.5.206"]);
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("restarts an already stopped role if another role rejects commit", async () => {
    const f = await setup();
    f.control.mockImplementation(async (role, action) => ({ id: role.id, active: 0, idleMs: 600000,
      enabled: true, busy: false, accepted: !(role.role === "remote" && action === "stop") }));
    await expect(applyIdleUpdate("1.5.206", "1.5.207", f.deps)).rejects.toThrow("commit_rejected");
    expect(f.install).not.toHaveBeenCalled();
    expect(f.restart).toHaveBeenCalledExactlyOnceWith(f.leases[0]);
  });

  it("attempts every restart even if one restart fails", async () => {
    const f = await setup(); f.restart.mockRejectedValueOnce(new Error("launch failed"));
    await expect(applyIdleUpdate("1.5.206", "1.5.207", f.deps)).rejects.toThrow("restart_failed");
    expect(f.restart).toHaveBeenCalledTimes(2);
  });

  it("serializes transactions and refuses malformed ownership records", async () => {
    const f = await setup(); let release!: () => void;
    const first = installationLock(f.installation.stateDir, "transaction", async () =>
      new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(installationLock(f.installation.stateDir, "transaction", async () => undefined)).rejects.toThrow("update_locked");
    release(); await first;
    await writeFile(path.join(f.installation.stateDir, "transaction.lock"), "{}");
    await expect(installationLock(f.installation.stateDir, "transaction", async () => undefined)).rejects.toThrow("update_locked");
  });
});
