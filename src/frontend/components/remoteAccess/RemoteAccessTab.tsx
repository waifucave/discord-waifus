import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type {
  ActivationStartResult,
  ActivationStatus,
  PendingPairingRequest,
  RemoteAccessConfig,
  TrustedDevice
} from "../../api/types";
import { useApi, useInterval } from "../../api/useApi";
import { useClientContext } from "../../state/clientContext";
import { useRemoteAccessState } from "../../state/useRemoteAccessState";
import { ContextExternalLink } from "../ContextExternalLink";
import { Notice } from "../Notice";
import { InvitationCard } from "./InvitationCard";
import { IdentityResetControl } from "./IdentityResetControl";
import { PairingRequestCard } from "./PairingRequestCard";
import { RemoteDiagnostics } from "./RemoteDiagnostics";
import { TrustedDevices } from "./TrustedDevices";
import { formatUnixSeconds, stateTone } from "./presentation";

type NoticeState = { tone: "ok" | "warn" | "err" | "info"; message: string };

function isRemoteAccessConfig(value: RemoteAccessConfig | { status: "accepted" }): value is RemoteAccessConfig {
  return "revision" in value;
}

function StatusValue({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="remote-status-value">
      <span className="field-label">{label}</span>
      {tone ? <span className={`chip ${tone}`}>{value.replaceAll("_", " ")}</span> : <span>{value}</span>}
    </div>
  );
}

