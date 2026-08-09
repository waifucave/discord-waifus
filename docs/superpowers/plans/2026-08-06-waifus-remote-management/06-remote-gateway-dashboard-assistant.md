# Waifus Remote Management Part 06 — App Gateway, Dashboard, CLI, and Assistant

> **For agentic workers:** Execute this file task-by-task with test-driven development. Use
> `superpowers:subagent-driven-development` when implementing independent tasks in one session,
> or `superpowers:executing-plans` when running the plan in a separate session. Keep every
> checkbox current and stop at any gate marked **BLOCKING**.

**Goal:** Integrate the signed `ts-connect` helper into Discord Waifus, add the local
`waifus remote` daemon and isolated browser gateway, download and verify the host's exact
dashboard, expose remote-access controls through that dashboard and its assistant, and preserve full
administrative parity for every route deliberately classified `full_admin`.

**Architecture:** The host's existing Node/Fastify process and the new remote Node gateway each
supervise one role-specific `ts-connect` child. Node never implements WireGuard, endpoint
discovery, pairing cryptography, or the Cloudflare control protocol. It talks to the helper over
the versioned authenticated IPC contract. The remote gateway binds only loopback and serves a
small local connection shell until a host is selected. Once directly connected, it verifies and
caches the selected host's exact dashboard bundle, serves it from a host/trust-epoch-isolated
origin, and transparently proxies only the selected host's authorized dashboard/API service.

**Tech stack:** Node 20+ TypeScript ESM, Fastify 5, React 19, Vite, Zod, Vitest, optional
target-specific npm binary packages, Node streams/fetch, Unix-domain sockets or Windows named
pipes through the shared helper IPC contract.

**Normative design:**
`docs/superpowers/specs/2026-08-06-waifus-remote-management-design.md`.

---

## Locked decisions for this part

- Management traffic is direct-only. Node must not add a relay, proxy service, TURN fallback,
  arbitrary destination, or stock Tailscale control path. A lost direct path becomes
  `reconnecting`, then `direct_unavailable`; the browser stays open and explains the state.
- `pair.waifucave.com` is coordination only. The Node app never sends dashboard assets, API
  bodies, model traffic, logs, or WebSocket/SSE payloads to it.
- The same data root may run the host backend and remote gateway simultaneously. It owns one
  installation identity but separate **host-role** and **remote-role** node/discovery keysets,
  helper state, sockets, PID/runtime files, logs, and process locks. The helper contract must
  enforce concurrent access and role separation.
- Supported helper targets are exactly macOS ARM64, Windows x64, Windows ARM64, Linux x64,
  Linux ARM64, and Linux ARMv7. Intel macOS is rejected with an actionable “later follow-up”
  message. It is not silently mapped to another package.
- Published installs and source checkouts resolve the same signed optional binary package. No
  install hook downloads an arbitrary executable and no secret is embedded in the package.
- A trusted remote is a full administrator for every route classified `full_admin`. Host
  identity reset and host exposure/filesystem fields remain `local_only`. A trusted remote may
  create an invitation and approve another remote through an actor/session-bound secure action.
- The remote downloads the host's exact dashboard build; it never streams pixels and never
  substitutes its locally installed dashboard after connection. Compatible app versions may
  differ when the transport major, minimum component versions, and required capabilities pass.
- The verified dashboard cache is capped at exactly 16 MiB per asset, 64 MiB per build, two builds
  per pinned host, and 256 MiB globally with LRU eviction. A cap violation fails before any partial
  build executes.
- The remote browser hostname uses the exact frozen derivation from plan 00: a 32-byte local seed,
  domain-separated pinned installation-key host ID, big-endian 64-bit remote-local origin epoch,
  and the full
  HMAC-SHA256 digest encoded as exactly 52 lowercase unpadded RFC 4648 Base32 characters in the
  exact hostname `waifus-<digest>.localhost`. Each host therefore has a distinct registrable
  `.localhost` site rather than sharing a parent such as `waifus.localhost`; the platform-browser
  gate must prove `Domain=localhost` is rejected or stop for a stronger isolation design. The label
  is stable across launches for that host epoch and rotates on forget/revoke or another
  authenticated host-trust change. A preserved global origin-epoch high-water forces re-pairing the
  same pinned host to allocate a strictly newer origin epoch. The gateway may remember a preferred
  initially-random loopback port. Because cookies ignore ports, a port change must also allocate the
  next local origin epoch and hostname before the replacement listener serves any content.
  Browser-session cookies rotate on every gateway launch.
- The remote gateway uses a launch-random, unexposed cookie name plus a 32-byte value in a host-only
  `HttpOnly`, `SameSite=Strict` session cookie and a separate same-origin CSRF token. It ignores every
  other browser cookie and validates exact `Host`, `Origin`, session, CSRF, and Fetch Metadata; it
  never accepts a client-supplied device/principal header.
- The installed connection shell is the only UI served before a host dashboard has been fully
  verified. Pairing secrets may be pasted into the shell or protected interactive stdin, but
  never CLI argv, an HTTPS/local URL query, logs, browser storage, or ordinary proxied HTTP.
- Existing external documentation links in the host dashboard are copy-only, non-clickable text
  in remote mode, with an isolation explanation. Do not add an arbitrary OS URL-opener controlled
  by host-supplied JavaScript.
- `waifus remote stop` stops only the local remote gateway daemon. Existing `waifus stop` remains
  host-process-only. Current `POST /api/runtime/stop` remains “stop one channel run”; it is not an
  OS process stop. Remote v1 intentionally has no host Node process stop/restart parity because
  stopping the host destroys the only management path and no system-service contract exists.
- `waifus clean` refuses while either host or remote daemon is live. Once stopped and confirmed,
  it removes ordinary user/config/cache data, transient browser sessions/actions/invitations, and
  `app/cache/remote-dashboard/`; it preserves the installation identity and activation credential,
  host remote-access enabled/settings state, role key references, trusted devices/pairings, deny
  and trust epochs, remembered hosts, operations, and administrative audit. It prints the exact
  preserved pairing count and an explicit instruction to use local Settings → Remote Access for
  typed identity reset. Only that local flow rotates the host installation identity and removes
  all of its pairings at once; reviewed device revoke/remote forget still remove one relationship.
- Identity reset runs inside the current local host process but refuses with
  `SiblingDaemonRunning` before mutation if the same root's separate remote gateway/helper is live.
  It consumes plan 05's data-root-wide reset primitive, clears both roles' identity/trust/remembered-
  host/origin/cache state after helper-owned vault rotation, and preserves operation/audit/reset-
  tombstone recovery state.
- Every SSE family uses a 128-random-bit stream epoch and the exact SSE ID
  `v1:<base64url-unpadded 16-byte epoch>:<decimal sequence>`. `Last-Event-ID` requests replay from
  the authorization-filtered/redacted ring capped at 2,000 events or 8 MiB per stream. A cursor
  gap or epoch mismatch causes the canonical reset/snapshot flow before resubscription; a
  process-local integer alone is forbidden.
- The assistant retains the initiating actor. A remote conversation/tool/action never becomes local
  merely because it uses `app.inject`. Pairing secrets and destructive confirmation payloads do
  not enter model or display transcripts.

---

## Cross-part gates and ownership

### Gate A — contracts (**BLOCKING for Tasks 2, 5, 6, and 7**)

The versioned contracts must already define and fixture-test:

- Node-helper IPC framing, request/response/body/stream/cancel messages, inherited capability,
  protocol major/minor, helper capabilities, and sanitized status events.
- The role-specific identity/state model: one installation key, separate host/remote node and
  discovery keys, trust epochs, key sequences, and simultaneous helper locking rules.
- Host dashboard manifest and asset request contracts.
- Actor/device/trust-epoch metadata supplied by authenticated host helper IPC.
- Retry classes, idempotency behavior, and the exact
  `v1:<base64url-unpadded 16-byte epoch>:<decimal sequence>` cursor encoding plus the 2,000-event/
  8-MiB-per-stream replay bounds.

Do not invent local alternatives in this file if the cross-repository contract is absent or
different. Update the contract plan first.

### Gate B — fork/helper feasibility (**BLOCKING for real end-to-end completion**)

The mandatory direct-only fork spike must pass before a production helper dependency is added.
Until signed development packages exist, tests in this file use an injected fake helper. Never
relax the direct-only invariant to make an app test pass.

### Gate C — host API security baseline (**BLOCKING for Task 8 final integration and Tasks 10, 12, and 13**)

The host must already provide authenticated principals, route policies, field policies,
redacted conflicts, idempotency/retry primitives, audit, epoch-aware streams, the reviewed
`/api/remote-access*` API, and `/api/client-context`. Transparent proxying is not an authorization
boundary.

### Gate D — publishing (**BLOCKING for package/release steps only**)

