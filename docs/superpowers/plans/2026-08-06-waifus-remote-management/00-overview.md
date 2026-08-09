# Waifus Direct Remote Management — Implementation Plan

> **For agentic workers:** Execute this plan in order. Do not skip a gate, collapse a
> cross-repository boundary, or publish/deploy merely because a local implementation task is
> complete. Re-read `CLAUDE.md`, the repository `AGENTS.md` instructions, and the approved
> [design](../../specs/2026-08-06-waifus-remote-management-design.md) before each phase.

**Goal:** Add `waifus remote`, giving a remembered, explicitly trusted device full parity with
the host's deliberately remote-authorized dashboard and local API over an authenticated,
direct-only peer connection. `pair.waifucave.com` coordinates activation, pairing, presence,
endpoint changes, and revocation metadata over bounded HTTPS/WSS records; it never carries host
application HTTP, dashboard assets, API, SSE, application-WebSocket, or WireGuard data.

**Architecture:** Discord Waifus remains the public Node/React application. A private, signed
`ts-connect` helper runs as a child process in either host or remote mode and embeds a narrowly
forked, direct-only Tailscale userspace data plane. The host authenticates helper IPC and turns
peer requests into explicit Fastify `remote_device` principals. The remote runs a loopback-only
gateway, downloads the host's authenticated/hash-verified dashboard bundle, and serves it on a stable
per-host/local-origin-epoch isolated origin. Cloudflare Workers and Durable Objects store only bounded,
encrypted or opaque coordination records.

**Primary technologies:** Node 20+, TypeScript ESM, Fastify, Zod, React/Vite, Vitest, Go 1.26.5,
Tailscale v1.102.2, WireGuard userspace networking, Noise, Cloudflare Workers, SQLite-backed
Durable Objects, Turnstile, npm optional platform packages, Ed25519 signatures.

## Plan set and execution order

| Phase | Document | Primary repository | Hard dependency |
|---|---|---|---|
| 0–1 | [Contracts and security baseline](./01-contracts-security-baseline.md) | `waifucave/discord-waifus` | None |
| 2 | [Public tsnet fork and feasibility spike](./02-tsnet-fork-spike.md) | `HeavenllyDemon/tsnet` | Frozen v1 contracts |
| 3 | [Private ts-connect helper](./03-private-ts-connect-helper.md) | `waifucave/ts-connect` | Fork gate passed |
| 4 | [Cloudflare coordination and pairing](./04-cloudflare-coordination-and-pairing.md) | `waifucave/ts-connect` | Helper simulator and crypto vectors |
| 5a | [Host API and authenticated bridge](./05-host-api-and-bridge.md) | `waifucave/discord-waifus` | Signed/dev helper protocol available |
| 5b–6 | [Remote gateway, dashboard, and assistant](./06-remote-gateway-dashboard-assistant.md) | `waifucave/discord-waifus` | Host bridge/API available |
| 7 | [Packaging, hardening, and rollout](./07-packaging-release-rollout.md) | All three repositories | Every prior gate |

Phases 0 and 1 land before any remote exposure. After the public contract commit, deterministic
public fixtures, fake-helper app work, and the public fork spike may overlap. Private helper
production scaffolding starts only after the fork feasibility gate passes; a real helper cannot
become an app dependency before that gate.

Within phase 5, plan 06 Tasks 1–4 are shared foundations and may be pulled forward once their
contracts are locked: its signed-helper resolver must exist before a production helper starts,
and its dashboard-manifest Task 3 must finish before plan 05 Task 5 serves that manifest. The
remaining remote-gateway/dashboard/assistant tasks still depend on the secured host bridge/API.

## Global constraints

These requirements apply to every task and override implementation convenience.

1. **Direct data path only.** No DERP, peer relay, TURN, general proxy, callback proxy, exit
   node, subnet router, or cloud-carried management bytes. If direct UDP cannot be established,
   show `Direct connection unavailable` and stop.
2. **Embedded userspace only.** Users install no Tailscale client/daemon, create no Tailscale
   account, and grant no root/admin permission or system TUN interface. `ts-connect` exposes only
   the Waifus application service through the embedded userspace netstack.
3. **Loopback boundaries remain intact.** The host Fastify server and the remote gateway bind
   only to loopback. Enabling host remote access fails if the effective Fastify bind is not
   loopback or if a custom `frontend.staticDir` is active.
4. **No client-held universal secret.** Activation grants a signed, quota-bound credential to
   one installation public key. Copying the credential without that installation private key
   is useless.
