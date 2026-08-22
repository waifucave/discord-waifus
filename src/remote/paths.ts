import path from "node:path";

export const REMOTE_STATE_RELATIVE_PATHS = Object.freeze({
  hostStateRoot: "app/remote-access",
  hostConfig: "app/remote-access/config.json",
  installation: "app/remote-access/installation.json",
  trustRoot: "app/remote-access/trust",
  trustIndex: "app/remote-access/trust/index.json",
  operationsRoot: "app/remote-access/operations",
  auditRoot: "app/remote-access/audit",
  resetTombstone: "app/remote-access/reset-tombstone.json",
  remoteGatewayStateRoot: "app/remote-gateway",
  dashboardCacheRoot: "app/cache/remote-dashboard",
  hostRuntimeRoot: "app/tmp/remote-host",
  hostRuntimePid: "app/tmp/remote-host/pid.json",
  remoteGatewayRuntimeRoot: "app/tmp/remote-gateway",
  remoteGatewayRuntimePid: "app/tmp/remote-gateway/pid.json",
  hostLog: "app/logs/remote-host.log",
  remoteGatewayLog: "app/logs/remote-gateway.log",
  backendPid: "app/pid.json",
  backendRuntime: "app/runtime.json"
} as const);

export type RemoteStatePaths = {
  [Key in keyof typeof REMOTE_STATE_RELATIVE_PATHS]: string;
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

/**
 * Ownership contract for the later typed installation reset. The current local host daemon is
 * the executor; a live remote-gateway/helper sibling must cause `SiblingDaemonRunning` before any
 * mutation. Helper-owned vault rotation happens before Node clears or rewrites these paths.
 */
export const IDENTITY_RESET_PATH_OWNERSHIP = Object.freeze({
  clearAfterVerifiedHelperReceipt: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.trustRoot,
    REMOTE_STATE_RELATIVE_PATHS.remoteGatewayStateRoot,
    REMOTE_STATE_RELATIVE_PATHS.dashboardCacheRoot
  ]),
  rewriteAfterVerifiedHelperReceipt: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.hostConfig,
    REMOTE_STATE_RELATIVE_PATHS.installation
  ]),
  preserve: Object.freeze([
    REMOTE_STATE_RELATIVE_PATHS.operationsRoot,
    REMOTE_STATE_RELATIVE_PATHS.auditRoot,
    REMOTE_STATE_RELATIVE_PATHS.resetTombstone
  ])
});