Creating repositories, publishing optional helper packages, deploying Cloudflare, or releasing
Discord Waifus requires explicit target verification and user authorization in its owning part.
Local code/tests and fake-package fixtures do not authorize publication.

### Work that may proceed in parallel

- Tasks 3 and 4 (manifest/cache) can proceed after the manifest contract is locked, without a
  live helper.
- Task 10's pure frontend types/reducers can proceed against API fixtures after Gate C schemas are
  locked.
- Tasks 12 and 13's conversation/action unit work can proceed after the principal contract is locked;
  their API integration waits for Gate C.

---

### Task 1: Role-specific app paths and runtime schemas

**Files:**

- Create: `src/remote/paths.ts`
- Create: `src/shared/schemas/remoteRuntime.ts`
- Modify: `src/config/layout.ts` (`DATA_LAYOUT_DIRS`, remote-only layout helper)
- Modify: `src/backend/runtime.ts` (`RuntimeStateSchema` host remote-access summary)
- Modify: `src/cli/commands.ts` (`readRuntimeFile` becomes schema-parameterized)
- Test: `tests/remoteRuntimeState.test.ts`
- Test: `tests/cli.test.ts`

**Produces:**

- `remoteRolePaths(dataRoot, "host" | "remote")` with distinct persistent references, transient
  runtime/socket/lock, and ordinary log paths.
- `RemoteDaemonStateSchema` for the local remote gateway.
- Optional sanitized `runtime.remoteAccess` on the host runtime state.
- A remote-only layout initializer that does not seed waifus or create Discord user files on a
  device used only as a remote.

- [ ] **Step 1: Write failing path/schema tests.** Pin the canonical roots exactly: preserved host
  settings, deny epochs, operations, audit, and host-role public/vault-reference metadata under
  `app/remote-access/`; remembered hosts/origins and remote-role public/vault-reference metadata
  under `app/remote-gateway/`; live runtime/socket/lock files under exact separate
  `app/tmp/remote-host/` and `app/tmp/remote-gateway/`; ordinary logs at exact
  `app/logs/remote-host.log` and `app/logs/remote-gateway.log`;
  and disposable verified bundles under `app/cache/remote-dashboard/`. Assert no path collides for
  the same root, clean deletes transient runtime, and `--include-logs` controls only ordinary role
  logs while administrative audit remains preserved. Assert both schemas tolerate the other role running concurrently and
  no third `app/remote/` trust root is introduced.
- [ ] **Step 2: Run the focused tests.**

  Run: `npx vitest run tests/remoteRuntimeState.test.ts tests/cli.test.ts`

  Expected: FAIL because the path helpers and remote daemon schema do not exist.
- [ ] **Step 3: Implement the schemas and layout.** Keep private key material out of Node JSON;
  store only installation IDs, role, display metadata, versions, sanitized state, and OS-secret
  references. Preserve `.js` extensions on local backend imports.
- [ ] **Step 4: Verify focused tests and typecheck.**

  Run: `npx vitest run tests/remoteRuntimeState.test.ts tests/cli.test.ts && npm run typecheck`

  Expected: PASS; no `user/waifus` tree is created by the remote-only initializer.
- [ ] **Step 5: Suggested commit.**

  `feat: add role-separated remote runtime state`

---

### Task 2: Signed helper package resolver

**Gate:** Gate A required; real package names/versions and signing keys require Gate B/D.

**Files:**

- Create: `src/remote/helperBinary.ts`
- Create: `src/remote/helperPackageManifest.ts`
- Create: `src/remote/componentCompatibility.ts`
- Create: `remote-compatibility.json`
- Modify later, only after packages exist: `package.json` (`optionalDependencies`, `files`)
- Modify later: `package-lock.json`
- Modify: `scripts/check-no-file-deps.mjs` only if validation needs exact optional-package checks
- Test: `tests/helperBinary.test.ts`
- Fixtures: `tests/fixtures/helper-packages/**`

**Symbols:**

- `resolveTsConnectBinary(options): Promise<ResolvedHelperBinary>`
- `verifyHelperPackageManifest(manifest, binary, trustRoots, appVersion, compatibility): Promise<void>`
- `supportedHelperTarget(platform, arch, armVersion): HelperTarget`

`remote-compatibility.json` is strict canonical JSON shipped in the root package. It declares its
schema version, the exact Discord Waifus version (which must equal `package.json`), helper minimum
and maximum-exclusive SemVer, minimum release sequence, supported IPC/direct-service/dashboard
protocol ranges, and sorted required capabilities. Plan 07 updates and release-checks this table;
runtime never infers an unbounded compatibility range from an npm dependency pin.

- [ ] **Step 1: Write failing table tests** for all six supported targets, Intel macOS, unknown
  targets, Linux ARMv7 detection, missing optional package, wrong package `os`/`cpu`, checksum
  mismatch, invalid signature, unknown signing key, signed release sequence/`releasedAt` outside the
  key's historical overlap window (without current-wall-clock expiry), missing/wrong
  `workerTrustRingSha256` versus embedded helper metadata, incompatible protocol,
  helper/release-sequence downgrade below the app's compatibility floor, app version below the
  manifest's `minimumDiscordWaifusVersion`, and app version equal to or above its
  `maximumDiscordWaifusVersionExclusive`. Test source-checkout and installed-package resolution
  against the same fixture package bytes and exact current root-package version.
- [ ] **Step 2: Run the focused test.**

  Run: `npx vitest run tests/helperBinary.test.ts`

  Expected: FAIL because the resolver does not exist.
- [ ] **Step 3: Implement resolution and verification.** Use `createRequire(import.meta.url)` or
  equivalent package resolution; never search the network or PATH as an unsigned fallback. Public
  verification keys ship in the reviewed `src/remote/helperReleaseTrust.ts` ring owned by plan 07.
  Enforce both directions: the app's component compatibility table accepts the helper version/
  release sequence/protocol/capabilities, and the signed helper manifest accepts the exact app
  version within its minimum/maximum-exclusive interval. Error messages name the unsupported/
  missing target without exposing local secret paths beyond the ordinary local CLI boundary.
- [ ] **Step 4: Keep production dependencies gated.** Use fixture packages until signed package
  versions are published and verified. Then add all six packages as exact-version optional
  dependencies and regenerate the lockfile. Do not add semver ranges.
- [ ] **Step 5: Generate and validate root compatibility metadata.** Reject package-version drift,
  malformed or unbounded ranges, unknown required capabilities, and any helper accepted in only one
  direction. Include the canonical file in source and `npm pack`.
- [ ] **Step 6: Verify.**

  Run: `npx vitest run tests/helperBinary.test.ts && node scripts/check-no-file-deps.mjs && npm run typecheck`

  Expected: PASS. Intel macOS reports unsupported; no fallback binary is selected.
- [ ] **Step 7: Suggested commits.**

  - Before publication: `feat: verify target-specific ts-connect helpers`
  - After explicitly authorized publication: `chore: pin signed ts-connect helper packages`

---

### Task 3: Deterministic dashboard manifest generation

**Gate:** Manifest contract from Gate A required; no helper required.

**Files:**

- Create: `scripts/generate-dashboard-manifest.mjs`
- Create: `src/remote/dashboardManifest.ts`
- Modify: `src/frontend/vite.config.ts`
- Modify: `package.json` (`build:frontend`, package `files` if needed)
- Test: `tests/dashboardManifest.test.ts`

**Symbols/contracts:**

- `DashboardManifestSchema`
- `loadBundledDashboardManifest(packageRoot)`
- generated `dist-frontend/waifus-dashboard-manifest.json`

- [ ] **Step 1: Write failing fixture tests.** Build a temporary bundle with `index.html`, hashed
  JS/CSS, a font, and an image. Assert sorted allowlisted relative paths, byte sizes, SHA-256,
  content types, deterministic build ID, API/transport versions, minimum helper/remote-gateway
  versions, required proxy capabilities, and RFC 8785 canonical JSON bytes. Reject traversal,
  absolute paths, symlinks, duplicate normalized paths, undeclared output, unsupported MIME types,
  and noncanonical reserialization. The manifest must not hash or recursively include itself.
- [ ] **Step 2: Run the focused test.**

  Run: `npx vitest run tests/dashboardManifest.test.ts`

  Expected: FAIL because no generator/loader exists.
- [ ] **Step 3: Implement generator and runtime loader.** `npm run build:frontend` must run Vite
  first and the generator second. Use a remote-compatible root-relative asset contract. Pin the
  validated bundle for a backend lifetime or atomically switch only after a complete new manifest
  validates; never serve a mixed old/new directory during an in-place package update. V1 does not
  add a dashboard release-signing key: the remote accepts this canonical manifest only through the
  authenticated application session for its currently pinned host/trust epoch, then verifies every
  declared asset hash before promotion.