5. **A trusted remote is a full administrator.** It may use every reviewed `full_admin` route,
   replace credentials, inspect activity/prompts, control the existing runtime, and—with an
   actor/session-bound confirmation—enroll another remote. Host identity reset and host
   bind/filesystem-serving fields remain local-only.
6. **Parity means the existing product surface.** The current `/api/runtime/stop` aborts a
   channel run; it does not stop the Waifus OS process. This feature does not invent remote
   host-process stop/restart controls.
7. **The host owns UI compatibility.** A remote downloads and locally serves the exact immutable
   dashboard build advertised by the host. Host and remote application versions do not have to
   match when protocol/capability negotiation succeeds.
8. **Authorization is host-side.** Transparent `/api` forwarding never grants access. Every
   Fastify route has reviewed policy metadata, and unknown future routes fail closed.
9. **No secret reflection.** Provider keys, Discord tokens, pair secrets, private keys,
   activation challenges, endpoint plaintext, request bodies, and destructive confirmation
   payloads stay out of errors, conflicts, logs, SSE, diagnostics, audits, and assistant/model
   transcripts.
10. **Revocation is locally authoritative.** The host writes its monotonic deny/trust epoch before
   closing sessions or notifying the helper/control plane. A Cloudflare outage cannot restore a
   revoked device.
11. **No silent replay.** Each mutation follows its reviewed retry class. Unknown outcomes are
    surfaced and require a new explicit decision.
12. **One installation, two roles.** One Ed25519 installation key represents a canonical data
    root. Host and remote helpers have independent role-specific node/discovery/WireGuard keys
    and runtime state so both daemons can coexist without key or state-file races.
13. **Official and source installs use the same helper artifacts.** A source checkout may use an
    unsigned helper path only behind an explicit test/development override with an unsafe
    warning. Production paths always verify the signed platform package.
14. **Preserve unrelated work.** Inspect `git status` before edits and commits. Never stage or
    alter unrelated dirty/untracked files.
15. **Publishing is a separate action.** Creating GitHub repositories, deploying Cloudflare,
    publishing npm packages, pushing tags, or cutting a Discord Waifus release happens only in
    the named stage after verifying the exact target and credentials. Earlier tasks do not
    authorize those external changes.
16. **Control origins are compiled profiles, not URLs.** The same signed helper bytes contain only
    the production `pair.waifucave.com` profile and an explicit local development/release-test
    `pair-staging.waifucave.com` profile, each with its pinned Worker keys. Production is the default;
    Node selects the staging enum only through authenticated IPC under the reviewed test override.
    No argv/environment/arbitrary-origin control setting exists, and only the active profile may be
    contacted.

## Frozen v1 protocol decisions

### Component and compatibility versions

- Public fork base: Tailscale `v1.102.2`, commit
  `eb67e5dcbe145d63e1128b9b4b630f8a82da101f`, built with Go `1.26.5`.
- Pairing library: `github.com/flynn/noise` `v1.1.0`, commit
  `4d9f71cd4ba1fe81415efac312664ccc4bc79b46`.
- Full-token pattern: `Noise_XXpsk0_25519_ChaChaPoly_SHA256`, with a fresh 32-byte PSK and
  fresh invitation-specific Noise static and ephemeral keys.
- Short-code pattern: `Noise_XX_25519_ChaChaPoly_SHA256`.
- Device identity: installation Ed25519 keys sign role identity bundles; they are not reused as
  Noise DH keys.
- Protocol majors are independently versioned for Node/helper IPC, coordination semantics,
  dashboard manifests, helper manifests, and event cursors.
- JSON uint64 values use canonical shortest unsigned decimal strings and JavaScript `bigint`
  arithmetic; they are never represented as JSON/TypeScript `number`. Binary and canonical-CBOR
  uint64 fields keep their fixed native encodings.
- Within one major, minor releases are additive. The Worker supports the current and previous
  control-protocol major for at least 180 days after the newer major reaches GA. Each Discord
  Waifus release carries an exact component-compatibility table; each helper manifest declares
  its minimum and maximum-exclusive compatible Discord Waifus versions; and dashboard manifests
  declare minimum helper/remote-gateway versions plus required capabilities.

### Pair tokens and human verification

- A full pair token is `WF1.` followed by unpadded base64url of canonical CBOR.
- The payload contains version, invitation ID, expiry, host installation public
  key/fingerprint, fresh host pairing public material, a 32-byte secret, and a host signature.
