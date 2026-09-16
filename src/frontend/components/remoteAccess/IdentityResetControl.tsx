import { useState } from "react";

export const IDENTITY_RESET_CONFIRMATION = "RESET REMOTE ACCESS";

export function identityResetConfirmationMatches(value: string): boolean {
  return value === IDENTITY_RESET_CONFIRMATION;
}

export function IdentityResetControl({
  mode,
  busy,
  onReset
}: {
  mode: "host" | "remote";
  busy: boolean;
  onReset: (confirmation: string) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const local = mode === "host";

  return (
    <section className="cell remote-access-section remote-reset-section">
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Identity reset</span>
          <div className="t-title">Reset Remote Access</div>
        </div>
        <button
          className="btn danger"
          disabled={!local || busy || !identityResetConfirmationMatches(confirmation)}
          onClick={() => void onReset(confirmation)}
        >
          Reset identity
        </button>
      </div>
      {local ? (
        <div className="remote-reset-confirmation">
          <p className="t-small t-mute">
            This permanently replaces this installation identity, removes every trusted device,
            clears remembered remote hosts and cached dashboards, and requires activation and
            pairing again.
          </p>
          <label className="field">
            <span className="field-label">Type {IDENTITY_RESET_CONFIRMATION} to confirm</span>
            <input
              className="input mono"
              aria-label={`Type ${IDENTITY_RESET_CONFIRMATION} to confirm`}
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
        </div>
      ) : (
        <p className="t-small t-mute">
          Identity reset is local-only. It cannot be started from a remote device.
        </p>
      )}
    </section>
  );
}