- [ ] **Step 4: Verify build output.**

  Run: `npm run build:frontend && node -e "const m=require('./dist-frontend/waifus-dashboard-manifest.json'); if(!m.buildId||!m.assets?.length) process.exit(1)"`

  Expected: PASS; every served immutable asset is declared exactly once.
- [ ] **Step 5: Run broader checks.**

  Run: `npx vitest run tests/dashboardManifest.test.ts tests/api.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 6: Suggested commit.**

  `feat: generate verified dashboard bundle manifests`

---

### Task 4: Host-key/build-key dashboard cache

**Files:**

- Create: `src/remote/dashboardCache.ts`
- Create: `src/remote/dashboardDownloader.ts`
- Modify: `src/remote/paths.ts`
- Test: `tests/dashboardCache.test.ts`

**Symbols:**

- `DashboardCache.openVerified(hostKey, manifest)`
- `DashboardCache.install(hostKey, manifest, readAsset)`
- `DashboardCache.evict()`

- [ ] **Step 1: Write failing tests** for complete cache hit, partial download cleanup, hash/size/
  MIME mismatch, traversal, absolute path, symlink, duplicate path, cancellation, atomic rename,
  malicious host A versus host B isolation, `2 builds per host` cap, 64 MiB build cap, 16 MiB asset
  cap, 256 MiB global LRU, and trust-epoch rotation cleanup.
- [ ] **Step 2: Run the focused test.**

  Run: `npx vitest run tests/dashboardCache.test.ts`

  Expected: FAIL because the cache does not exist.
- [ ] **Step 3: Implement using filesystem primitives.** Use `lstat`, exclusive temporary
  directories, bounded streaming hashes, mode-restricted metadata, and atomic rename. Never execute
  or serve a partial build. Partition by pinned host installation key fingerprint and build ID,
  not display name or Cloudflare room ID.
- [ ] **Step 4: Verify.**

  Run: `npx vitest run tests/dashboardCache.test.ts tests/dashboardManifest.test.ts && npm run typecheck`

  Expected: PASS and no test writes outside its temp root.
- [ ] **Step 5: Suggested commit.**

  `feat: cache host dashboards by pinned identity and build`

---

### Task 5: Reuse the authenticated helper client for the remote role

**Gate:** Part 05's generic host helper client/supervisor plus Gate A are required. Gate B is
required for real-binary tests; fake-helper coexistence tests may run earlier.

**Files:**

- Modify/reuse: `src/remote/helperClient.ts`
- Modify/reuse: `src/remote/helperSupervisor.ts`
- Modify/reuse: `src/remote/helperTypes.ts`
- Test: `tests/remoteHelperReuse.test.ts`
- Modify: `tests/helperSupervisor.test.ts`

**Symbols:**

- `HelperClient.request`, `.openStream`, `.cancel`, `.events`, `.close`
- `HelperSupervisor.start(role, rolePaths)`, `.status()`, `.drainAndStop()`, `.restartNow()`
- injectable `HelperProcessFactory` and `HelperClientFactory`

- [ ] **Step 1: Reuse Part 05's scripted fake helper and frozen IPC fixtures.** Do not create a
  second frame codec, supervisor, retry policy, or helper lifecycle for remote mode. Add only the
  remote-role fixture commands/events needed by this plan.
- [ ] **Step 2: Write remote-role reuse/coexistence tests.** Start host and remote supervisors on
  one data root and assert separate role identity, state, inherited per-launch capability, UDS/
  named-pipe endpoint, lock, log, retry budget, and child lifecycle. Prove remote drain/restart does
  not affect the host helper and host shutdown does not orphan or stop the remote helper. Re-run
  generic body streaming, backpressure, cancellation, malformed-frame, EOF, and secret-redaction
  conformance through the remote role rather than duplicating their implementation. Normal runtime
  always authenticates HELLO with `controlProfile:1,runtimePurpose:"normal"`; profile 2 works only in
  injected development/release-validation harnesses. Reject user CLI/config/argv/environment URLs,
  post-HELLO profile changes, cross-profile redirects/Worker keys, and every third origin.
- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/remoteHelperReuse.test.ts tests/helperClient.test.ts tests/helperSupervisor.test.ts`

  Expected: FAIL because Part 05's generic supervisor is not yet wired to the remote-role paths and
  commands.
- [ ] **Step 4: Implement only additive remote-role reuse.** Extend the shared factories/types when
  necessary, then instantiate them with `role: "remote"` and Task 1's remote persistent, transient,
  and ordinary-log paths.
  Pass only the closed numeric control-profile/runtime-purpose fields through the authenticated
  HELLO; ordinary app commands never accept or derive an origin.
  Preserve the inherited-pipe capability, POSIX mode-`0600` UDS, current-user-only Windows named
  pipe, and secret-free logging invariants already implemented by Part 05. Do not reimplement or
  alter the host Fastify/helper startup and shutdown lifecycle here.
- [ ] **Step 5: Verify fake and real smoke.**

  Run: `npx vitest run tests/remoteHelperReuse.test.ts tests/helperClient.test.ts tests/helperSupervisor.test.ts && npm run typecheck`

  Expected: PASS with both fake roles alive concurrently. After Gate B supplies a signed
  development binary, run Part 05's shared contract smoke once per role and expect protocol/
  capability agreement without weakening direct-only or role-isolation assertions.
- [ ] **Step 6: Suggested commit.**

  `feat: reuse ts-connect supervisor for remote role`

---

### Task 6: Secure isolated remote browser gateway

**Gate:** Gate A required. Use a fake selected-host transport until Gate B.

**Files:**

- Create: `src/remote/gateway/server.ts`
- Create: `src/remote/gateway/session.ts`
- Create: `src/remote/gateway/security.ts`
- Create: `src/remote/gateway/browserContext.ts`
- Create: `src/remote/gateway/originStore.ts`
- Create: `src/remote/gateway/runtime.ts`
- Test: `tests/remoteGatewaySecurity.test.ts`
- Test: `tests/remoteOriginStore.test.ts`

**Symbols:**

- `startRemoteGateway(options): Promise<RunningRemoteGateway>`
- `RemoteBrowserSessionStore`
- `createRemoteBrowserContext(session, validatedRequest)`
- `RemoteOriginStore.allocateOrReuse(pinnedHostId, hostTrustEpoch)` transactionally reusing or
  allocating from global high-water and returning a distinct `localOriginEpoch`
- `RemoteOriginStore.rotateForPortFailover(pinnedHostId, expectedOriginEpoch)` atomically allocating
  a greater epoch before a replacement-port listener becomes reachable
- `validateRemoteBrowserRequest(request, session)`

- [ ] **Step 1: Write failing origin tests.** Pin byte vectors for the exact plan 00 derivation:
  32-byte seed, `SHA-256("waifus/host-id/v1" || installation public key)`, domain separator plus
  NUL, 32-byte host ID, `uint64BE(localOriginEpoch)`, full HMAC-SHA256, exactly 52 lowercase
  unpadded RFC 4648 Base32 characters using `abcdefghijklmnopqrstuvwxyz234567`, and the exact
  `waifus-<52 chars>.localhost` hostname. Assert it is stable
  across launches for one pinned host/local-origin epoch, differs across hosts/seeds/epochs, and
  advances/rotates on an authenticated host-trust change, local forget, or revoke. Before deleting a
  remembered host, preserve a single owner-only global origin-epoch high-water; offline forget
  followed by re-pairing that identical installation key must increment it, allocate a strictly
  greater epoch, and must not reopen its old cookies/storage. Counter exhaustion fails closed until
  identity reset supplies a fresh origin seed. Store/serialize epochs as canonical uint64 decimal
  strings and use `bigint`; include `MAX_SAFE_INTEGER + 1` and uint64-max-minus-one allocation
  vectors with overflow refusal. Assert the gateway reuses its preferred initially-random port
  when available. If it is unavailable, bind a replacement loopback listener without serving,
  atomically allocate a greater local origin epoch/hostname, and only then expose the bootstrap;
  never reuse the old hostname on a different port or migrate cookies/storage. Exercise a malicious
  host-only cookie and `Domain=localhost` attempt across the failover and across two hostnames in
  real Chromium, Firefox, and WebKit/Safari-family gates; parent-domain acceptance is a release
  blocker. Session cookies must rotate even when the hostname and port are reused after a gateway
  restart.
