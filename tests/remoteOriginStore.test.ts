import { chmod, lstat, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import {
  RemoteOriginStore,
  derivePinnedHostId,
  deriveRemoteOriginHostname
} from "../src/remote/gateway/originStore.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const port = 43_123;
const seed = Buffer.alloc(32, 0x11);

function pinnedHost(value: number): string {
  return Buffer.alloc(32, value).toString("base64url");
}

async function originStore(prefix: string): Promise<{
  root: string;
  store: RemoteOriginStore;
}> {
  const root = await makeTempRoot(prefix);
  roots.push(root);
  await ensureRemoteOnlyLayout(root);
  const store = new RemoteOriginStore(root, {
    randomBytes: (size) => Buffer.alloc(size, 0x11)
  });
  await store.initializePreferredPort(port);
  return { root, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

describe("remote origin derivation", () => {
  it("matches the frozen host-id, uint64, HMAC, and lowercase base32 vector", () => {
    const hostId = derivePinnedHostId(Buffer.alloc(32, 0x22));
    expect(hostId).toBe("L0P6YYCoPxkF_mxNt0A4FcoDxiqqZkVT982je2HcrSI");
    expect(deriveRemoteOriginHostname(seed, hostId, "1")).toBe(
      "waifus-jqi7xbezf5gauo67ot5fqb745fuycxjcxgjwbuw6by5oo3hpl36q.localhost"
    );
    expect(deriveRemoteOriginHostname(seed, hostId, "9007199254740992")).toBe(
      "waifus-xaklldlfijai7hqenqp2v7l2uy7wmvxenvujm4bhmslkiz7n73ia.localhost"
    );
  });

  it("changes for a different seed, host, or epoch and always uses one 59-character label", () => {
    const firstHost = pinnedHost(0x31);
    const base = deriveRemoteOriginHostname(seed, firstHost, "1");
    expect(new Set([
      base,
      deriveRemoteOriginHostname(Buffer.alloc(32, 0x12), firstHost, "1"),
      deriveRemoteOriginHostname(seed, pinnedHost(0x32), "1"),
      deriveRemoteOriginHostname(seed, firstHost, "2")
    ]).size).toBe(4);
    expect(base).toMatch(/^waifus-[a-z2-7]{52}\.localhost$/u);
    expect(base.split(".")[0]).toHaveLength(59);
  });

  it("rejects malformed key material and epochs outside the positive uint64 range", () => {
    const hostId = pinnedHost(0x33);
    expect(() => derivePinnedHostId(Buffer.alloc(31))).toThrow(/exactly 32 bytes/u);
    expect(() => deriveRemoteOriginHostname(Buffer.alloc(31), hostId, "1"))
      .toThrow(/exactly 32 bytes/u);
    expect(() => deriveRemoteOriginHostname(seed, hostId, "0")).toThrow();
    expect(() => deriveRemoteOriginHostname(seed, hostId, "18446744073709551616")).toThrow();
  });
});

describe("remote origin persistence", () => {
  it("allocates once, reuses an unchanged trust binding, and rotates on trust change", async () => {
    const { root, store } = await originStore("waifus-origin-store-");
    const hostId = pinnedHost(0x41);
    const first = await store.allocateOrReuse(hostId, "7");
    const reused = await store.allocateOrReuse(hostId, "7");
    const rotated = await store.allocateOrReuse(hostId, "8");

    expect(first).toMatchObject({
      pinnedHostId: hostId,
      hostTrustEpoch: "7",
      localOriginEpoch: "1",
      port
    });
    expect(reused).toEqual(first);
    expect(rotated).toMatchObject({
      pinnedHostId: hostId,
      hostTrustEpoch: "8",
      localOriginEpoch: "2",
      port
    });
    expect(rotated.hostname).not.toBe(first.hostname);

    const statePath = remoteStatePaths(root).remoteOriginState;
    const metadata = await lstat(statePath);
    if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      version: 1,
      localOriginSeed: seed.toString("base64url"),
      originEpochHighWater: "2",
      preferredPort: port,
      hosts: [{
        pinnedHostId: hostId,
        hostTrustEpoch: "8",
        localOriginEpoch: "2",
        port
      }]
    });
  });

  it("serializes concurrent store instances into unique global epochs", async () => {
    const { root, store } = await originStore("waifus-origin-concurrent-");
    const stores = [
      store,
      new RemoteOriginStore(root),
      new RemoteOriginStore(root),
      new RemoteOriginStore(root)
    ];
    const bindings = await Promise.all(
      [0x51, 0x52, 0x53, 0x54].map((value, index) => (
        stores[index].allocateOrReuse(pinnedHost(value), "1")
      ))
    );
    expect(bindings.map((binding) => binding.localOriginEpoch).sort()).toEqual(["1", "2", "3", "4"]);
    expect((await store.getState()).originEpochHighWater).toBe("4");
  });

  it("burns an epoch before forget so re-pairing cannot reopen the old origin", async () => {
    const { store } = await originStore("waifus-origin-forget-");
    const hostId = pinnedHost(0x61);
    const first = await store.allocateOrReuse(hostId, "3");
    await store.forget(hostId, first.localOriginEpoch);
    expect(await store.getState()).toMatchObject({
      originEpochHighWater: "2",
      hosts: []
    });

    const repaired = await store.allocateOrReuse(hostId, "4");
    expect(repaired.localOriginEpoch).toBe("3");
    expect(repaired.hostname).not.toBe(first.hostname);
  });

  it("does not mutate state when a stale forget or preferred-port change is rejected", async () => {
    const { store } = await originStore("waifus-origin-stale-");
    const binding = await store.allocateOrReuse(pinnedHost(0x62), "3");
    const before = await store.getState();

    await expect(store.forget(binding.pinnedHostId, "2"))
      .rejects.toMatchObject({ code: "origin_binding_conflict" });
    await expect(store.initializePreferredPort(port + 1))
      .rejects.toMatchObject({ code: "preferred_port_conflict" });
    expect(await store.getState()).toEqual(before);
  });

  it("rotates the selected host and invalidates other saved origins on port failover", async () => {
    const { store } = await originStore("waifus-origin-port-");
    const firstHost = await store.allocateOrReuse(pinnedHost(0x71), "1");
    const secondHost = await store.allocateOrReuse(pinnedHost(0x72), "1");
    const rotated = await store.rotateForPortFailover(
      firstHost.pinnedHostId,
      firstHost.localOriginEpoch,
      43_124
    );

    expect(rotated).toMatchObject({ localOriginEpoch: "3", port: 43_124 });
    expect(rotated.hostname).not.toBe(firstHost.hostname);
    expect((await store.getState()).hosts).toHaveLength(1);
    await expect(store.rotateForPortFailover(
      firstHost.pinnedHostId,
      firstHost.localOriginEpoch,
      43_125
    )).rejects.toMatchObject({ code: "origin_binding_conflict" });

    const secondAfterFailover = await store.allocateOrReuse(secondHost.pinnedHostId, "1");
    expect(secondAfterFailover).toMatchObject({ localOriginEpoch: "4", port: 43_124 });
    expect(secondAfterFailover.hostname).not.toBe(secondHost.hostname);
  });

  it("preserves bigint epochs and fails closed when uint64 allocation is exhausted", async () => {
    const root = await makeTempRoot("waifus-origin-uint64-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const statePath = remoteStatePaths(root).remoteOriginState;
    await writeFile(statePath, JSON.stringify({
      version: 1,
      localOriginSeed: seed.toString("base64url"),
      originEpochHighWater: "18446744073709551614",
      preferredPort: port,
      hosts: []
    }, null, 2) + "\n", { mode: 0o600 });
    const store = new RemoteOriginStore(root);
    const last = await store.allocateOrReuse(pinnedHost(0x7a), "9007199254740992");
    expect(last.localOriginEpoch).toBe("18446744073709551615");
    await expect(store.allocateOrReuse(pinnedHost(0x7b), "1"))
      .rejects.toMatchObject({ code: "origin_epoch_exhausted" });
    expect((await store.getState()).originEpochHighWater).toBe("18446744073709551615");
  });

  it("rejects a state file that is writable by another local account", async () => {
    if (process.platform === "win32") return;
    const { root } = await originStore("waifus-origin-mode-");
    const statePath = remoteStatePaths(root).remoteOriginState;
    await chmod(statePath, 0o644);
    await expect(new RemoteOriginStore(root).getState())
      .rejects.toMatchObject({ code: "origin_state_untrusted" });
  });

  it("rejects corrupt and internally inconsistent persisted state", async () => {
    const { root } = await originStore("waifus-origin-corrupt-");
    const statePath = remoteStatePaths(root).remoteOriginState;
    await writeFile(statePath, JSON.stringify({
      version: 1,
      localOriginSeed: seed.toString("base64url"),
      originEpochHighWater: "1",
      preferredPort: port,
      hosts: [
        {
          pinnedHostId: pinnedHost(0x81),
          hostTrustEpoch: "1",
          localOriginEpoch: "2",
          port
        }
      ]
    }), { mode: 0o600 });

    await expect(new RemoteOriginStore(root).getState())
      .rejects.toMatchObject({ code: "origin_state_invalid" });
  });

  it("rejects a symlinked state file", async () => {
    if (process.platform === "win32") return;
    const { root } = await originStore("waifus-origin-symlink-");
    const statePath = remoteStatePaths(root).remoteOriginState;
    const targetPath = `${statePath}.target`;
    await writeFile(targetPath, "{}", { mode: 0o600 });
    await unlink(statePath);
    await symlink(targetPath, statePath);

    await expect(new RemoteOriginStore(root).getState())
      .rejects.toMatchObject({ code: "origin_state_untrusted" });
  });

  it("fails before persistence when the seed generator returns the wrong size", async () => {
    const root = await makeTempRoot("waifus-origin-random-");
    roots.push(root);
    await ensureRemoteOnlyLayout(root);
    const store = new RemoteOriginStore(root, {
      randomBytes: () => Buffer.alloc(31)
    });

    await expect(store.initializePreferredPort(port)).rejects.toThrow(/exactly 32 bytes/u);
    await expect(lstat(remoteStatePaths(root).remoteOriginState)).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});
