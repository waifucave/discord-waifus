import { afterEach, describe, expect, it } from "vitest";
import type { ModelPipeline } from "../src/providers/types.js";
import {
  ASSISTANT_ACTION_TTL_MS,
  AssistantActionCapacityError,
  AssistantActionConflictError,
  AssistantActionNotFoundError,
  AssistantActionStore,
  AssistantActionTooLargeError,
  AssistantActionUnsafeContentError,
  MAX_ASSISTANT_ACTION_BYTES,
  MAX_ASSISTANT_ACTIONS_PER_OWNER
} from "../src/api/assistant/actions.js";
import { createApiServer } from "../src/api/server.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import {
  createLocalRequestPrincipal,
  createRemoteRequestPrincipal
} from "../src/api/requestPrincipal.js";
import type { RemoteAccessService } from "../src/backend/remoteAccess/remoteAccessService.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { mapSasIndicesToWordsV1 } from "../src/shared/sasWordlist.js";
import { AuditStore } from "../src/storage/auditStore.js";
import { StorageService } from "../src/storage/storageService.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");
const bytes32 = (value: number) => Buffer.alloc(32, value).toString("base64url");
const roots: string[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

function localPrincipal(sessionByte = 0x22, launchByte = 0x21) {
  return createLocalRequestPrincipal({
    verifiedBy: "host_server",
    hostServerLaunchId: bytes32(launchByte),
    browserSessionId: bytes32(sessionByte),
    requestNonce: bytes16(0x23),
    method: "POST",
    canonicalTarget: "/api/assistant/conversations/conversation-1/messages",
    csrfValidated: true
  });
}

function remotePrincipal(input: {
  deviceId?: string;
  trustEpoch?: string;
  transportByte?: number;
  gatewayByte?: number;
  sessionByte?: number;
  method?: "GET" | "POST" | "DELETE";
  canonicalTarget?: string;
} = {}) {
  const deviceId = input.deviceId ?? "travel-mac";
  return createRemoteRequestPrincipal({
    kind: "remote_device",
    stableId: `remote:${deviceId}`,
    deviceId,
    peerFingerprint: bytes16(0x31),
    transportSessionId: bytes16(input.transportByte ?? 0x32),
    trustEpoch: input.trustEpoch ?? "5",
    browserContext: {
      version: 1,
      gatewayLaunchId: bytes32(input.gatewayByte ?? 0x33),
      browserSessionId: bytes32(input.sessionByte ?? 0x34),
      requestNonce: bytes16(0x35),
      method: input.method ?? "POST",
      canonicalTarget: input.canonicalTarget ?? "/api/assistant/conversations/conversation-1/messages",
      csrfValidated: true,
      verifiedBy: "host_helper"
    }
  });
}

function deterministicRandom() {
  let sequence = 1;
  return (size: number) => {
    const result = Buffer.alloc(size);
    result.writeUInt32BE(sequence++);
    return result;
  };
}

function proposal(payload: Record<string, unknown> = { enabled: true }) {
  return {
    category: "remote_access_enable",
    summary: "Enable remote access on this host.",
    resource: { type: "remote_access", identifier: "host" },
    operation: {
      kind: "exact_http" as const,
      method: "PUT" as const,
      canonicalTarget: "/api/remote-access",
      payload
    }
  };
}

const delegation = {
  conversationId: "conversation-1",
  toolCallId: "tool-1"
};

type FakeRemoteState = {
  authorized: boolean;
  enabled: boolean;
  updateInputs: unknown[];
  approvalInputs: Array<{ requestId: string; input: unknown; actor: unknown }>;
  invitationActors: unknown[];
  pairingRequest: ReturnType<typeof pairingRequest> | undefined;
  cancellationActors?: unknown[];
  rejectedRequestIds?: string[];
  renameInputs?: Array<{ deviceId: string; input: unknown; actor: unknown }>;
  reconnectCount?: number;
  invalidationListener?: (event: {
    version: 1;
    kind: "device_trust_revoked";
    stableId: string;
    deviceId: string;
    trustEpoch: string;
    denyEpoch: string;
  }) => void;
};

function pairingRequest() {
  const sasIndices = [1, 2, 3, 4, 5] as [number, number, number, number, number];
  return {
    version: 1 as const,
    requestId: bytes16(0x51),
    invitationId: bytes16(0x52),
    invitationGeneration: "4",
    entryFlow: "full_token" as const,
    claimedDisplayName: "Travel laptop",
    claimedPlatform: { os: "darwin" as const, arch: "arm64" as const },
    claimedInstallationFingerprint: bytes16(0x53),
    remoteIdentityBundleHash: bytes32(0x61),
    expiresAt: "1893456000",
    protocol: { major: 1, minor: 0 },
    transcriptHash: bytes32(0x62),
    channelBinding: bytes32(0x63),
    sasIndices,
    sasWords: mapSasIndicesToWordsV1(sasIndices),
    sasFingerprint: "abcdef123456"
  };
}

function fakeRemoteAccess(state: FakeRemoteState): RemoteAccessService {
  return {
    subscribeInvalidations: (listener: NonNullable<FakeRemoteState["invalidationListener"]>) => {
      state.invalidationListener = listener;
      return () => {
        if (state.invalidationListener === listener) state.invalidationListener = undefined;
      };
    },
    getStatus: async () => ({
      version: 1,
      config: {
        revision: "7",
        enabled: state.enabled,
        displayName: "Studio host",
        updatedAt: "1786270800"
      },
      identity: { deviceId: "host-device-01", installationFingerprint: bytes16(0x41) },
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helperVersion: "0.1.0",
      helperReleaseSequence: "42",
      protocol: { major: 1, minor: 0 },
      capabilities: [],
      helperState: state.enabled ? "ready" : "disabled",
      activationState: "active",
      controlState: state.enabled ? "connected" : "inactive",
      directState: state.enabled ? "direct" : "inactive",
      lastDirectAt: state.enabled ? "1786270800" : null,
      lastErrorCode: null
    }),
    updateConfig: async (input: { enabled?: boolean }) => {
      state.updateInputs.push(structuredClone(input));
      state.enabled = input.enabled ?? state.enabled;
      return {
        revision: "8",
        enabled: state.enabled,
        displayName: "Studio host",
        updatedAt: "1786270801"
      };
    },
    createInvitation: async (actor: unknown) => {
      state.invitationActors.push(structuredClone(actor));
      return {
        invitationId: bytes16(0x71),
        fullToken: `WF1.${Buffer.alloc(192, 0x72).toString("base64url")}`,
        shortCode: "01AB-CDEF",
        expiresAt: "1893456000"
      };
    },
    cancelInvitation: async (_invitationId: string, actor: unknown) => {
      state.cancellationActors?.push(structuredClone(actor));
    },
    listPairingRequests: async () => ({
      version: 1,
      requests: state.pairingRequest ? [state.pairingRequest] : []
    }),
    approvePairingRequest: async (requestId: string, input: unknown, actor: unknown) => {
      state.approvalInputs.push({ requestId, input: structuredClone(input), actor: structuredClone(actor) });
      state.pairingRequest = undefined;
    },
    rejectPairingRequest: async (requestId: string) => {
      state.rejectedRequestIds?.push(requestId);
      state.pairingRequest = undefined;
    },
    listDevices: async () => ({
      version: 1,
      devices: [{
        version: 1,
        deviceId: "travel-mac",
        displayName: "Travel laptop",
        platform: { os: "darwin", arch: "arm64" },
        installationFingerprint: bytes16(0x42),
        trustEpoch: "5",
        revision: "3",
        pairedAt: "1786000000",
        lastSeenAt: "1786270800",
        connectionState: "direct"
      }]
    }),
    renameDevice: async (deviceId: string, input: { displayName: string }, actor: unknown) => {
      state.renameInputs?.push({ deviceId, input: structuredClone(input), actor: structuredClone(actor) });
      return {
        version: 1,
        deviceId,
        displayName: input.displayName,
        platform: { os: "darwin", arch: "arm64" },
        installationFingerprint: bytes16(0x42),
        trustEpoch: "5",
        revision: "4",
        pairedAt: "1786000000",
        lastSeenAt: "1786270800",
        connectionState: "direct"
      };
    },
    revokeDevice: async () => undefined,
    reconnect: async () => {
      state.reconnectCount = (state.reconnectCount ?? 0) + 1;
    },
    diagnostics: async () => ({
      version: 1,
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helper: {
        state: "ready",
        version: "0.1.0",
        releaseSequence: "42",
        forkCommit: "0123456789abcdef0123456789abcdef01234567",
        target: { os: "darwin", arch: "arm64" },
        protocol: { major: 1, minor: 0 },
        capabilities: [],
        secretStorage: "keychain"
      },
      controlState: "connected",
      stun: "unknown",
      udp: "unknown",
      portMapping: "unknown",
      directState: "direct",
      lastTransitionAt: null,
      lastDirectAt: "1786270800",
      lastErrorCode: null,
      prohibited: {
        derpRouteSelections: "0",
        derpApplicationBytes: "0",
        peerRelayRouteSelections: "0",
        peerRelayApplicationBytes: "0",
        genericProxyRequests: "0",
        genericProxyBytes: "0"
      }
    })
  } as unknown as RemoteAccessService;
}

function scriptedToolPipeline(
  toolName: string,
  args: Record<string, unknown>,
  capture: (result: string) => void
): ModelPipeline {
  return {
    async generateWaifu() {
      throw new Error("unused");
    },
    async generateAssistantTurn(request) {
      const argumentsJson = JSON.stringify(args);
      const result = await request.executeTool(toolName, argumentsJson);
      capture(result);
      request.onEvent?.({ type: "tool_call", name: toolName, arguments: argumentsJson });
      request.onEvent?.({ type: "tool_result", name: toolName, result });
      return {
        content: "The secure dashboard card is ready.",
        messages: [
          ...request.messages,
          { role: "assistant", content: "The secure dashboard card is ready." }
        ]
      };
    }
  };
}

async function makeActionApp(pipeline: ModelPipeline, state: FakeRemoteState) {
  const root = await makeTempRoot("waifus-assistant-actions-");
  roots.push(root);
  await ensureDataLayout(root);
  const storage = new StorageService(root);
  const auditStore = new AuditStore(root, { storage });
  const runtime = createRuntimeState({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    packageVersion: "1.5.203",
    port: 3888,
    dataRoot: root,
    mode: "test",
    paused: false,
    discord: { connected: false, orchestratorConnected: false, waifuBotCount: 0, warnings: [] },
    queues: { active: 0, configuredGuilds: 0 }
  });
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage,
    assistant: { createPipeline: () => pipeline },
    remoteAccess: fakeRemoteAccess(state),
    remoteTrust: { isAuthorized: () => state.authorized },
    administration: { auditStore }
  });
  apps.push(app);
  await app.inject({
    method: "PUT",
    url: "/api/providers/deepseek/credentials",
    payload: { apiKey: "sk-test" }
  });
  const config = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
  await app.inject({
    method: "PUT",
    url: "/api/orchestrator/config",
    payload: {
      revision: config.json().revision,
      providerId: "deepseek",
      modelId: "deepseek-v4-pro"
    }
  });
  return { app, auditStore };
}

