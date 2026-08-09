# Waifus Remote Management — Host API and Authenticated Bridge

> **For agentic workers:** implement this document task-by-task with test-driven development. Task 1 is a mandatory feasibility spike and hard gate; do not disguise a buffered `app.inject` proof as a streaming bridge.

**Goal:** Supervise the signed `ts-connect` helper from the existing host process, carry authenticated direct-peer HTTP/SSE requests into Fastify without exposing Fastify, and implement the complete local `/api/remote-access*` management surface.

**Architecture:** `RemoteAccessService` is the only Node owner of helper lifecycle and host remote-access state. The helper authenticates the peer and application stream, the Node bridge attaches the already-verified `remote_device` principal through non-forgeable internal metadata, and Fastify remains the single authorization/validation/mutation boundary. The ordinary server continues to listen only on loopback whenever remote access is enabled.

**Source of truth:** `docs/superpowers/specs/2026-08-06-waifus-remote-management-design.md`, `01-contracts-security-baseline.md`, and the pinned public contracts produced by that plan.

## Dependencies and hard gates

- All completion gates in `01-contracts-security-baseline.md` must pass first.
- The public Tailscale-fork feasibility gate must have proved direct connect, roaming, revocation, and zero DERP/peer-relay data routes/bytes.
- The private helper must pass the public Go contract fixtures and provide a development artifact with the versioned hello/IPC protocol.
- Signed package selection/verification may be injected behind an interface for early tests, but production helper startup is blocked until the exact target package and signature verifier exist.
- The remote gateway may not depend on this host bridge until Task 1 proves streaming, cancellation, backpressure, and principal propagation.
- `waifucave/gateway` receives no remote-networking responsibility.

## Locked bridge and lifecycle constants

- IPC protocol starts at `1.0`; incompatible major versions fail before coordination or peer acceptance.
- The per-launch parent capability is 32 random bytes, delivered only through an inherited protected pipe. It never appears in argv, environment values, logs, diagnostics, HTTP headers, or state files.
- Unix IPC directories are mode `0700`; socket/state files are mode `0600`. Windows named pipes grant only the current user SID and deny network/anonymous access.
- Node supervisor constants inherited from the helper contract: helper hello timeout is five seconds, and graceful helper drain is twenty seconds before forced cancellation/kill.
- Node restart-policy constants chosen by this plan: backoff is 1, 2, 5, 10, then 30 seconds with bounded jitter. Ten failures within five minutes enters `degraded` until explicit reconnect or host restart.
- Each frame uses the frozen 24-byte network-order `WIPC` header. Canonical-JSON control payloads are at most 32 KiB, encoded headers are at most 16 KiB, raw binary frames are at most 64 KiB, and one connection carries at most 128 concurrent streams. Unknown frame kinds, reserved bits, duplicate stream IDs, invalid state transitions, and over-limit fields fail closed.
- Stricter Node implementation policies chosen by this plan: at most 32 active application streams per paired device, with buffered unread data capped at 2 MiB per stream and 8 MiB aggregate per helper IPC connection. Producers pause at the cap rather than allocating without bound.
- A cancellation must reach the Fastify/upstream abort signal within one second. A closed browser/helper/peer connection cancels every associated in-flight stream.
- Remote access never changes the configured host bind silently. Effective bind is `StartBackendOptions.host ?? config.http.host`; it must resolve to loopback and the selected dashboard must be the bundled build.
- Helper failure degrades remote access but does not stop the local Discord Waifus host. Authentication, protocol, signature, or downgrade failures remain fail-closed and are visible in sanitized status/doctor output.
- The activation-flow implementation constant chosen by this plan is a ten-minute challenge lifetime. Activation uses browser polling; there is no callback from an Internet page into localhost.
- Host dashboard asset limits are those in the approved design: 16 MiB per asset, 64 MiB per build, two cached builds per host, and 256 MiB global remote cache. `index.html` is always `no-store`; immutable declared assets use their SHA-256 as ETag.

---

### Task 1: Mandatory streaming bridge and principal-propagation spike

**Files:**

- Create: `src/backend/remoteAccess/requestBridge.ts`
- Create: `src/backend/remoteAccess/bridgeProtocol.ts`
- Create: `tests/fixtures/fakeTsConnect.mjs`
- Create: `tests/remoteRequestBridge.test.ts`
- Create: `contracts/remote/v1/bridge-decision.md`
- Modify: `src/api/internalDispatch.ts` only if the spike proves a reusable internal primitive

