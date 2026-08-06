# Waifus Direct Remote Management — Design

Approved by the user on 2026-08-06 after section-by-section review.

This design adds a `waifus remote` mode that runs the same dashboard on one device while
managing a Discord Waifus server on another. Pairing and endpoint coordination use
`pair.waifucave.com`; all dashboard and API traffic must travel over an authenticated,
encrypted, direct peer-to-peer path. WaifuCave never relays management traffic.

## Goals

1. Add `waifus remote` as a first-class mode with full dashboard and local-API parity.
2. Require no separately installed Tailscale client, account, VPN, daemon, or privileged
   system network interface.
3. Pair two attended devices through a short-lived invitation, then remember the remote
   device until it is revoked.
4. Carry management traffic directly between the paired devices using an embedded,
   userspace WireGuard/Tailscale-derived runtime.
5. Recover automatically after sleep, process restarts, and ordinary network changes when a
   new direct path is possible.
6. Fail clearly instead of relaying when direct UDP connectivity is unavailable.
7. Preserve full administrative parity, including credential replacement, activity and
   prompt visibility, destructive actions, and runtime controls.
8. Expose remote-access management through the host's local API and dashboard assistant.
9. Support official npm installations and source checkouts through the same signed helper
   binaries.
10. Ship on supported macOS ARM64, Windows x64/ARM64, and Linux x64/ARM targets. Intel macOS
    is a documented later follow-up.

## Non-goals and invariants

- No WaifuCave-hosted or third-party carriage of screen pixels, dashboard/API payloads,
  HTTP/SSE/WebSocket proxy bytes, or WireGuard packets. Bounded coordination metadata is the
  only information mediated by `pair.waifucave.com`.
- No WaifuCave-hosted data plane, TURN server, DERP data path, peer relay, exit node, or
  general Internet proxy.
- Remote access never publishes or directly exposes the existing Fastify server. While
  remote access is enabled, its effective bind must remain loopback-only.
- No user account requirement for pairing.
- No claim of uninterrupted connectivity across every firewall or NAT. Direct-only systems
  necessarily become unavailable on some networks.
- No universal secret embedded in a distributed client binary.
- No attempt to prove that a request came from an unmodified open-source client. The
  enforceable boundary is a narrow, authenticated, quota-bound protocol.
- No mobile client in v1.
- No Intel macOS binary in v1; keep it in the follow-up matrix.

## Threat model

The design defends against:

- An unauthenticated Internet attacker guessing invitations, replaying requests, submitting
  endpoints, exhausting quotas, or attempting to reach the host API.
- A malicious or compromised Cloudflare coordination plane trying to read endpoint metadata,
  substitute keys, replay stale state, add routes/capabilities, or redirect peers. It may
  still delay or deny coordination; preventing control-plane denial of service is impossible.
- A stolen or compromised paired remote. It has the explicitly granted full Waifus-admin
  rights until revoked, including confirmed trust expansion, but it cannot rotate the host
  identity or change local host network/filesystem exposure.
- A malicious paired host serving hostile dashboard JavaScript to a remote that also manages
  other hosts. Each host dashboard must be origin/cache/session isolated.
- A supply-chain attacker replacing a helper binary, manifest, or old vulnerable version.
- Accidental exposure through logs, errors, diagnostics, assistant transcripts, browser
  origins, or future API routes.

The design does not claim to withstand a fully compromised local operating-system account or
administrator on either device. Such a process can inspect memory, drive the official binary,
or access user-scoped key stores. OS vaults, file permissions, helper isolation, and private
source protect data at rest and reduce accidental exposure; they are not remote attestation.

A malicious trusted remote is authorized to perform remotely allowed administrative actions.
The host must therefore provide immediate local revocation and a local-only identity-recovery
path. A malicious trusted host can administer only itself and must not gain browser/session
access to another remembered host on the same remote device.

## Current architecture and prerequisites

Discord Waifus is currently a single local Node 20+ TypeScript ESM application. Fastify
serves both the local REST/SSE API and the bundled React/Vite dashboard. The Discord runtime,
storage, migrations, orchestration, and assistant all live in that host process. The
dashboard uses same-origin HTTP and SSE; it does not currently depend on a dashboard
WebSocket.

The existing API is trusted-local-only and is not safe to expose merely by changing its bind
address. Before remote parity ships, the implementation must:

- Add an authenticated request principal and strict Host/Origin/CSRF handling.
- Whenever remote access is enabled, require Fastify's effective bind to be loopback and
  accept remote principals only through authenticated helper IPC.
- Replace the generic `StorageConflictError.latest` response with a redacted conflict DTO.
  Current credential or Discord-bot conflicts must never return stored key/token fields.
- Audit `/api/events`, logs, captured model queries/replies, diagnostics, status, and config
  responses for secrets and host-only filesystem/network fields.
- Make credential reads status-only; stored API keys and Discord tokens remain write-only.
- Add remote mutation idempotency and an administrative audit trail.
- Require every Fastify route to declare one reviewed remote policy: `full_admin`,
  `local_only`, or `never_proxy`. Route registration/CI fails when the policy is missing.
  Transparent proxying does not imply authorization for future routes.

These are release blockers, not optional follow-up hardening.

## Locked product decisions

- **Remote mode:** `waifus remote` runs a local gateway and browser UI but no Discord runtime.
- **Parity:** a trusted remote is a full Waifus administrator for every route deliberately
  classified `full_admin`. Host identity reset and host network-exposure controls remain
  local-host-only.
- **Pairing:** both devices are online; the local host or an already trusted administrator
  creates a one-time invitation and approves the joining device's exact identity bundle and
  fingerprint through an actor-bound confirmation. An existing trusted remote may therefore
  enroll another remote, and every such action is audited.
- **Trust lifetime:** a paired device stays trusted across restarts until revoked.
- **Data path:** direct encrypted WireGuard traffic only. No fallback relay.
- **Coordination:** `pair.waifucave.com` remains available after pairing for presence and
  changing endpoint metadata. It never receives management payloads.
- **Dashboard versioning:** the remote downloads and locally serves the host's own dashboard
  build. Host and remote application versions need not match.
- **Networking implementation:** public full-repository Tailscale fork plus a private
  WaifuCave connector/helper.
- **Source builds:** supported. They download the same signed binary-only packages used by
  the published npm installation.
- **Infrastructure:** launch on Cloudflare Workers Free plus SQLite-backed Durable Objects;
  design for a later paid-plan transition without a protocol break.

## Repository and package topology

### `waifucave/discord-waifus` — public

Owns the CLI, Fastify host integration, local remote gateway, React dashboard, shared Zod
schemas, storage metadata, assistant tools, documentation, and tests. It depends on
`@waifucave/gateway` as it does today and selects the correct `ts-connect` binary package for
the current platform.

