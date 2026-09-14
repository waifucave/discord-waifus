import { useState } from "react";
import type { PendingPairingRequest } from "../../api/types";
import { formatHelperTarget, formatUnixSeconds } from "./presentation";

export function PairingRequestCard({
  request,
  onApprove,
  onReject
}: {
  request: PendingPairingRequest;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [compared, setCompared] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="cell pairing-request-card">
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Pairing request</span>
          <div className="t-title">{request.claimedDisplayName}</div>
        </div>
        <span className="chip butter">pending</span>
      </div>
      <p className="t-small t-mute">
        Claimed device: {formatHelperTarget(request.claimedPlatform)} · expires {formatUnixSeconds(request.expiresAt)}
      </p>
      <div className="sas-phrase" aria-label="Safety phrase">{request.sasWords.join(" ")}</div>
      <div className="sas-fingerprint">
        <span className="field-label">Safety fingerprint</span>
        <code>{request.sasFingerprint}</code>
      </div>
      <label className="checkbox-chip pairing-confirmation">
        <input
          type="checkbox"
          checked={compared}
          onChange={(event) => setCompared(event.target.checked)}
        />
        I compared both the words and fingerprint on the requesting device
      </label>
      <div className="remote-actions">
        <button
          className="btn primary"
          disabled={!compared || busy}
          onClick={() => act(onApprove)}
        >
          Approve device
        </button>
        <button className="btn danger" disabled={busy} onClick={() => act(onReject)}>
          Reject
        </button>
      </div>
    </article>
  );
}
