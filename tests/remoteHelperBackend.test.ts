import { describe, expect, it, vi } from "vitest";
import {
  createRemoteHelperBackend,
  rememberedHostFromCompletedPair
} from "../src/remote/gateway/helperBackend.js";
import { derivePinnedHostId } from "../src/remote/gateway/originStore.js";

const bytes = (length: number, value: number) => Buffer.alloc(length, value).toString("base64url");
const operationId = bytes(32, 0x31);
const pairId = bytes(16, 0x32);
const publicKey = bytes(32, 0x33);
const hostId = derivePinnedHostId(Buffer.from(publicKey, "base64url"));

function fixture() {
  const calls: string[] = [];
  const snapshot = vi.fn(() => ({
    state: "ready",
    helperVersion: "0.1.0",
    releaseSequence: "1",
    forkCommit: "a".repeat(40),
    target: { os: "darwin", arch: "arm64" },
    protocol: { major: 1, minor: 0 },
    capabilities: ["waifus.http.v1"],
    runtimeStatus: {
      activationState: "active",
      controlState: "connected",
      directState: "direct",
      lastDirectAt: "100",
      lastErrorCode: null
    },
    lastErrorCode: null,
    consecutiveFailures: 0,
    restartScheduled: false
  }));
  const helper = {
    snapshot,
    beginActivation: vi.fn(),
    pollActivation: vi.fn(),
    cancelActivation: vi.fn(),
    beginPair: vi.fn(async () => ({ operationId, expiresAt: "200" })),
    pollPair: vi.fn(async () => ({ operationId, state: "connecting", expiresAt: "200" })),
    cancelPair: vi.fn(async () => ({ operationId, cancelled: true })),
    consumeCompletedPair: vi.fn(async () => ({
      operationId,
      pairId,
      hostDisplayName: "Test host",
      hostPlatform: { os: "linux", arch: "x64" },
      hostInstallationPublicKey: publicKey,
      hostInstallationFingerprint: bytes(16, 0x34),
      hostTrustEpoch: "7",
      pairedAt: "100"
    })),
    startRuntime: vi.fn(async (selectedPairId: string) => {
      calls.push(`start:${selectedPairId}`);
    }),
    stopRuntime: vi.fn(async () => {
      calls.push("stop");
    })
  };
  const backend = createRemoteHelperBackend({
    supervisor: helper as never,
    appVersion: "1.5.203",
    deviceDisplayName: "Remote device"
  });
  return { backend, helper, calls };
}

describe("remote helper backend", () => {
  it("maps verified helper identity, pairing, and completed host data", async () => {
    const { backend, helper } = fixture();
    expect(await backend.snapshot()).toMatchObject({
      gatewayVersion: "1.5.203",
      helperVersion: "0.1.0",
      helperReleaseSequence: "1",
      directState: "direct"
    });
    const input = { kind: "short_code", code: "0123-4567" } as never;
    expect(await backend.beginPair(operationId, input)).toEqual({ expiresAt: "200" });
    expect(helper.beginPair).toHaveBeenCalledWith(operationId, input, {
      displayName: "Remote device",
      platform: { os: "darwin", arch: "arm64" }
    });
    expect(await backend.pollPair(operationId)).toEqual({
      pairOperationId: operationId,
      statusUrl: `/_waifus_remote/v1/pair/${operationId}`,
      state: "connecting",
      expiresAt: "200"
    });
    expect(await backend.consumeCompletedPair(operationId)).toMatchObject({
      hostId,
      helperPairId: pairId,
      displayName: "Test host",
      installationPublicKey: publicKey,
      trustEpoch: "7",
      revision: "1",
      connectionState: "offline"
    });
  });

  it("rejects helper operation substitution before persisting a host", async () => {
    const { backend, helper } = fixture();
    helper.consumeCompletedPair.mockResolvedValueOnce({
      operationId: bytes(32, 0x35),
      pairId,
      hostDisplayName: "Test host",
      hostPlatform: { os: "linux", arch: "x64" },
      hostInstallationPublicKey: publicKey,
      hostInstallationFingerprint: bytes(16, 0x34),
      hostTrustEpoch: "7",
      pairedAt: "100"
    });
    await expect(backend.consumeCompletedPair(operationId)).rejects.toMatchObject({
      code: "helper_incompatible"
    });
  });

  it("stops the old selected pair before switching and never claims forget succeeded", async () => {
    const { backend, calls } = fixture();
    const first = rememberedHostFromCompletedPair({
      operationId,
      pairId,
      hostDisplayName: "Test host",
      hostPlatform: { os: "linux", arch: "x64" },
      hostInstallationPublicKey: publicKey,
      hostInstallationFingerprint: bytes(16, 0x34),
      hostTrustEpoch: "7",
      pairedAt: "100"
    } as never);
    const second = { ...first, helperPairId: bytes(16, 0x37) };
    await backend.connectRememberedHost(first);
    await backend.connectRememberedHost(second);
    await backend.disconnectRememberedHost(first);
    await backend.disconnectRememberedHost(second);
    expect(calls).toEqual([
      `start:${pairId}`,
      "stop",
      `start:${second.helperPairId}`,
      "stop"
    ]);
    expect(await backend.requestSignedSelfRevocation(first)).toBe(false);
    await expect(backend.forgetRememberedHost(first)).rejects.toMatchObject({
      code: "helper_unavailable"
    });
  });
});
