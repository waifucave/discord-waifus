# Remote Access

How Remote Access behaves for the owner: opening the host's dashboard from another device over an
authenticated direct peer connection. Code: `src/remote/`, `src/backend/remoteAccess/`,
`src/api/remoteAccess.ts`, `src/frontend/remote-shell/`. Setup steps for people are in the README's
Remote management section and `docs/assistant-kb/remote-access.md`.

## The helper

- A signed native child process, `ts-connect`. The host supervises one when Remote Access is enabled;
  `waifus remote` (the remote gateway, no Discord runtime) supervises its own.
- Pinned exactly to **0.1.16** for the five targets (macOS ARM64, Windows x64/ARM64, Linux x64/ARM64)
  in `package.json` `optionalDependencies`. Helper 0.1.17 is not on `main`: the trust window in
  `src/remote/helperReleaseTrust.ts` covers release sequences 13–17 (0.1.12–0.1.16), so a 0.1.17 would
  also need that window raised. Intel macOS and Linux ARMv7 are not supported and never fall back.
- **Pending (helper 0.1.17):** remembers the NAT's public address pool (an address counts only when at
  least 2 STUN destinations confirm it), uses short-lived learning sockets, asks 7 STUN services from 6
  operators (Cloudflare, Google, Twilio, Nextcloud, sipgate, BlackBerry), and ranks the candidates it
  currently observes first. Still direct only. Not pinned on `main` yet.
- Before launch it is verified fail-closed (`src/remote/helperBinary.ts`): package inventory (no
  links), Ed25519-signed manifest, binary and notices hashes, target metadata, embedded build info
  (5 s probe), and `remote-compatibility.json` (app 3.3.0; helper ≥ 0.1.16, < 0.2.0, release
  sequence ≥ 17; protocol majors; six required capabilities). Errors: `helper_missing`,
  `helper_signature_invalid`, `helper_incompatible`, `unsupported_platform`.
- A missing or invalid helper never stops the host from booting; Remote Access is then unavailable.
- **Supervision** (`src/remote/helperSupervisor.ts`, constants in `helperTypes.ts`): restarts after
  1, 2, 5, 10, 30 s (then 30 s), ±10% jitter. After **10 failures in 5 minutes** the circuit opens:
  no fast restarts, one slow recovery attempt pending (10 min, then every 15 min, ±10%) until a launch
  authenticates or reconnect/stop/reset/close clears it.
- **Status**: the helper reports runtime status only when asked. While following an enabled helper,
  the host asks every **5 s** until control is connected and the path is direct, then every **60 s**
  (`RUNTIME_STATUS_REFRESH_MS`).

## Direct only

The coordinator `pair.waifucave.com` handles only bounded activation, pairing, presence, endpoint,
capability and revocation metadata. Dashboard, API, assistant, uploads, downloads and event streams go
only over the authenticated direct peer path. There is no DERP, TURN, peer relay, proxy or
coordinator fallback; the helper build must carry the `waifus_direct_only` tag. When no direct path
exists: page loads get the waiting page, other requests 503 `DirectUnavailable`, opening a host 409
`DirectUnavailable`. Fastify is never a network listener.

## Pairing

1. **Activate** each installation (host: Settings → Remote Access, local browser only; challenge
   valid 600 s).
2. **Enable** on the host (needs activation, a loopback `http.host`, and the bundled dashboard).
3. **Invite**: the host's secure card shows a `WF1.` token, a `XXXX-XXXX` short code and a QR code;
   its expiry comes from the helper (the contract value is 5 minutes). The CLI never takes a token as
   an argument.
4. On the other device run `waifus remote` (or `--setup`) and paste the token or short code.
5. **Compare** the 5-word safety phrase and 12-hex fingerprint on both devices; on the host tick "I
   compared both…" and **Approve device**. Approval is bound to the exact transcript, channel binding
   and safety values.

- Saved pairing is per data root and reused on later connections. Limits: 256 trusted devices, 16
  pending requests, 256 remembered hosts.
- Approve/reject are full-admin routes, so an already paired device can approve another.
- **Revocation** writes a host-local deny cutoff first: the old device can't open new requests, use
  pending assistant actions or resume conversations, even during helper failure; then its streams are
  closed and the helper converges (resumed after reconnect or restart). Re-pairing needs a new pair.