- The QR code contains exactly that token. A full token is accepted only by a secure local form
  or protected interactive stdin; never argv, a URL query, logs, analytics, or durable browser
  storage.
- The short code is eight Crockford Base32 characters, displayed as `XXXX-XXXX`. It is only a
  lookup handle, lasts five minutes, admits one joiner, and has bounded guesses.
- Both devices display the same SAS derived with HKDF-SHA256 from the Noise channel binding,
  pair ID, and canonical identity-bundle hash using label `waifus/sas/v1`. Take 50 bits and map
  them to five words from a checked-in fixed 1,024-word unambiguous English list; also display a
  short hexadecimal fingerprint.
- Approval binds the exact handshake transcript, host and remote identity bundles, invitation
  generation, and actor/session. A SAS mismatch or generation change rejects the join.
- The crypto transcript, canonical encodings, and vectors require an independent review before
  beta. Do not design new cryptography while implementing UI/API tasks.

### Node/helper IPC framing

Node creates a mode-`0600` Unix-domain socket or current-user-only Windows named pipe. The
per-launch capability reaches the child over an inherited descriptor/pipe, never argv or the
environment.

Each frame starts with a 24-byte network-order header:

| Field | Size | Rule |
|---|---:|---|
| Magic | 4 bytes | ASCII `WIPC` |
| Major | 2 bytes | Reject unsupported major |
| Minor | 2 bytes | Negotiate additive capabilities |
| Type | 1 byte | Unknown required type closes fail-closed |
| Flags | 1 byte | Reserved bits must be zero |
| Reserved | 2 bytes | Must be zero |
| Stream ID | 8 bytes | Nonzero for multiplexed request streams |
| Payload length | 4 bytes | Validated before allocation |

Control payloads use canonical JSON and are limited to 32 KiB. Raw data frames are limited to
64 KiB, encoded headers to 16 KiB, and a connection to 128 concurrent streams. Frames include
`hello`, `hello_ack`, `command`, `result`, `event`, `request_start`, `request_chunk`,
`request_end`, `request_cancel`, `response_start`, `response_chunk`, `response_end`,
`response_error`, and `window_update`. Explicit receive windows provide backpressure. Oversize,
duplicate terminal, invalid stream-state, capability-replay, or unknown-type input closes the
affected stream or connection according to the v1 state machine.

IPC multiplexes many streams. Across the direct WireGuard path, v1 opens one authenticated TCP
application connection per HTTP/SSE request and uses the same framed request/response grammar;
it does not add yamux. A path change may break a live stream; cursor replay and reviewed retry
semantics recover above transport.

### Canonical serialization and signed material

- Public contract JSON and signed JSON use RFC 8785 JSON Canonicalization Scheme.
- Pair/QR tokens use canonical CBOR with duplicate-key and noncanonical-form rejection.
- Helper release manifests use canonical JSON plus detached Ed25519 signatures. A trusted helper
  release-key ring is embedded in Discord Waifus; rotation requires an old-and-new overlap
  manifest and explicit signed release-sequence/`releasedAt` validity windows. Historical helpers
  are checked against their signed release time rather than current wall-clock age. Unknown keys,
  invalid signatures, target mismatch,
  capability mismatch, or downgrade below the negotiated minimum fail closed.
- Dashboard manifests use canonical JSON and are accepted only over the currently authenticated
  application session for the pinned host identity/trust epoch. Their declared SHA-256 values
  authenticate every downloaded asset before atomic cache promotion. There is no separate
  dashboard release-signing key in v1; peer/service authentication is the manifest authenticity
  boundary.

## Frozen local storage and retention rules

Under each canonical data root:

```text
app/remote-access/              # preserved host settings, deny epochs, operations, audit
app/remote-gateway/             # preserved remembered hosts, origins, remote-role references
app/cache/remote-dashboard/     # disposable verified host dashboard bundles
app/tmp/remote-host/            # disposable live host PID/socket/lock/runtime state
app/tmp/remote-gateway/         # disposable live gateway PID/socket/lock/runtime state
app/logs/remote-host.log        # ordinary host log; removed only by clean --include-logs
app/logs/remote-gateway.log     # ordinary gateway log; removed only by clean --include-logs
```

Installation private keys and activation credentials belong in the OS vault/private helper
storage. Public fingerprints and nonsecret trust metadata may be mirrored in the directories
above with owner-only permissions.

