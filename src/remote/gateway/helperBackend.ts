import {
  PairOperationStatusSchema,
  type PairOperationStatus,
  type PairStartInput
} from "../../shared/schemas/remoteLifecycle.js";
import { SemVerSchema } from "../../shared/schemas/remoteProtocol.js";
import {
  HelperDeviceDescriptorSchema,
  HelperSupervisorError,
  type HelperCompletedPair
} from "../helperTypes.js";
import type { HelperSupervisor } from "../helperSupervisor.js";
import {
  RememberedHostRecordV1Schema,
  type RememberedHostRecordV1
} from "../rememberedHosts.js";
import { derivePinnedHostId } from "./originStore.js";
import type { RemoteGatewayLocalBackend } from "./localApi.js";

type RemoteHelper = Pick<HelperSupervisor,
  | "snapshot"
  | "beginActivation"
  | "pollActivation"
  | "cancelActivation"
  | "beginPair"
  | "pollPair"
  | "cancelPair"
  | "consumeCompletedPair"
  | "startRuntime"
  | "stopRuntime"
>;

export type RemoteHelperBackendOptions = Readonly<{
  supervisor: RemoteHelper;
  appVersion: string;
  deviceDisplayName: string;
}>;

export function rememberedHostFromCompletedPair(
  completed: HelperCompletedPair
): RememberedHostRecordV1 {
  return RememberedHostRecordV1Schema.parse({
    version: 1,
    hostId: derivePinnedHostId(Buffer.from(completed.hostInstallationPublicKey, "base64url")),
    helperPairId: completed.pairId,
    displayName: completed.hostDisplayName,
    platform: completed.hostPlatform,
    installationPublicKey: completed.hostInstallationPublicKey,
    installationFingerprint: completed.hostInstallationFingerprint,
    trustEpoch: completed.hostTrustEpoch,
    revision: "1",
    pairedAt: completed.pairedAt,
    lastSeenAt: null,
    lastDirectAt: null,
    connectionState: "offline",
    lastErrorCode: null
  });
}

/** Adapt the verified remote-role helper to the connection-shell API. */
export function createRemoteHelperBackend(
  options: RemoteHelperBackendOptions
): RemoteGatewayLocalBackend {
  const appVersion = SemVerSchema.parse(options.appVersion);
  const supervisor = options.supervisor;
  let selectedPairId: string | undefined;
  return {
    snapshot: () => {
      const snapshot = supervisor.snapshot();
      return {
        gatewayVersion: appVersion,
        helperVersion: snapshot.helperVersion,
        helperReleaseSequence: snapshot.releaseSequence,
        protocol: snapshot.protocol ?? { major: 1, minor: 0 },
        capabilities: snapshot.capabilities,
        activationState: snapshot.runtimeStatus.activationState,
        helperState: snapshot.state,
        controlState: snapshot.runtimeStatus.controlState,
        directState: snapshot.runtimeStatus.directState,
        lastErrorCode: snapshot.lastErrorCode
      };
    },
    beginActivation: (operationId) => supervisor.beginActivation(operationId),
    pollActivation: (operationId) => supervisor.pollActivation(operationId),
    cancelActivation: (operationId) => supervisor.cancelActivation(operationId),
    beginPair: async (operationId: string, input: PairStartInput) => {
      const target = supervisor.snapshot().target;
      if (!target) {
        throw new HelperSupervisorError("helper_unavailable", "Remote helper target is unavailable.");
      }
      const descriptor = HelperDeviceDescriptorSchema.parse({
        displayName: options.deviceDisplayName,
        platform: target
      });
      const started = await supervisor.beginPair(operationId, input, descriptor);
      if (started.operationId !== operationId) {
        throw new HelperSupervisorError("helper_incompatible", "Pair start response changed operation identity.");
      }
      return { expiresAt: started.expiresAt };
    },
    pollPair: async (operationId: string): Promise<PairOperationStatus> => {
      const polled = await supervisor.pollPair(operationId);
      if (polled.operationId !== operationId) {
        throw new HelperSupervisorError("helper_incompatible", "Pair poll response changed operation identity.");
      }
      const { operationId: _operationId, ...status } = polled;
      return PairOperationStatusSchema.parse({
        ...status,
        pairOperationId: polled.operationId,
        statusUrl: `/_waifus_remote/v1/pair/${polled.operationId}`
      });
    },
    cancelPair: async (operationId) => {
      const cancelled = await supervisor.cancelPair(operationId);
      if (cancelled.operationId !== operationId || !cancelled.cancelled) {
        throw new HelperSupervisorError("helper_incompatible", "Pair cancellation response changed operation identity.");
      }
    },
    consumeCompletedPair: async (operationId) => {
      const completed = await supervisor.consumeCompletedPair(operationId);
      if (completed.operationId !== operationId) {
        throw new HelperSupervisorError("helper_incompatible", "Completed pair changed operation identity.");
      }
      return rememberedHostFromCompletedPair(completed);
    },
    connectRememberedHost: async (host) => {
      if (selectedPairId && selectedPairId !== host.helperPairId) {
        await supervisor.stopRuntime();
        selectedPairId = undefined;
      }
      await supervisor.startRuntime(host.helperPairId);
      selectedPairId = host.helperPairId;
    },
    disconnectRememberedHost: async (host) => {
      if (selectedPairId !== host.helperPairId) return;
      await supervisor.stopRuntime();
      selectedPairId = undefined;
    },
    // Signed self-revocation and individual local deny are separate helper IPC
    // operations. Until those are wired, never claim a successful forget.
    requestSignedSelfRevocation: async () => false,
    forgetRememberedHost: async () => {
      throw new HelperSupervisorError("helper_unavailable", "Individual remembered-host forget is not available yet.");
    }
  };
}