### `waifucave/gateway` — public

Remains the LLM/provider gateway. It receives no peer-to-peer networking responsibility.

### `HeavenllyDemon/tsnet` — public

A true GitHub-network fork of the complete `tailscale/tailscale` repository. The target is
currently unused. Preserve upstream history, the BSD-3-Clause `LICENSE`, `PATENTS`, source
headers, and required third-party notices. Keep the upstream `tailscale.com` module identity
where practical and pin every WaifuCave build to an exact reviewed upstream commit.

The maintained delta should stay narrow:

1. Expose a supported production seam for a WaifuCave `controlclient.Client` implementation.
2. Add an explicit direct-only mode whose data plane structurally omits DERP packet routes.
3. Accept endpoint/network-map updates from the WaifuCave control client.
4. Expose sanitized direct-path, rebind, STUN, and connectivity state.
5. Add test hooks and invariants proving no application packet can use DERP.

The fork/helper must also fail closed unless the WaifuCave control client is explicitly
installed. Disable the stock Tailscale control URL fallback, logtail/support-log uploads,
telemetry, auto-update, SSH, Serve/Funnel, SOCKS/HTTP proxy, LocalAPI, DNS, exit/subnet routes,
peer relays, and every unused service surface. The permitted egress classes are only:

- `pair.waifucave.com` coordination.
- Explicitly configured STUN discovery.
- PCP/NAT-PMP/UPnP to the local gateway.
- Bounded probes and encrypted traffic to an already approved peer's validated candidates.

