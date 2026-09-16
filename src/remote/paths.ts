import path from "node:path";

export const REMOTE_STATE_RELATIVE_PATHS = Object.freeze({
  hostStateRoot: "app/remote-access",
  hostConfig: "app/remote-access/config.json",
  installation: "app/remote-access/installation.json",
  trustRoot: "app/remote-access/trust",
  trustIndex: "app/remote-access/trust/index.json",
  localDenyIndex: "app/remote-access/trust/local-deny-v1.json",
  operationsRoot: "app/remote-access/operations",
  auditRoot: "app/remote-access/audit",
  resetTombstone: "app/remote-access/reset-tombstone.json",
  remoteGatewayStateRoot: "app/remote-gateway",
  remoteOriginState: "app/remote-gateway/origins-v1.json",
  remoteRememberedHosts: "app/remote-gateway/remembered-hosts-v1.json",
  dashboardCacheRoot: "app/cache/remote-dashboard",
  hostRuntimeRoot: "app/tmp/remote-host",
  hostRuntimePid: "app/tmp/remote-host/pid.json",
  remoteGatewayRuntimeRoot: "app/tmp/remote-gateway",
  remoteGatewayRuntimePid: "app/tmp/remote-gateway/pid.json",
  backendLog: "app/logs/backend.log",
  hostLog: "app/logs/remote-host.log",
  remoteGatewayLog: "app/logs/remote-gateway.log",
  backendPid: "app/pid.json",
  backendRuntime: "app/runtime.json"
} as const);

export type RemoteStatePaths = {
  [Key in keyof typeof REMOTE_STATE_RELATIVE_PATHS]: string;
};

export type RemoteRole = "host" | "remote";

export type RemoteRolePaths = {
  readonly role: RemoteRole;
  readonly stateRoot: string;
  readonly helperRoleState: string;
  readonly helperRoleLock: string;
  readonly helperPairIndex: string;
  readonly helperPairJournal: string;
  readonly controlNonceState: string;
  readonly pairControlState: string;
  readonly runtimeRoot: string;
  readonly runtimePid: string;
  readonly runtimeState: string;
  readonly startupHandoff: string;
  readonly runtimeLock: string;
  readonly parentEndpoint: string;
  readonly log: string;
};

export function remoteStatePaths(dataRoot: string): RemoteStatePaths {
  const canonicalRoot = path.resolve(dataRoot);
  return Object.fromEntries(
    Object.entries(REMOTE_STATE_RELATIVE_PATHS).map(([key, relativePath]) => [
      key,
      path.join(canonicalRoot, ...relativePath.split("/"))
    ])
  ) as RemoteStatePaths;
}

export function remoteRolePaths(dataRoot: string, role: RemoteRole): RemoteRolePaths {
  const paths = remoteStatePaths(dataRoot);
  const stateRoot = role === "host" ? paths.hostStateRoot : paths.remoteGatewayStateRoot;
  const runtimeRoot = role === "host" ? paths.hostRuntimeRoot : paths.remoteGatewayRuntimeRoot;
  return Object.freeze({
    role,
    stateRoot,
    helperRoleState: path.join(stateRoot, "helper-role-v1.json"),
    helperRoleLock: path.join(stateRoot, ".helper.lock"),
    helperPairIndex: path.join(stateRoot, "helper-pairs-v1.json"),
    helperPairJournal: path.join(stateRoot, "helper-pair-journal-v1.json"),
    controlNonceState: path.join(stateRoot, "control-response-nonces-v1.json"),
    pairControlState: path.join(stateRoot, "pair-control-state-v1.json"),
    runtimeRoot,
    runtimePid: path.join(runtimeRoot, "pid.json"),
    runtimeState: path.join(runtimeRoot, "runtime.json"),
    startupHandoff: path.join(runtimeRoot, "startup-handoff.json"),
    runtimeLock: path.join(runtimeRoot, "daemon.lock"),
    parentEndpoint: path.join(runtimeRoot, "p"),
    log: role === "host" ? paths.hostLog : paths.remoteGatewayLog
  });
}

/**
 * Ownership contract for the typed installation reset. The current local host daemon is
 * the executor; a live remote-gateway/helper sibling must cause `SiblingDaemonRunning` before any
 * mutation. Helper-owned vault rotation happens before Node clears or rewrites these exact paths;
 * freshly generated helper role metadata under both role roots is retained and the replacement
 * installation metadata is verified rather than rewritten by Node.
 */
export const IDENTITY_RESET_PATH_OWNERSHIP = Object.freeze({
  clearAfterVerifiedHelperReceipt: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.trustRoot,
    REMOTE_STATE_RELATIVE_PATHS.remoteOriginState,
    REMOTE_STATE_RELATIVE_PATHS.remoteRememberedHosts,
    REMOTE_STATE_RELATIVE_PATHS.dashboardCacheRoot
  ]),
  rewriteAfterVerifiedHelperReceipt: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.hostConfig,
    REMOTE_STATE_RELATIVE_PATHS.trustIndex,
    REMOTE_STATE_RELATIVE_PATHS.localDenyIndex
  ]),
  verifyAfterHelperReceipt: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.installation
  ]),
  preserve: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.operationsRoot,
    REMOTE_STATE_RELATIVE_PATHS.auditRoot,
    REMOTE_STATE_RELATIVE_PATHS.resetTombstone
  ])
});