- **Remote-side forget** tries a signed self-revocation; if the host is unreachable it offers "Forget
  locally anyway… Revoke it on the host later."
- **Identity reset** is local-only (host browser, typed `RESET REMOTE ACCESS`), refused while a remote
  gateway runs on the same data root; it removes every pairing and requires activation again.

## Connection timeline (`waifus remote`)

1. **CLI**: if a gateway is already running, it reopens the browser through an owner-private launcher
   (no restart); otherwise it starts a detached gateway and waits up to 30 s. Flags `--setup`,
   `--host <id|name>`, `--port`, `--foreground`, `--no-open`; `remote status` / `remote stop` touch
   only the gateway.
2. **Host selection**: an explicit choice, else the only remembered host, else the setup screen.
3. **Readiness**: every 2 s the gateway refreshes helper status and, while not direct, re-registers the
   same launch and sends a bounded `GET /api/health` through the helper (25 s, 64 KiB). Only the
   helper's status decides "direct".
4. **Waiting page** (`src/remote/gateway/browserRecovery.ts` `waitingDashboard`, "Waiting for your
   host", light/dark): shown for a page load before a direct path or a verified build exists. It polls
   every 2 s and reloads once the path is direct (or the launch changed after a host or gateway
   restart). A 403 shows "Remote access was disconnected. Reopen with waifus remote."
5. **Dashboard**: the gateway downloads the host's exact bundled build from its live manifest
   (`GET /api/remote-access/dashboard-manifest`, then each asset), checks every hash, type and length,
   and serves it. The disk cache (64 MiB per build, 256 MiB total, 2 builds per host) only saves
   re-downloading a build the host's **live** manifest still names; an older cached build is never
   served.
6. Normal launches open the remembered host's dashboard directly, without a connection screen.

**Browser sessions**: no idle timeout or 8-hour cutoff; at most 1,024 per gateway launch, least
recently used evicted. The trusted frame keeps a non-exportable P-256 key in IndexedDB and answers
single-use 30 s challenges to get fresh cookies/CSRF after a restart; the gateway stores only public
keys. Bootstrap links are single-use and expire after 5 minutes. Cookies are HttpOnly,
SameSite=Strict, without expiry.

## What is different over Remote Access

| Thing | Over Remote Access |
|---|---|
| DM content (`includePrivate`) | 403 `PrivateContentLocalOnly`; the Life reveal toggle is disabled |
| Activation, identity reset, the host's root page | Local only (403 `RemoteRouteForbidden`) |
| `http.host`, `frontend.staticDir`, `updates.*` changes | 403 `RemoteConfigFieldForbidden`; `http.host`/`frontend.staticDir` hidden in config reads |
| Host OS stop/restart | Not possible (no such route) |
| Status/runtime | `httpUrl`, `dataRoot`, `pid`, `port` removed |
| Mutations | Need an `Idempotency-Key` (else 428) |
| Allowed | Everything else full-admin, including pause/resume/reload, disabling Remote Access, inviting and approving devices |

The remote dashboard's CSP allows scripts and styles from itself, images from itself and `blob:`
(file previews), and nothing else; no frames, workers or objects.

## Diagnostics

- `GET /api/remote-access/diagnostics`: app version, dashboard build id, helper state/version/
  release sequence/target/protocol/capabilities/secret storage, control state, direct state, last
  direct time, last error code. `stun`, `udp`, `portMapping` are always `unknown` and the relay
  counters always `0` (not measured).
- `POST /api/remote-access/reconnect`: reconnects the helper (clears the circuit) and resumes pending
  revocations.
- States: helper `disabled | starting | ready | degraded | failed`; control `inactive | connecting |
  connected | reconnecting | unavailable`; direct `inactive | direct | reconnecting |
  direct_unavailable`; activation `activation_required | active | renewal_due`.
- Local logs: `app/logs/remote-diagnostics/{host,remote}.jsonl`, closed enum fields and timestamps
  only, 64 KiB plus one rotated copy, repeats within 30 s suppressed; uploads nothing; a write failure
  disables it until the next start (`src/remote/diagnosticLog.ts`).

## Docs differ

- The app declares a 300 s invitation lifetime constant but does not enforce it; the helper sets
  `expiresAt`.