async function createRemoteActionConversation(app: Awaited<ReturnType<typeof makeActionApp>>["app"]) {
  const created = await dispatchInternal(app, remotePrincipal({
    method: "POST",
    canonicalTarget: "/api/assistant/conversations"
  }), undefined, {
    method: "POST",
    url: "/api/assistant/conversations",
    headers: { "idempotency-key": bytes32(0x81) }
  });
  expect(created.statusCode).toBe(200);
  const conversationId = created.json<{ conversationId: string }>().conversationId;
  const target = `/api/assistant/conversations/${conversationId}/messages`;
  const response = await dispatchInternal(app, remotePrincipal({
    method: "POST",
    canonicalTarget: target
  }), undefined, {
    method: "POST",
    url: target,
    headers: { "idempotency-key": bytes32(0x82) },
    payload: { content: "do the remote access action" }
  });
  expect(response.statusCode).toBe(200);
  return conversationId;
}

describe("AssistantActionStore", () => {
  it("binds immutable exact actions to browser launch, session, actor, and trust epoch", () => {
    const now = 1_800_000_000_000;
    const store = new AssistantActionStore({ now: () => now, randomBytes: deterministicRandom() });
    const payload = { enabled: true, revision: "7" };
    const created = store.create({ principal: remotePrincipal(), delegation, proposal: proposal(payload) });
    expect(Buffer.from(created.actionId, "base64url")).toHaveLength(32);
    expect(Date.parse(created.expiresAt) - now).toBe(ASSISTANT_ACTION_TTL_MS);

    payload.revision = "999";
    const reconnected = remotePrincipal({ transportByte: 0x45 });
    const exact = store.get(created.actionId, reconnected);
    expect(exact.operation).toMatchObject({
      kind: "exact_http",
      canonicalTarget: "/api/remote-access",
      payload: { enabled: true, revision: "7" }
    });
    expect(Object.isFrozen(exact.operation)).toBe(true);

    for (const other of [
      remotePrincipal({ trustEpoch: "6" }),
      remotePrincipal({ gatewayByte: 0x46 }),
      remotePrincipal({ sessionByte: 0x47 }),
      remotePrincipal({ deviceId: "studio-pc" }),
      localPrincipal()
    ]) {
      expect(() => store.get(created.actionId, other)).toThrow(AssistantActionNotFoundError);
    }
  });

  it("atomically consumes once and never reopens cancelled or completed actions", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const principal = localPrincipal();
    const created = store.create({ principal, delegation, proposal: proposal() });
    const lease = store.beginConsume(created.actionId, principal);
    expect(lease.actionId).toBe(created.actionId);
    expect(() => store.beginConsume(created.actionId, principal)).toThrow(AssistantActionConflictError);
    store.complete(created.actionId, principal, {
      status: "completed",
      message: "Remote access was enabled."
    });
    expect(() => store.get(created.actionId, principal)).toThrow(AssistantActionConflictError);

    const cancelled = store.create({ principal, delegation, proposal: proposal({ enabled: false }) });
    store.cancel(cancelled.actionId, principal);
    expect(() => store.get(cancelled.actionId, principal)).toThrow(AssistantActionConflictError);
  });

  it("fails closed at per-owner and record limits without evicting a live action", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const principal = localPrincipal();
    const ids = Array.from({ length: MAX_ASSISTANT_ACTIONS_PER_OWNER }, () =>
      store.create({ principal, delegation, proposal: proposal() }).actionId
    );
    expect(() => store.create({ principal, delegation, proposal: proposal() }))
      .toThrow(AssistantActionCapacityError);
    expect(store.get(ids[0], principal).actionId).toBe(ids[0]);

    expect(() => store.create({
      principal: localPrincipal(0x55),
      delegation,
      proposal: { ...proposal(), summary: "x".repeat(8 * 1024 + 1) }
    })).toThrow(AssistantActionTooLargeError);
    expect(() => store.create({
      principal: localPrincipal(0x56),
      delegation,
      proposal: proposal({ large: "x".repeat(30 * 1024) })
    })).toThrow(AssistantActionTooLargeError);
  });

  it("enforces the global byte cap without evicting any unexpired live action", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const firstPrincipal = localPrincipal(0x60);
    const first = store.create({
      principal: firstPrincipal,
      delegation,
      proposal: proposal({ large: "x".repeat(14 * 1024) })
    });
    let admitted = 1;
    for (let index = 1; index < 256; index += 1) {
      const principal = localPrincipal(0x60 + Math.floor(index / MAX_ASSISTANT_ACTIONS_PER_OWNER));
      try {
        store.create({
          principal,
          delegation,
          proposal: proposal({ large: "x".repeat(14 * 1024), index })
        });
        admitted += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(AssistantActionCapacityError);
        break;
      }
    }
    expect(admitted).toBeLessThan(256);
    expect(store.stats().accountedBytes).toBeLessThanOrEqual(MAX_ASSISTANT_ACTION_BYTES);
    expect(store.get(first.actionId, firstPrincipal).actionId).toBe(first.actionId);
  });

  it("rejects secret-bearing summaries, exact payloads, and receipts", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const principal = localPrincipal();
    const pairToken = `WF1.${Buffer.alloc(32, 0x44).toString("base64url")}`;
    expect(() => store.create({
      principal,
      delegation,
      proposal: { ...proposal(), summary: `Use ${pairToken}` }
    })).toThrow(AssistantActionUnsafeContentError);
    expect(() => store.create({
      principal,
      delegation,
      proposal: proposal({ apiKey: "not-even-a-real-key" })
    })).toThrow(AssistantActionUnsafeContentError);

    const created = store.create({ principal, delegation, proposal: proposal() });
    store.beginConsume(created.actionId, principal);
    expect(() => store.complete(created.actionId, principal, {
      status: "completed",
      message: `Created ${pairToken}`
    })).toThrow(AssistantActionUnsafeContentError);

    const oversized = store.create({ principal: localPrincipal(0x58), delegation, proposal: proposal() });
    store.beginConsume(oversized.actionId, localPrincipal(0x58));
    expect(() => store.complete(oversized.actionId, localPrincipal(0x58), {
      status: "completed",
      message: "x".repeat(8 * 1024 + 1)
    })).toThrow(AssistantActionTooLargeError);
  });

  it("removes only terminal or expired records when admitting new work", () => {
    let now = 1_800_000_000_000;
    const store = new AssistantActionStore({ now: () => now, randomBytes: deterministicRandom() });
    const principal = localPrincipal();
    const live = store.create({ principal, delegation, proposal: proposal() });
    const terminal = store.create({ principal, delegation, proposal: proposal({ enabled: false }) });
    store.beginConsume(terminal.actionId, principal);
    store.complete(terminal.actionId, principal, { status: "completed", message: "Done." });
    expect(store.stats()).toMatchObject({ records: 2, live: 1 });

    store.create({ principal: localPrincipal(0x41), delegation, proposal: proposal() });
    expect(store.stats()).toMatchObject({ records: 2, live: 2 });
    expect(store.get(live.actionId, principal).actionId).toBe(live.actionId);

    now += ASSISTANT_ACTION_TTL_MS + 1;
    expect(store.stats()).toEqual({ records: 0, live: 0, accountedBytes: 0 });
  });

  it("retains only an approval hash and safe request ID for derived pairing actions", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const principal = remotePrincipal();
    const expectedPayload = {
      invitationGeneration: "4",
      remoteIdentityBundleHash: bytes32(0x61),
      transcriptHash: bytes32(0x62),
      channelBinding: bytes32(0x63),
      sasIndices: [1, 2, 3, 4, 5],
      sasFingerprint: "AB12-CD34-EF5"
    };
    const created = store.create({
      principal,
      delegation,
      proposal: {
        category: "remote_pairing_approval",
        summary: "Approve Travel laptop after comparing its safety phrase.",
        resource: { type: "remote_pairing_request", identifier: bytes16(0x51) },
        operation: {
          kind: "derived_pairing_approval",
          method: "POST",
          canonicalTarget: `/api/remote-access/pairing-requests/${bytes16(0x51)}/approve`,
          requestId: bytes16(0x51),
          expectedPayload
        }
      }
    });
    const serialized = JSON.stringify(store.get(created.actionId, principal));
    expect(serialized).toContain("payloadHash");
    expect(serialized).toContain(bytes16(0x51));
    for (const secret of [bytes32(0x61), bytes32(0x62), bytes32(0x63), "AB12-CD34-EF5"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("tracks invitation ownership without retaining its token or code", () => {
    let now = 1_800_000_000_000;
    const store = new AssistantActionStore({ now: () => now, randomBytes: deterministicRandom() });
    const owner = remotePrincipal();
    const invitationId = bytes16(0x71);
    store.rememberInvitation(invitationId, String(Math.floor(now / 1000) + 60), owner);
    expect(store.ownsInvitation(invitationId, remotePrincipal({ transportByte: 0x72 }))).toBe(true);
    expect(store.ownsInvitation(invitationId, remotePrincipal({ sessionByte: 0x73 }))).toBe(false);
    now += 61_000;
    expect(store.ownsInvitation(invitationId, owner)).toBe(false);
  });

  it("invalidates all actions and invitation ownership for one revoked device epoch", () => {
    const store = new AssistantActionStore({ randomBytes: deterministicRandom() });
    const revoked = remotePrincipal();
    const pending = store.create({ principal: revoked, delegation, proposal: proposal() });
    const executing = store.create({ principal: revoked, delegation, proposal: proposal() });
    store.beginConsume(executing.actionId, revoked);
    const completed = store.create({ principal: revoked, delegation, proposal: proposal() });
    const repairedEpoch = remotePrincipal({ trustEpoch: "6" });
    const unaffected = store.create({ principal: repairedEpoch, delegation, proposal: proposal() });
    store.beginConsume(completed.actionId, revoked);
    store.complete(completed.actionId, revoked, { status: "completed", message: "Done." });
    const revokedInvitation = bytes16(0x71);
    const unaffectedInvitation = bytes16(0x72);
    store.rememberInvitation(revokedInvitation, "1893456000", revoked);
    store.rememberInvitation(unaffectedInvitation, "1893456000", repairedEpoch);

    expect(store.invalidateOwner("remote:travel-mac", "5")).toBe(3);

    for (const action of [pending, executing, completed]) {
      expect(() => store.get(action.actionId, revoked)).toThrow(AssistantActionNotFoundError);
    }
    expect(store.get(unaffected.actionId, repairedEpoch).actionId).toBe(unaffected.actionId);
    expect(store.ownsInvitation(revokedInvitation, revoked)).toBe(false);
    expect(store.ownsInvitation(unaffectedInvitation, repairedEpoch)).toBe(true);
    expect(store.stats()).toMatchObject({ records: 1, live: 1 });
  });
});

describe("assistant action API", () => {
  it("drops a revoked device epoch's conversations and actions from the host invalidation event", async () => {
    let toolResult = "";
    const state: FakeRemoteState = {
      authorized: true,
      enabled: true,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: undefined
    };
    const { app } = await makeActionApp(
      scriptedToolPipeline("set_remote_access_enabled", { enabled: false }, (value) => {
        toolResult = value;
      }),
      state
    );
    const conversationId = await createRemoteActionConversation(app);
    const actionId = (JSON.parse(toolResult) as { actionId: string }).actionId;
    expect(state.invalidationListener).toBeTypeOf("function");

    state.invalidationListener?.({
      version: 1,
      kind: "device_trust_revoked",
      stableId: "remote:travel-mac",
      deviceId: "travel-mac",
      trustEpoch: "5",
      denyEpoch: "6"
    });

    const conversationTarget = `/api/assistant/conversations/${conversationId}`;
    const conversation = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: conversationTarget
    }), undefined, { method: "GET", url: conversationTarget });
    expect(conversation.statusCode).toBe(404);
    const actionTarget = `/api/assistant/actions/${actionId}`;
    const action = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: actionTarget
    }), undefined, { method: "GET", url: actionTarget });
    expect(action.statusCode).toBe(404);
  });

  it("confirms one exact action for the originating remote browser and audits that actor", async () => {
    let toolResult = "";
    const state: FakeRemoteState = {
      authorized: true,
      enabled: false,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: undefined
    };
    const { app, auditStore } = await makeActionApp(
      scriptedToolPipeline("set_remote_access_enabled", { enabled: true }, (value) => {
        toolResult = value;
      }),
      state
    );
    const conversationId = await createRemoteActionConversation(app);
    expect(toolResult, toolResult).toMatch(/^\{/u);
    const actionId = (JSON.parse(toolResult) as { actionId: string }).actionId;
    const detailTarget = `/api/assistant/actions/${actionId}`;
    const detail = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: detailTarget
    }), undefined, { method: "GET", url: detailTarget });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      actionId,
      category: "remote_access_enable",
      summary: "Enable Remote Access on Studio host."
    });
    expect((await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: detailTarget,
      sessionByte: 0x75
    }), undefined, { method: "GET", url: detailTarget })).statusCode).toBe(404);
    expect((await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: detailTarget,
      gatewayByte: 0x76
    }), undefined, { method: "GET", url: detailTarget })).statusCode).toBe(404);
    expect((await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: detailTarget,
      trustEpoch: "6"
    }), undefined, { method: "GET", url: detailTarget })).statusCode).toBe(404);

    const confirmTarget = `/api/assistant/actions/${actionId}/confirm`;
    const substituted = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: confirmTarget
    }), undefined, {
      method: "POST",
      url: confirmTarget,
      headers: { "idempotency-key": bytes32(0x87) },
      payload: { enabled: false }
    });
    expect(substituted.statusCode, substituted.body).toBe(400);
    expect(state.updateInputs).toEqual([]);

    const confirmations = await Promise.all([
      dispatchInternal(app, remotePrincipal({
        method: "POST",
        canonicalTarget: confirmTarget
      }), undefined, {
        method: "POST",
        url: confirmTarget,
        headers: { "idempotency-key": bytes32(0x83) }
      }),
      dispatchInternal(app, remotePrincipal({
        method: "POST",
        canonicalTarget: confirmTarget
      }), undefined, {
        method: "POST",
        url: confirmTarget,
        headers: { "idempotency-key": bytes32(0x84) }
      })
    ]);
    expect(confirmations.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const confirmed = confirmations.find((response) => response.statusCode === 200);
    expect(confirmed).toBeDefined();
    expect(confirmed?.json()).toMatchObject({
      actionId,
      category: "remote_access_enable",
      status: "completed"
    });
    expect(state.updateInputs).toEqual([{ revision: "7", enabled: true }]);

    const repeated = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: confirmTarget
    }), undefined, {
      method: "POST",
      url: confirmTarget,
      headers: { "idempotency-key": bytes32(0x89) }
    });
    expect(repeated.statusCode).toBe(409);

    const audit = await auditStore.list();
    const delegated = audit.find((record) => record.action === "remote_access.update");
    expect(delegated?.actor).toMatchObject({ kind: "remote_device", stableId: "remote:travel-mac" });
    expect(delegated?.delegation).toMatchObject({
      conversationId,
      pendingActionId: actionId
    });
  });

  it("keeps pairing proof out of tools, transcripts, receipts, and audit while showing it to the secure card", async () => {
    let safeList = "";
    let actionResult = "";
    const pending = pairingRequest();
    const state: FakeRemoteState = {
      authorized: true,
      enabled: true,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: pending
    };
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        safeList = await request.executeTool("list_remote_pairing_requests", "{}");
        actionResult = await request.executeTool(
          "approve_remote_pairing_request",
          JSON.stringify({ requestId: pending.requestId })
        );
        request.onEvent?.({
          type: "tool_call",
          name: "approve_remote_pairing_request",
          arguments: JSON.stringify({ requestId: pending.requestId })
        });
        request.onEvent?.({ type: "tool_result", name: "approve_remote_pairing_request", result: actionResult });
        return {
          content: "Compare the secure card on both devices.",
          messages: [
            ...request.messages,
            { role: "assistant", content: "Compare the secure card on both devices." }
          ]
        };
      }
    };
    const { app, auditStore } = await makeActionApp(pipeline, state);
    const conversationId = await createRemoteActionConversation(app);
    const actionId = (JSON.parse(actionResult) as { actionId: string }).actionId;
    const forbidden = [
      pending.remoteIdentityBundleHash,
      pending.transcriptHash,
      pending.channelBinding,
      pending.sasFingerprint,
      ...pending.sasWords
    ];
    for (const value of forbidden) {
      expect(safeList).not.toContain(value);
      expect(actionResult).not.toContain(value);
    }

    const conversationTarget = `/api/assistant/conversations/${conversationId}`;
    const conversation = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: conversationTarget
    }), undefined, { method: "GET", url: conversationTarget });
    for (const value of forbidden) expect(conversation.body).not.toContain(value);

    const detailTarget = `/api/assistant/actions/${actionId}`;
    const detail = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: detailTarget
    }), undefined, { method: "GET", url: detailTarget });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      actionId,
      secure: {
        kind: "pairing_request",
        requestId: pending.requestId,
        claimedDisplayName: pending.claimedDisplayName,
        sasWords: pending.sasWords,
        sasFingerprint: pending.sasFingerprint
      }
    });
    for (const value of [pending.remoteIdentityBundleHash, pending.transcriptHash, pending.channelBinding]) {
      expect(detail.body).not.toContain(value);
    }

    const confirmTarget = `/api/assistant/actions/${actionId}/confirm`;
    const confirmed = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: confirmTarget
    }), undefined, {
      method: "POST",
      url: confirmTarget,
      headers: { "idempotency-key": bytes32(0x85) }
    });
    expect(confirmed.statusCode).toBe(200);
    for (const value of forbidden) expect(confirmed.body).not.toContain(value);
    expect(state.approvalInputs).toHaveLength(1);
    expect(state.approvalInputs[0]).toMatchObject({
      requestId: pending.requestId,
      input: {
        invitationGeneration: pending.invitationGeneration,
        remoteIdentityBundleHash: pending.remoteIdentityBundleHash,
        transcriptHash: pending.transcriptHash,
        channelBinding: pending.channelBinding,
        sasIndices: pending.sasIndices,
        sasFingerprint: pending.sasFingerprint
      },
      actor: {
        kind: "remote_device",
        stableId: "remote:travel-mac",
        trustEpoch: "5",
        gatewayLaunchId: bytes32(0x33),
        browserSessionId: bytes32(0x34)
      }
    });
    const auditJson = JSON.stringify(await auditStore.list());
    for (const value of forbidden) expect(auditJson).not.toContain(value);
  });

  it("requires a pending action to cancel another browser's invitation and lets its owner dismiss it", async () => {
    let toolResult = "";
    const invitationId = bytes16(0x79);
    const state: FakeRemoteState = {
      authorized: true,
      enabled: true,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: undefined,
      cancellationActors: []
    };
    const { app } = await makeActionApp(
      scriptedToolPipeline("cancel_remote_pairing_invite", { invitationId }, (value) => {
        toolResult = value;
      }),
      state
    );
    await createRemoteActionConversation(app);
    expect(JSON.parse(toolResult)).toMatchObject({
      status: "confirmation_required",
      category: "remote_invitation_cancel"
    });
    expect(state.cancellationActors).toEqual([]);

    const actionId = (JSON.parse(toolResult) as { actionId: string }).actionId;
    const actionTarget = `/api/assistant/actions/${actionId}`;
    const wrongBrowser = await dispatchInternal(app, remotePrincipal({
      method: "DELETE",
      canonicalTarget: actionTarget,
      sessionByte: 0x7a
    }), undefined, {
      method: "DELETE",
      url: actionTarget,
      headers: { "idempotency-key": bytes32(0x8a) }
    });
    expect(wrongBrowser.statusCode).toBe(404);

    const cancelled = await dispatchInternal(app, remotePrincipal({
      method: "DELETE",
      canonicalTarget: actionTarget
    }), undefined, {
      method: "DELETE",
      url: actionTarget,
      headers: { "idempotency-key": bytes32(0x8b) }
    });
    expect(cancelled.statusCode).toBe(204);
    const confirmTarget = `${actionTarget}/confirm`;
    const afterCancel = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: confirmTarget
    }), undefined, {
      method: "POST",
      url: confirmTarget,
      headers: { "idempotency-key": bytes32(0x8c) }
    });
    expect(afterCancel.statusCode).toBe(409);
    expect(state.cancellationActors).toEqual([]);
  });

  it("returns a new invitation only to the confirming browser and never to the model transcript", async () => {
    let toolResult = "";
    let cancelResult = "";
    let turn = 0;
    const state: FakeRemoteState = {
      authorized: true,
      enabled: true,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: undefined,
      cancellationActors: []
    };
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        turn += 1;
        const toolName = turn === 1 ? "request_remote_pairing_invite" : "cancel_remote_pairing_invite";
        const argumentsJson = turn === 1
          ? "{}"
          : JSON.stringify({ invitationId: bytes16(0x71) });
        const result = await request.executeTool(toolName, argumentsJson);
        if (turn === 1) toolResult = result;
        else cancelResult = result;
        request.onEvent?.({ type: "tool_call", name: toolName, arguments: argumentsJson });
        request.onEvent?.({ type: "tool_result", name: toolName, result });
        const content = turn === 1
          ? "The secure invitation card is ready."
          : "The invitation was cancelled.";
        return {
          content,
          messages: [...request.messages, { role: "assistant", content }]
        };
      }
    };
    const { app, auditStore } = await makeActionApp(pipeline, state);
    const conversationId = await createRemoteActionConversation(app);
    const actionId = (JSON.parse(toolResult) as { actionId: string }).actionId;
    const confirmTarget = `/api/assistant/actions/${actionId}/confirm`;
    const confirmed = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: confirmTarget
    }), undefined, {
      method: "POST",
      url: confirmTarget,
      headers: { "idempotency-key": bytes32(0x86) }
    });
    const fullToken = `WF1.${Buffer.alloc(192, 0x72).toString("base64url")}`;
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({
      status: "completed",
      invitation: {
        invitationId: bytes16(0x71),
        fullToken,
        shortCode: "01AB-CDEF"
      }
    });

    const conversationTarget = `/api/assistant/conversations/${conversationId}`;
    const conversation = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: conversationTarget
    }), undefined, { method: "GET", url: conversationTarget });
    expect(conversation.body).not.toContain(fullToken);
    expect(conversation.body).not.toContain("01AB-CDEF");
    expect(JSON.stringify(await auditStore.list())).not.toContain(fullToken);
    expect(state.invitationActors[0]).toMatchObject({
      kind: "remote_device",
      stableId: "remote:travel-mac",
      gatewayLaunchId: bytes32(0x33),
      browserSessionId: bytes32(0x34)
    });

    const messageTarget = `/api/assistant/conversations/${conversationId}/messages`;
    const cancelled = await dispatchInternal(app, remotePrincipal({
      method: "POST",
      canonicalTarget: messageTarget
    }), undefined, {
      method: "POST",
      url: messageTarget,
      headers: { "idempotency-key": bytes32(0x88) },
      payload: { content: "cancel that invitation" }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelResult).toBe(`Pairing invitation ${bytes16(0x71)} was cancelled.`);
    expect(state.cancellationActors).toHaveLength(1);
    expect(state.cancellationActors?.[0]).toMatchObject({
      kind: "remote_device",
      stableId: "remote:travel-mac",
      gatewayLaunchId: bytes32(0x33),
      browserSessionId: bytes32(0x34)
    });

    const refreshed = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: conversationTarget
    }), undefined, { method: "GET", url: conversationTarget });
    const confirmationEvents = refreshed.json<{ messages: Array<{ event?: { type?: string } }> }>()
      .messages.filter((message) => message.event?.type === "confirmation_required");
    expect(confirmationEvents).toHaveLength(1);
  });

  it("runs read-only and low-risk remote tools directly with assistant-safe results", async () => {
    const pending = pairingRequest();
    const captured = new Map<string, string>();
    const state: FakeRemoteState = {
      authorized: true,
      enabled: true,
      updateInputs: [],
      approvalInputs: [],
      invitationActors: [],
      pairingRequest: pending,
      rejectedRequestIds: [],
      renameInputs: [],
      reconnectCount: 0
    };
    const calls: Array<[string, Record<string, unknown>]> = [
      ["get_remote_access_status", {}],
      ["list_remote_devices", {}],
      ["get_remote_access_diagnostics", {}],
      ["rename_remote_device", { deviceId: "travel-mac", displayName: "Travel renamed" }],
      ["reject_remote_pairing_request", { requestId: pending.requestId }],
      ["reconnect_remote_access", {}]
    ];
    const pipeline: ModelPipeline = {
      async generateWaifu() {
        throw new Error("unused");
      },
      async generateAssistantTurn(request) {
        for (const [name, args] of calls) {
          captured.set(name, await request.executeTool(name, JSON.stringify(args)));
        }
        return {
          content: "Remote Access maintenance is complete.",
          messages: [
            ...request.messages,
            { role: "assistant", content: "Remote Access maintenance is complete." }
          ]
        };
      }
    };
    const { app } = await makeActionApp(pipeline, state);
    const conversationId = await createRemoteActionConversation(app);

    expect(captured.get("get_remote_access_status")).not.toContain(bytes16(0x41));
    expect(captured.get("list_remote_devices")).not.toContain(bytes16(0x42));
    expect(JSON.parse(captured.get("get_remote_access_status") ?? "null")).toMatchObject({
      identity: { deviceId: "host-device-01" },
      directState: "direct"
    });
    expect(JSON.parse(captured.get("list_remote_devices") ?? "null")[0]).toMatchObject({
      deviceId: "travel-mac",
      displayName: "Travel laptop"
    });
    expect(captured.get("rename_remote_device")).not.toContain(bytes16(0x42));
    expect(JSON.parse(captured.get("rename_remote_device") ?? "null")).toMatchObject({
      deviceId: "travel-mac",
      displayName: "Travel renamed"
    });
    expect(JSON.parse(captured.get("get_remote_access_diagnostics") ?? "null")).toMatchObject({
      directState: "direct",
      prohibited: { derpApplicationBytes: "0" }
    });
    expect(state.renameInputs).toHaveLength(1);
    expect(state.renameInputs?.[0]).toMatchObject({
      deviceId: "travel-mac",
      input: { revision: "3", displayName: "Travel renamed" },
      actor: { kind: "remote_device", stableId: "remote:travel-mac" }
    });
    expect(state.rejectedRequestIds).toEqual([pending.requestId]);
    expect(state.reconnectCount).toBe(1);

    const conversationTarget = `/api/assistant/conversations/${conversationId}`;
    const conversation = await dispatchInternal(app, remotePrincipal({
      method: "GET",
      canonicalTarget: conversationTarget
    }), undefined, { method: "GET", url: conversationTarget });
    expect(conversation.body).not.toContain("confirmation_required");
  });
});