Tests must fail on any undeclared Tailscale SaaS or Internet-service egress.
The upstream default control/logging behavior is documented in the current
[`tsnet.Server` API](https://pkg.go.dev/tailscale.com/tsnet), so disabling it is an explicit
fork acceptance criterion rather than an environment-only convention.

Do not put WaifuCave server secrets or the private Worker protocol in this fork. Describe it
as an unofficial Discord Waifus-specific fork and never imply Tailscale endorsement.

### `waifucave/ts-connect` — private source

Owns:

- The Go `ts-connect` helper executable.
- The WaifuCave pair-scoped, host-centered control client.
- The direct-only application service built on the public fork.
- The ordinary HTTPS/hibernating-WebSocket protocol used with `pair.waifucave.com`.
- Cloudflare Worker and Durable Object implementation.
- Platform build, signing, notarization, and binary-package publishing workflows.

The repository may remain private as an additional barrier against casual copying, but its
secrecy is not an authorization boundary. The distributed binary can be inspected or driven
by an attacker. Actual Cloudflare secrets live only in Cloudflare secret storage and never in
Git or the binary.

The helper imports normal `tailscale.com/...` package paths and pins the public fork through a
reviewed Go module replacement/vendor lock at one exact fork commit. The public, versioned
contracts between repositories are the Node-helper IPC protocol, dashboard manifest,
capability/version model, binary manifest, and coordination semantics. The concrete
Cloudflare wire encoding may remain private but must implement those documented semantics.

### Binary-only npm packages — public

The private build publishes target-specific packages such as:

- `@waifucave/ts-connect-darwin-arm64`
- `@waifucave/ts-connect-win32-x64`
- `@waifucave/ts-connect-win32-arm64`
- `@waifucave/ts-connect-linux-x64`
- `@waifucave/ts-connect-linux-arm64`
- `@waifucave/ts-connect-linux-armv7`

`@waifucave/discord-waifus` references these as optional platform dependencies so npm and
source checkouts install one relevant binary rather than every target. No install-time secret
is provisioned by npm.

The initial target triples are exactly `darwin/arm64`, `windows/amd64`, `windows/arm64`,
`linux/amd64`, `linux/arm64`, and `linux/arm/v7`. Linux helpers are built with
`CGO_ENABLED=0` and smoke-tested on representative glibc and musl distributions. Each package
declares matching npm `os`/`cpu` metadata, an exact helper version, protocol/capability fields,
and signed checksums. Unsupported architecture or an unavailable optional package produces an
actionable error rather than downloading an arbitrary fallback. Signing-key rotation uses an
old-and-new overlap manifest; downgrade below the host/remote minimum is rejected.

## Component topology

```text
Remote browser
    | localhost HTTP/SSE, tokenized browser session
    v
Discord Waifus remote gateway
    | OS-protected local IPC
    v
remote ts-connect
    || authenticated direct WireGuard/application stream only
    v
host ts-connect
    | OS-protected local IPC + per-launch capability
    v
Host Fastify at 127.0.0.1:3888
    |
    +-- existing storage, Discord runtime, orchestration, assistant, bundled dashboard

remote ts-connect <---- coordination metadata only ----> pair.waifucave.com
host ts-connect   <---- coordination metadata only ----> pair.waifucave.com
```

The helper is application-scoped. It does not install a system VPN or route unrelated device
traffic. The host helper accepts only the Waifus service; the remote helper exposes only the
local gateway-to-host service.

Node does not accept a helper-supplied principal header on the ordinary loopback Fastify
listener. Host integration uses a second versioned, framed request/stream/cancel protocol over
a mode-`0600` Unix-domain socket on macOS/Linux or a current-user ACL Windows named pipe. The
connection also proves a random capability delivered through an inherited pipe at launch.
Node derives the remote principal from that authenticated IPC connection and injects it into
Fastify as internal request metadata. The public loopback listener strips/rejects all internal
principal fields. Same-user compromise remains outside the threat model, but a website or
ordinary loopback HTTP caller cannot forge a remote identity.

### Multi-device topology

The overlay is a host-centered star, not a general tailnet:

- A remote's local map contains only itself and its selected host.
- A host may know all of its approved remotes, but exposes only one Waifus service to each.
- Remotes never receive another remote's node key, candidate envelope, address, or route.
- Remote-to-remote forwarding and discovery are structurally disabled.
- Pair-control keys, endpoint generations, revocation/trust epochs, and ACL entries are
  independent per host/remote pair.
- Stable collision-free userspace overlay addresses derive from a host-specific ULA prefix
  plus approved device IDs; they never become OS routes. The application addresses the host
  by pinned peer/service identity rather than accepting arbitrary overlay destinations.

## Host lifecycle

Remote access is opt-in.

1. `waifus start` continues to start the existing backend and dashboard.
2. Enabling or starting remote access first verifies that Fastify's effective bind is
   loopback and that the bundled dashboard directory is active. The legacy explicit
   non-loopback bind and custom dashboard-directory modes remain available when remote access
   is disabled, but are mutually exclusive with remote access in v1; validation returns an
   actionable error without silently rewriting either setting.
3. When remote access is enabled, the backend supervises the platform `ts-connect` helper.
4. Node passes configuration and a random per-launch IPC capability through an inherited
   pipe or OS-protected channel, never command-line arguments or logs.
5. The helper restores its persistent device identity, reconnects to coordination, and
   advertises the Waifus service.
6. The host Node process is the sole supervisor. It restarts a failed helper with bounded
   backoff. Loss of the authenticated parent pipe makes the helper exit, so a crashed Node
   process cannot leave an orphan helper accepting connections. A user or platform service
   manager restarts Waifus itself; the next launch restores identity and reconnects.
7. Disabling remote access returns an acknowledgement, drains active operations, closes
   tunnels, and stops endpoint publication without deleting trusted devices.

Remote access state appears in `waifus status` and the dashboard. `waifus doctor` validates
the binary, signature, version, control connectivity, STUN, UDP, port mapping, and direct
path without displaying secrets or raw endpoint addresses by default.

## Remote lifecycle

1. `waifus remote` verifies and starts the target-specific helper and a separate remote
   gateway daemon for the selected data root.
2. It starts a random-port loopback gateway, opens a tokenized browser URL, and returns after
   the daemon is healthy. `--foreground` keeps it attached for development; `--no-open`
   suppresses browser launch; `--host <id-or-name>` selects a remembered host; `--port`
   requests a loopback port; and normal data-root options/environment continue to apply.
3. Before a host is selected or connected, the gateway serves a small bundled connection
   shell.
4. First use accepts either the full invitation link/token or the short-code flow described
   below. If there is one remembered host, later launches connect automatically; with
   multiple hosts the shell shows a selector.
5. After direct authentication, it checks the host dashboard manifest, downloads any missing
   assets, and loads the host dashboard locally.
6. `waifus remote status` and `waifus remote stop` operate only on the remote daemon.
   Existing `waifus stop` remains host-server-only. `waifus status` summarizes both when they
   coexist. Host and remote modes use distinct PID/socket/log state and may run simultaneously
   on one device.

The remote Node gateway daemon is likewise the sole supervisor of its helper. The helper
exits when its authenticated parent channel closes; only the user or platform service manager
restarts a stopped gateway daemon.

## Device identity, activation, and storage

Each data root creates an independent installation identity and long-lived keys inside
`ts-connect`:

- An installation/device signing key used for coordination requests.
- The Tailscale/WireGuard-derived node and discovery keys required by the direct runtime.
- A locally generated recovery/trust epoch.

The installation key signs a device identity bundle binding the canonical data-root-scoped
device ID, role, trust epoch, WireGuard node key, discovery key, and monotonic key sequence.
Pair approval pins this entire bundle, not a display fingerprint detached from transport
keys. The application stream performs an installation-key challenge (or validates a narrowly
certified session key) above WireGuard before Node receives a principal. Node/discovery key
rotation requires a monotonic cross-signature from the pinned installation key; installation
key rotation requires fresh approval.

Private keys are owned by the helper, not readable through the Node API, and stored using:

- macOS Keychain where available.
- Windows DPAPI/Credential Manager-protected storage.
- Linux Secret Service where available, with a mode-`0600` private-file fallback and clear
  diagnostics when the fallback is used.

Keychain/DPAPI labels derive from an installation ID stored under the canonical data root so
multiple `DC_WAIFUS_HOME` values do not share identities accidentally. Trusted-host metadata,
remote daemon state, and dashboard caches are also partitioned by data root.

Node stores only revisioned, nonsecret configuration and display metadata. Destroying or
rotating the host identity is a separate local-only reset action; ordinary `clean`, updates,
or restarts must not accidentally rotate it. Existing `waifus clean` leaves remote identity
and pairings intact and reports that fact; only the explicit local remote-access reset removes
them.

### Anonymous activation

Because the product is accountless and open source, no shared embedded key can prove an
"official client." Instead:

1. The first remote-access activation opens a one-time browser Turnstile flow.
2. After server-side validation, the Worker issues an anonymous credential bound to the
   installation public key.
3. Every control request signs the method, route, canonical body hash, protocol version,
   timestamp, and nonce.
4. Normal pairing and endpoint refreshes require no further challenges.
5. Suspicious credential churn or quota abuse may require another Turnstile challenge.

Turnstile proves that a human completed activation, not that the binary is unmodified. This
limitation must remain explicit.

## Pairing protocol

Pairing is attended and fail-closed.

1. The local host helper generates an ephemeral invitation key and at least 128 bits of
   secret material. The secret never goes to Cloudflare.
2. The host registers only an invitation ID, expiry, public identity/ephemeral material, and
   a cryptographic commitment with the Worker. The Worker creates a five-minute room with one
   host, one joiner, bounded guesses, and atomic consumption.
3. The host displays two entry methods:
   - A QR/full copy token consumed by the local `waifus remote` shell. It contains the room ID,
     host key/fingerprint, and full secret. It is not an HTTPS query parameter and is never
     submitted to `pair.waifucave.com`.
   - A short manual lookup code. This has lower entropy and is therefore never authorization
     by itself; it only opens a pending handshake that requires the safety-phrase flow below.
4. The Worker acts as a bounded mailbox for an authenticated Noise handshake. Both signed
   device identity bundles, invitation ID, roles, protocol version, and the complete
   transcript are cryptographically bound. The QR/full-token path mixes its secret as a PSK;
   the short-code path relies on the attended short-authentication-string check.
5. The joining device and the approving host dashboard derive and display the same safety
   phrase plus device name/platform/fingerprint. The approver must be either the local host
   browser or an already trusted remote administrator using its actor-bound secure browser
   session. It compares and approves the exact phrase and pending identity bundle. A mismatch
   or replacement attempt is rejected.
6. Before that approval, neither helper publishes endpoint candidates to the joiner nor sends
   any UDP probe toward joiner-supplied addresses. A guessed short code can create only a
   rate-limited pending request.
7. Approval pins the complete transcript and identity bundle. Each side proves possession of
   its pinned installation key; the Worker cannot substitute a transport/node key without
   invalidating the proof.
8. Only after approval do the helpers exchange signed, encrypted endpoint envelopes and begin
   bounded direct probing.
9. The invitation is atomically consumed and deleted. Failed code guesses eventually destroy
   it.
10. The pair derives an ongoing pair-specific coordination relationship used only for
    endpoint generations and revocation state.

A host may trust multiple remote devices, and a remote installation may remember multiple
hosts. Each invitation still admits exactly one new remote device.

Do not invent a bespoke cryptosystem for the control relationship. Use maintained Go
implementations of standard primitives: an authenticated Noise pattern with independent
ephemeral X25519 keys, the full-token secret mixed as a PSK through HKDF-SHA-256, Ed25519
installation signatures, and AEAD-encrypted endpoint envelopes. Bind pair ID, device roles,
complete identity bundles, transcript hash, protocol version, and endpoint epoch as
associated data. Derive separate keys for coordination encryption, confirmation, and future
rotation; never reuse the invitation secret as a long-lived credential. The implementation
plan must pin the exact Noise pattern/library for both entry methods and receive a focused
cryptographic review before beta.

## `pair.waifucave.com` coordination plane

The launch implementation uses a Cloudflare Worker on `pair.waifucave.com` plus
SQLite-backed Durable Objects. As of the design date, Workers Free supplies 100,000 requests
per day and Durable Objects are available on Free. These limits are a launch assumption, not
a permanent SLA; quota exhaustion may deny new coordination but cannot produce Free-plan
overage charges. See the current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

Durable Objects own atomic invitation and pair state. Hibernating WebSockets provide prompt
endpoint updates without polling continuously. HTTPS reconnect is always available when a
control WebSocket drops.

The control protocol accepts only fixed, versioned message types:

- Installation credential activation/refresh.
- Invitation create, claim, cancel, expire, and consume.
- Pending-device approval/rejection state.
- Encrypted endpoint generation publication and acknowledgement.
- Presence, protocol capability, revocation, and reconnect signals.

It has no arbitrary message, file, room-name, callback, broadcast, destination-connect, or
data-forwarding operation. Control and data code paths use separate types and sockets;
management proxy bytes are accepted only by the direct WireGuard service.

The Worker never emits a generic Tailscale `NetworkMap`. It forwards only the minimal
authenticated Waifus pair DTO. `ts-connect` decrypts and validates that DTO, then constructs a
minimal local userspace map. It hard-rejects DERP, peer-relay, DNS, SSH, Serve/Funnel,
exit-node, subnet-route, arbitrary-service, and unrelated-peer fields even if coordination is
malicious or buggy.

### Data minimization

The Worker stores only what coordination requires:

- Installation public key and anonymous credential metadata.
- Hashed/opaque pair identifiers and protocol versions.
- Short-lived invitation state.
- Fixed-size end-to-end-encrypted endpoint envelopes with monotonically increasing epochs.
- Revocation epochs and quota counters.

It must not log pair secrets, Turnstile tokens, endpoint plaintext, complete device keys,
management request data, prompts, logs, or credentials. Correlation metrics use rotating
keyed hashes where needed.

### Abuse containment

Strict "official Waifus only" detection is impossible while the app is accountless,
open-source, and runs on user-controlled machines. A private helper raises the cost of casual
imitation but cannot change that fact. The service instead makes unrelated use low-capacity
and unattractive:

- Tiny request/body caps enforced before parsing (target 1–2 KiB per control record).
- Exact schemas, fixed candidate counts, and rejection of unknown fields.
- One active invitation per installation and one joiner per invitation.
- Per-installation, per-pair, per-session, coarse IP/ASN, route, and global budgets.
- Signed timestamps/nonces, replay caches, and monotonic endpoint epochs.
- Cloudflare edge rate limiting as a burst shield; Durable Object counters are authoritative.
- Adaptive Turnstile or modest proof-of-work for suspicious new identities.
- A fail-closed emergency switch for new activation/pairing while existing direct tunnels
  continue.

Candidate envelopes are accepted only from an approved, pinned peer and bind the pair,
identity bundle, endpoint epoch, and transcript. Candidate counts, update frequency, packet
sizes, and probe budgets are capped. Reject malformed, multicast, broadcast, unspecified,
and impossible addresses. LAN/private candidates may be tried only after peer approval, using
small authenticated handshake probes with no amplification or application payload.

Even a copied client receives only a tiny two-device endpoint exchange, not generic storage
or a relay.

## Direct transport and Tailscale fork behavior

The official `tsnet` embedding API is Go-only and expects a Tailscale-compatible control
server. Stock Tailscale also starts/falls back through DERP and has no supported strict
per-connection direct-only mode. The current behavior is documented in
[Tailscale connection types](https://tailscale.com/docs/reference/connection-types) and the
open [direct-only feature request](https://github.com/tailscale/tailscale/issues/3624).

Waifus therefore uses the fork, not stock `tsnet`:

- The private helper supplies a custom control client over ordinary Cloudflare-compatible
  HTTPS/WebSockets rather than the stock tailcontrol wire protocol.
- Locally constructed maps omit default DERP regions and advertise STUN-only discovery
  endpoints.
- The data plane has no DERP packet route or peer-relay configuration.
- The helper refuses to open a management stream until both peer identity and a direct path
  are authenticated.
- A path loss pauses/closes the application stream and starts direct reconnection; it never
  switches to a relay.
- Tests and runtime diagnostics assert zero DERP/peer-relay application routes/bytes.
  Observing status after the fact is not accepted as the enforcement mechanism.

### Mandatory fork feasibility gate

The fork may be created publicly to preserve history and begin work, but no production helper
or Discord Waifus dependency may rely on it until an architecture spike demonstrates:

1. Two userspace peers accept the minimal Waifus pair DTO through the custom control seam.
2. They establish the application service with no DERP/peer-relay configuration, connection,
   egress, or bytes.
3. Endpoint changes trigger rebind/STUN/control update and regain a direct path.
4. Revocation closes/refuses the peer without coordination availability.
5. The prototype builds/runs on representative macOS ARM64, Windows, and Linux targets.

The structural absence of a relay data path is the guarantee; tests provide evidence against
regression, not a mathematical proof of every future dependency version. If the spike cannot
meet the invariant, stop and return to design review rather than silently allowing relay
fallback or maintaining an unbounded fork.

V1 uses Cloudflare Realtime's public `stun.cloudflare.com:3478` endpoint for STUN discovery;
Cloudflare currently documents that STUN endpoint as free and unlimited. It never provisions
or uses TURN credentials. Available PCP/NAT-PMP/UPnP mappings also improve reachability. These
mechanisms carry only discovery/mapping packets, never management payload. If STUN is
unavailable, LAN/IPv6/static candidates may still work; otherwise direct setup waits and
reports discovery failure. The Cloudflare control connection coordinates simultaneous direct
probing when endpoint generations change. Revisit provider redundancy if the documented
public STUN availability or terms change. See the current
[Cloudflare STUN FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

## Roaming and recovery state machine

`ts-connect` exposes three user-facing data-path states:

- `direct`: peer authenticated and management traffic is using a direct path.
- `reconnecting`: a formerly usable path is being rediscovered/re-punched.
- `direct_unavailable`: no direct path exists within the bounded attempt window.

Network monitors react to interface, default-route, address, suspend/resume, and meaningful
link changes:

1. Rebind the UDP socket when required.
2. Re-run STUN and port-mapping discovery.
3. Publish a signed, monotonic endpoint generation.
4. Receive the peer's latest generation.
5. Probe viable address pairs simultaneously and select the best direct path.
6. Re-authenticate the application service and resume the proxy.

The runtime uses bounded exponential backoff with jitter, direct-path keepalives, health
probes, and immediate wake/network-change triggers. Stable peer identities and logical
service addresses survive process and endpoint changes.

Honest availability contract: Waifus automatically recovers whenever a direct path becomes
possible. If UDP is blocked or both peers are behind incompatible hard NAT/firewall behavior,
the host remains offline until conditions change. "Never relay" takes precedence over
availability.

## Dashboard delivery and version compatibility

The remote does not stream the host's pixels and does not assume its locally installed
dashboard matches the host.

1. The remote connection shell requests a signed/authenticated dashboard manifest containing
   the host build ID, asset hashes, API version, transport protocol major/minor, capabilities,
   minimum helper version, minimum remote-gateway version, and required proxy capabilities.
2. The gateway reuses immutable assets already cached for that host/build.
3. Missing HTML, JavaScript, CSS, fonts, and images are downloaded through the direct tunnel,
   hash-verified, and served to the browser from loopback.
4. The browser runs the dashboard locally. Only API calls and live streams continue through
   the direct proxy.
5. `index.html` and sensitive bootstrap data are revalidated/no-store; hashed static assets
   may be cached.
6. If the host updates mid-session, the connection drains/restarts, the build ID changes, and
   the remote reloads the matching dashboard.

`npm run build:frontend` must generate this manifest alongside `dist-frontend`. Each immutable
entry contains an allowlisted relative path, byte size, SHA-256, and content type. The gateway
rejects traversal, absolute paths, symlinks, undeclared assets, size overruns, duplicate paths,
and hash mismatches. It downloads to a temporary host-key/build-key directory and atomically
renames only after full verification. Cache entries are partitioned by pinned host key and
build ID and never shared across hosts. Initial safety caps are 16 MiB per asset, 64 MiB per
dashboard build, two builds per host, and 256 MiB globally, with LRU eviction; exceeding a cap
fails clearly rather than executing a partial build.

Remote access v1 serves only the bundled `dist-frontend` build with its generated manifest.
If `frontend.staticDir` resolves to a custom directory, remote access refuses to enable or
start and reports how to restore the bundled dashboard. Supporting signed/manifested custom
dashboard builds is a later capability, not an implicit trust of arbitrary host files.

Vite output must use a remote-compatible base/asset contract: manifest-declared root-relative
asset URLs are resolved by the local gateway, SPA navigation receives the verified
`index.html`, and redirects can never escape the selected local origin.

The local connector is deliberately an opaque streaming proxy. It does not need to know new
settings, route schemas, or SSE event types.

Every dashboard build also calls `GET /api/client-context`. On the host it returns
`{ mode: "host" }`; the remote gateway intercepts it locally and returns sanitized remote
transport state plus the selected host ID. This lets the same host-supplied bundle render the
connection banner without injecting or rewriting executable JavaScript.

- Same transport major: negotiate optional minor capabilities, then require both manifest
  minimum versions and every required proxy capability before downloading/executing assets.
- Different transport major: refuse safely with `Remote connector update required`.
- New host + older compatible remote: download the new host UI and work normally.
- Old host + newer remote: download the old host UI and expose only old-host features.

An unknown required capability fails closed even when the transport major matches. The
coordination service maintains a documented compatibility window rather than breaking all
older installations at each release.

## Remote HTTP/SSE gateway

The remote gateway binds only loopback on a random port and launches a high-entropy,
per-host `*.waifus.localhost` name plus a tokenized browser URL. It establishes a host-only
(`Domain` absent), `HttpOnly`, `SameSite=Strict`, short-lived session cookie, rotates the
session, and removes the token from the visible URL. It enforces the exact Host and Origin,
rejects cross-site requests and DNS rebinding, and applies its own restrictive CSP,
Permissions Policy, and `Referrer-Policy: no-referrer`.

It may proxy only:

- The selected paired host's dashboard manifest/static assets.
- Same-origin `/api` traffic to that selected host.
- Required streaming/upgrade semantics supported by the host dashboard.

It cannot select arbitrary destinations or become a general HTTP/SOCKS proxy. The browser
never connects directly to the host, WireGuard address, or Cloudflare coordination socket.

Proxy parity includes methods, query strings, request/response streaming, cancellation,
status codes, safe headers, binary bodies, uploads/downloads, and SSE. Hop-by-hop headers,
host filesystem paths, and helper-internal headers are stripped.

Treat host-supplied dashboard code as isolated web content even though the host is paired:

- One host/session uses one unguessable hostname/origin; switching hosts creates a new origin.
- Cookies, local/session storage, in-memory credentials, and asset caches are never shared
  across host keys. Revoke/forget/switch closes the old listener and clears that origin's
  sensitive state.
- The gateway strips host `Set-Cookie`, CORS, CSP, service-worker, and unsafe redirect headers;
  rewrites safe same-host redirects to the local origin; and supplies its own policy headers.
- `worker-src 'none'` and asset allowlisting prohibit service-worker persistence.
- Browser egress is limited to the same local origin; all API connectivity must pass through
  the authenticated gateway.

### Gateway-owned local API

Reserve `/_waifus_remote/v1/*` for the connection shell. These routes are served locally and
are never proxied to a host:

| Method | Path | Purpose |
|---|---|---|
| GET | `/_waifus_remote/v1/bootstrap` | Gateway/helper versions, local session, selected host, and sanitized state. |
| GET | `/_waifus_remote/v1/hosts` | Remembered hosts for this data root. |
| POST | `/_waifus_remote/v1/pair` | Begin the full-token or short-code pairing flow. |
| POST | `/_waifus_remote/v1/hosts/:hostId/connect` | Select/connect a pinned host. |
| POST | `/_waifus_remote/v1/hosts/:hostId/disconnect` | Disconnect without forgetting trust. |
| DELETE | `/_waifus_remote/v1/hosts/:hostId` | Forget locally; request signed self-revocation first when reachable. |
| GET | `/_waifus_remote/v1/events` | Stream-epoch/cursor-aware local connection events. |

They require the exact local browser session and CSRF protection. Pair tokens are accepted
only by `/pair`, passed directly into helper memory, and never logged, persisted in browser
storage, or forwarded as ordinary host HTTP.

## Request principals, authorization, and audit

The host helper authenticates the WireGuard/device peer before accepting an application
stream. Each request has one stable actor principal:

- `local` from the ordinary loopback listener, with optional browser-session/CSRF context, or
- `remote_device` with device ID, pinned peer-key fingerprint, session ID, and current trust
  epoch.

Assistant use is delegation provenance layered onto that actor, never an alternative
principal. It adds conversation/tool/action identifiers while retaining the initiating
local/remote actor.

This preserves the existing same-machine automation contract: a local process may call the
loopback API directly and is inside the documented local-user trust boundary. Browser requests
must additionally satisfy exact Host/Origin and CSRF rules. `local_only` means the request
arrived through that loopback/local control boundary, never through remote helper IPC;
security-sensitive confirmation cards additionally require the bound local browser session.

Never trust a client-supplied `X-Device-*` header. The helper and Node use a per-launch
capability or authenticated IPC envelope that cannot be supplied through the public HTTP
surface.

A trusted remote receives every route deliberately classified `full_admin`. Exceptions:

- Host identity rotation/reset is local-host-only.
- Changing host-bind or filesystem-serving fields such as `http.host` and
  `frontend.staticDir` is local-host-only even when other app config fields are `full_admin`;
  any effective non-loopback bind or custom static directory prevents remote access from
  enabling or starting in v1.
- Pairing secrets and destructive remote-access confirmations must pass through secure UI
  surfaces, not the assistant model transcript.

Every mutation records an administrative audit event containing actor type/device,
local-versus-remote origin, assistant conversation/tool when applicable, action/resource,
request/idempotency ID, before/after revision, outcome, and timestamp. It never records
request bodies, credentials, tokens, pair codes, endpoint candidates, prompts, or private
keys.

Authorization rechecks the current local trust/revocation epoch when opening a stream, on
each request, when an assistant tool executes, and again when a confirmation action is
consumed. Revocation cannot be bypassed by an existing browser session, conversation, queued
tool, cached action, or old endpoint generation. Internal `app.inject` calls must supply the
inherited actor explicitly; missing internal actor metadata is an error, never a fallback to
local admin.

## Safe retries and live streams

Every mutating route receives a reviewed retry class. The remote gateway assigns one stable
`Idempotency-Key` and preserves it across reconnects; the host scopes it to stable device ID,
trust epoch, route, and canonical streaming body hash, not the transient connection/session.

- **Transactional retry:** local state changes that can durably record the operation ID with
  the mutation (using the storage transaction/intent mechanism) may return the recorded
  result on the same key/body. Same key with a different body is `409 Conflict`.
- **Reconciled operation:** long-running or external effects first create a durable operation
  resource. After interruption, the host queries/reconciles actual state before continuing
  and returns the same operation ID.
- **Non-replayable/unknown outcome:** an effect that cannot be reconciled atomically is never
  retried automatically. The UI reports `outcome_unknown`, refreshes observable state, and
  requires an explicit user decision before another attempt.

Revision/`If-Match` checks remain mandatory where applicable. Destructive writes are never
replayed under a new actor/trust epoch. The durable ledger is bounded by TTL, entry count, and
result size; large/secret responses are not copied into it.

Invitation creation uses a dedicated creator-bound recovery rule rather than the generic
ledger. The host helper retains the active invitation secret only in protected local
invitation state until expiry/cancellation. A retry with the same idempotency key from the
same still-authorized principal may retrieve that same invitation; general status and other
principals cannot. If recovery is impossible, return an explicit uncertain result and
cancel/recreate only after user confirmation—never create a second invitation silently.

Runtime shutdown or remote-disable sends its accepted acknowledgement/operation ID before
draining the connection.

SSE cursors are `{ streamEpoch, sequence }`, not a process-local integer alone. Replay is
bounded, authorization-filtered, and passed through the same redaction policy as live events.
An epoch mismatch or unrecoverable cursor gap forces a canonical snapshot before
resubscription. Reads refresh after reconnect. The local UI remains open with a
`Connected directly`, `Reconnecting`, or `Direct connection unavailable` banner.

## Host local API

Implement the routes in a dedicated remote-access module backed by a `RemoteAccessService`
that communicates with local `ts-connect` IPC. Put strict Zod contracts in
`src/shared/schemas/remoteAccess.ts` and mirror them in the frontend according to current
project conventions.

| Method | Path | Remote policy | Purpose |
|---|---|---|---|
| GET | `/api/remote-access` | `full_admin` | Redacted config/status, device identity fingerprint, helper/control/direct state, build and protocol capabilities. |
| PUT | `/api/remote-access` | `full_admin` | Revisioned enable/disable and nonsecret display configuration. First enable still requires the local activation flow. |
| GET | `/api/remote-access/dashboard-manifest` | `full_admin` | Build ID, immutable asset hashes, API/transport versions, minimum versions, and required capabilities. |
| POST | `/api/remote-access/invitations` | `full_admin` | Create a short-lived invitation through a secure browser action; `201` and `Cache-Control: no-store`. |
| DELETE | `/api/remote-access/invitations/:inviteId` | `full_admin` | Cancel an invitation created by the same actor, or by another administrator after confirmation. |
| GET | `/api/remote-access/pairing-requests` | `full_admin` | Pending device names/platforms/identity fingerprints and expiry. |
| POST | `/api/remote-access/pairing-requests/:requestId/approve` | `full_admin` | Confirm and approve the exact pending transcript/identity bundle/generation. |
| POST | `/api/remote-access/pairing-requests/:requestId/reject` | `full_admin` | Reject the request. |
| GET | `/api/remote-access/devices` | `full_admin` | Redacted trusted-device list and connection status. |
| PUT | `/api/remote-access/devices/:deviceId` | `full_admin` | Revisioned rename/display metadata update. |
| DELETE | `/api/remote-access/devices/:deviceId` | `full_admin` | Revoke and immediately disconnect locally. |
| POST | `/api/remote-access/reconnect` | `full_admin` | Force endpoint rediscovery/direct reconnection. |
| GET | `/api/remote-access/diagnostics` | `full_admin` | Sanitized helper, control, STUN, port-mapping, and path diagnostics. |
| GET | `/api/remote-access/events` | `full_admin` | Stream-epoch/cursor-aware remote-access state changes. |
| POST | `/api/remote-access/reset` | `local_only` | Typed confirmation; rotate identity and remove all pairings. |

Invitation secrets appear only in the creator-bound creation/idempotent-recovery response
during that invitation's lifetime and are never placed in general status, logs, events,
diagnostics, audit, or assistant tool results. Sensitive responses use `no-store`.

The existing `GET /api/diagnostics/bundle` gains only a sanitized remote-access section.
Add `GET /api/client-context` for the same dashboard bundle's host-versus-remote bootstrap
state; it contains no key, address, capability token, or pairing secret.

Every existing and future route receives the same policy metadata. A route-inventory test
compares the registered Fastify surface with the reviewed policy manifest and fails on any
unclassified route. The host enforces policy after principal authentication; the remote
gateway's transparent `/api` forwarding is not the authorization boundary.
Routes with mixed-sensitivity bodies/responses additionally declare principal-aware field
policies. In particular, remote app-config reads/writes redact or reject host bind paths,
absolute data roots, and static-directory fields while preserving ordinary configuration
parity.

## Dashboard assistant capabilities

The current assistant executes tools through the app's own Fastify routes with `app.inject`.
Remote-access tools keep that pattern so Zod validation, revisions, idempotency, audit, and
authorization remain centralized.

Add:

- `get_remote_access_status`
- `set_remote_access_enabled`
- `request_remote_pairing_invite`
- `cancel_remote_pairing_invite`
- `list_remote_pairing_requests`
- `approve_remote_pairing_request`
- `reject_remote_pairing_request`
- `list_remote_devices`
- `rename_remote_device`
- `revoke_remote_device`
- `reconnect_remote_access`
- `get_remote_access_diagnostics`

Extend the current assistant plumbing before adding the tools:

- `ConversationStore` binds an immutable owner actor/trust epoch when a conversation is
  created; conversation reads, messages, streams, and deletion authorize that actor.
- `AssistantToolContext` carries the current actor plus conversation/tool delegation
  provenance rather than only `{ app }`.
- Every `app.inject` supplies that internal actor metadata and passes the same route-policy
  checks as network calls.
- Add a typed `confirmation_required` SSE event and a server-held pending-action store.

An assistant invocation from a remote browser therefore remains attributable to that remote
device and cannot silently become a local-host principal. If the device is revoked or its
trust epoch changes, its conversations, queued tools, and pending actions stop authorizing.
Tool definitions are principal-aware: host identity reset remains omitted from a remote
conversation's callable tool set. Pairing and trust-expansion tools remain available to a
trusted remote administrator but can complete only through the actor-bound secure browser
actions below.

### Secure assistant actions

Pairing and trust actions need server-enforced UI confirmation rather than prompt-text-only
confirmation:

- `request_remote_pairing_invite` emits a secure dashboard-card request. The browser calls
  the invitation API using the initiating local or trusted-remote actor and its bound browser
  session, then displays the code/QR directly; no secret enters the model transcript.
- Enabling/disabling access, approving a device, and revoking another device produce a
  one-time confirmation card bound to actor, exact action, resource, payload hash, and a
  short expiry.
- The browser confirms the stored action directly. The model cannot approve its own request
  or substitute a different target.
- Rejecting a pending request, cancelling one's own invitation, reconnecting, reading status,
  and renaming display metadata require an explicit user request but no destructive
  confirmation. Cancelling another administrator's invitation uses the bound confirmation
  flow.
- Remote identity reset is not an assistant tool.

Implement pending assistant actions as a generic, server-held resource rather than putting
the intended mutation in model-controlled browser data:

- `GET /api/assistant/actions/:actionId` returns the sanitized confirmation summary only to
  the originating browser principal/session.
- `POST /api/assistant/actions/:actionId/confirm` atomically executes the already stored exact
  action once.
- `DELETE /api/assistant/actions/:actionId` cancels it.

Action IDs are high entropy, short-lived, principal/session-bound, single-use, and protected
by the normal browser CSRF controls. The confirmation response goes to the browser and a
redacted receipt may enter the conversation afterward.

Update the assistant system prompt/tool descriptions and add
`docs/assistant-kb/remote-access.md`; update `docs/assistant-kb/api.md`, getting-started, and
troubleshooting documentation.

## Dashboard experience

Add **Settings → Remote Access** with:

- Disabled/enabled lifecycle state.
- Helper and protocol versions.
- Direct/control status and last successful direct connection.
- Enable/disable controls.
- Create/cancel invitation card with QR, copy link, manual code, expiry, and pending joiner.
- Safety phrase/fingerprint approval UI.
- Trusted device list with rename, last seen, current state, and revoke.
- Sanitized diagnostics and reconnect action.
- Local-host-only reset section with a typed destructive confirmation.

When accessed remotely, the same host-supplied view is available except local-host-only
controls are visibly unavailable with an explanation.

## Failure behavior

- **Cloudflare unavailable:** an established direct tunnel continues. New pairing or endpoint
  rediscovery waits and reports `coordination_unavailable`.
- **Free quota exhausted:** existing direct traffic is unaffected; new coordination fails
  closed until quota reset/plan change.
- **Host offline:** remote shell remains available and reports the remembered host offline.
- **Direct path lost:** live requests fail/queue according to their safe retry class; the
  connector enters `reconnecting` and republishes endpoints.
- **Hard NAT/UDP blocked:** enter `direct_unavailable`; never relay.
- **Helper crash:** supervisor restarts it with the same identity and bounded backoff.
- **Corrupt identity/trust state:** fail closed and require explicit recovery; do not silently
  replace the identity.
- **Dashboard hash failure:** delete the partial cache and retry; never execute an asset whose
  manifest hash failed.
- **Protocol major mismatch:** refuse management traffic and display the required connector
  update.
- **Host update mid-operation:** drain where possible, reconnect, download the new build, and
  recover each operation according to its recorded retry class/idempotency ID; unknown
  external outcomes are never repeated automatically.
- **Device revoked while coordination is down:** the host immediately and durably removes
  local trust and closes/refuses the peer. Publishing the revocation to Cloudflare is eventual
  on coordination reconnect. A revoked device may retain stale endpoint ciphertext, but it
  cannot authenticate to the host or obtain new authorized state.

## Security and privacy tests

### Node/API

- Principal creation and propagation through helper IPC, Fastify, assistant conversations,
  and `app.inject` tools.
- Host/Origin/CSRF/DNS-rebinding protection for both local servers.
- Unauthorized peer, revoked peer, stale session, forged-header, and replay rejection.
- Invitation racing, code-guess caps, expiry, atomic consume, and exact-key approval.
- Full-token PSK and short-code safety-phrase flows, transcript/key-bundle binding, and no
  pre-approval endpoint probing.
- Retry-class inventory; transactional replay, reconciled operations, unknown-outcome
  handling, and invitation-specific recovery across reconnect/restart boundaries.
- Redaction goldens for every error class, especially storage conflicts.
- Credential/token absence from status, events, logs, diagnostics, audit, and assistant output.
- Remote/local-only authorization boundaries.
- Registered-route versus remote-policy-manifest completeness.
- Existing-data-root migration, multiple independent data roots, helper missing/corrupt, and
  `clean` versus explicit reset semantics.

### Fork/helper

- Compile-time/configuration tests that direct-only mode has no DERP data route.
- Runtime counters/assertions proving zero DERP/peer-relay application bytes.
- Custom control-client minimal-DTO update and rejection of generic Tailscale
  DERP/route/DNS/SSH/Serve/Funnel/peer-relay fields.
- Egress tests allowing only WaifuCave coordination, configured STUN, local port mapping, and
  approved-peer candidates; stock Tailscale control/logtail/telemetry never appears.
- WireGuard peer/installation-key bundle pinning, star-topology isolation, rotation, and
  application-service isolation.
- Helper IPC authentication, permissions, crash cleanup, and secret-free logs.
- Signed binary/manifest verification and downgrade protection.

### Network simulation

- Direct LAN, public IPv4, public IPv6, typical NAT, and port-mapped paths.
- Wi-Fi to cellular/hotspot transitions and simultaneous endpoint changes.
- Suspend/resume, route changes, packet loss, reordering, latency, and UDP socket rebinding.
- Cloudflare/control disconnection while direct data remains active.
- Hard NAT and UDP-blocked cases proving deterministic failure without relay.

Use Linux network namespaces/netem for reproducible transport cases plus real macOS, Windows,
and Linux end-to-end smoke tests.

### Dashboard/proxy

- Host dashboard manifest/hash cache and mid-session version update.
- New-host/old-remote and old-host/new-remote fixtures, including required-capability failure.
- Full route parity, uploads, downloads, binary responses, cancellation, and SSE resumption.
- Secure assistant cards that keep invitation secrets and confirmation tokens out of model
  transcripts.
- Per-host hostname/session/storage isolation against a malicious dashboard; CSP/header
  override, service-worker rejection, cache traversal/symlink/size exhaustion, and revoke/
  switch cleanup.

### Packaging

- Clean npm installation selects exactly one target helper.
- Source checkout installs and verifies the identical binary.
- macOS signing/notarization, Windows Authenticode, and cross-platform signature manifests.
- License and third-party notice inclusion for the statically linked helper.
- `waifus doctor` reports actionable errors for missing, invalid, or incompatible helpers.

### Test ownership

- `waifucave/discord-waifus`: Vitest for schemas, routes, principals, proxying, assistant,
  cache, CLI, and storage; existing `npm run test`, `npm run typecheck`, and `npm run build`
  remain required.
- `HeavenllyDemon/tsnet`: focused Go unit/integration/race tests for the control seam,
  direct-only enforcement, map construction, egress, and upstream compatibility; run the
  applicable upstream Go suite and license checks.
- Private `waifucave/ts-connect`: Go helper/IPC/crypto tests plus Cloudflare Worker/Durable
  Object tests using the supported Workers test runtime.
- Privileged Linux CI: netns/netem NAT/roaming/failure matrix.
- Per-OS release CI: signed-artifact launch/install/pair smoke tests for every exact target,
  plus N-1/current compatibility and rollback fixtures.

## Implementation and release order

0. **Contract/threat-model lock:** version the IPC, pair DTO, identity bundle, dashboard
   manifest, route policy, capability model, retry classes, exact target matrix, and test
   fixtures before parallel repository work.
1. **Existing security baseline:** fix current redaction/conflict leaks and add generic route
   policy, actor, audit, retry-operation, and SSE cursor primitives without remote exposure.
2. **Public fork and mandatory spike:** create/publish `HeavenllyDemon/tsnet`, pin upstream,
   implement the narrow custom-control/direct-only seam, and pass the feasibility gate before
   tagging a helper dependency.
3. **Private connector foundation:** create `waifucave/ts-connect`, helper IPC, identity/key
   bundle storage, direct service, development binaries, and signing foundation.
4. **Coordination:** Worker/Durable Object protocol, activation, both invitation flows,
   endpoint epochs, quotas, revocation, and observability.
5. **Host and remote foundations:** remote service, `/api/remote-access*`, CLI daemon,
   gateway-owned API, dashboard manifest/cache, transparent proxy, and reconnect UX.
6. **Dashboard/assistant integration:** settings UI, secure action cards, tools, docs, and full
   route-parity validation.
7. **Cross-platform hardening/release:** network simulation, signed binary packages,
   real-device roaming, security review, and beta release.

Each stage must keep unrelated dirty worktree files untouched. Creating repositories,
deploying Cloudflare, publishing npm packages, or releasing binaries occurs only in the
corresponding implementation stage with explicit target verification.

Production rollout order is backward-compatible Worker first, then signed helper packages,
then `discord-waifus`. Keep the prior Worker protocol/helper packages available through the
documented compatibility window. Rollback reverses the Discord Waifus/helper selection before
removing any Worker protocol version; identity/trust storage migrations require tested
forward/backward recovery.

## Acceptance criteria

The feature is ready for beta only when all are true:

1. A fresh remote device can pair through either approved attended invitation flow and
   becomes trusted only after exact transcript/identity-bundle approval.
2. `waifus remote` loads the host's exact dashboard build and every deliberately remotely
   authorized dashboard/API function works through the direct proxy.
3. Host and remote Waifus versions may differ only when transport major, minimum component
   versions, and required capabilities all negotiate successfully.
4. Switching either device between ordinary networks reconnects automatically whenever a
   direct path is possible.
5. An impossible direct path produces an explicit offline state and zero third-party-carried
   WireGuard packets or management proxy bytes; bounded Cloudflare coordination metadata is
   permitted.
6. Fastify remains loopback-only and rejects forged/untrusted principals.
7. Provider keys, Discord tokens, pair secrets, private keys, and endpoint plaintext never
   appear in forbidden responses/logs/events/assistant transcripts.
8. Every mutation follows its reviewed retry class; retryable operations deduplicate or
   reconcile, and unknown outcomes are never repeated automatically.
9. Device revocation immediately terminates and durably prevents local host access; its
   coordination-plane revocation converges when Cloudflare is reachable.
10. The assistant can diagnose and manage remote access through the same host APIs while
    sensitive actions use browser-enforced confirmation.
11. Source checkouts and npm installations use verified, identical helper binaries.
12. `darwin/arm64`, `windows/amd64`, `windows/arm64`, `linux/amd64`, `linux/arm64`, and
    `linux/arm/v7` packages install, verify, launch, pair, and pass direct-connectivity smoke
    tests (Linux on representative glibc and musl systems).

## Explicit follow-ups and out of scope

- Intel macOS helper package and validation.
- Mobile/iOS/Android remote clients.
- Relayed fallback of any kind.
- Multi-user roles or reduced-permission remote administrators.
- Tailscale SaaS/OEM or Headscale deployment.
- Remote host-identity reset.
- A browser-only cloud dashboard.
- A claim of universal availability on hostile networks.