`waifus clean` must refuse while either host or remote daemon is running. It retains identity,
activation credential, host remote-access enabled/settings state, pairings, deny epochs, and
remembered hosts. It removes the ordinary user/config/cache data it removes today, including
the remote-dashboard cache, and prints the preserved pairing count plus an explicit instruction
to use the local Settings → Remote Access typed identity-reset flow. Only that local reset
removes or rotates trust identity.

The typed identity reset is a separate, data-root-wide security transition. The current local
host process may execute it, but it must return `409 SiblingDaemonRunning` without mutation if a
remote-gateway daemon/helper for the same canonical data root is alive. It disables remote access,
stops the host-role helper, invalidates all remote actors/sessions/streams/actions and pairing
sessions while retaining the local executor's operation view, rotates the installation
identity, clears its activation certificate, both roles' node/discovery/WireGuard key references,
all trusted pair state, remembered hosts, local origin seed/epochs/high-water, and verified dashboard
cache, then requires activation and pairing again. The bounded operation ledger, administrative
audit, and a monotonic reset tombstone survive so a crash or stale helper state cannot resurrect the
old identity. Per-device host revoke and remote-side forget remain separate single-relationship
operations.

Retention limits are protocol constants, not magic numbers:

| Store | Time limit | Count/size limit | Special rule |
|---|---:|---:|---|
| Completed operation results | 24 hours | Shared max 10,000 entries or 32 MiB | Stored result max 64 KiB; never secrets |
| Prepared/unknown operations | 30 days | Same bounded ledger | Never auto-repeat without a reconciler |
| Administrative audit | 90 days | 50,000 events or 64 MiB | Rotate oldest; never request/response bodies |
| Event replay | Process epoch | 2,000 events or 8 MiB per stream | Authorization-filtered and redacted |
| Assistant pending action | 5 minutes | 16 live per actor/browser session, 256 live and 4 MiB globally | Each record max 32 KiB; summary/receipt max 8 KiB within it |
| Coordination record | Per record expiry | Approximately 2 KiB maximum | No management payload or plaintext endpoint set |

If an operation intent or mandatory audit entry cannot be persisted, the mutation fails closed.
An unresolved `prepared` operation returns `outcome_unknown`; a separate ledger must not claim
atomic exactly-once behavior it cannot provide. Capacity cleanup may remove only TTL-expired
operation records—never an unexpired completed, prepared, or unknown receipt. If the count/byte
cap is full of unexpired records, new mutations fail closed until records expire or a reviewed
reconciler resolves them.

Pending assistant-action cleanup likewise removes only expired or consumed records. It never
evicts a live action to admit another one. Hitting any per-actor, count, record, or byte cap fails
closed before emitting `confirmation_required` or performing the proposed mutation.

Every `202` response contains `{operationId, status, statusUrl}`. The canonical
`GET /api/admin/operations/:operationId` safe-read route is `full_admin` but returns a resource
only to the same initiating actor at the same trust epoch or to a local principal; otherwise it
returns indistinguishable `404`. Its redacted, `no-store` representation is the authoritative way
to recover a reconciled or unknown outcome after reconnect, independent of best-effort SSE.

## Principal, browser, and route-policy model

The host sees exactly one base principal:

```text
local
remote_device(deviceId, pinnedFingerprint, sessionId, trustEpoch)
```

Assistant provenance layers conversation, tool-call, and action IDs onto that principal. It
never replaces the actor. Internal Fastify dispatch carries a non-forgeable principal through
Node `AsyncLocalStorage`; a missing internal actor is an error, not implicit local admin. Public
HTTP headers can never manufacture an internal principal.

Browser sessions additionally require exact `Host` and `Origin`, a per-launch high-entropy
cookie, and CSRF on mutations. Non-browser loopback automation with no `Origin` remains in the
existing local-user trust boundary, but cannot execute browser-bound secure action endpoints.
The unchanged dashboard obtains its 32-byte session-bound CSRF token only from the
`X-Waifus-CSRF` response header on its same-origin, `no-store` `GET /api/client-context`; the host
answers that route locally and the remote gateway intercepts it locally. The token is never
injected into dashboard bytes, a URL, browser storage, or a proxied host response.

For a trusted remote browser, the remote gateway validates its unexposed cookie/CSRF first and
sends no browser credential as an ordinary proxied header. `RemoteBrowserContextV1` travels through
authenticated helper framing outside application headers. The remote helper MACs its gateway launch,
browser session, per-request nonce, CSRF result, method, canonical concrete target, direct-session/
stream binding, device, and trust epoch with an application-session-derived key; the host helper
verifies it and supplies immutable context to the principal. Dashboard JavaScript, a loopback caller,
and assistant internal dispatch cannot manufacture it. Secure remote-browser actions require this
context and fail on stale launch, cross-device/epoch, request-target, or stream substitution.

