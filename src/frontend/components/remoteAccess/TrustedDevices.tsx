import { useEffect, useState } from "react";
import type { TrustedDevice } from "../../api/types";
import { formatHelperTarget, formatUnixSeconds, stateTone } from "./presentation";

function TrustedDeviceRow({
  device,
  onRename,
  onRevoke
}: {
  device: TrustedDevice;
  onRename: (displayName: string) => Promise<void>;
  onRevoke: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(device.displayName);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setDisplayName(device.displayName), [device.displayName]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="cell trusted-device-row">
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Trusted device</span>
          <div className="t-title">{device.displayName}</div>
        </div>
        <span className={`chip ${stateTone(device.connectionState)}`}>{device.connectionState.replaceAll("_", " ")}</span>
      </div>
      <div className="remote-device-meta t-small t-mute">
        <span>{formatHelperTarget(device.platform)}</span>
        <span>Paired {formatUnixSeconds(device.pairedAt)}</span>
        <span>Last seen {formatUnixSeconds(device.lastSeenAt)}</span>
        <span className="mono">Fingerprint {device.installationFingerprint}</span>
      </div>
      <div className="remote-inline-form">
        <label className="field">
          <span className="field-label">Device name</span>
          <input
            className="input"
            value={displayName}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <button
          className="btn"
          disabled={busy || !displayName.trim() || displayName.trim() === device.displayName}
          onClick={() => act(() => onRename(displayName.trim()))}
        >
          Rename
        </button>
        <button
          className="btn danger"
          disabled={busy}
          onClick={() => {
            setConfirmingRevoke((value) => !value);
            setConfirmation("");
          }}
        >
          Revoke
        </button>
      </div>
      {confirmingRevoke && (
        <div className="remote-revoke-confirmation">
          <p className="t-small">Type <strong>{device.displayName}</strong> to revoke this device immediately.</p>
          <div className="remote-inline-form">
            <input
              className="input"
              value={confirmation}
              aria-label={`Type ${device.displayName} to confirm revocation`}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            <button
              className="btn danger"
              disabled={busy || confirmation !== device.displayName}
              onClick={() => act(onRevoke)}
            >
              Confirm revoke
            </button>
            <button className="btn" disabled={busy} onClick={() => setConfirmingRevoke(false)}>Keep device</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function TrustedDevices({
  devices,
  onRename,
  onRevoke
}: {
  devices: TrustedDevice[];
  onRename: (device: TrustedDevice, displayName: string) => Promise<void>;
  onRevoke: (device: TrustedDevice) => Promise<void>;
}) {
  if (devices.length === 0) {
    return (
      <div className="cell empty remote-empty">
        <span className="empty-title">No trusted remote devices</span>
        <span className="empty-help">Create an invitation to pair the first device.</span>
      </div>
    );
  }
  return (
    <div className="remote-card-list">
      {devices.map((device) => (
        <TrustedDeviceRow
          key={`${device.deviceId}:${device.revision}`}
          device={device}
          onRename={(displayName) => onRename(device, displayName)}
          onRevoke={() => onRevoke(device)}
        />
      ))}
    </div>
  );
}
