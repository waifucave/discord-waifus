# Waifus Remote Management — Public Tailscale Fork and Direct-Only Spike

> **For agentic workers:** REQUIRED SUB-SKILL: use test-driven development while implementing each task, and verification-before-completion before reporting a gate as passed.

**Status:** ready for staged execution

**Repository owner:** public GitHub repository **HeavenllyDemon/tsnet**

**Depends on:** the public remote-contract lock from plan 01

**Blocks:** production helper work, binary publication, and any Discord Waifus dependency on the helper

**Goal:** Prove that a small, reviewable fork of Tailscale can run two application-scoped userspace peers with a WaifuCave control client, recover a direct path after endpoint changes, reject revoked peers while coordination is unavailable, and make DERP and peer relay structurally unavailable.

## Locked Inputs

- Upstream release: **tailscale/tailscale v1.102.2**
- Upstream commit: **eb67e5dcbe145d63e1128b9b4b630f8a82da101f**
- Go toolchain: **1.26.5**
- Fork repository keeps the upstream **tailscale.com** module identity.
- The helper later pins the fork by exact commit, never a branch or floating tag.
- The fork contains no WaifuCave Worker secret, private coordination encoding, activation credential, or product-wide shared secret.
- V1 data paths are direct UDP/WireGuard only. DERP, peer relay, TURN, exit nodes, subnet routes, DNS, SSH, Serve/Funnel, LocalAPI, SOCKS/HTTP proxying, and unrelated services are unavailable.
- Intel macOS is excluded from V1 and tracked as a later **darwin/amd64** follow-up.

The injected client has exactly two compiled profile enum values and no string URL setter:

| Enum | Profile | HTTPS origin | WebSocket origin |
|---:|---|---|---|
| `1` | production, default | `https://pair.waifucave.com` | `wss://pair.waifucave.com` |
| `2` | development/release validation only | `https://pair-staging.waifucave.com` | `wss://pair-staging.waifucave.com` |

The private helper's canonical `WORKER_KEYS.lock` later pins each origin to its distinct Worker
certificate key. Node may select only this enum over mutually authenticated IPC; arbitrary URL,
hostname, key, argv, environment, config, redirect, and cross-profile fallback inputs do not exist.
One signed helper byte sequence contains both profiles so release candidates test staging and then
production without rebuild drift.

## Explicit Action Boundary

Creating **HeavenllyDemon/tsnet**, pushing branches/tags, or changing GitHub settings is an explicit later external action. Local inspection, patches in a temporary clone, and tests do not authorize repository creation or publication. Before the first GitHub mutation, show the exact authenticated owner, target name, visibility, upstream base, and command, then obtain the user's confirmation.

## Direct-Only Structural Contract

The spike is not accepted merely because diagnostics happen to report a direct connection.

The Waifus build must set a dedicated **waifus_direct_only** build tag and construct the engine with an immutable **DirectOnly** policy. In that build and mode:

1. The control factory is supplied explicitly. There is no default Tailscale control URL or stock control-client fallback.
2. A DERP map is never installed. A non-empty DERP map is a hard protocol error.
3. DERP dial/write functions and peer-relay allocation/forwarding are either excluded by the build tag or replaced by fail-closed stubs that cannot create a socket or enqueue an application packet.
4. The peer path selector has only direct IPv4 and direct IPv6 outcomes. With no direct endpoint it returns a typed no-direct-path result.
5. The peer-relay manager is not constructed, and map fields that could create a relay server are rejected.
6. The userspace network stack exposes only the single Waifus application listener and cannot route arbitrary overlay destinations.
7. Runtime prohibited-path counters exist as regression tripwires and remain zero; they are evidence, not the enforcement mechanism.
8. Node/discovery/WireGuard key expiry and automatic rotation are disabled in V1. A control map that
   requests expiry/rotation or a local missing/corrupt key fails `repair_required`; the fork never
   silently replaces it.

The spike must include both source-structure checks and observed egress checks. If this cannot be achieved with a bounded delta, stop and return to design review.

---

## Task 1: Verify and create the full-history fork

**External action — do not execute during an earlier local task.**

**Repositories:**

- Read: **tailscale/tailscale**
- Create later: **HeavenllyDemon/tsnet**

- [ ] Confirm the upstream tag and commit without changing state:

~~~bash
git ls-remote https://github.com/tailscale/tailscale.git refs/tags/v1.102.2 refs/tags/v1.102.2^{}
~~~

Expected: the peeled tag resolves to **eb67e5dcbe145d63e1128b9b4b630f8a82da101f**. Stop if it differs.