**Why this is a hard gate:** current assistant code uses `app.inject`, which is suitable for short in-process self-REST calls but is not evidence for indefinite SSE, incremental binary response delivery, backpressure, or remote cancellation. `AsyncLocalStorage` can preserve an actor only while dispatch remains in the same async chain; it does not by itself turn a framed socket into a streaming Fastify request. The bridge must not accept a helper-supplied principal header on the ordinary loopback listener.

**Permitted spike outcomes:**

1. A proven streaming-capable Fastify internal dispatch that carries principal metadata outside HTTP headers.
2. A second OS-protected internal adapter that reuses the same route handlers and policy hooks while speaking the versioned framed IPC protocol.
3. A small framework-neutral route-dispatch layer shared by the loopback Fastify adapter and framed bridge.

Do not ship an ordinary loopback HTTP listener with `X-Device-*`, a reusable bearer header, or a helper-selectable actor. Same-user compromise is outside the threat model, but ordinary websites and loopback callers must still be unable to forge a remote principal.

- [ ] **Step 1: Write the failing spike matrix using `fakeTsConnect.mjs`.** Cover:

  - GET and JSON request/response, query strings, repeated safe headers, and exact status codes.
  - An 8 MiB binary upload and a 32 MiB incremental download without whole-response buffering.
  - An SSE stream that delivers its first event before the handler completes, resumes through 100 events, then stays open.
  - Client cancellation of SSE, upload, download, and `/api/llm/v1/chat` propagation to the handler/upstream abort signal.
  - Slow consumer backpressure staying within the locked memory caps.
  - 32 concurrent streams from one device and isolation between two device principals.
  - Forged actor/header, reused per-launch capability, duplicate stream ID, malformed frame, oversized control frame, and stale trust epoch rejection.
  - Exact public `parentProof`/`helperProof` vectors, wrong/reflected/replayed helper proof, a
    same-user process winning the socket race, and any frame arriving before mutual authentication.
  - Exact `RemoteBrowserContextV1` vectors: a gateway-validated remote session arrives only as
    host-helper-verified immutable IPC metadata bound to device/trust epoch, application session/
    stream, gateway launch/browser session, request nonce, CSRF result, method, and canonical target.
    Ordinary Cookie/CSRF/internal headers, dashboard JavaScript, assistant injection, stale launch,
    or cross-device/request substitution cannot create a confirmed browser actor.
  - Helper disconnect cancelling every associated request without affecting local browser traffic.

- [ ] **Step 2: Run the test and document the current failure.**

  Run: `npx vitest run tests/remoteRequestBridge.test.ts`

  Expected: FAIL because no bridge exists; a naïve `app.inject` prototype must additionally fail the first-event/backpressure/cancellation assertions.

- [ ] **Step 3: Prototype the smallest permitted outcome.** Reuse Task 1 contracts. Principal and
  optional verified browser-context data originate from the authenticated IPC connection, are
  immutable for a stream, and reach the Fastify policy hook as internal metadata. Strip all helper-
  internal fields before the application handler sees headers. A remote principal without valid
  browser context remains a full admin for non-browser routes but cannot satisfy `ConfirmedAdminActor`.

- [ ] **Step 4: Prove lifecycle safety.** Close the parent capability pipe and assert the helper exits; close the helper and assert Node cancels streams; close Fastify and assert the bridge refuses new frames. Ensure no orphan listener survives.

- [ ] **Step 5: Record the chosen adapter and rejected alternatives in `bridge-decision.md`.** Include the exact dispatch API, cancellation path, memory bounds, platform socket ownership, and why an Internet/loopback caller cannot forge the actor.

- [ ] **Step 6: Run the hard gate with ten iterations encoded by `it.each` in the race/leak cases.**

  Run: `npx vitest run tests/remoteRequestBridge.test.ts`

  Expected: PASS ten times with first-event streaming, bounded memory assertions, zero leaked listeners/timers, and cancellation under one second.

**Stop condition:** if no bounded adapter can preserve Fastify authorization semantics and true streaming without an ordinary forgeable principal header, stop and revise the architecture/spec before any host API integration.

**Suggested commit:** `test: prove authenticated streaming helper bridge`

---

### Task 2: Implement helper supervision and `RemoteAccessService`

**Files:**

- Create: `src/remote/helperTypes.ts`
- Create: `src/remote/helperSupervisor.ts`
- Create: `src/remote/helperClient.ts`
- Create: `src/backend/remoteAccess/stateStore.ts`
- Create: `src/backend/remoteAccess/remoteAccessService.ts`
- Create: `src/backend/remoteAccess/events.ts`
- Modify: `src/backend/server.ts:startBackend`, `RunningBackend`
- Modify: `src/backend/runtime.ts:RuntimeStateSchema`
- Modify: `src/api/server.ts:ApiServerOptions`
- Modify: `src/config/layout.ts`
- Test: `tests/helperSupervisor.test.ts`
- Test: `tests/remoteAccessService.test.ts`
- Modify tests: `tests/backend.test.ts`

