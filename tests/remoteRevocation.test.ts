import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RemoteAccessStateStore } from "../src/backend/remoteAccess/stateStore.js";
import { RemoteAccessInvalidations } from "../src/backend/remoteAccess/invalidation.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { remoteStatePaths } from "../src/remote/paths.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function makeEnabledRoot(): Promise<string> {
  const root = await makeTempRoot("waifus-remote-revocation-");
  roots.push(root);
  await ensureDataLayout(root);
  const paths = remoteStatePaths(root);
  const config = JSON.parse(await readFile(paths.hostConfig, "utf8")) as Record<string, unknown>;
  await writeFile(paths.hostConfig, JSON.stringify({
    ...config,
    revision: "1",
    enabled: true,
    updatedAt: "1"
  }, null, 2) + "\n", { mode: 0o600 });
  return root;
}

async function writeTrust(
  root: string,
  trustEpochHighWater: string,
  pairs: Array<{ deviceId: string; pairId: string; trustEpoch: string }>
): Promise<void> {
  await writeFile(remoteStatePaths(root).trustIndex, JSON.stringify({
    version: 1,
    trustEpochHighWater,
    resetTombstone: "0",
    pairs
  }, null, 2) + "\n", { mode: 0o600 });
}

describe("durable local remote-device denial", () => {
  it("delivers security invalidation to every subscriber even if one throws", () => {
    const invalidations = new RemoteAccessInvalidations();
    const seen: string[] = [];
    invalidations.subscribe(() => {
      seen.push("throwing");
      throw new Error("broken feature subscriber");
    });
    invalidations.subscribe((event) => seen.push(event.stableId));

    expect(() => invalidations.emit({
      version: 1,
      kind: "device_trust_revoked",
      stableId: "remote:travel-mac",
      deviceId: "travel-mac",
      trustEpoch: "7",
      denyEpoch: "8"
    })).not.toThrow();
    expect(seen).toEqual(["throwing", "remote:travel-mac"]);
  });

  it("blocks a revoked epoch across restart without overwriting helper-owned trust", async () => {
    const root = await makeEnabledRoot();
    const paths = remoteStatePaths(root);
    const targetPair = {
      deviceId: "travel-mac",
      pairId: Buffer.alloc(16, 0x41).toString("base64url"),
      trustEpoch: "7"
    };
    const otherPair = {
      deviceId: "studio-pc",
      pairId: Buffer.alloc(16, 0x42).toString("base64url"),
      trustEpoch: "6"
    };
    await writeTrust(root, "7", [targetPair, otherPair]);

    const store = new RemoteAccessStateStore(root);
    const result = await store.denyDevice("travel-mac", "7", 100n);

    expect(result).toMatchObject({
      created: true,
      denial: {
        deviceId: "travel-mac",
        pairId: targetPair.pairId,
        deniedTrustEpoch: "7",
        denyEpoch: "8",
        revokedAt: "100"
      }
    });
    expect(await store.isAuthorized("travel-mac", "7")).toBe(false);
    expect(await store.isAuthorized("studio-pc", "6")).toBe(true);
    expect(JSON.parse(await readFile(paths.trustIndex, "utf8"))).toMatchObject({
      trustEpochHighWater: "7",
      pairs: [targetPair, otherPair]
    });
    expect(JSON.parse(await readFile(paths.localDenyIndex, "utf8"))).toEqual({
      version: 1,
      trustEpochHighWater: "8",
      devices: [result.denial]
    });

    const restarted = new RemoteAccessStateStore(root);
    expect(await restarted.isAuthorized("travel-mac", "7")).toBe(false);

    await writeTrust(root, "9", [{ ...targetPair, trustEpoch: "9" }, otherPair]);
    expect(await restarted.isAuthorized("travel-mac", "9")).toBe(false);

    await writeTrust(root, "9", [{
      ...targetPair,
      pairId: Buffer.alloc(16, 0x43).toString("base64url"),
      trustEpoch: "9"
    }, otherPair]);
    expect(await restarted.isAuthorized("travel-mac", "9")).toBe(true);
  });

  it("serializes concurrent cutoffs and makes an exact repeated denial idempotent", async () => {
    const root = await makeEnabledRoot();
    const firstPair = {
      deviceId: "first-mac",
      pairId: Buffer.alloc(16, 0x51).toString("base64url"),
      trustEpoch: "7"
    };
    const secondPair = {
      deviceId: "second-mac",
      pairId: Buffer.alloc(16, 0x52).toString("base64url"),
      trustEpoch: "9"
    };
    await writeTrust(root, "9", [firstPair, secondPair]);
    const store = new RemoteAccessStateStore(root);

    const [first, second] = await Promise.all([
      store.denyDevice(firstPair.deviceId, firstPair.trustEpoch, 200n),
      store.denyDevice(secondPair.deviceId, secondPair.trustEpoch, 201n)
    ]);
    const repeated = await store.denyDevice(firstPair.deviceId, firstPair.trustEpoch, 999n);

    expect(new Set([first.denial.denyEpoch, second.denial.denyEpoch])).toEqual(
      new Set(["10", "11"])
    );
    expect(repeated).toEqual({ created: false, denial: first.denial });
    expect(JSON.parse(await readFile(remoteStatePaths(root).localDenyIndex, "utf8")))
      .toMatchObject({ trustEpochHighWater: "11" });
  });
});