Each route declares:

- remote policy: `full_admin`, `local_only`, or `never_proxy`;
- principal-aware request/response field policy;
- retry class: safe read, transactional, reconciled, non-replayable, or invitation-special;
- audit action/resource metadata.

`GET /api/client-context` is `never_proxy`: the remote gateway answers it locally. Host identity
reset is `local_only`. All intentionally exposed current dashboard/API routes and the new remote
access routes are `full_admin`, subject to field redaction. For remote `/api/config`, reject
`http.host`, `frontend.staticDir`, absolute data roots, and equivalent exposure fields; change
the endpoint to a partial patch so omitted/redacted fields are never defaulted over stored local
values.

The existing gateway wildcard is additionally restricted for `remote_device` actors to the
reviewed semantic routes:

```text
GET  /api/llm/v1/providers
GET  /api/llm/v1/models
GET  /api/llm/v1/models/:provider/:model
POST /api/llm/v1/chat
POST /api/llm/v1/validate
```

Any new gateway path remains remote-denied until the allowlist and route inventory are reviewed.

## Retry-class baseline

The route-policy inventory is authoritative, but implementation starts from this classification:

- **Transactional:** revisioned JSON CRUD, credential replacement/deletion, assets, device
  rename, and assistant-action cancellation. Persist intent and replay only a bounded,
  nonsecret completed result for the same device/trust epoch/route/key/body hash.
- **Reconciled:** app configuration plus reload, Discord-bot configuration plus reload, OCR
  clear, link-bot/roster refresh, pause/resume/reload/channel-stop, helper enable/disable,
  pairing approve/reject, revoke, and reconnect. Return a durable operation resource and
  reconcile observable state after interruption.
- **Non-replayable/unknown:** digest generation, runtime triggers, LLM chat, and assistant
  message turns. Never retry automatically after transport ambiguity.
- **Invitation-special:** retain the active invitation secret in protected helper state. Only
  the same authorized creator and idempotency key may recover it before expiry/cancellation.
- **Safe:** reads and validation endpoints; reconnecting clients refresh state.

The exact host dashboard owns logical-mutation identity: it generates one 32-random-byte
`Idempotency-Key` before the first attempt and retains the route class, canonical target/body, key,
and returned operation URL in memory until a definitive outcome. A reconnect retry of a reviewed
transactional/reconciled mutation reuses that object/key; a second user action gets a new key;
non-replayable ambiguity is never retried. The remote gateway is a byte/stream proxy—it forwards the
key and connection failure but never invents logical identity or chooses a semantic retry.

## Event cursor and dashboard-origin formats

- A stream epoch is 128 random bits. SSE IDs are
  `v1:<base64url-unpadded 16-byte epoch>:<decimal sequence>`.
- `Last-Event-ID` requests bounded replay. Epoch mismatch or a cursor gap returns the canonical
  reset/snapshot signal before subscription.
- Revocation first durably advances the local deny/trust epoch and installs that denial in
  memory. After the accepted response can flush, it closes the actor's streams and invalidates
  browser sessions, conversations, queued tool work, and pending actions before converging the
  helper and Worker state.