- [ ] **Step 2: Write failing browser-security tests.** Cover one-use bootstrap token path,
  immediate `303` to a token-free URL, an unexposed per-launch cookie name with at least 128 random
  bits, a host-only `HttpOnly; SameSite=Strict; Path=/` session cookie, exactly 32 random session
  bytes, 30-minute idle expiry, eight-hour absolute expiry, rotation each
  launch, and a separate exactly 32-random-byte session-bound CSRF token/header. Cover exact
  Host/Origin, missing/wrong/cross-session CSRF on
  mutations, DNS rebinding Host, cross-site Fetch Metadata, forged `X-Device-*`/internal headers,
  no CORS wildcard, and closed old listeners after host switch. After successful validation, create
  strict `RemoteBrowserContextV1` with a 32-byte gateway launch ID, exact unexposed 32-byte browser
  session ID, fresh per-request nonce, method/canonical concrete target, CSRF result, and helper-
  supplied direct-session/stream/device/trust proof. Reject attempts to pass any of these fields in
  browser headers/body or reuse them across launch/session/request/host.
- [ ] **Step 3: Pin policy headers separately.** Downloaded host dashboards require a gateway-owned HTTP CSP containing
  `sandbox allow-scripts allow-forms allow-same-origin allow-downloads` and same-origin-only asset,
  form, and connection directives, including at least `default-src 'self'`,
  `connect-src 'self'`, `worker-src 'none'`, `frame-ancestors 'none'`, `object-src 'none'`,
  `base-uri 'none'`, and `form-action 'self'`. No `allow-popups` or top-navigation sandbox token is
  permitted. Require `Permissions-Policy` and `Referrer-Policy: no-referrer`. Host-supplied code
  and host CSP/CORS/cookie headers cannot weaken or replace the gateway response headers. The
  locally bundled connection shell has a separate fixed CSP that adds only sandbox
  `allow-popups`, solely so its reviewed activation anchor can open the exact Worker activation
  origin with `target=_blank rel="noopener noreferrer"`; it still has no top-navigation or
  `allow-popups-to-escape-sandbox`, accepts no host-supplied code, and cannot open an arbitrary URL.
  Assert `allow-popups` is absent from every downloaded-dashboard response.
- [ ] **Step 4: Run tests.**

  Run: `npx vitest run tests/remoteOriginStore.test.ts tests/remoteGatewaySecurity.test.ts`

  Expected: FAIL because the gateway is absent.
- [ ] **Step 5: Implement.** Bind loopback only. The unauthenticated surface serves only the
  minimum bootstrap needed to consume the one-use local session token; all shell, local API,
  dashboard, and proxy routes require the resulting session. Persist the exactly 32-random-byte
  `local-origin-seed` and the
  preferred port, local-origin epochs, and global origin-epoch high-water in owner-only
  remote-gateway state.
  Derive the hostname from the frozen HMAC formula rather than storing a random label, advance the
  local origin epoch transactionally before forget/revoke. On preferred-port failure, bind the
  replacement without serving, rotate the epoch/hostname transactionally, then expose it; never
  serve the old hostname on the replacement port. Send validated browser
  context only through the authenticated role-neutral `HelperClient`; never forward gateway cookies,
  CSRF tokens, or internal context fields as HTTP headers.
- [ ] **Step 6: Verify.**

  Run: `npx vitest run tests/remoteOriginStore.test.ts tests/remoteGatewaySecurity.test.ts && npm run typecheck`

  Expected: PASS; a request with a forged remote-device header remains an unauthenticated local
  browser request and is rejected.
- [ ] **Step 7: Suggested commit.**

  `feat: isolate remote dashboards behind local browser sessions`

---

### Task 7: Connection shell and gateway-owned local API

**Gate:** Gateway-owned DTOs from Gate A required. Pair cryptography stays in `ts-connect`.

**Files:**

- Create: `src/frontend/remote-shell/index.html`
- Create: `src/frontend/remote-shell/main.tsx`
- Create: `src/frontend/remote-shell/App.tsx`
- Create: `src/frontend/remote-shell/api.ts`
- Create: `src/frontend/remote-shell/types.ts`
- Create: `src/frontend/remote-shell/styles.css`
- Create: `src/frontend/remote-shell/vite.config.ts`
- Create: `src/remote/gateway/localApi.ts`
- Create: `src/remote/rememberedHosts.ts`
- Modify: `package.json` (`build:remote-shell`, `build`, `files`)
- Test: `tests/remoteLocalApi.test.ts`
- Browser test later: `tests/e2e/remote-shell.spec.ts`

**Exact local routes:**

Every route under `/_waifus_remote/v1/*` is registered only for the installed connection-shell
Host/origin and its shell-scoped session. On any selected downloaded-dashboard origin, every such
path returns the same `404` and never reveals whether a host, activation, pair request, or operation
exists. The selected host dashboard receives only gateway-owned `GET /api/client-context` plus its
strict selected-host `/api` proxy; it cannot enumerate or mutate the remote device's other remembered
hosts or local trust.

- `GET /_waifus_remote/v1/bootstrap`
- `POST /_waifus_remote/v1/activation`
- `GET /_waifus_remote/v1/activation/:activationOperationId`
- `DELETE /_waifus_remote/v1/activation/:activationOperationId`
- `GET /_waifus_remote/v1/hosts`
- `POST /_waifus_remote/v1/pair`
- `GET /_waifus_remote/v1/pair/:pairOperationId`
- `DELETE /_waifus_remote/v1/pair/:pairOperationId`
- `POST /_waifus_remote/v1/hosts/:hostId/connect`
- `POST /_waifus_remote/v1/hosts/:hostId/disconnect`
- `DELETE /_waifus_remote/v1/hosts/:hostId`
- `GET /_waifus_remote/v1/events`

`POST /pair` accepts exactly one strict `{kind:"full_token", token}` or
`{kind:"short_code", code}` body and returns `202 PairStartResult` containing only a separate
32-random-byte local `pairOperationId`, its same-origin status path, initial state, and expiry. One live pair operation is allowed
per shell browser session. Same-session `GET`, always `no-store`, is the sole browser detail resource:
when its state is `verification_required`, it may include the helper-derived five SAS words,
12-character fingerprint, claimed host name/platform/installation fingerprint, entry-flow label,
and expiry. `DELETE` cancels and erases the helper operation. Local SSE carries only opaque operation
ID/state transitions, never SAS/fingerprint/identity details.

- [ ] **Step 1: Write failing route tests.** Require exact local session/CSRF, strict Zod bodies,
  unknown-field rejection, no arbitrary destination fields, redacted bootstrap, remembered-host
  partitioning by data root, one-host autoselect, multi-host selector, signed self-revocation before
  reachable forget, explicit warning for offline local-only forget, and epoch-aware local events.
  `/_waifus_remote/v1/bootstrap` and pre-connection shell HTML use gateway-owned
  `Cache-Control: no-store`; no helper/session/CSRF/pair state is cacheable.
  The credentialed shell bootstrap returns its exact 43-character session-bound CSRF token only in
  gateway-owned `X-Waifus-CSRF`; the installed shell reads it from that response and keeps it in
  memory. It is absent from HTML, URLs, browser storage, events, logs, and every downloaded-host
  origin.
  Pairing detail resources are browser-session/operation-bound and expose only the helper-derived
  five-word SAS, 12-character hexadecimal fingerprint, host device name/platform/installation
  fingerprint, entry-flow label, and expiry needed for attended comparison—never the full token,
  PSK, Noise state, identity private material, endpoint candidates, or generic mailbox bytes. Events
  carry only opaque operation IDs and sanitized transition names. Table-test every
  listed local route from a downloaded Host A origin/session and require indistinguishable `404`,
  with no Host B/local-state read or mutation and no event subscription.
- [ ] **Step 2: Write remote activation tests.** A fresh remote-only root starts in
  `activation_required` without silently creating a Worker challenge or opening a browser. `POST`
  begins activation only after an explicit shell gesture and returns a separate 32-random-byte local
  `activationOperationId`, exact validated fragment-only verification URL, and expiry with
  `no-store`; `GET` polls only for the same shell/browser session and returns sanitized `no-store` state;
  `DELETE` cancels it. The helper alone maps that local handle to the Worker activation ID, signs
  begin/poll, verifies/vault-stores the certificate, and never exposes either the Worker ID or
  certificate. On a user click, the trusted shell may
  open only the validated `https://pair.waifucave.com/activate#...` (or configured staging host) with
  `noopener,noreferrer`; host-supplied dashboard JavaScript never receives a general URL opener.
- [ ] **Step 3: Write secret-lifetime tests.** Full token and short code enter only `/pair`, are
  passed directly into helper memory, and never appear in state files, browser storage, events,
  diagnostics, audit, errors, or logs. Reject pair tokens in URL query and CLI argv. The derived
  SAS/fingerprint may exist only in the bound shell's in-memory attended-comparison state and is
  erased on approve/reject/cancel/expiry, host switch, session close, or gateway restart.
  Pin `PairStartResult`, same-session GET/DELETE ownership, one-live-operation cap, helper crash,
  repeated poll/cancel, completion, and exact erasure. Random/cross-session/expired operation IDs are
  indistinguishable `404`; no URL, browser storage, event, audit, or log contains the token/code or
  attended-comparison fields.