export function RemoteAccessTab() {
  const context = useClientContext();
  const status = useRemoteAccessState(context);
  const pairingRequests = useApi((signal) => api.remoteAccessPairingRequests(signal), []);
  const devices = useApi((signal) => api.remoteAccessDevices(signal), []);
  const diagnostics = useApi((signal) => api.remoteAccessDiagnostics(signal), []);
  const [displayName, setDisplayName] = useState("");
  const [invitation, setInvitation] = useState<Awaited<ReturnType<typeof api.createRemoteAccessInvitation>> | undefined>();
  const [activation, setActivation] = useState<ActivationStartResult | undefined>();
  const [activationStatus, setActivationStatus] = useState<ActivationStatus | undefined>();
  const [notice, setNotice] = useState<NoticeState | undefined>();
  const [busy, setBusy] = useState<string | undefined>();

  useEffect(() => {
    if (status.data) setDisplayName(status.data.config.displayName);
  }, [status.data?.config.displayName]);

  useEffect(() => {
    if (!activation || activationStatus?.state === "completed" || activationStatus?.state === "expired" || activationStatus?.state === "failed") {
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const next = await api.remoteAccessActivation(activation.activationOperationId);
        if (!active) return;
        setActivationStatus(next);
        if (next.state === "completed") {
          setNotice({ tone: "ok", message: "This installation is activated. Remote access can now be enabled." });
          status.reload();
        } else if (next.state === "expired") {
          setNotice({ tone: "warn", message: "The activation link expired. Start a new activation." });
        } else if (next.state === "failed") {
          setNotice({ tone: "err", message: `Activation failed: ${next.errorCode.replaceAll("_", " ")}.` });
        }
      } catch (error) {
        if (active) setNotice({ tone: "err", message: (error as Error).message });
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activation, activationStatus?.state, status.reload]);

  useInterval(() => {
    pairingRequests.reload();
    devices.reload();
    diagnostics.reload();
  }, 5_000);

  const showMessage = useCallback((message: string, error = false) => {
    setNotice({ tone: error ? "err" : "ok", message });
  }, []);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      setNotice({ tone: "err", message: (error as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const reloadManagement = () => {
    status.reload();
    pairingRequests.reload();
    devices.reload();
    diagnostics.reload();
  };

  const beginActivation = () => run("activation", async () => {
    const next = await api.beginRemoteAccessActivation();
    setActivation(next);
    setActivationStatus({
      activationOperationId: next.activationOperationId,
      expiresAt: next.expiresAt,
      state: "pending"
    });
    setNotice({ tone: "info", message: "Open the activation page and finish the short verification flow." });
  });

  const cancelActivation = () => {
    if (!activation) return Promise.resolve();
    return run("activation", async () => {
      await api.cancelRemoteAccessActivation(activation.activationOperationId);
      setActivation(undefined);
      setActivationStatus(undefined);
      setNotice({ tone: "ok", message: "Activation cancelled." });
    });
  };

  const updateConfig = (change: { enabled?: boolean; displayName?: string }, success: string) => {
    if (!status.data) return Promise.resolve();
    return run("config", async () => {
      const result = await api.updateRemoteAccess({ revision: status.data!.config.revision, ...change });
      if (isRemoteAccessConfig(result)) {
        status.setData({ ...status.data!, config: result });
      } else {
        status.reload();
      }
      setNotice({ tone: "ok", message: success });
    });
  };

  const createInvitation = () => run("invitation", async () => {
    const next = await api.createRemoteAccessInvitation();
    setInvitation(next);
    setNotice({ tone: "ok", message: "Invitation created. Keep its token private." });
  });

  const cancelInvitation = () => {
    if (!invitation) return Promise.resolve();
    return run("invitation", async () => {
      await api.cancelRemoteAccessInvitation(invitation.invitationId);
      setInvitation(undefined);
      setNotice({ tone: "ok", message: "Invitation cancelled." });
    });
  };

  const approve = (request: PendingPairingRequest) => run(`approve:${request.requestId}`, async () => {
    await api.approveRemoteAccessPairing(request.requestId, {
      invitationGeneration: request.invitationGeneration,
      remoteIdentityBundleHash: request.remoteIdentityBundleHash,
      transcriptHash: request.transcriptHash,
      channelBinding: request.channelBinding,
      sasIndices: request.sasIndices,
      sasFingerprint: request.sasFingerprint
    });
    setNotice({ tone: "ok", message: `${request.claimedDisplayName} was approved.` });
    reloadManagement();
  });

  const reject = (request: PendingPairingRequest) => run(`reject:${request.requestId}`, async () => {
    await api.rejectRemoteAccessPairing(request.requestId);
    setNotice({ tone: "ok", message: `${request.claimedDisplayName} was rejected.` });
    pairingRequests.reload();
  });

  const renameDevice = (device: TrustedDevice, nextName: string) => run(`rename:${device.deviceId}`, async () => {
    await api.renameRemoteAccessDevice(device.deviceId, {
      revision: device.revision,
      displayName: nextName
    });
    setNotice({ tone: "ok", message: "Device renamed." });
    devices.reload();
  });

  const revokeDevice = (device: TrustedDevice) => run(`revoke:${device.deviceId}`, async () => {
    await api.revokeRemoteAccessDevice(device.deviceId, device.revision);
    setNotice({ tone: "ok", message: `${device.displayName} was revoked.` });
    reloadManagement();
  });

  const resetIdentity = (confirmation: string) => run("identity-reset", async () => {
    await api.resetRemoteAccess(confirmation);
    setInvitation(undefined);
    setActivation(undefined);
    setActivationStatus(undefined);
    setNotice({
      tone: "ok",
      message: "Remote Access identity was reset. Activate and pair every device again."
    });
    reloadManagement();
  });

  if (status.loading && !status.data) {
    return <div className="content"><div className="cell remote-loading">Loading remote access…</div></div>;
  }

  if (!status.data) {
    return (
      <div className="content">
        <div className="cell remote-access-section">
          <Notice tone="err">{status.error?.message ?? "Remote access status is unavailable."}</Notice>
          <button className="btn" onClick={status.reload}>Try again</button>
        </div>
        <div className="cell growcell" />
      </div>
    );
  }

  const current = status.data;
  const canInvite = current.config.enabled && current.activationState === "active" && current.helperState === "ready";
  const activationPending = activationStatus?.state === "pending";

  return (
    <div className="content remote-access-content">
      {notice && <div className="cell remote-notice"><Notice tone={notice.tone}>{notice.message}</Notice></div>}
      {status.error && (
        <div className="cell remote-notice">
          <Notice tone="warn">Live Remote Access updates are reconnecting: {status.error.message}</Notice>
        </div>
      )}

      <section className="cell remote-access-section">
        <div className="remote-section-head">
          <div>
            <span className="t-micro">Remote Access</span>
            <div className="t-title">{current.config.displayName}</div>
          </div>
          <span className={`chip ${current.config.enabled ? "mint" : "peach"}`}>
            {current.config.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="remote-status-grid">
          <StatusValue label="Helper" value={current.helperState} tone={stateTone(current.helperState)} />
          <StatusValue label="Activation" value={current.activationState} tone={stateTone(current.activationState)} />
          <StatusValue label="Control" value={current.controlState} tone={stateTone(current.controlState)} />
          <StatusValue label="Direct path" value={current.directState} tone={stateTone(current.directState)} />
          <StatusValue label="Last direct" value={formatUnixSeconds(current.lastDirectAt)} />
          <StatusValue label="App" value={current.appVersion} />
          <StatusValue label="Dashboard build" value={current.dashboardBuildId.slice(0, 12)} />
          <StatusValue label="Helper version" value={current.helperVersion ?? "Not running"} />
          <StatusValue label="Protocol" value={`${current.protocol.major}.${current.protocol.minor}`} />
          <StatusValue label="Last error" value={current.lastErrorCode?.replaceAll("_", " ") ?? "None"} />
        </div>
        <div className="remote-capabilities">
          <span className="field-label">Negotiated capabilities</span>
          <div>{current.capabilities.length
            ? current.capabilities.map((capability) => <span className="tag" key={capability}>{capability}</span>)
            : <span className="t-small t-mute">None reported</span>}</div>
        </div>
      </section>

      <section className="cell remote-access-section">
        <div className="remote-section-head">
          <div>
            <span className="t-micro">Host settings</span>
            <div className="t-title">Identity and lifecycle</div>
          </div>
          <button className="btn sm" onClick={reloadManagement}>Refresh state</button>
        </div>
        <div className="remote-inline-form remote-config-form">
          <label className="field">
            <span className="field-label">Host display name</span>
            <input
              className="input"
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <button
            className="btn"
            disabled={busy === "config" || !displayName.trim() || displayName.trim() === current.config.displayName}
            onClick={() => updateConfig({ displayName: displayName.trim() }, "Host display name saved.")}
          >
            Save name
          </button>
          <button
            className={current.config.enabled ? "btn danger" : "btn primary"}
            disabled={busy === "config" || (!current.config.enabled && current.activationState !== "active")}
            onClick={() => updateConfig(
              { enabled: !current.config.enabled },
              current.config.enabled ? "Remote access is disabling." : "Remote access is starting."
            )}
          >
            {current.config.enabled ? "Disable remote access" : "Enable remote access"}
          </button>
          <button
            className="btn"
            disabled={busy === "reconnect" || !current.config.enabled}
            onClick={() => run("reconnect", async () => {
              await api.reconnectRemoteAccess();
              setNotice({ tone: "ok", message: "Direct reconnection started." });
              reloadManagement();
            })}
          >
            Reconnect
          </button>
        </div>
        <div className="remote-identity t-small t-mute">
          <span className="mono">Device {current.identity.deviceId}</span>
          <span className="mono">Installation fingerprint {current.identity.installationFingerprint}</span>
        </div>
      </section>

      {current.activationState !== "active" && (
        <section className="cell remote-access-section">
          <div className="remote-section-head">
            <div>
              <span className="t-micro">One-time setup</span>
              <div className="t-title">Activate this installation</div>
            </div>
            <span className={`chip ${current.activationState === "renewal_due" ? "butter" : "peach"}`}>
              {current.activationState.replaceAll("_", " ")}
            </span>
          </div>
          {context.mode === "remote" ? (
            <Notice tone="warn">Activation is local-only. Open this dashboard on the host device to activate it.</Notice>
          ) : activation ? (
            <div className="remote-activation">
              <ContextExternalLink className="btn primary" href={activation.verificationUrl}>
                Open activation page ↗
              </ContextExternalLink>
              <span className="t-small t-mute">Expires {formatUnixSeconds(activation.expiresAt)}</span>
              <span className={`chip ${activationPending ? "butter" : "mint"}`}>
                {activationStatus?.state ?? "pending"}
              </span>
              <button className="btn" disabled={busy === "activation"} onClick={cancelActivation}>Cancel</button>
            </div>
          ) : (
            <button className="btn primary" disabled={busy === "activation"} onClick={beginActivation}>
              Start activation
            </button>
          )}
        </section>
      )}

      <section className="cell remote-access-section">
        <div className="remote-section-head">
          <div>
            <span className="t-micro">Pairing</span>
            <div className="t-title">Invite a remote device</div>
          </div>
          {!invitation && (
            <button className="btn primary" disabled={!canInvite || busy === "invitation"} onClick={createInvitation}>
              Create invitation
            </button>
          )}
        </div>
        {!canInvite && (
          <p className="t-small t-mute">Activate and enable Remote Access, then wait for the verified helper to become ready.</p>
        )}
      </section>

      {invitation && <InvitationCard invitation={invitation} onCancel={cancelInvitation} onMessage={showMessage} />}

      <section className="remote-section-label cell">
        <span className="t-micro">Pending approvals · {pairingRequests.data?.requests.length ?? 0}</span>
      </section>
      {pairingRequests.error ? (
        <div className="cell remote-access-section"><Notice tone="err">{pairingRequests.error.message}</Notice></div>
      ) : pairingRequests.data?.requests.length ? (
        <div className="remote-card-list">
          {pairingRequests.data.requests.map((request) => (
            <PairingRequestCard
              key={request.requestId}
              request={request}
              onApprove={() => approve(request)}
              onReject={() => reject(request)}
            />
          ))}
        </div>
      ) : (
        <div className="cell empty remote-empty">
          <span className="empty-title">No pending pairing requests</span>
          <span className="empty-help">Requests appear here only after the other device uses an active invitation.</span>
        </div>
      )}

      <section className="remote-section-label cell">
        <span className="t-micro">Trusted devices · {devices.data?.devices.length ?? 0}</span>
      </section>
      {devices.error
        ? <div className="cell remote-access-section"><Notice tone="err">{devices.error.message}</Notice></div>
        : <TrustedDevices devices={devices.data?.devices ?? []} onRename={renameDevice} onRevoke={revokeDevice} />}

      {diagnostics.error
        ? <div className="cell remote-access-section"><Notice tone="err">{diagnostics.error.message}</Notice></div>
        : diagnostics.data && <RemoteDiagnostics diagnostics={diagnostics.data} />}

      <IdentityResetControl
        mode={context.mode}
        busy={busy === "identity-reset"}
        onReset={resetIdentity}
      />

      <div className="cell growcell" />
    </div>
  );
}