- [ ] Confirm the authenticated GitHub owner and that **HeavenllyDemon/tsnet** still does not exist.
- [ ] Ask the user before creating the fork.
- [ ] Create a true GitHub-network fork with full history, then add an **upstream** remote.
- [ ] Create a working branch from the exact commit, not current upstream main:

~~~bash
git switch --detach eb67e5dcbe145d63e1128b9b4b630f8a82da101f
git switch -c waifus/direct-only-v1.102.2
~~~

- [ ] Verify preserved upstream files: **LICENSE**, **PATENTS**, source headers, **go.mod**, and applicable third-party notices.
- [ ] Add **WAIFUCAVE_FORK.md** documenting the upstream SHA, purpose, unsupported Tailscale association, direct-only invariant, update procedure, and private-protocol exclusion.
- [ ] Add **WAIFUCAVE_UPSTREAM.lock** containing the upstream tag, commit, Go version, and review date.

Expected: **git merge-base --is-ancestor eb67e5... HEAD** succeeds and GitHub shows the fork relationship.

**Suggested commit:** **chore: establish Waifus fork baseline at Tailscale v1.102.2**

## Task 2: Lock the toolchain and establish the untouched baseline

**Files in HeavenllyDemon/tsnet:**

- Modify only if needed: **go.toolchain.version**, CI toolchain configuration
- Create: **.github/workflows/waifus-ci.yml**

- [ ] Install/use Go **1.26.5** and record:

~~~bash
go version
go env GOOS GOARCH GOTOOLCHAIN
~~~

Expected: **go version go1.26.5**.

- [ ] Before fork changes, run and save the baseline results for:

~~~bash
go test ./control/controlclient ./ipn/ipnlocal ./tsnet ./wgengine/...
go test -race ./control/controlclient ./ipn/ipnlocal ./tsnet ./wgengine/magicsock
go test .
~~~

Expected: all applicable upstream tests pass. Record any reproducible upstream-only failure before changing code; do not hide it with a skip.

- [ ] Add CI for the exact Go version, focused unit/race suites, license tests, Linux feasibility integration, and six-target compilation.
- [ ] Make CI fail if **WAIFUCAVE_UPSTREAM.lock**, the checked-out upstream base, and the declared toolchain disagree.

**Suggested commit:** **ci: lock Go 1.26.5 and the Waifus fork baseline**

## Task 3: Add a production control-client injection seam

**Likely files in HeavenllyDemon/tsnet, verified against the pinned checkout before editing:**

- Modify: **ipn/ipnlocal/local.go**
- Modify: **tsnet/tsnet.go**
- Test: **ipn/ipnlocal/local_test.go**
- Test: **tsnet/tsnet_test.go**

The pinned upstream already has a test-only control-client getter. Promote the minimum construction seam; do not expose all LocalBackend internals.

- [ ] Write failing tests proving:
  - A **tsnet.Server** configured for Waifus receives and invokes the supplied **controlclient.Client** factory.
  - Starting Waifus mode without a factory fails before any network request.
  - The factory is immutable after start.
  - The stock control client is never constructed in Waifus mode.
  - The seam accepts only the numeric compiled production/staging profile enum selected before
    engine construction; it has no arbitrary origin/key setter and cannot change profile at runtime.
  - Shutdown calls the custom client's shutdown exactly once.
- [ ] Add a typed production option, such as **ControlClientFactory**, at LocalBackend construction and thread it through a narrow **tsnet.Server** Waifus option.
- [ ] Keep normal upstream behavior byte-for-byte equivalent when Waifus mode is not selected.
- [ ] Add a test dialer that fails on every network request and prove the missing-factory failure makes zero dials.

Verification:

~~~bash
go test ./control/controlclient ./ipn/ipnlocal ./tsnet
go test -race ./ipn/ipnlocal ./tsnet
~~~

Expected: new tests fail before implementation and pass after; ordinary tsnet tests remain green.

**Suggested commit:** **feat: add explicit control-client factory for embedded peers**

## Task 4: Make DERP and peer relay structurally unavailable

**Likely files in HeavenllyDemon/tsnet:**