- [ ] **Step 4: Run focused tests.**

  Run: `npx vitest run tests/remoteLocalApi.test.ts`

  Expected: FAIL because the routes are absent.
- [ ] **Step 5: Implement the local API and minimal shell.** Before connection, never serve the
  installed full Waifus dashboard as a substitute. The shell displays activation, pair entry,
  remembered hosts, sanitized state, reconnect, and direct-unavailable explanations. For both
  entry flows it displays the exact helper-derived five-word SAS and short hex fingerprint beside
  the host name/platform/fingerprint; short-code pairing cannot proceed without the attended
  comparison and exact host-side approval. The shell does not derive, parse, or implement
  Noise/Tailscale messages itself. The shell uses its own loopback Host/origin and shell-scoped
  session; after selection the gateway redirects through a one-use bootstrap into the derived
  per-host origin, whose downloaded dashboard cannot call any `/_waifus_remote/v1/*` route.
- [ ] **Step 6: Build and verify.**

  Run: `npm run build:remote-shell && npx vitest run tests/remoteLocalApi.test.ts && npm run typecheck`

  Expected: PASS; `dist-remote-shell` contains only the shell and no provider/user data.
- [ ] **Step 7: Suggested commit.**

  `feat: add the local remote connection shell`

---

### Task 8: Selected-host proxy, exact dashboard serving, and reconnect behavior

**Gate:** Gates A, B, and C required for final integration; fake transports first.

**Files:**

- Create: `src/remote/gateway/proxy.ts`
- Create: `src/remote/gateway/headerPolicy.ts`
- Create: `src/remote/gateway/selectedHost.ts`
- Modify: `src/remote/gateway/server.ts`
- Modify: `src/remote/dashboardDownloader.ts`
- Test: `tests/remoteProxy.test.ts`
- Test: `tests/remoteDashboardServing.test.ts`

**Allowed surface after host selection:**

- Manifest-declared dashboard assets for exactly the selected pinned host/build.
- Same-origin `/api` requests to exactly that host's Waifus service.
- Required HTTP request/response streaming, binary bodies, uploads/downloads, cancellation, and
  SSE. No generic HTTP/SOCKS proxy and no arbitrary overlay address.
- `GET /api/client-context` is intercepted locally and returns sanitized `{mode:"remote", ...}`
  plus the current session's exact `X-Waifus-CSRF` response header with `no-store`; neither is
  forwarded to obtain a local-host context.

- [ ] **Step 1: Write failing proxy parity tests.** Cover methods, query strings, status codes,
  JSON, zero-length bodies, binary bodies, bounded uploads/downloads, request/response streaming,
  client abort propagated to helper cancel, host abort, SSE framing/cursors, and backpressure. For a
  reconciled mutation, drop the direct path after its `202`, reconnect with the same actor/trust
  epoch, and recover the identical redacted result from its returned
  `/api/admin/operations/:operationId` URL; a different device or stale epoch receives `404`.
- [ ] **Step 2: Write failing policy tests.** Reject absolute-form URLs, CONNECT, alternate host,
  arbitrary overlay destination, `/_waifus_remote/` proxy attempts, undeclared asset, traversal,
  and unknown required proxy capabilities. Strip hop-by-hop/internal headers, host `Set-Cookie`,
  CORS, CSP, service-worker headers, and unsafe redirects. Rewrite only safe same-host redirects to
  the selected local origin. Strip host cache validators/policy and assert gateway-owned serving:
  dashboard manifest, `index.html`, `/api/client-context`, and sensitive bootstrap use
  `Cache-Control: no-store`; verified hashed assets use their manifest SHA-256 as ETag plus
  `Cache-Control: public, max-age=31536000, immutable`. Prove stripped browser/internal headers
  cannot manufacture `RemoteBrowserContextV1`; only gateway validation followed by remote-helper
  app-session proof reaches the host, and stale launch/cross-device/method/target/stream substitution
  fails before Fastify dispatch.
- [ ] **Step 3: Write dashboard lifecycle tests.** Require the canonical manifest to arrive only
  through the authenticated current pinned-host/trust-epoch application session, helper/remote
  minimum versions, transport-major equality, optional minor capability negotiation, hash-verified
  full cache install before execution, old-host/new-remote and new-host/old-compatible-remote,
  incompatible-major refusal, and host build change causing drain/cache/reload rather than mixed
  execution.
- [ ] **Step 4: Run focused tests.**

  Run: `npx vitest run tests/remoteProxy.test.ts tests/remoteDashboardServing.test.ts`

  Expected: FAIL because the proxy is absent.
- [ ] **Step 5: Implement.** The remote Node gateway speaks only the helper's selected-host service
  API. Forward the exact dashboard-supplied `Idempotency-Key` and bytes, but never generate a key,
  decide that two HTTP attempts are one logical mutation, or automatically retry any request; Task
  10's route-aware frontend wrapper owns that decision. Keep the browser open and serve the
  local connection banner/shell state while transport reconnects. Generate cache headers locally
  from the verified manifest/route class; never forward host cache policy or cache sensitive HTML/
  bootstrap data.
- [ ] **Step 6: Verify.**

  Run: `npx vitest run tests/remoteProxy.test.ts tests/remoteDashboardServing.test.ts tests/dashboardCache.test.ts && npm run typecheck`

  Expected: PASS; test counters show zero requests to any unselected destination.
- [ ] **Step 7: Suggested commit.**

  `feat: proxy selected hosts through verified direct sessions`

---

### Task 9: `waifus remote` CLI and dual-daemon status

**Files:**

- Modify: `src/cli/parser.ts` (`CliCommand`, nested remote action parsing)
- Refactor/modify: `src/cli/commands.ts`
- Create: `src/cli/remoteCommand.ts`
- Create: `src/cli/processState.ts`
- Create: `src/cli/openBrowser.ts`
- Modify: `src/backend/runtime.ts`
- Test: `tests/remoteCli.test.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/doctor.test.ts`

**CLI contract:**

```text
waifus remote [--foreground] [--no-open] [--host ID_OR_NAME] [--port PORT] [--data-root PATH]
waifus remote status [--data-root PATH]
waifus remote stop [--data-root PATH]
```

- [ ] **Step 1: Write parser/help tests.** Pin nested `status|stop`, flags, unknown subcommand
  errors, data-root environment behavior, and help text. A positional full pairing token must be
  rejected with instructions to paste it into the local shell/protected prompt.
- [ ] **Step 2: Write lifecycle tests with injected process/browser functions.** Cover detached
  start, `--foreground`, `--no-open`, browser opens only after health, `--host` forwarding by stable
  remembered-host ID/name, stale PID cleanup, remote stop only, host stop only, coexistence, and
  distinct logs/runtime files. `waifus status` returns success if either daemon is alive and prints
  separate `host` and `remote` objects; `waifus remote status` succeeds only for the remote daemon.
- [ ] **Step 3: Write unsupported/missing-helper tests.** Intel macOS and absent/corrupt helper
  fail before daemon spawn with doctor guidance. `waifus start` remains usable on Intel macOS while
  host remote access is disabled.
- [ ] **Step 4: Run focused tests.**

  Run: `npx vitest run tests/remoteCli.test.ts tests/cli.test.ts tests/doctor.test.ts`

  Expected: FAIL because `remote` is not a command.
- [ ] **Step 5: Implement.** Extract reusable PID/read/wait/stop logic instead of duplicating the
  current host implementation. Use injected browser opening for tests and platform-specific local
  commands only after a healthy tokenized URL exists. Never pass pair secrets or inherited helper
  capability through browser/process argv.
- [ ] **Step 6: Implement doctor/status summaries.** Doctor verifies package/signature/version/
  protocol and reports sanitized helper/control/STUN/UDP/port-mapping/direct status when available;
  it does not show raw endpoint candidates by default.
- [ ] **Step 7: Verify.**

  Run: `npx vitest run tests/remoteCli.test.ts tests/cli.test.ts tests/doctor.test.ts && npm run build:backend`

  Expected: PASS; `node bin/waifus.mjs help` lists the nested commands from compiled `dist`.
- [ ] **Step 8: Suggested commit.**

  `feat: add waifus remote daemon commands`

---

### Task 10: Client context, connection banner, and Remote Access settings

**Gate:** Gate C host endpoints and DTOs required.

**Files:**

