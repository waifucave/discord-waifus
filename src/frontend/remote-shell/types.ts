export type GatewayBootstrap = {
  version: 1;
  gatewayVersion: string;
  helperVersion: string | null;
  helperReleaseSequence: string | null;
  protocol: { major: number; minor: number };
  capabilities: string[];
  session: { idleExpiresAt: string; absoluteExpiresAt: string };
  activationState: "activation_required" | "active" | "renewal_due";
  helperState: "disabled" | "starting" | "ready" | "degraded" | "failed";
  controlState: "inactive" | "connecting" | "connected" | "reconnecting" | "unavailable";
  directState: "inactive" | "direct" | "reconnecting" | "direct_unavailable";
  rememberedHostCount: number;
  selectionState: "no_hosts" | "selection_required" | "automatic_single" | "explicit";
  selectedHostId: string | null;
  lastErrorCode: string | null;
};

export type RememberedHost = {
  version: 1;
  hostId: string;
  displayName: string;
  platform: { os: string; arch: string };
  installationFingerprint: string;
  trustEpoch: string;
  revision: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastDirectAt: string | null;
  connectionState: "offline" | "direct" | "reconnecting" | "direct_unavailable";
  lastErrorCode: string | null;
};

export type PairStartInput =
  | { kind: "full_token"; token: string }
  | { kind: "short_code"; code: string };

export type PairStatus = {
  pairOperationId: string;
  statusUrl: string;
  state: "starting" | "verification_required" | "awaiting_host_approval" | "connecting" | "completed" | "failed" | "expired" | "cancelled";
  expiresAt: string;
  entryFlow?: "full_token" | "short_code";
  sasWords?: [string, string, string, string, string];
  sasFingerprint?: string;
  claimedHostDisplayName?: string;
  claimedHostPlatform?: { os: string; arch: string };
  claimedHostInstallationFingerprint?: string;
  errorCode?: string;
};

export type ActivationStart = {
  activationOperationId: string;
  verificationUrl: string;
  expiresAt: string;
};

export type ApiErrorBody = Record<string, unknown> & { error?: string };