- `local-origin-seed` is 32 random owner-only bytes. Define `pinnedHostId` as
  `SHA-256(ASCII "waifus/host-id/v1" || pinned host Ed25519 installation public key)` and the
  origin digest as `HMAC-SHA256(local-origin-seed, ASCII "waifus/origin/v1" || 0x00 ||
  pinnedHostId || uint64BE(localOriginEpoch))`. `localOriginEpoch` is a remote-local monotonically
  increasing uint64 allocated for that pinned host, distinct from the host-issued authorization
  trust epoch. Owner-only remote-gateway state retains one global `originEpochHighWater`; creation,
  authenticated host-trust change, revoke, and re-pair atomically increment it and assign the new
  value before exposing an origin. A preferred-port bind failure is also an origin transition and
  allocates a new value before the replacement listener serves any response. Deleting a
  remembered-host row never lowers that high-water mark,
  so re-pairing the same host must allocate a strictly greater value without an unbounded per-host
  tombstone set. Counter exhaustion fails closed until typed identity reset supplies a new seed.
  Encode the complete
  32-byte digest as lowercase RFC 4648
  Base32 with alphabet `abcdefghijklmnopqrstuvwxyz234567`, no padding: exactly 52 characters. The
  remote dashboard hostname is exactly `waifus-<that-label>.localhost`; the complete first label is
  59 characters. This deliberately gives each remembered host its own registrable `.localhost`
  site instead of placing mutually untrusted dashboards under a shared `waifus.localhost` cookie
  parent. The real-browser gate must prove that a dashboard cannot set `Domain=localhost`; any
  supported browser that accepts such a parent-domain cookie blocks release pending a stronger
  storage-partition design.
  The gateway also persists a preferred initially random loopback port and reuses the full
  scheme/hostname/port tuple when available, preserving host-specific `localStorage`. Because
  cookies ignore ports, failure to rebind that port must atomically allocate the next
  `localOriginEpoch` and therefore a new hostname before serving on a replacement port; no browser
  state is migrated. The hostname rotates on forget/revoke/re-pair, authenticated trust change, and
  port failover; browser-session cookies rotate on every gateway launch regardless.
- Remote dashboard CSP permits only the minimum same-origin scripts/styles/images/fonts/forms,
  with sandboxing and no popups, top navigation, service workers, or arbitrary network egress.
  Existing external documentation links render as copyable text in remote mode. Referrer policy
  is `no-referrer`.

## Cross-repository completion gates

Do not advance a real dependency past any failed gate:

1. **Contract gate:** TypeScript schemas, exported JSON Schema, fixed valid/invalid fixtures,
   crypto vectors, and a Go conformance harness agree byte-for-byte.
2. **Security-baseline gate:** existing Fastify API tests pass with route inventory, browser
   security, redaction, operations, audit, and cursor primitives enabled—before helper IPC can
   authenticate a remote actor.
3. **Fork gate:** two fake-controller peers pair, connect directly, roam, and revoke with zero
   DERP/peer-relay routes, connections, or bytes and no undeclared Tailscale egress. If this
   requires an unbounded fork, stop and redesign.
4. **Bridge gate:** the real framed helper simulator proves concurrent JSON, binary upload and
   download, SSE streaming, backpressure, abort propagation, helper disconnect, and
   `AsyncLocalStorage` actor isolation. A buffered-only `app.inject` bridge is not acceptable.
5. **Coordination gate:** concurrent invitation consume, short-code guessing limits, replay,
   activation quota, endpoint epoch, and revocation tests pass; direct traffic continues during
   a Worker outage.
6. **Dashboard gate:** a malicious host bundle cannot cross another remembered host's origin,
   cache, cookies, storage, session, or allowed network destinations.
7. **Platform gate:** all six v1 targets install, verify, launch, pair, and carry a direct API
   smoke. Linux ARM targets are tested on real representative hardware and both glibc/musl where
   applicable; cross-compilation alone is insufficient.
8. **Release gate:** current/N-1 component compatibility, roaming/failure simulation, supply
   chain verification, security review, docs, rollback, and independent post-publish checks pass.

Intel macOS is intentionally excluded from the v1 gate and recorded as a later follow-up. Do
not let its absence silently expand to unsupported unlisted targets.

## Repository workflow and validation discipline

For each checkbox task:

1. Verify the current checkout, branch, worktree, repository remote, and source-of-truth files.
2. Write a focused failing test or fixture first and run it to prove the failure.
3. Implement the smallest behavior that satisfies the frozen contract.
4. Run the focused test, then the owning repository's typecheck/build/test suite.
5. Inspect logs/fixtures for forbidden secrets and run `git diff --check`.
6. Commit only the files named by the task with the suggested scoped subject.

Standard Discord Waifus validation at stable phase boundaries:

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

Standard Go validation at stable helper/fork boundaries:

```bash
go test ./...
go test -race ./...
go vet ./...
```

Platform-specific, integration, network-namespace, browser, signing, and packaging commands are
listed in their owning phase documents. A green unit suite is not a substitute for the named
cross-process or real-device proof.

## Definition of done

This plan is complete only when the approved design's twelve acceptance criteria are all backed
by reproducible evidence. In particular, `waifus remote` must serve the host's exact verified UI,
provide full reviewed API/dashboard parity, recover after ordinary network moves when a new
direct path exists, fail clearly with no relay when it does not, and keep every secret and
host-only field out of forbidden surfaces. A release is not complete merely because the code
builds or a LAN demo succeeds.