- Modify: `src/frontend/api/types.ts`
- Modify: `src/frontend/api/client.ts`
- Create: `src/frontend/api/logicalMutation.ts`
- Create: `src/frontend/api/retryPolicy.ts` generated/checked against the shared route-policy manifest
- Create: `src/frontend/state/clientContext.tsx`
- Create: `src/frontend/state/remoteAccessStore.ts`
- Create: `src/frontend/components/RemoteConnectionBanner.tsx`
- Create: `src/frontend/components/remoteAccess/RemoteAccessTab.tsx`
- Create: `src/frontend/components/remoteAccess/InvitationCard.tsx`
- Create: `src/frontend/components/remoteAccess/PairingRequestCard.tsx`
- Create: `src/frontend/components/remoteAccess/TrustedDevices.tsx`
- Create: `src/frontend/components/remoteAccess/RemoteDiagnostics.tsx`
- Modify: `src/frontend/App.tsx`
- Modify: `src/frontend/nav.ts`
- Modify: `src/frontend/screens/SettingsScreen.tsx`
- Modify: `src/frontend/screens/scaffold.tsx`
- Modify: `src/frontend/styles/system.css`
- Test: `tests/frontendRemoteState.test.ts`
- Test: `tests/frontendLogicalMutation.test.ts`
- Browser test later: `tests/e2e/remote-settings.spec.ts`

**Consumes:** the committed `/api/remote-access*` route table and `GET /api/client-context`.

- [ ] **Step 1: Write failing pure state tests.** Fixture host and remote client contexts; pin
  `Connected directly`, `Reconnecting`, and `Direct connection unavailable` states, snapshot after
  cursor reset, host/build switch, and stale request cancellation. `dataRoot`, endpoint plaintext,
  helper capability token, and pairing secret are not frontend DTO fields. Remote context may expose
  only the gateway-generated nonsecret exact connection-shell origin (no bootstrap/session token),
  never local shell state or another remembered host.
  Table-test every frontend mutation wrapper against its route retry class. One logical action must
  create a 32-random-byte base64url `Idempotency-Key` before its first request and retain key,
  canonical target/body hash, class, and any returned operation URL in memory until definitive
  completion; a second user action gets a new key.
- [ ] **Step 2: Run the focused test.**

  Run: `npx vitest run tests/frontendRemoteState.test.ts tests/frontendLogicalMutation.test.ts`

  Expected: FAIL because the client-context/remote store does not exist.
- [ ] **Step 3: Implement bootstrap and banner.** Fetch client context before mounting actor-sensitive
  controls. The same host dashboard bundle renders host/remote mode; do not rewrite executable JS.
  Keep the UI mounted during reconnect and make read refresh explicit after reconnection. The banner
  renders the exact nonsecret connection-shell origin as copy-only text and instructs the user to use
  browser Back or rerun `waifus remote`; it does not weaken the downloaded-dashboard no-navigation/
  no-popup CSP. Host JavaScript may know that origin but cannot fetch/read its response or state.
- [ ] **Step 4: Implement Settings → Remote Access.** Show lifecycle, versions/capabilities,
  direct/control status, last direct connection, enable/disable, invite QR/copy/manual code/expiry,
  pending safety phrase/fingerprint approval, device rename/revoke, reconnect, and sanitized
  diagnostics. Local-only reset is visible with explanation but disabled remotely; on host it
  requires the typed destructive flow.
- [ ] **Step 5: Enforce remote external-link behavior.** Add a context-aware link component and
  replace the current provider docs and Discord guide external anchors. In remote mode render a
  copy-only, non-clickable URL; never call a host-controlled local URL-opener.
- [ ] **Step 6: Add CSRF and stream-session support to the client.** Browser mutations include the
  gateway/host session's CSRF header, read from the same-origin `GET /api/client-context` response
  and retained in memory only. Do not place auth session or CSRF tokens in JS storage. The shared
  fetch-based SSE GET uses same-origin credentials, explicit `Last-Event-ID` on reconnect, and
  server-side Origin/session checks; do not replace it with native `EventSource` where the client
  must control the resume header.
- [ ] **Step 7: Implement logical mutation recovery.** Generate/check the frontend retry-policy map
  from the shared reviewed route inventory so a new mutation cannot silently omit a class. On a
  transport break, reuse the existing key only for its same transactional/reconciled logical action,
  or poll an already received operation URL. Never automatically repeat `non_replayable`; surface
  `outcome_unknown`, refresh observable state, and require a new explicit action. Invitation recovery
  uses its named special rule. Keys are nonsecret but remain process-memory state, not URL or browser
  storage.
- [ ] **Step 8: Verify.**

  Run: `npx vitest run tests/frontendRemoteState.test.ts tests/frontendLogicalMutation.test.ts && npm run typecheck && npm run build:frontend`

  Expected: PASS; both host and remote fixtures build from the same frontend source.
- [ ] **Step 9: Suggested commit.**

  `feat: add remote access dashboard controls`

---

### Task 11: Epoch-aware frontend streams

**Gate:** Host event-cursor primitives from Gate C required.

**Files:**

- Modify/reuse: `src/frontend/api/eventCursor.ts` created atomically with the backend cursor migration in plan 01
- Modify: `src/frontend/api/client.ts` (`openEventStream`)
- Modify: `src/frontend/state/runtimeStore.ts`
- Modify: `src/frontend/state/assistantChat.ts`
- Modify: `src/frontend/screens/ActivityScreen.tsx`
- Modify: `src/frontend/state/remoteAccessStore.ts`
- Modify/extend: `tests/frontendEventCursor.test.ts`
- Test: `tests/assistantConversations.test.ts`

**Symbols:**

- `parseEventCursor`
- `compareEventCursor`
- `ResumableEventFeed`

- [ ] **Step 1: Write failing cursor/reducer tests.** Parse only the exact SSE ID
  `v1:<base64url-unpadded 16-byte epoch>:<decimal sequence>` with a 128-bit epoch. Cover duplicate
  sequence, ordered new event, `Last-Event-ID` reconnect replay, process epoch change, a replay gap
  beyond the host's exact 2,000-event-or-8-MiB-per-stream ring, malformed/noncanonical cursor,
  revoked session, canonical reset/snapshot before resubscribe, and separate cursor state per
  runtime/activity/assistant/remote-access stream. Preserve plan 01's numeric-ID rejection and
  assistant compatibility tests while extending the primitive to the other feeds.
- [ ] **Step 2: Run tests.**

  Run: `npx vitest run tests/frontendEventCursor.test.ts tests/assistantConversations.test.ts`

  Expected: FAIL because runtime/activity/remote-access consumers do not yet use the shared
  resumable cursor primitive, even though plan 01 already migrated the assistant consumer.
- [ ] **Step 3: Extend the plan 01 primitive.** Reuse its credentialed `fetch` plus incremental SSE
  parser and `AbortController`; record the last complete exact cursor, explicitly send it as
  `Last-Event-ID`, recognize the server's canonical reset/snapshot signal, abort, fetch the canonical
  snapshot endpoint, clear stale feed state as appropriate, and open a new stream. Never apply events
  from an old selected host/trust epoch to a new one. Reuse the frozen cursor parser/constants from
  the shared contract; do not add a second client-only encoding or replay limit. Add a real-browser
  harness assertion that the reconnect request contains the exact header and an aborted feed leaves
  no duplicate listener or parser.
- [ ] **Step 4: Verify.**

  Run: `npx vitest run tests/frontendEventCursor.test.ts tests/assistantConversations.test.ts && npm run typecheck`

  Expected: PASS.
- [ ] **Step 5: Suggested commit.**

  `feat: resume dashboard streams with epoch cursors`

---

### Task 12: Assistant actor ownership and principal-preserving tools

**Gate:** Principal/trust-epoch contract and internal authenticated injection from Gate C required.

**Files:**

- Modify: `src/api/assistant/conversations.ts`
- Modify: `src/api/assistant/routes.ts`
- Modify: `src/api/assistant/service.ts`
- Modify: `src/api/assistant/tools.ts`
- Test: `tests/assistantConversations.test.ts`
- Test: `tests/assistantApi.test.ts`
- Test: `tests/assistantTools.test.ts`
- Test: `tests/assistantTurn.test.ts`

**Required changes:**

- `ConversationStore.create(owner)` binds immutable actor ID/type, trust epoch, and browser session.
- Every conversation list/read/message/stream/delete checks that owner and current authorization.
- `AssistantToolContext` carries actor and `{conversationId, toolCallId, actionId?}` delegation.
- Every `app.inject` uses the principal-preserving internal injection helper; missing internal actor
  metadata is an error, never local-admin fallback.
- `toolDefs(context)` may hide tools by principal/capability.

- [ ] **Step 1: Write failing ownership tests.** Local actor A cannot read remote B's conversation;
  remote B cannot read local A's; remote B retains its device principal through target resolution,
  snapshot reads, tools, and retries; revocation/trust-epoch change invalidates conversation,
  active stream, queued tool, and subsequent turn.
