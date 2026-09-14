import type { RemoteAccessDiagnostics as RemoteAccessDiagnosticsData } from "../../api/types";
import {
  formatHelperTarget,
  formatUnixSeconds,
  prohibitedTrafficIsZero,
  stateTone
} from "./presentation";

function DiagnosticValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="remote-diagnostic-value">
      <span className="field-label">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

export function RemoteDiagnostics({ diagnostics }: { diagnostics: RemoteAccessDiagnosticsData }) {
  const directOnly = prohibitedTrafficIsZero(diagnostics);
  return (
    <section className="cell remote-access-section">
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Sanitized diagnostics</span>
          <div className="t-title">Network and helper</div>
        </div>
        <span className={`chip ${directOnly ? "mint" : "peach"}`}>
          {directOnly ? "relay counters clear" : "direct-only invariant failed"}
        </span>
      </div>
      <div className="remote-diagnostics-grid">
        <DiagnosticValue label="Helper" value={diagnostics.helper.state} />
        <DiagnosticValue label="Helper version" value={diagnostics.helper.version ?? "Unavailable"} />
        <DiagnosticValue label="Platform" value={formatHelperTarget(diagnostics.helper.target)} />
        <DiagnosticValue label="Secret storage" value={diagnostics.helper.secretStorage ?? "Unavailable"} />
        <DiagnosticValue label="Control" value={diagnostics.controlState} />
        <DiagnosticValue label="Direct path" value={diagnostics.directState} />
        <DiagnosticValue label="STUN" value={diagnostics.stun} />
        <DiagnosticValue label="UDP" value={diagnostics.udp} />
        <DiagnosticValue label="Port mapping" value={diagnostics.portMapping} />
        <DiagnosticValue label="Last transition" value={formatUnixSeconds(diagnostics.lastTransitionAt)} />
        <DiagnosticValue label="Last direct" value={formatUnixSeconds(diagnostics.lastDirectAt)} />
        <DiagnosticValue label="Last error" value={diagnostics.lastErrorCode ?? "None"} />
      </div>
      <div className="remote-prohibited-grid" data-clear={directOnly ? "true" : "false"}>
        {Object.entries(diagnostics.prohibited).map(([name, value]) => (
          <DiagnosticValue key={name} label={name.replaceAll(/([A-Z])/g, " $1")} value={value} />
        ))}
      </div>
      <p className="t-small t-mute">
        These counters must remain zero. Waifus does not expose raw endpoint candidates or permit DERP,
        peer relay, or generic proxy traffic.
      </p>
      <div className="remote-state-chips" aria-hidden="true">
        <span className={`chip ${stateTone(diagnostics.helper.state)}`}>{diagnostics.helper.state}</span>
        <span className={`chip ${stateTone(diagnostics.controlState)}`}>{diagnostics.controlState}</span>
        <span className={`chip ${stateTone(diagnostics.directState)}`}>{diagnostics.directState}</span>
      </div>
    </section>
  );
}