The files under `src/remote/` are role-neutral and are reused unchanged by the later remote-gateway daemon. Host-only trust/config/API behavior stays under `src/backend/remoteAccess/`; do not create a second supervisor/client in that directory.

**Service interface:**

```ts
interface RemoteAccessService {
  start(): Promise<void>;
  close(): Promise<void>;
  authorize(principal: RemoteDevicePrincipal): Promise<void>;
  getStatus(): Promise<RemoteAccessStatus>;
  updateConfig(input: UpdateRemoteAccessInput, actor: RequestActor): Promise<OperationResult>;
  beginActivation(actor: LocalBrowserActor): Promise<ActivationChallenge>;
  getActivation(id: string, actor: LocalBrowserActor): Promise<ActivationStatus>;
  cancelActivation(id: string, actor: LocalBrowserActor): Promise<void>;
  createInvitation(actor: ConfirmedAdminActor, key: string): Promise<PairInvitation>;
  cancelInvitation(id: string, actor: ConfirmedAdminActor): Promise<OperationResult>;
  listPairingRequests(actor: RequestActor): Promise<PairingRequestSummary[]>;
  approvePairingRequest(id: string, input: ApprovePairingInput, actor: ConfirmedAdminActor): Promise<OperationResult>;
  rejectPairingRequest(id: string, actor: RequestActor): Promise<OperationResult>;
  listDevices(): Promise<TrustedDeviceSummary[]>;
  renameDevice(id: string, input: RenameDeviceInput, actor: RequestActor): Promise<TrustedDeviceSummary>;
  revokeDevice(id: string, actor: ConfirmedAdminActor): Promise<OperationResult>;
  reconnect(actor: RequestActor): Promise<OperationResult>;
  diagnostics(): Promise<RemoteAccessDiagnostics>;
  resetIdentity(input: ResetInput, actor: LocalBrowserActor): Promise<OperationResult>;
}
```

Private keys, anonymous activation credentials, invitation secrets, WireGuard node/disco keys, and endpoint plaintext remain helper-owned. Node retains only revisioned nonsecret configuration, public identity/trust metadata needed for local authorization, a durable deny/trust epoch mirror, and sanitized status.

For peer requests, `HelperClient` accepts only the host helper's already-verified
`RemoteBrowserContextV1`; it never reconstructs it from forwarded `Cookie`, CSRF, Origin, or custom
headers. `RequestActor` carries the immutable gateway launch/browser session/request binding, and
confirmation resolution rechecks device trust plus that exact browser session. Context-less remote
API/assistant requests cannot be upgraded into a browser-confirmed actor.

- [ ] **Step 1: Write failing supervisor tests with the fake helper.** Cover signed-path resolver injection, hello/version/capability validation, inherited capability delivery, exact mutual `parentProof`/`helperProof`, wrong-helper/socket-race rejection before traffic, no secrets in argv/env/logs, Unix permissions, Windows pipe-name/ACL contract, hello timeout, backoff, degraded threshold, manual reconnect, parent-pipe loss, and graceful/forced shutdown. Ordinary host startup sends only `controlProfile:1,runtimePurpose:"normal"`; an injected development/release-validation harness may select profile 2, while URLs, user config/flags, profile changes, and cross-profile Worker keys are rejected.

- [ ] **Step 2: Write failing service tests.** Cover disabled startup, enabled startup, missing/corrupt/incompatible helper, bind/static prerequisite failure, status/events, multi-data-root isolation, helper crash/restart, coordination outage while direct state remains connected, and close ordering.

- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/helperSupervisor.test.ts tests/remoteAccessService.test.ts tests/backend.test.ts -t "remote|helper|bind|shutdown"`

  Expected: FAIL because no supervisor/service integration exists.

- [ ] **Step 4: Implement the role-neutral `src/remote/HelperSupervisor`.** Accept `role: "host" | "remote"` plus injected role-specific paths/configuration, resolve and verify the exact target binary before spawn, negotiate hello before advertising, create the protected IPC boundary, pass the random capability through the inherited pipe, apply bounded restart, and expose only sanitized lifecycle state. It must contain no host trust-policy or Fastify dependency.

- [ ] **Step 5: Implement `RemoteAccessService` against an injectable `HelperClient`.** Keep all helper command/response validation in strict schemas. Maintain the local deny/trust mirror as a fail-closed authorization source; helper status alone must not resurrect a revoked epoch.

- [ ] **Step 6: Integrate with `startBackend`.** Compute the effective host from runtime options, not merely persisted config. Build the service before API registration, attach the proven bridge, call `app.listen`, then start/restore the helper. On close, stop accepting remote streams, drain/stop the helper, then close Fastify. Local Discord startup remains independent.

- [ ] **Step 7: Refactor frontend directory resolution.** Replace private `resolveStaticDir`'s ambiguous string result with a result identifying `{path, source: "bundled" | "custom"}`. Refuse enabled remote access only when the effective directory is custom; a stale custom path that falls back to the bundled build is reported clearly.

- [ ] **Step 8: Run service/backend regressions.**

  Run: `npx vitest run tests/helperSupervisor.test.ts tests/remoteAccessService.test.ts tests/backend.test.ts && npm run typecheck`

  Expected: PASS; local host starts even when remote access is degraded, while no remote stream is accepted without a valid helper hello and current trust epoch.

**Suggested commit:** `feat: supervise the remote connector helper`

---

### Task 3: Implement anonymous activation with browser polling

**Files:**

- Modify: `src/shared/schemas/remoteAccess.ts`
- Modify: `src/backend/remoteAccess/remoteAccessService.ts`
- Create: `src/api/remoteAccess.ts` (activation routes first)
- Modify: `src/api/server.ts` to register the module
- Modify: `src/api/errors.ts` with `ActivationRequired`
- Test: `tests/remoteActivationApi.test.ts`

**Route contract:**

| Method | Path | Policy | Result |
|---|---|---|---|
| POST | `/api/remote-access/activation` | `local_only` + bound local browser | `201`, `{activationOperationId, verificationUrl, expiresAt}`, `no-store` |
| GET | `/api/remote-access/activation/:activationOperationId` | same creator/session | `200`, sanitized `pending | completed | expired | failed`, `no-store` |
| DELETE | `/api/remote-access/activation/:activationOperationId` | same creator/session | `204` |

There is no localhost callback. The helper generates a fresh nonce and signs the canonical `activation.begin` request with its installation Ed25519 key. The local browser opens exactly `https://pair.waifucave.com/activate#<activationId>`; the activation ID is in the URL fragment and is never sent as a query parameter or Referer. The browser completes Turnstile directly with the Worker. The Turnstile token never reaches local Node, the local API, helper logs, or app logs.

The helper polls activation status with signed requests proving the same installation key. On completion, the Worker returns its Ed25519-signed nonsecret activation certificate binding the installation public key, certificate serial, expiry, and quota class. The helper verifies the configured Worker signing key and vault-stores the certificate. Certificate lifetime is 365 days with automatic key-proof renewal during the final 30 days; the Worker may require another Turnstile completion for suspicious churn. Node receives only a separate local opaque `activationOperationId`, the validated fragment URL, and sanitized pending/completed/expiry state. The Worker's activation ID never becomes a local route parameter, query, audit field, or log field.

- [ ] **Step 1: Write failing API/service tests.** Cover local browser requirement, remote/non-browser rejection, actor/session isolation, ten-minute challenge expiry, cancellation, repeated completion, Worker error, signed `activation.begin` nonce, separation of the local operation ID from the Worker activation ID, fragment-only verification URL, signed certificate key/serial/expiry/quota binding, 365-day lifetime/final-30-day renewal state, wrong Worker signing key, `no-store`, and absence of Worker activation IDs, Turnstile tokens, or certificates from local paths/logs/audit.

- [ ] **Step 2: Test first-enable behavior.** `PUT /api/remote-access` with `enabled: true` and no activation must return 428 `{error:"ActivationRequired"}` without changing revision or launching/advertising the helper. After completion, retry succeeds.

- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/remoteActivationApi.test.ts`

  Expected: FAIL because activation routes and service commands do not exist.

- [ ] **Step 4: Implement start/poll/cancel.** Local activation-operation IDs use 32 random bytes, are creator/session-bound, expire at ten minutes, and are never stored in browser local/session storage. The helper owns the independent Worker activation ID and maps the local operation handle internally. Node treats the validated fragment URL as an opaque `no-store` value and never parses, persists, or logs it. The helper signs begin/poll, verifies the Worker certificate signature and installation-key binding, vault-stores it, and reports only sanitized completion metadata before Node marks activation complete.

- [ ] **Step 5: Run focused tests and redaction goldens.**

  Run: `npx vitest run tests/remoteActivationApi.test.ts tests/apiRedaction.test.ts`

  Expected: PASS; no Internet page needs permission to connect to localhost.

**Suggested commit:** `feat: add anonymous remote activation flow`

---

### Task 4: Implement the complete host remote-access API

**Files:**

- Modify: `src/api/remoteAccess.ts`
- Modify: `src/api/server.ts`
- Modify: `src/shared/schemas/remoteAccess.ts`
- Modify: `src/backend/remoteAccess/remoteAccessService.ts`
- Modify: `src/api/routePolicyManifest.ts`
- Modify: `src/api/mutations.ts`
- Test: `tests/remoteAccessApi.test.ts`
- Test: `tests/remoteAccessAuthorization.test.ts`

**Routes and status behavior:**

| Method | Path | Policy | Success |
|---|---|---|---|
| GET | `/api/remote-access` | `full_admin` | `200` redacted config/status/capabilities |
| PUT | `/api/remote-access` | `full_admin`, restricted fields | `200` display-only update; `202` helper enable/disable operation |
| GET | `/api/remote-access/dashboard-manifest` | `full_admin` | `200`, authenticated manifest, `no-store` |
| GET | `/api/remote-access/dashboard-assets/:buildId/*` | `full_admin` + asset allowlist | streamed bytes |
| POST | `/api/remote-access/invitations` | confirmed local or trusted-remote browser | `201`, creator-bound secret response, `no-store` |
| DELETE | `/api/remote-access/invitations/:inviteId` | creator or confirmed other admin | `202` operation |
| GET | `/api/remote-access/pairing-requests` | `full_admin` | `200` redacted summaries |
| POST | `/api/remote-access/pairing-requests/:requestId/approve` | confirmed local or trusted-remote browser | `202` operation |
| POST | `/api/remote-access/pairing-requests/:requestId/reject` | `full_admin` | `202` operation |
| GET | `/api/remote-access/devices` | `full_admin` | `200` redacted list/status |
| PUT | `/api/remote-access/devices/:deviceId` | `full_admin` | `200` revisioned rename |
| DELETE | `/api/remote-access/devices/:deviceId` | confirmed local or trusted-remote browser | `202` revoke operation |
| POST | `/api/remote-access/reconnect` | `full_admin` | `202` reconciled operation |
| GET | `/api/remote-access/diagnostics` | `full_admin` | `200` sanitized diagnostics |
| GET | `/api/remote-access/events` | `full_admin` | epoch/cursor SSE |
| POST | `/api/remote-access/reset` | `local_only` confirmed browser | `202` fail-closed reset operation |
| GET | `/api/client-context` | `never_proxy` | `{mode:"host"}` locally plus same-origin `X-Waifus-CSRF`; remote gateway intercepts both body/header |

Invitation recovery is not the generic operation ledger: the helper retains the active secret in protected creator-bound state until expiry/cancellation. Same actor, session, idempotency key, and body may recover the same invitation; nobody else can retrieve it. An uncertain unrecoverable creation is cancelled/recreated only after explicit confirmation.

Every `202` row returns plan 01's exact `{operationId, status, statusUrl}` resource. A reconnecting
initiator recovers the same redacted result through principal-scoped
`GET /api/admin/operations/:operationId`; SSE notification is only an optimization and never the
sole completion mechanism.

- [ ] **Step 1: Write a table-driven failing route test.** Assert method/path/policy/status, strict
  body/params schemas, CSRF/session requirements, remote full-admin parity, local-only reset, field
  restrictions, `no-store`, audit action, retry class, and route-manifest inclusion. Browser-
  confirmed remote rows must reject absent/forged forwarded browser headers, stale gateway launch,
  cross-device/trust-epoch/session, method/target/request substitution, and assistant internal
  dispatch without helper-verified `RemoteBrowserContextV1`.

- [ ] **Step 2: Write pairing security tests.** Cover QR/full-token creator response, short-code pending request, exact phrase/fingerprint/transcript/generation approval, approval mismatch, invite racing/atomic consume, expiry, cancellation ownership, confirmation for another actor's invite, and no endpoint publication/probing before approval.

- [ ] **Step 3: Explicitly test trusted-remote trust expansion.** A current trusted remote browser can create an invitation, view the exact pending summary, approve another remote using its actor/session-bound confirmation, and is identified in audit. A revoked/stale remote cannot do any step. Identity reset remains absent from its authority.

- [ ] **Step 4: Run focused tests.**

  Run: `npx vitest run tests/remoteAccessApi.test.ts tests/remoteAccessAuthorization.test.ts`

  Expected: FAIL because only activation routes exist.

- [ ] **Step 5: Implement the route module as thin service adapters.** Route handlers parse Zod contracts, resolve the principal/confirmation context, and delegate. Do not duplicate helper protocol, authorization, audit, or idempotency logic inside handlers.

- [ ] **Step 6: Implement enable/disable semantics.** Validate effective loopback bind and bundled dashboard before enable. Send the accepted operation response before disabling drains the caller's direct connection. Never silently rewrite `http.host` or `frontend.staticDir`.

- [ ] **Step 7: Add the sanitized remote section to `GET /api/diagnostics/bundle`.** Include component versions, capability negotiation, control/STUN/port-mapping/direct state and error categories; omit raw endpoints, candidates, socket paths, pair identifiers/secrets, and private key material.

- [ ] **Step 8: Run API, authorization, operation, redaction, and route-inventory suites.**

  Run: `npx vitest run tests/remoteAccessApi.test.ts tests/remoteAccessAuthorization.test.ts tests/operationStore.test.ts tests/auditStore.test.ts tests/apiRedaction.test.ts tests/routePolicy.test.ts`

  Expected: PASS; every route has explicit policy/retry/audit metadata.

**Suggested commit:** `feat: add host remote access API`

---

### Task 5: Serve the authenticated dashboard manifest and immutable asset route

**Files:**

- Create: `src/backend/remoteAccess/dashboardBuild.ts`
- Modify: `src/api/remoteAccess.ts`
- Modify: `src/api/server.ts:resolveStaticDir`, `tryServeFrontend`
- Consume: `dist-frontend/waifus-dashboard-manifest.json` generated by plan 06 Task 3
- Test: `tests/dashboardManifestApi.test.ts`

**Asset contract:**

- `GET /api/remote-access/dashboard-manifest` returns the RFC 8785 canonical manifest containing build ID, relative path, byte size, SHA-256, content type, API/transport version, minimum helper/remote-gateway versions, and required capabilities. Only an authenticated current `full_admin` principal can read it; v1 relies on that pinned peer/application-session authentication rather than a separate dashboard release signature.
- `GET /api/remote-access/dashboard-assets/:buildId/*` accepts only the exact allowlisted relative path for that current build. It is never an arbitrary filesystem endpoint.
- Reject decoded traversal, absolute paths, separators outside the normalized manifest path, duplicate manifest entries, symlinks, non-regular files, size drift, hash drift, content-type drift, stale build IDs, and assets above 16 MiB.
- Serve `index.html` with `no-store`; serve other declared immutable assets with `Cache-Control: public, max-age=31536000, immutable` and an ETag equal to the declared SHA-256.
- Remote v1 refuses a genuinely custom effective `frontend.staticDir` even if its contents look valid.

- [ ] **Step 1: Write failing manifest/asset tests.** Create synthetic bundled builds containing HTML, JS, CSS, font/image, binary, traversal, symlink, oversize, duplicate, stale-build, hash-mismatch, and MIME-mismatch fixtures.

- [ ] **Step 2: Write streaming assertions.** A multi-megabyte declared asset must begin delivering before full buffering and must cancel on bridge cancellation. Safe range requests are out of scope for v1 unless the generated dashboard actually requires them.

- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/dashboardManifestApi.test.ts`

  Expected: FAIL because the host has no manifest reader or authenticated asset route.

- [ ] **Step 4: Implement `DashboardBuild`.** Load only the generated bundled manifest, validate every entry against disk once per build, cache the validated metadata without caching file bytes, and invalidate on build ID/change.

- [ ] **Step 5: Implement the two routes using stream backpressure and the bridge cancellation signal.** Never expose the absolute path in errors, headers, diagnostics, or audit.

- [ ] **Step 6: Run tests plus a real frontend build.**

  Run: `npm run build:frontend && npx vitest run tests/dashboardManifestApi.test.ts tests/remoteRequestBridge.test.ts`

  Expected: PASS; every generated manifest asset downloads byte-identically and undeclared paths fail.

**Suggested commit:** `feat: serve verified host dashboard builds remotely`

---

### Task 6: Make approval, revocation, disable, and reset ordering fail closed

**Files:**

- Modify: `src/backend/remoteAccess/remoteAccessService.ts`
- Modify: `src/backend/remoteAccess/stateStore.ts`
- Modify: `src/backend/remoteAccess/requestBridge.ts`
- Modify: `src/api/remoteAccess.ts`
- Create: `src/backend/remoteAccess/invalidation.ts` with a role-neutral actor/trust invalidation subscription API
- Create: `src/remote/identityResetState.ts` with canonical data-root-wide reset paths/tombstone
- Modify: `src/config/layout.ts`
- Test: `tests/remoteRevocation.test.ts`
- Test: `tests/remoteIdentityReset.test.ts`
- Modify: `tests/remoteAccessAuthorization.test.ts`, `tests/eventStream.test.ts`

**Revocation order:**

1. Revalidate actor, browser session/confirmation, device ID, current device revision, and trust epoch.
2. Reserve/recover the reconciled operation and persist the mandatory accepted audit entry; if either write fails, abort before changing trust.
3. Durably advance the local deny/trust epoch before acknowledging success; old epochs can never be reaccepted from helper state.
4. Mark the device revoked in memory so every new request/tool/action/stream fails immediately.
5. Persist the operation outcome/audit completion and let the accepted revocation response flush.
6. Publish one actor/trust invalidation and close that device's bridge streams. Plan 06 binds the
   existing browser/conversation/queued-tool layers and its later pending-action store to this
   generic subscription; the host service never imports those feature modules.
7. Command the helper to persist cryptographic revocation, disconnect the peer, and converge coordination-plane revocation. If helper/Cloudflare is unavailable, keep local denial authoritative and reconcile later.

Approval is the reverse trust transition: helper verifies and persists the exact approved transcript/identity bundle first, Node persists the matching public trust mirror, and only then may `authorize()` accept that epoch. A Worker claim alone never creates local trust.

Identity reset applies the same fail-closed pattern to the complete installation represented by
the selected canonical data root. The current local host Node process is the executor and is not a
"sibling daemon"; before reserving the operation, it checks that no separately running remote
gateway/helper owns the same root. A live sibling returns `409 SiblingDaemonRunning` with no state
mutation. The role-neutral `identityResetState` module owns exact paths for both app roles so the
host service does not import plan 06's later remembered-host implementation.

After that check, reset persists its operation/audit and a monotonically increasing reset tombstone,
sets host remote access disabled/reset-pending, installs an all-current-trust local deny, invalidates
remote actors/sessions/streams/actions and pairing sessions, and drains peer application streams
without stopping the mutually authenticated parent IPC. It starts a verified helper in reset-only
mode if none is running, then sends the public `reset_identity` command with that tombstone and
expected old fingerprint. The helper crash-safely rotates the installation identity, clears the old
activation certificate and host/remote role node/discovery/WireGuard/pair secrets, durably records
`IdentityResetReceiptV1`, returns it, and only then drains/self-exits. Only after Node verifies that
receipt does it clear host trust/pair metadata and activation
reference, remote-gateway remembered hosts/origin seed/local-origin epochs and high-water/role
metadata, and `app/cache/remote-dashboard/`; it rewrites remote-access settings to disabled defaults.
It preserves the bounded operation ledger, administrative audit, and reset tombstone. The new
unactivated installation has no trusted or remembered peer. If any helper outcome is uncertain,
restart recovery calls `get_reset_status` with the same tombstone while remaining disabled/reset-
pending and resumes reconciliation; it never restores the old
identity from app files. This route is local-browser-only and never an assistant tool for a remote
actor. Per-device revoke and remote-side forget do not invoke installation reset.

- [ ] **Step 1: Write failing race tests.** Cover a request concurrent with revocation, existing SSE, two deterministic fake invalidation subscribers representing queued assistant work and pending confirmation, reconnect using old endpoint generation, helper crash during revoke, Worker outage, self-revoke, repeated revoke, and stale operation replay under a new epoch. Prove each subscriber sees the exact actor/old epoch once and cannot authorize afterward; actual assistant/action wiring belongs to plan 06. Add host-plus-remote coexistence fixtures proving reset returns `SiblingDaemonRunning` without changing any sentinel while the remote role lives, succeeds from the current host process after that sibling stops, and leaves neither role able to restart with old identity material.

- [ ] **Step 2: Test acknowledgement ordering.** The accepted revocation/disable response must flush before its own direct stream closes, while a concurrently opened second request is denied after the durable local epoch change.

- [ ] **Step 3: Test restart durability.** Restart Node/helper after every numbered transition point. The device must never regain access; incomplete external convergence resumes without repeating an unsafe action. For identity reset, crash/restart around sibling check, reset-tombstone write, deny installation, reset-only helper spawn, every helper journal stage, durable receipt before/after delivery, helper self-exit, each role-tree cleanup, and operation completion. Reissue/query only the same tombstone, verify the same receipt/new public identity, preserve operation/audit/tombstone, require a fresh activation, and prove later host and remote starts see the same new installation identity with separate fresh role keys and empty pair/remembered-host state.

- [ ] **Step 4: Run and prove the races fail before implementation.**

  Run: `npx vitest run tests/remoteRevocation.test.ts tests/remoteIdentityReset.test.ts tests/remoteAccessAuthorization.test.ts tests/eventStream.test.ts`

  Expected: FAIL until service, bridge, streams, and generic invalidation subscribers share the same trust source.

- [ ] **Step 5: Implement two-phase local-deny/response-drain/external-convergence behavior.** Expose invalidation subscriptions rather than importing assistant internals into the service. Implement reset through the shared canonical-path/tombstone module and helper-owned vault rotation, never by deleting a broad ancestor. Ensure authorization rechecks happen at request open, every request, tool execution, pending-action consumption, and stream event/heartbeat.

- [ ] **Step 6: Run the race suite with ten iterations encoded by `it.each` for every ordering-sensitive case.**

  Run: `npx vitest run tests/remoteRevocation.test.ts tests/remoteIdentityReset.test.ts tests/remoteAccessAuthorization.test.ts tests/eventStream.test.ts`

  Expected: PASS ten times with no post-revocation protected event or request.

**Suggested commit:** `fix: make remote revocation immediately fail closed`

---

### Task 7: Complete diagnostics, startup compatibility, and host integration verification

**Files:**

- Modify: `src/backend/runtime.ts`
- Modify: `src/backend/server.ts`
- Modify: `src/api/server.ts`
- Modify: `src/backend/redaction.ts`
- Modify: `tests/backend.test.ts`
- Create: `tests/remoteHostIntegration.test.ts`

- [ ] **Step 1: Add integration tests using two fake authenticated devices.** Exercise full current API parity, credential replacement without read-back, uploads/downloads, `/api/llm` streaming cancellation, `/api/events` resume, runtime controls, one remote enrolling a second, device rename/revoke, disable, restart restore, and impossible direct-path status.

- [ ] **Step 2: Add compatibility tests.** Same-major minor negotiation succeeds only when minimum component versions and all required capabilities are met. Major mismatch, helper downgrade, unknown required capability, custom dashboard, and non-loopback effective bind fail before advertisement.

- [ ] **Step 3: Add diagnostics goldens.** Verify actionable categories for missing helper, invalid signature, incompatible helper, control offline, STUN unavailable, UDP blocked, port mapping unavailable, direct path unavailable, and roaming; verify raw addresses/candidates/secrets never appear.

- [ ] **Step 4: Run focused host integration.**

  Run: `npx vitest run tests/remoteHostIntegration.test.ts tests/backend.test.ts tests/apiRedaction.test.ts`

  Expected: PASS with the fake helper; this is not yet proof of real direct networking.

- [ ] **Step 5: Run the real development-helper smoke only after upstream gates pass.** Start two supported machines/data roots, pair through staging, load the manifest/assets, exercise API/SSE, move one device between networks, revoke it, and capture sanitized proof of a direct path and zero relay bytes.

- [ ] **Step 6: Run the repository completion gate.**

  Run: `npm run test && npm run typecheck && npm run build`

  Expected: PASS. Fastify remains loopback-only; no remote request bypasses route policy, operation/audit, redaction, or current trust checks.

**Suggested commit:** `test: verify host remote management integration`

## Completion gate

The host side is implementation-complete only when:

- The mandatory bridge spike proves true streaming, bounded backpressure, cancellation, and non-forgeable principals on macOS/Linux plus the Windows pipe contract.
- Effective bind and bundled-dashboard prerequisites are checked before helper advertisement.
- First activation uses the local-only polling flow and stores no credential in Node.
- Every committed host API route, including manifest assets and `client-context`, has reviewed policy/retry/audit metadata.
- A trusted remote can enroll another remote with exact actor/session-bound confirmation and audit.
- Revocation/disable acknowledgement ordering is tested, old trust epochs never return, and Cloudflare outage cannot restore access.
- Invitation secrets, endpoints, credentials, tokens, internal capabilities, paths, and private keys are absent from forbidden outputs.
- Fake-helper integration, real-helper staging smoke, `npm run test`, `npm run typecheck`, and `npm run build` all pass.

## External execution dependency

Task 1 intentionally ends in a hard implementation choice recorded by the spike. If none of the permitted adapter designs can meet streaming and principal requirements without a forgeable loopback header, this plan is blocked pending a design revision; later tasks must not weaken that gate.
