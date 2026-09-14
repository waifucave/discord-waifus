import type { ClientContext } from "../api/types";
import { remoteConnectionPresentation } from "../state/clientContext";

export function RemoteConnectionBanner({ context }: { context: ClientContext }) {
  const presentation = remoteConnectionPresentation(context);
  if (!presentation) return null;
  return (
    <aside className="remote-connection-banner cell" data-tone={presentation.tone}>
      <span className="remote-connection-state">{presentation.label}</span>
      <span className="t-small">
        Connection shell: <code className="mono">{presentation.connectionShellOrigin}</code>
      </span>
      <span className="t-small t-mute">
        Use browser Back to return to the connection shell, or rerun <code>waifus remote</code>.
      </span>
    </aside>
  );
}
