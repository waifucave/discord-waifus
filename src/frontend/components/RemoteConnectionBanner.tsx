import type { ClientContext } from "../api/types";
import { remoteConnectionPresentation } from "../state/clientContext";

export function RemoteConnectionBanner({ context }: { context: ClientContext }) {
  const presentation = remoteConnectionPresentation(context);
  if (!presentation) return null;
  if (presentation.tone === "ok") return null;
  return (
    <aside className="remote-connection-banner cell" data-tone={presentation.tone}>
      <span className="remote-connection-state">{presentation.label}</span>
      <span className="t-small">
        This dashboard will reconnect automatically.
      </span>
      <span className="t-small t-mute">
        To manage saved hosts, run <code>waifus remote --setup</code>.
      </span>
    </aside>
  );
}
