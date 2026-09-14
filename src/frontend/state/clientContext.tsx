import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import type { ClientContext } from "../api/types";

const CANONICAL_BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const REMOTE_SHELL_HOST = /^waifus-[a-z2-7]{52}\.localhost$/u;
const CONNECTION_STATES = new Set(["direct", "reconnecting", "direct_unavailable"]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length
    && actual.every((key, index) => key === sorted[index]);
}

function validShellOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number.parseInt(url.port, 10);
    return url.protocol === "http:"
      && url.username === ""
      && url.password === ""
      && REMOTE_SHELL_HOST.test(url.hostname)
      && url.port !== ""
      && Number.isInteger(port)
      && port >= 1
      && port <= 65_535
      && url.origin === value;
  } catch {
    return false;
  }
}

export function parseClientContext(value: unknown): ClientContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Client context must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "host" && exactKeys(candidate, ["mode"])) {
    return Object.freeze({ mode: "host" });
  }
  if (
    candidate.mode === "remote"
    && exactKeys(candidate, [
      "mode",
      "selectedHostId",
      "connectionState",
      "connectionShellOrigin"
    ])
    && typeof candidate.selectedHostId === "string"
    && CANONICAL_BASE64URL_32.test(candidate.selectedHostId)
    && typeof candidate.connectionState === "string"
    && CONNECTION_STATES.has(candidate.connectionState)
    && validShellOrigin(candidate.connectionShellOrigin)
  ) {
    const connectionState = candidate.connectionState as Extract<
      ClientContext,
      { mode: "remote" }
    >["connectionState"];
    return Object.freeze({
      mode: "remote",
      selectedHostId: candidate.selectedHostId,
      connectionState,
      connectionShellOrigin: candidate.connectionShellOrigin
    });
  }
  throw new TypeError("Client context violates the strict host/remote contract.");
}

export type RemoteConnectionPresentation = Readonly<{
  label: "Connected directly" | "Reconnecting" | "Direct connection unavailable";
  tone: "ok" | "warn" | "err";
  connectionShellOrigin: string;
}>;

export function remoteConnectionPresentation(
  context: ClientContext
): RemoteConnectionPresentation | null {
  if (context.mode === "host") return null;
  const status = context.connectionState === "direct"
    ? { label: "Connected directly" as const, tone: "ok" as const }
    : context.connectionState === "reconnecting"
      ? { label: "Reconnecting" as const, tone: "warn" as const }
      : { label: "Direct connection unavailable" as const, tone: "err" as const };
  return Object.freeze({ ...status, connectionShellOrigin: context.connectionShellOrigin });
}

const ClientContextState = createContext<ClientContext | undefined>(undefined);

export function ClientContextProvider({
  children,
  loadContext
}: {
  children: ReactNode;
  loadContext: () => Promise<unknown>;
}) {
  const [context, setContext] = useState<ClientContext | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    loadContext()
      .then((value) => {
        if (active) setContext(parseClientContext(value));
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Client context failed to load.");
      });
    return () => {
      active = false;
    };
  }, [loadContext]);

  if (error) {
    return (
      <main className="client-context-gate cell">
        <span className="t-title">Dashboard session unavailable</span>
        <span className="t-small">{error}</span>
      </main>
    );
  }
  if (!context) {
    return (
      <main className="client-context-gate cell">
        <span className="t-micro">Establishing dashboard session…</span>
      </main>
    );
  }
  return <ClientContextState.Provider value={context}>{children}</ClientContextState.Provider>;
}

export function useClientContext(): ClientContext {
  const context = useContext(ClientContextState);
  if (!context) throw new Error("useClientContext must run inside ClientContextProvider.");
  return context;
}
