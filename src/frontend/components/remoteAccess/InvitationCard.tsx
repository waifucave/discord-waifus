import { useMemo } from "react";
import QRCode from "qrcode";
import type { PairInvitation } from "../../api/types";
import { formatUnixSeconds } from "./presentation";

async function copyText(value: string): Promise<void> {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable in this browser.");
  await navigator.clipboard.writeText(value);
}

export function InvitationCard({
  invitation,
  onCancel,
  onMessage
}: {
  invitation: PairInvitation;
  onCancel: () => Promise<void>;
  onMessage: (message: string, error?: boolean) => void;
}) {
  const qr = useMemo(() => {
    const modules = QRCode.create(invitation.fullToken, { errorCorrectionLevel: "M" }).modules;
    const margin = 4;
    let path = "";
    for (let row = 0; row < modules.size; row += 1) {
      for (let column = 0; column < modules.size; column += 1) {
        if (modules.get(row, column)) {
          path += `M${column + margin} ${row + margin}h1v1h-1z`;
        }
      }
    }
    return { path, size: modules.size + margin * 2 };
  }, [invitation.fullToken]);

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      onMessage(`${label} copied.`);
    } catch (error) {
      onMessage((error as Error).message, true);
    }
  };

  return (
    <section className="cell remote-access-section invitation-card">
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Active invitation</span>
          <div className="t-title">Pair another device</div>
        </div>
        <span className="chip butter">expires {formatUnixSeconds(invitation.expiresAt)}</span>
      </div>
      <div className="remote-invitation-grid">
        <div className="remote-qr">
          <svg
            role="img"
            aria-label="QR code for this pairing invitation"
            viewBox={`0 0 ${qr.size} ${qr.size}`}
            width="224"
            height="224"
            shapeRendering="crispEdges"
          >
            <rect width={qr.size} height={qr.size} fill="#ffffff" />
            <path d={qr.path} fill="#141414" />
          </svg>
        </div>
        <div className="remote-secret-stack">
          <div>
            <span className="field-label">Pairing token</span>
            <code className="remote-secret-value">{invitation.fullToken}</code>
            <button className="btn sm" onClick={() => copy(invitation.fullToken, "Pairing token")}>Copy token</button>
          </div>
          <div>
            <span className="field-label">Manual code</span>
            <code className="remote-short-code">{invitation.shortCode}</code>
            <button className="btn sm" onClick={() => copy(invitation.shortCode, "Manual code")}>Copy code</button>
          </div>
          <p className="t-small t-mute">
            This invitation is secret. Anyone holding it can request pairing until it expires;
            approval on an already trusted dashboard is still required.
          </p>
          <button className="btn danger" onClick={onCancel}>Cancel invitation</button>
        </div>
      </div>
    </section>
  );
}