- [ ] **Step 2: Write forged/fallback tests.** Direct `app.inject` from an assistant path without
  explicit actor must fail rather than becoming local. Client headers cannot manufacture actor B.
- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/assistantConversations.test.ts tests/assistantApi.test.ts tests/assistantTools.test.ts tests/assistantTurn.test.ts`

  Expected: FAIL because conversations have no owner and tool context is `{app}` only.
- [ ] **Step 4: Implement owner-aware conversation/service plumbing.** Preserve current LRU/busy/
  transcript limits while making all lookup/list/subscription methods actor-aware. Redact actor
  details in model-visible strings; audit retains stable device attribution separately.
- [ ] **Step 5: Verify.**

  Run: `npx vitest run tests/assistantConversations.test.ts tests/assistantApi.test.ts tests/assistantTools.test.ts tests/assistantTurn.test.ts && npm run typecheck`

  Expected: PASS; remote tool mutations are audited as that remote actor.
- [ ] **Step 6: Suggested commit.**

  `feat: bind assistant sessions and tools to actors`

---

### Task 13: Generic secure assistant actions and remote-access tools

**Gate:** Task 12 and host remote-access API required.

**Files:**

- Create: `src/api/assistant/actions.ts`
- Modify: `src/api/assistant/conversations.ts` (`confirmation_required` event)
- Modify: `src/api/assistant/routes.ts` (three action routes)
- Modify: `src/api/assistant/service.ts`
- Modify: `src/api/assistant/tools.ts`
- Modify: `src/api/routePolicyManifest.ts`
- Modify: `src/frontend/api/types.ts`
- Modify: `src/frontend/api/client.ts`
- Modify: `src/frontend/state/assistantChat.ts`
- Modify: `src/frontend/components/assistant/AssistantPanel.tsx`
- Test: `tests/assistantActions.test.ts`
- Test: `tests/assistantTools.test.ts`
- Test: `tests/assistantApi.test.ts`
- Modify: `tests/routePolicy.test.ts`
- Browser test later: `tests/e2e/assistant-remote-actions.spec.ts`

**Action routes:**

- `GET /api/assistant/actions/:actionId`
- `POST /api/assistant/actions/:actionId/confirm`
- `DELETE /api/assistant/actions/:actionId`

**Remote-access tools:**

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

- [ ] **Step 1: Write failing action-store tests.** Require high-entropy IDs and actor/session/trust-
  epoch binding, including the current host-browser-server launch ID for a local actor or the
  helper-verified remote gateway launch ID for a remote actor, plus the exact browser session ID;
  exact action/resource/payload hash, the frozen five-minute expiry, single atomic
  consume, cancel, concurrent confirm race, gateway restart/stale-launch and revocation invalidation,
  sanitized summaries, redacted
  receipts, and no request body/pair secret/confirmation token in logs or transcripts. Enforce at
  most 16 live actions per actor/browser-session pair, 256 live actions and 4 MiB globally, 32 KiB
  canonical stored record size including exact payload/metadata, and 8 KiB each for its sanitized
  summary or receipt within that record. Cleanup removes only expired/consumed records, never a live
  action; any count/byte/record cap fails closed before emitting an event or executing a mutation.
  Classify all
  three action routes in the reviewed manifest with principal/session, retry, audit, and field
  policies; the inventory test must fail if any route or automatic HEAD surface is unclassified.
- [ ] **Step 2: Write failing tool behavior tests.** Status/list/diagnostics/reconnect/rename/reject
  may call reviewed APIs directly. Enable/disable, approve, revoke, and cancelling another actor's
  invitation create a pending action and emit `confirmation_required`. Requesting an invitation
  emits a secure dashboard-card request; only the browser calls the invitation endpoint and sees
  its QR/code. Freeze an assistant-safe pairing-request DTO containing only request ID, claimed
  display name/platform, and expiry. SAS words, fingerprint, transcript/channel binding, invitation
  generation, and identity bundles never enter tool definitions/arguments/results, model/chat rows,
  `confirmation_required` events, completion receipts, logs, or audit. The model approves by opaque
  request/action ID only. Remote identity reset is not a tool.
- [ ] **Step 3: Run focused tests.**

  Run: `npx vitest run tests/assistantActions.test.ts tests/assistantTools.test.ts tests/assistantApi.test.ts tests/routePolicy.test.ts`

  Expected: FAIL because no pending-action resource/event exists.
- [ ] **Step 4: Implement backend actions and tools.** Store the exact mutation server-side. The
  browser confirms only an action ID with normal CSRF; it cannot replace the target/payload. Recheck
  current actor/trust epoch both when the tool creates the action and when confirmation consumes it.
  Apply the frozen caps before insertion and fail closed rather than evicting another live action.
- [ ] **Step 5: Implement secure cards.** `AssistantPanel` renders from the typed
  `confirmation_required` event, which carries only the opaque action ID/category and assistant-safe
  summary. For pairing approval, the actor/session-bound, `no-store` browser action-detail request
  fetches the current helper-derived SAS/fingerprint and claimed identity directly for the secure
  card; the action store retains only request ID, exact mutation hash, and binding metadata, never
  the Noise transcript or identity bundle. Revalidate those details/generation at confirmation.
  Invitation QR/code comes from the direct browser invitation response, not tool call arguments/
  results. Neither verification card data nor a redacted completion receipt is appended to the chat
  transcript; the receipt may show only generic success/failure and opaque resource ID.
- [ ] **Step 6: Update the assistant prompt.** Explain direct-only availability, remote actor
  boundaries, secure cards, and that `/api/runtime/stop` stops a channel run—not the host process.
  Do not tell the model it can restart/stop the host OS process.
- [ ] **Step 7: Verify.**

  Run: `npx vitest run tests/assistantActions.test.ts tests/assistantConversations.test.ts tests/assistantApi.test.ts tests/assistantTools.test.ts tests/assistantTurn.test.ts tests/routePolicy.test.ts && npm run typecheck`

  Expected: PASS; fixture secrets are absent from serialized conversation/event/audit/log output.
- [ ] **Step 8: Suggested commit.**

  `feat: confirm remote access actions outside assistant chat`

---

### Task 14: Clean semantics and preserved trust proof

**Files:**

- Modify: `src/cli/commands.ts` (`cleanCommand`)
- Modify: `src/remote/paths.ts`
- Modify: `src/remote/rememberedHosts.ts`
- Test: `tests/remoteClean.test.ts`
- Test: `tests/cli.test.ts`

- [ ] **Step 1: Write a seeded failing test.** Create ordinary user/config/cache data, verified
  dashboard cache, sessions/actions/invitations, host remote-access enabled/settings state,
  installation ID/activation credential/OS-secret references, role key metadata, trusted devices,
  remembered hosts, pair records, deny/trust epochs, operations, ordinary host/remote logs,
  transient role-runtime files, and administrative audit. Assert
  clean refuses without mutating any sentinel if either the host or remote PID is alive.
- [ ] **Step 2: Pin post-clean state.** After stopped/confirmed clean: ordinary user/config/cache
  state, `app/cache/remote-dashboard/`, and transient sessions/actions/invitations are gone. The
  installation identity, activation credential, host enabled/settings state, role references,
  trusted devices/pairings, remembered hosts, deny/trust epochs, operations, and audit remain
  byte-identical. Output includes the exact preserved pairing count and an explicit instruction to
  use the typed identity-reset flow in local Settings → Remote Access. `--force` skips the prompt
  but never bypasses the running-process refusal.
- [ ] **Step 3: Pin log/runtime behavior.** Exact `app/tmp/remote-host/` and
  `app/tmp/remote-gateway/` live state is
  removed once both daemons are stopped. Ordinary `app/logs/remote-host.log` and
  `app/logs/remote-gateway.log` files remain
  without `--include-logs` and are deleted with it; `app/remote-access/audit/` survives both cases.
- [ ] **Step 4: Run tests.**

  Run: `npx vitest run tests/remoteClean.test.ts tests/cli.test.ts`

  Expected: FAIL because current clean deletes broad paths without remote-aware reporting.
- [ ] **Step 5: Implement using explicit allow/delete paths.** Delete only the existing ordinary
  roots, named transient session/action/invitation records, exact role runtime paths under
  `app/tmp/`, the `app/cache/remote-dashboard/` cache, and—only with `--include-logs`—the exact
  ordinary role logs. Preserve every frozen retained record beneath
  `app/remote-access/` and `app/remote-gateway/` rather than deleting an ancestor and trying to
  reconstruct security state afterward. Resolve every destructive target under the canonical data
  root and preserve unrelated roots.
- [ ] **Step 6: Verify.**

  Run: `npx vitest run tests/remoteClean.test.ts tests/cli.test.ts && npm run typecheck`

  Expected: PASS with preserved trust hashes unchanged.
- [ ] **Step 7: Suggested commit.**

  `fix: preserve remote identities and pairings during clean`

---

### Task 15: Browser integration and malicious-host isolation

**Gate:** Tasks 6–13 complete with fake helper; use a deterministic two-end fake transport first.

**Files:**

- Create: `playwright.config.ts`
- Create: `tests/e2e/fixtures/remoteHarness.ts`
- Create: `tests/e2e/remote-shell.spec.ts`
- Create: `tests/e2e/remote-dashboard.spec.ts`
- Create: `tests/e2e/remote-settings.spec.ts`
- Create: `tests/e2e/assistant-remote-actions.spec.ts`
- Modify: `package.json` (`test:e2e`, required test dependency)

- [ ] **Step 1: Build a deterministic harness** that runs a local remote gateway and two fake
  pinned hosts with distinct trust epochs/dashboard builds. It must record all attempted egress,
  proxy destinations, headers, event cursors, and cancellation messages.
- [ ] **Step 2: Test the connection shell.** Pair input never enters URL/storage; one host
  autoconnects; multiple hosts select; direct-unavailable keeps the shell usable; reconnect loads
  the verified dashboard. Both full-token and short-code flows display the exact five-word SAS,
  12-character fingerprint, and host identity fixture supplied by the helper; mismatch/reject/
  expiry erases it and never connects, while short-code pairing cannot skip attended comparison.
- [ ] **Step 3: Test exact dashboard and origin isolation.** Host A and B get distinct origins,
  cookies/storage/cache do not cross; offline forget then re-pair of Host A uses a greater local
  origin epoch and cannot reopen the old origin. A forced preferred-port collision also allocates a
  greater epoch and hostname before serving on the replacement port; host-only cookies and an
  attempted `Domain=localhost` cookie do not reach the new origin or Host B in the required real-
  browser matrix. Any browser accepting the parent-domain cookie fails the release gate. A
  malicious Host A dashboard cannot register a
  service worker, keep privileged persistence after switch, reach Host B, override the gateway-owned
  HTTP CSP, receive a host `Set-Cookie`, read/overwrite/name or authenticate with the launch-random
  `HttpOnly` gateway session cookie, navigate/open an external link, or make non-same-origin network
  requests. It may create ordinary same-origin `document.cookie` entries, but the gateway ignores
  every non-session cookie and no such entry crosses the rotated host origin. External
  documentation links render only as copyable, non-clickable text in remote mode. Assert the CSP
  sandbox has exactly the allowed script/form/same-origin/download capabilities and no popup or
  top-navigation capability.
- [ ] **Step 4: Test parity.** Exercise representative GET/PUT/POST/DELETE, binary avatar upload,
  download, SSE reconnect/reset, cancellation, settings invitation/approval/revoke, and host build
  update. Drop the path after a mutation effect but before `202`: transactional/reconciled recovery
  reuses the same logical key and returns/polls the same operation, a second user action uses a new
  key, and a non-replayable action reports unknown without retry. Assert the host's build ID is the
  executing build, not the remote install's build.
- [ ] **Step 5: Test secure assistant actions.** Remote conversation owner stays remote; invitation
  and confirmation secrets are absent from chat/tool rows; revoke invalidates the conversation and
  action immediately.
- [ ] **Step 6: Run browser tests.**

  Run: `npm run build && npm run test:e2e`

  Expected: PASS in Chromium. Harness egress ledger contains only loopback fake-helper traffic and
  the selected pinned host service; no arbitrary/external browser egress.
- [ ] **Step 7: Suggested commit.**

  `test: prove remote dashboard and assistant isolation`

---

### Task 16: Packaging, docs, and complete app verification

**Gate:** Signed helper packages and user-authorized publishing are separate from local completion.

**Files:**

- Modify: `docs/api.md`
- Create: `docs/assistant-kb/remote-access.md`
- Modify: `docs/assistant-kb/api.md`
- Modify: `docs/assistant-kb/getting-started.md`
- Modify: `docs/assistant-kb/troubleshooting.md`
- Modify: `CLAUDE.md`
- Modify: `scripts/release.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/packageRemoteHelper.test.ts`

- [ ] **Step 1: Add package tests.** `npm pack` must contain both dashboard builds/manifests,
  public contract fixtures, helper verification metadata, and no private source/secret. A clean npm
  install for each fixture target selects exactly one helper. `--omit=optional` still runs `waifus
  help` and doctor gives an actionable missing-helper result; a normal supported install verifies
  and launches the exact signed helper.
- [ ] **Step 2: Extend release smoke.** Preserve the core tarball smoke, then add supported-target
  jobs in the owning release workflow. Source checkout and npm install must hash the same helper
  bytes. Include license/third-party notices for the statically linked helper packages.
- [ ] **Step 3: Update docs.** Document commands, direct-only/offline behavior, both pairing modes,
  remote API/tools, secure confirmations, clean preservation, external-link isolation, version
  compatibility, unsupported Intel macOS, and the fact that remote v1 cannot stop/restart the host
  OS process.
- [ ] **Step 4: Run focused package checks.**

  Run: `npx vitest run tests/packageRemoteHelper.test.ts && npm pack --dry-run --json`

  Expected: PASS; the dry-run file list contains no private repo source or generated local secrets.
- [ ] **Step 5: Run the entire app verification set.**

  Run: `npm run test && npm run typecheck && npm run build && npm run test:e2e && git diff --check`

  Expected: all tests pass, both backend/frontend builds succeed, manifests are regenerated, and
  the diff has no whitespace errors. Treat any pre-existing unrelated failure separately and do
  not call the suite green until the remote-focused commands above pass.
- [ ] **Step 6: Inspect the npm artifact, not only the worktree.** Install the tarball into a fresh
  temp prefix, run `waifus help`, `waifus doctor`, `waifus remote --no-open` with a fake/signed test
  helper as appropriate, and verify missing-helper and unsupported-platform diagnostics.
- [ ] **Step 7: Suggested commit.**

  `docs: document direct remote management`

---

## Final cross-part acceptance for this file

- [ ] A source checkout and supported npm installation verify the identical signed helper binary.
- [ ] Host and remote helpers can coexist for one data root without sharing role transport keys,
  PID/runtime/socket/log files, or locks incorrectly.
- [ ] `waifus remote`, `waifus remote status`, and `waifus remote stop` obey the locked daemon
  boundaries; ordinary `waifus status` reports both roles.
- [ ] The browser sees only the connection shell until the selected host's complete authenticated,
  hash-verified dashboard build is available.
- [ ] Every remote browser request passes exact origin/session/CSRF checks and every proxy request
  targets only the pinned selected host service.
- [ ] Binary bodies, streams, cancellation, safe retries, and epoch-aware SSE survive direct
  reconnect according to their reviewed contracts.
- [ ] Host switching, revocation, and trust-epoch changes rotate origins and prevent cookie/storage/
  service-worker/cache/session bleed.
- [ ] The same host dashboard bundle clearly distinguishes host/remote context; local-only controls
  are unavailable remotely with an explanation.
- [ ] The assistant's conversations, tools, and pending actions retain the remote actor, and
  secrets never enter the model/display transcript.
- [ ] Clean preserves identity, activation, enabled/settings state, pairings, deny/trust epochs,
  remembered hosts, operations, and audit exactly while deleting ordinary user/config/cache,
  remote-dashboard cache, and transient remote state.
- [ ] No UI or assistant claims it can stop/restart the host OS process in remote v1.
- [ ] Intel macOS remains an explicit later follow-up; all six supported targets have install/
  launch/pair/direct-connect release smoke ownership.

## Gate-supplied production inputs — do not guess

1. Plan 07 freezes the first helper version at `0.1.0`, the canonical-JSON plus raw 64-byte
   Ed25519 signature format, and initial key ID `waifucave-ts-connect-release-2026-01`. The public
   trust-ring source/fingerprint is committed and reviewed before package smoke; only the generated
   production public-key bytes/fingerprint remain an approval-gated setup input. Fixture keys are
   never production keys.
2. Plan 01 freezes the IPC capability names and plan 03 freezes the exact helper framing and
   command/status contracts. This phase consumes those committed fixtures without redefining them.
3. The role-specific key derivation/storage contract must be ratified by the helper/crypto review;
   this plan requires separate host/remote node/discovery keysets under one installation identity.
4. Gate C must have implemented plan 01's exact five-route inner allowlist for the current
   `@waifucave/gateway/fastify` wildcard. Any later gateway route remains remote-denied until that
   manifest is deliberately reviewed.
5. Real signed-binary and network-roaming tests depend on the direct-only fork feasibility gate and
   private helper/coordination implementation. Fake-helper success is not direct-connectivity proof.
6. Per-OS CI runners/signing/notarization credentials and the explicit user-authorized publication
   sequence belong to the packaging/release part; never infer those credentials or authority here.