- Modify: **wgengine/magicsock/magicsock.go**
- Modify/tag-split: **wgengine/magicsock/derp.go**
- Modify/tag-split: **wgengine/magicsock/relaymanager.go**
- Create as needed: **wgengine/magicsock/derp_waifus_disabled.go**
- Create as needed: **wgengine/magicsock/relay_waifus_disabled.go**
- Modify: **wgengine/userspace.go**, **tsnet/tsnet.go**, or the pinned equivalent construction path
- Test: focused **wgengine/magicsock/*_test.go** and **tsnet/*_test.go**

- [ ] First add failing tests for:
  - Non-empty DERP map rejection under **DirectOnly**.
  - Peer-relay node/map-field rejection.
  - No DERP or relay manager construction.
  - Sending with no direct endpoint returns **ErrNoDirectPath** and makes no TCP/TLS/HTTP dial.
  - A malicious control client cannot switch a running direct-only engine into DERP or peer relay.
  - Direct IPv4 and direct IPv6 remain valid.
- [ ] Add the **waifus_direct_only** tagged implementation and immutable **DirectOnly** construction policy.
- [ ] Remove or fail-close the DERP and peer-relay send branches for tagged builds.
- [ ] Add prohibited-path counters that increment on any attempted forbidden call, then make tests assert zero.
- [ ] Add a source/dependency audit script, **tool/waifus-direct-audit**, that checks the tagged build and fails on newly reachable forbidden dial sites or path variants.
- [ ] Run:

~~~bash
go test -tags=waifus_direct_only ./wgengine/magicsock ./wgengine ./tsnet
go test -race -tags=waifus_direct_only ./wgengine/magicsock ./tsnet
go list -deps -tags=waifus_direct_only ./tsnet
~~~

Expected: direct paths pass, all forbidden maps/paths fail closed, and no test observes a DERP/relay socket or byte.

**Suggested commit:** **feat: structurally disable relay paths in Waifus direct-only builds**

## Task 5: Reject generic tailnet configuration and unused services

**Files in HeavenllyDemon/tsnet:**

- Create: a narrow Waifus map validator near the injected control/backend boundary
- Modify: only construction/configuration sites necessary to prevent unused services
- Test: validator and tsnet integration tests

- [ ] Add failing table tests for each forbidden field:
  - A remote view containing anything beyond self plus its one selected host.
  - A host pair view containing an unapproved remote, another remote's pair material, or any
    cross-remote adjacency; multiple remotes exist only as separately approved isolated edges.
  - DERP or peer relay.
  - DNS configuration.
  - Exit/subnet routes or OS routes.
  - SSH, Serve, Funnel, peer API, LocalAPI, drive, taildrop, app connectors, proxy services, arbitrary services, or route advertisements.
  - A remote receiving another remote's keys, endpoints, or address.
- [ ] Accept only:
  - Self and one selected peer for a remote.
  - Self plus individually approved remotes for a host, with pair-isolated views.
  - One stable userspace address and one Waifus service identity per pair.
  - Direct candidate endpoints from the injected client.
- [ ] Model the host as a star of independently approved pair edges, never a generic multi-peer
  tailnet: no remote receives another remote's map/key/address/endpoint/service/presence, and the
  host engine cannot forward, route, bridge, or proxy packets/services between remote edges.
- [ ] Disable stock control URL fallback, logtail/support upload, telemetry, auto-update, DNS, LocalAPI, SSH, Serve/Funnel, SOCKS/HTTP proxy, exit/subnet routes, and peer relay at construction rather than by convention.
- [ ] Add a failing egress allowlist test. Permitted classes are only:
  - The injected client to exactly the one active compiled profile:
    **pair.waifucave.com** for production or **pair-staging.waifucave.com** for explicit
    development/release validation. The inactive profile and every third origin receive zero
    connections/bytes; redirects cannot switch profiles.
  - The configured STUN endpoint.
  - LAN gateway PCP/NAT-PMP/UPnP.
  - Validated approved-peer candidate probes and encrypted direct packets.

Verification:

~~~bash
go test -tags=waifus_direct_only ./ipn/ipnlocal ./tsnet ./wgengine/...
go test -race -tags=waifus_direct_only ./ipn/ipnlocal ./wgengine/magicsock
~~~

Expected: every forbidden fixture is rejected before network or route configuration.

**Suggested commit:** **feat: constrain embedded maps to the Waifus pair service**

## Task 6: Build the two-peer feasibility harness

**Files in HeavenllyDemon/tsnet:**

- Create: **cmd/waifus-direct-spike/**
- Create: **tstest/waifuscontrol/** or equivalent fake injected control client
- Create: Linux netns/netem test scripts under **tool/waifus-spike/**
- Test: integration tests owned by the fork

The public harness uses only fake/local control DTOs. It must not contain private Worker encoding.

- [ ] Write the failing integration sequence:
  1. Start two userspace peers with the custom factory.
  2. Install a minimal two-node map with empty DERP and relay state.
  3. Open one authenticated application listener.
  4. Exchange a test request directly.
  5. Replace both endpoint generations.
  6. Recover and exchange a second request.
  7. Revoke the peer while the fake coordinator is disconnected.
  8. Confirm the existing/new stream is closed/refused.
- [ ] Instrument all TCP/TLS/HTTP dials and UDP destinations.
- [ ] Capture packets in netns and classify STUN, local mapping, candidate probe, and peer traffic.
- [ ] Fail on any undeclared DNS lookup or Internet destination.
- [ ] Add hard-NAT/UDP-blocked fixture. Expected state is deterministic **direct_unavailable**, never relay.
- [ ] Add malicious updates attempting DERP, peer relay, extra peers, routes, DNS, and arbitrary services.
- [ ] Add a host-plus-two-remotes isolation sequence:
  1. Start one host, remote A, and remote B with two separately approved pair views.
  2. Prove each remote's installed map/service view contains only itself and the host; it never
     receives the other remote's node/discovery key, address, endpoint, service ID, or presence.
  3. Carry concurrent authenticated application requests from A and B to the host.
  4. Attempt remote-to-remote discovery, dial, probe, service access, and malicious map injection;
     every attempt must fail before a packet is sent.
  5. Disconnect fake coordination, locally revoke A, and prove A's existing/new traffic closes or
     is refused while B's existing stream and a new B request remain connected and uninterrupted.
  6. Assert packet/dial ledgers contain no A-to-B or B-to-A destination and B receives no key/map
     update caused by A's revocation.

Verification:

~~~bash
go test -tags=waifus_direct_only ./cmd/waifus-direct-spike ./tstest/waifuscontrol
sudo -n ./tool/waifus-spike/run-netns-matrix.sh
~~~

Expected: direct connect, rebind recovery, offline revocation, and host-plus-two-remotes isolation
pass; revoking one remote does not disturb the other. Forbidden/hard-NAT/cross-remote cases fail
closed with zero relay or remote-to-remote bytes. If passwordless netns is unavailable locally, CI
must run the privileged matrix before this gate closes.

**Suggested commit:** **test: prove direct-only peer lifecycle and offline revocation**

## Task 7: Cross-platform spike and bounded-delta review

**Targets:**

- **darwin/arm64**
- **windows/amd64**
- **windows/arm64**
- **linux/amd64**
- **linux/arm64**
- **linux/arm/v7**

- [ ] Cross-compile the spike/helper-facing packages with Go **1.26.5** and **waifus_direct_only**.
- [ ] Run real launch/connect/rebind smoke tests on macOS ARM64, Windows x64, representative Windows ARM64, and Linux.
- [ ] Run Linux x64/ARM64/ARMv7 static-binary tests on representative glibc and musl systems.
- [ ] Record binary size, goroutine/socket surfaces, forbidden-path counters, and fork diffstat.
- [ ] Run applicable upstream focused and race suites again.
- [ ] Review the complete fork range against upstream **eb67e5dc...**. Confirm the delta remains bounded and every new public API is documented.
- [ ] Create a signed feasibility report containing:
  - Exact fork commit.
  - Exact upstream and Go pins.
  - Test commands/results per platform.
  - Packet/egress evidence.
  - Known reachability failures.
  - Confirmation that no production helper depends on the fork yet.
- [ ] Ask the user before pushing/tagging the fork.

Expected gate: all five feasibility requirements in the design pass. A failed platform or any possible relay path blocks plan 03 production integration.

**Suggested commit:** **docs: record direct-only feasibility gate**

## Fork Update Rule After the Spike

Every upstream update is its own reviewed task:

1. Select an immutable upstream tag and SHA.
2. Rebase/reapply the narrow patch series in a review branch.
3. Run all source, race, egress, netns, malicious-map, and platform tests.
4. Publish a new fork commit.
5. Update the private helper pin only after its full suite passes.

No automation may merge upstream or advance the helper pin by itself.

## Completion Gate

Plan 03 may consume the fork only when:

- The exact fork commit is public and reviewed.
- Direct-only enforcement is structural, not status-only.
- The fake-control two-peer spike connects and roams.
- Both compiled control profiles exercise the same fork/helper bytes; default production,
  explicit staging, cross-profile certificate/origin, arbitrary destination, and key-expiry tests
  pass with no inactive-profile or prohibited egress.
- Offline revocation works.
- Forbidden maps and egress fail closed.
- Representative macOS ARM64, Windows, and Linux runs pass.
- Host plus two approved remotes passes the star-isolation/revoke-one test: each reaches only the
  host, neither learns/reaches the other, and the unaffected remote stays connected.
- Arbitrary multi-peer maps and every host forwarding/bridging path remain structurally rejected.
- The delta is judged maintainable.

Intel macOS remains a tracked follow-up and must not be silently mapped to the ARM64 package.
