import { chmod, lstat, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRemoteOnlyLayout } from "../src/config/layout.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";
import {
  RememberedHostStore,
  type RememberedHostRecordV1
} from "../src/remote/rememberedHosts.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function record(value: number, overrides: Partial<RememberedHostRecordV1> = {}): RememberedHostRecordV1 {
  const installationPublicKey = Buffer.alloc(32, value).toString("base64url") as never;
  return {
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(installationPublicKey, "base64url")) as never,
    displayName: `Host ${value}`,
    platform: { os: "darwin", arch: "arm64" },
    installationFingerprint: Buffer.alloc(16, value).toString("base64url") as never,
    trustEpoch: "1" as never,
    revision: "1" as never,
    pairedAt: "1786270800" as never,
    lastSeenAt: null,
    lastDirectAt: null,
    connectionState: "offline",
    lastErrorCode: null,
    helperPairId: Buffer.alloc(16, value + 32).toString("base64url") as never,
    installationPublicKey,
    ...overrides
  };
}

async function makeStore(prefix: string): Promise<{ root: string; store: RememberedHostStore }> {
  const root = await makeTempRoot(prefix);
  roots.push(root);
  await ensureRemoteOnlyLayout(root);
  return { root, store: new RememberedHostStore(root) };
}

describe("remembered host store", () => {
  it("is partitioned by data root and never exposes helper pair references or public keys", async () => {
    const first = await makeStore("waifus-remembered-first-");
    const second = await makeStore("waifus-remembered-second-");
    const host = record(0x31);
    await first.store.upsert(host);

    expect(await first.store.list()).toEqual({
      version: 1,
      hosts: [{
        version: 1,
        hostId: host.hostId,
        displayName: host.displayName,
        platform: host.platform,
        installationFingerprint: host.installationFingerprint,
        trustEpoch: host.trustEpoch,
        revision: host.revision,
        pairedAt: host.pairedAt,
        lastSeenAt: null,
        lastDirectAt: null,
        connectionState: "offline",
        lastErrorCode: null
      }]
    });
    expect(JSON.stringify(await first.store.list())).not.toContain(host.helperPairId);
    expect(JSON.stringify(await first.store.list())).not.toContain(host.installationPublicKey);
    expect(await second.store.list()).toEqual({ version: 1, hosts: [] });

    const statePath = remoteStatePaths(first.root).remoteRememberedHosts;
    if (process.platform !== "win32") {
      expect((await lstat(statePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("auto-selects one host, requires a choice for many, and persists an explicit selection", async () => {
    const { root, store } = await makeStore("waifus-remembered-selection-");
    const first = record(0x41);
    const second = record(0x42);
    expect(await store.selection()).toEqual({ selectionState: "no_hosts", selectedHostId: null });
    await store.upsert(first);
    expect(await store.selection()).toEqual({
      selectionState: "automatic_single",
      selectedHostId: first.hostId
    });
    await store.upsert(second);
    expect(await store.selection()).toEqual({
      selectionState: "selection_required",
      selectedHostId: null
    });
    await store.select(second.hostId);
    expect(await new RememberedHostStore(root).selection()).toEqual({
      selectionState: "explicit",
      selectedHostId: second.hostId
    });
  });

  it("validates host identity, bytewise ordering, unique pair IDs, and optimistic removal", async () => {
    const { store } = await makeStore("waifus-remembered-integrity-");
    const first = record(0x51);
    await expect(store.upsert({ ...first, hostId: record(0x52).hostId })).rejects.toThrow();
    await store.upsert(first);
    await expect(store.remove(first.hostId, "2"))
      .rejects.toMatchObject({ code: "host_conflict" });
    expect(await store.record(first.hostId)).toEqual(first);
    await store.remove(first.hostId, "1");
    expect(await store.record(first.hostId)).toBeUndefined();
    expect(await store.selection()).toEqual({ selectionState: "no_hosts", selectedHostId: null });
  });

  it("updates only sanitized connection state while preserving trust revision", async () => {
    const { store } = await makeStore("waifus-remembered-status-");
    const host = record(0x61);
    await store.upsert(host);
    const updated = await store.updateConnection(
      host.hostId,
      "direct",
      "1786270900",
      null
    );
    expect(updated).toMatchObject({
      hostId: host.hostId,
      revision: "1",
      connectionState: "direct",
      lastDirectAt: "1786270900"
    });
  });

  it("rejects owner-broad persisted state", async () => {
    if (process.platform === "win32") return;
    const { root, store } = await makeStore("waifus-remembered-mode-");
    await store.getState();
    const statePath = remoteStatePaths(root).remoteRememberedHosts;
    await chmod(statePath, 0o644);
    await expect(new RememberedHostStore(root).getState())
      .rejects.toMatchObject({ code: "remembered_hosts_untrusted" });
    expect(await readFile(statePath, "utf8")).not.toContain("privateKey");
  });
});
