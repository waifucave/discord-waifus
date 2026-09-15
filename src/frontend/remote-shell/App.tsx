import { useCallback, useEffect, useRef, useState } from "react";
import {
  RemoteShellApiError,
  openActivationUrl,
  shellApi
} from "./api";
import type {
  ActivationStart,
  GatewayBootstrap,
  PairStatus,
  RememberedHost
} from "./types";

function stateLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function errorLabel(error: unknown): string {
  if (error instanceof RemoteShellApiError) {
    return typeof error.body.error === "string" ? error.body.error : `Request failed (${error.status})`;
  }
  return error instanceof Error ? error.message : "Request failed";
}

export function App() {
  const [bootstrap, setBootstrap] = useState<GatewayBootstrap>();
  const [hosts, setHosts] = useState<RememberedHost[]>([]);
  const [activation, setActivation] = useState<ActivationStart>();
  const [entryFlow, setEntryFlow] = useState<"full_token" | "short_code">("full_token");
  const [pairSecret, setPairSecret] = useState("");
  const [pair, setPair] = useState<PairStatus>();
  const [offlineForget, setOfflineForget] = useState<RememberedHost>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const openingHost = useRef<string | undefined>(undefined);
  const requestedHost = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    const [nextBootstrap, nextHosts] = await Promise.all([
      shellApi.bootstrap(),
      shellApi.hosts()
    ]);
    setBootstrap(nextBootstrap);
    setHosts(nextHosts.hosts);
  }, []);

  useEffect(() => {
    void refresh().catch((value) => setError(errorLabel(value)));
  }, [refresh]);

  useEffect(() => {
    const selectedHostId = bootstrap?.selectedHostId;
    const shouldOpen = bootstrap?.selectionState === "automatic_single"
      || requestedHost.current === selectedHostId;
    if (bootstrap?.directState !== "direct" || !selectedHostId || !shouldOpen) {
      openingHost.current = undefined;
      return;
    }
    if (openingHost.current === selectedHostId) return;
    openingHost.current = selectedHostId;
    window.location.assign(`/_waifus_remote/open/${encodeURIComponent(selectedHostId)}`);
  }, [bootstrap?.directState, bootstrap?.selectedHostId, bootstrap?.selectionState]);

  useEffect(() => {
    if (!bootstrap?.selectedHostId || bootstrap.directState === "direct") return;
    const timer = window.setInterval(() => {
      void refresh().catch((value) => setError(errorLabel(value)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [bootstrap?.directState, bootstrap?.selectedHostId, refresh]);

  useEffect(() => {
    if (!pair || !["starting", "verification_required", "awaiting_host_approval", "connecting"].includes(pair.state)) {
      return;
    }
    const timer = window.setInterval(() => {
      void shellApi.pairStatus(pair.statusUrl).then((status) => {
        setPair(status);
        if (status.state === "completed") void refresh();
      }).catch((value) => setError(errorLabel(value)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [pair, refresh]);

  useEffect(() => {
    if (!activation) return;
    const timer = window.setInterval(() => {
      void shellApi.activationStatus(activation.activationOperationId).then((status) => {
        if (status.state === "completed") {
          setActivation(undefined);
          void refresh();
        } else if (status.state === "failed" || status.state === "expired") {
          setActivation(undefined);
          setError(String(status.errorCode ?? status.state));
        }
      }).catch((value) => setError(errorLabel(value)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [activation, refresh]);

  const act = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await shellApi.beginActivation();
      setActivation(started);
    } catch (value) {
      setError(errorLabel(value));
    } finally {
      setBusy(false);
    }
  };

  const beginPair = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const secret = pairSecret;
      const started = await shellApi.beginPair(
        entryFlow === "full_token"
          ? { kind: "full_token", token: secret.trim() }
          : { kind: "short_code", code: secret.trim().toUpperCase() }
      );
      setPairSecret("");
      setPair(started);
    } catch (value) {
      setError(errorLabel(value));
    } finally {
      setBusy(false);
    }
  };

  const hostAction = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await task();
      setOfflineForget(undefined);
      await refresh();
    } catch (value) {
      if (
        value instanceof RemoteShellApiError
        && value.status === 409
        && value.body.state === "local_only_confirmation_required"
      ) {
        return;
      }
      setError(errorLabel(value));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell">
      <header className="hero cell">
        <div>
          <p className="eyebrow">Waifus Remote</p>
          <h1>Connect to your Waifus host.</h1>
        </div>
        <span className={`status ${bootstrap?.directState ?? "inactive"}`}>
          {stateLabel(bootstrap?.directState ?? "starting")}
        </span>
      </header>

      {error && <div className="notice error" role="alert">{error}</div>}
      {bootstrap?.directState === "direct_unavailable" && (
        <div className="notice warning">
          A direct connection could not be established. Waifus never relays dashboard traffic;
          check UDP/network access on both devices and try again.
        </div>
      )}

      <section className="grid">
        <article className="cell panel">
          <p className="eyebrow">01 · Activation</p>
          <h2>{bootstrap?.activationState === "active" ? "This device is active" : "Activate this device"}</h2>
          <p>Activation lets this installation use the pairing coordinator. It does not relay your dashboard.</p>
          {activation ? (
            <button onClick={() => openActivationUrl(activation.verificationUrl)}>
              Continue activation in a new tab
            </button>
          ) : bootstrap?.activationState !== "active" ? (
            <button disabled={busy} onClick={() => void act()}>Prepare activation</button>
          ) : null}
        </article>

        <article className="cell panel">
          <p className="eyebrow">02 · Pair</p>
          <h2>Add a host</h2>
          <div className="segmented">
            <button className={entryFlow === "full_token" ? "active" : ""} onClick={() => setEntryFlow("full_token")}>Full token</button>
            <button className={entryFlow === "short_code" ? "active" : ""} onClick={() => setEntryFlow("short_code")}>Short code</button>
          </div>
          <label>
            <span>{entryFlow === "full_token" ? "Pairing token" : "XXXX-XXXX code"}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={pairSecret}
              onChange={(event) => setPairSecret(event.target.value)}
            />
          </label>
          <button disabled={busy || pairSecret.trim() === ""} onClick={() => void beginPair()}>Begin pairing</button>
        </article>
      </section>

      {pair && (
        <section className="cell panel comparison">
          <p className="eyebrow">Pairing · {stateLabel(pair.state)}</p>
          {pair.state === "verification_required" && pair.sasWords && (
            <>
              <h2>Compare on both devices</h2>
              <p className="words">{pair.sasWords.join(" · ")}</p>
              <p className="fingerprint">{pair.sasFingerprint}</p>
              <dl>
                <div><dt>Host</dt><dd>{pair.claimedHostDisplayName}</dd></div>
                <div><dt>Platform</dt><dd>{pair.claimedHostPlatform?.os} / {pair.claimedHostPlatform?.arch}</dd></div>
                <div><dt>Installation</dt><dd>{pair.claimedHostInstallationFingerprint}</dd></div>
              </dl>
              <p>Approve only if every value matches the host exactly.</p>
            </>
          )}
          {pair.state !== "completed" && pair.state !== "failed" && (
            <button className="danger" onClick={() => void shellApi.cancelPair(pair.statusUrl).then(() => setPair(undefined))}>Cancel pairing</button>
          )}
        </section>
      )}

      <section className="cell panel hosts">
        <div className="section-head">
          <div>
            <p className="eyebrow">03 · Remembered hosts</p>
            <h2>{hosts.length === 0 ? "No hosts yet" : `${hosts.length} host${hosts.length === 1 ? "" : "s"}`}</h2>
          </div>
          <button disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        {hosts.map((host) => (
          <article className="host" key={host.hostId}>
            <div>
              <h3>{host.displayName}</h3>
              <p>{host.platform.os} / {host.platform.arch} · {stateLabel(host.connectionState)}</p>
              <code>{host.installationFingerprint}</code>
            </div>
            <div className="actions">
              <button disabled={busy} onClick={() => {
                requestedHost.current = host.hostId;
                void hostAction(() => shellApi.connect(host.hostId));
              }}>Connect</button>
              <button disabled={busy} onClick={() => void hostAction(() => shellApi.disconnect(host.hostId))}>Disconnect</button>
              <button className="danger" disabled={busy} onClick={() => {
                setOfflineForget(host);
                void hostAction(() => shellApi.forgetReachable(host));
              }}>Forget</button>
            </div>
          </article>
        ))}
      </section>

      {offlineForget && (
        <section className="notice warning">
          <strong>{offlineForget.displayName} is unreachable.</strong> Local-only forget removes it
          here, but its remote trust may remain on the host. Revoke it on the host later.
          <button className="danger" disabled={busy} onClick={() => void hostAction(() => shellApi.forgetLocal(offlineForget))}>
            Forget locally anyway
          </button>
        </section>
      )}

      <footer>
        <span>Gateway {bootstrap?.gatewayVersion ?? "…"}</span>
        <span>Helper {bootstrap?.helperVersion ?? "unavailable"}</span>
        <span>Control {stateLabel(bootstrap?.controlState ?? "inactive")}</span>
      </footer>
    </main>
  );
}
