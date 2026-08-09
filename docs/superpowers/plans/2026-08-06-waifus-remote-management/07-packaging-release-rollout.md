# Waifus Remote Management — Packaging, Signing, Release, and Rollout

> **For agentic workers:** REQUIRED SUB-SKILL: use verification-before-completion for every artifact and release claim. Publication, deployment, tags, repository settings, and follow-up issue creation are explicit external mutations.

**Status:** ready for staged execution

**Repositories:** public **HeavenllyDemon/tsnet**, private **waifucave/ts-connect**, public **waifucave/discord-waifus**

**Depends on:** every functional/security/platform gate in plans 01–06

**Goal:** Produce six signed target-specific helper packages, prove source and npm installs use identical bytes, roll out Worker → helper → Discord Waifus in a reversible order, and independently verify the public result without ever releasing a relay-capable or unverified helper.

## Locked Release Model

- Helper packages use one independent SemVer as a release set. Initial beta set: **0.1.0**.
- Discord Waifus pins every helper package to exact **0.1.0**, never a range or dist-tag.
- The six public binary-only npm packages are exactly:

| npm package | Go target | npm os | npm cpu | Extra runtime check |
|---|---|---|---|---|
| **@waifucave/ts-connect-darwin-arm64** | darwin/arm64 | darwin | arm64 | signed/notarized Mach-O |
| **@waifucave/ts-connect-win32-x64** | windows/amd64 | win32 | x64 | Authenticode |
| **@waifucave/ts-connect-win32-arm64** | windows/arm64 | win32 | arm64 | Authenticode |
| **@waifucave/ts-connect-linux-x64** | linux/amd64 | linux | x64 | static executable |
| **@waifucave/ts-connect-linux-arm64** | linux/arm64 | linux | arm64 | static executable |
| **@waifucave/ts-connect-linux-armv7** | linux/arm/v7 | linux | arm | signed manifest says GOARM 7 |

- Linux builds use **CGO_ENABLED=0**.
- All builds use Go **1.26.5**, the **waifus_direct_only** tag, exact fork/contract pins, **-trimpath**, and embedded build metadata.
- Every binary embeds the exact two-profile table: enum `1` production at
  `https://pair.waifucave.com` / `wss://pair.waifucave.com` and enum `2` development/release-only
  staging at `https://pair-staging.waifucave.com` / `wss://pair-staging.waifucave.com`, with
  distinct pinned Worker certificate keys. Production is the normal default; only authenticated
  IPC HELLO fields `controlProfile:1|2` and
  `runtimePurpose:normal|development|release_validation` can select it, staging is rejected for
  normal purpose, and no arbitrary URL/argv/config path exists. The identical final signed
  bytes test staging and production.
- Package tarballs contain no install/postinstall script and no npm **bin** mapping. Discord Waifus resolves the known binary path.
- Source checkouts and npm installs consume the same public npm package. An unsigned helper override exists only behind an explicit development/test flag with a prominent unsafe warning.
- Intel macOS is not mapped to ARM64. Ordinary local **waifus start** remains available, while
  host remote-access enable and **waifus remote** start fail with an actionable unsupported-target
  result.
- Never unpublish a helper version. Rollback publishes a new root/app version that pins a previously verified helper.

## Explicit Action Boundary

Local builds, dry runs, package tarballs, and test signatures do not authorize:

- Creating/reconfiguring npm packages or trusted publishers.
- Using production signing/notarization credentials.
- Pushing helper/fork/root tags.
- Changing npm dist-tags.
- Deploying staging/production Worker changes.
- Publishing helper or Discord Waifus packages.
- Creating the Intel macOS follow-up issue.

At each external step, verify and show the exact authenticated account, repository/package/domain, version/tag, artifact hashes, credentials by nonsecret identifier, and command. Obtain the user's confirmation for that stage.

## Canonical Helper Manifest and Signatures

Each target package contains **manifest.json**, encoded with RFC 8785 JSON Canonicalization Scheme. Its exact V1 fields are:

| Field | Rule |
|---|---|
| schemaVersion | integer 1 |
| helperVersion | exact SemVer |
| releaseSequence | canonical uint64 decimal string, monotonically increasing, initial `"1"`; BigInt comparisons only |
| releasedAt | signed canonical UTC RFC 3339 timestamp at whole-second precision |
| packageName | exact package from table |
| target | os, arch, optional goarm; exact expected target |
| binary | relativePath, byteSize, sha256 |
| protocols | supported IPC, coordination, direct-service, helper-manifest major/minor ranges |
| capabilities | sorted unique public capability names |
| minimumDiscordWaifusVersion | exact SemVer floor |
| maximumDiscordWaifusVersionExclusive | exact SemVer upper bound; the app version must be lower |
| sourceCommit | private helper commit SHA |
| contractCommit | public contract commit SHA |
| forkCommit | public fork commit SHA |
| workerTrustRingSha256 | SHA-256 of canonical **WORKER_KEYS.lock**, including both enum/name/HTTPS/WSS origins and distinct staging/production key IDs/raw-public-key fingerprints |
| tailscale | tag v1.102.2 and SHA eb67e5dcbe145d63e1128b9b4b630f8a82da101f |
| goVersion | exactly go1.26.5 |
| directOnlyBuildTag | exactly waifus_direct_only |
| ossNoticeSha256 | hash of bundled notice inventory |
| releaseKeyIds | sorted IDs of all required overlap signatures |

The package contains:

- **bin/ts-connect** or **bin/ts-connect.exe**
- **manifest.json**
- **signatures/<keyId>.sig**, each exactly 64 raw Ed25519 signature bytes
- **LICENSE.txt** with approved helper distribution terms
- **THIRD_PARTY_NOTICES.txt**
- **sbom.spdx.json**
- minimal **package.json**

Ed25519 signs the exact canonical **manifest.json** bytes, not a parsed/reserialized object and not merely the binary hash. Verification order is:

1. Read raw manifest/signatures with strict file/type/size limits.
2. Verify at least one required trusted release key and every manifest-declared overlap key against
   the manifest's signed release sequence and `releasedAt`, never key expiry against the current wall
   clock.
3. Parse strict canonical JSON and require re-canonicalization byte equality.
4. Verify package name/target/version/protocol/capabilities/release sequence.
5. Hash the binary and notices and compare.
6. Apply the minimum helper/release-sequence floor.
7. Check platform signature where applicable.
8. Launch **version --json** and require embedded metadata to equal the signed manifest.

Unknown keys, missing overlap signature, wrong target, malformed canonical JSON, invalid hash/platform signature, incompatible capability, or downgrade fails before execution.

## Release-Key Rotation

Initial production key ID: **waifucave-ts-connect-release-2026-01**. Generate its keypair only during the explicitly approved signing setup; commit only the public key to Discord Waifus.

Rotation is exact:

Each public trust-ring entry contains the exact raw key, key ID, inclusive canonical uint64
`sequenceFrom`/`sequenceThrough`, and inclusive signed-release-time
`releasedAtFrom`/`releasedAtThrough`. Verification checks the manifest's signed sequence/time inside
those intervals; current wall-clock age never makes an immutable helper expire. An app additionally
enforces its compatibility minimum release sequence and exact pinned helper version. A compromise
update narrows the affected key to the last independently evidenced valid sequence/time (or removes
it entirely); versions outside that evidence cease to verify. Otherwise, old helpers signed inside
their historical window remain verifiable indefinitely.

1. Publish Discord Waifus release R1 trusting old and new key IDs with explicit overlapping signed-release-time/helper-sequence intervals, while helpers remain old-signed.
2. Publish an overlap helper set whose manifest lists both IDs and includes valid signatures from both.
3. Keep overlap through the full compatibility window: current and previous coordination major, and at least 180 days after the newer major reaches GA.
4. Publish Discord Waifus R2 that requires the new key for newer release sequences but still verifies old immutable helper versions it explicitly pins.
5. Only then publish helpers signed solely by the new key.

The private keys are protected GitHub Environment secrets on an approval-gated release environment or a stronger signing service selected before setup. They never enter the repository, package, log, artifact cache, or unprotected PR job. Key compromise triggers new key/root releases; an existing npm package is never silently replaced.

Apple Developer ID/notary and Windows Authenticode identities rotate independently. Their certificate identifiers and timestamp service are recorded in the release evidence without exposing private material.

## Compatibility Window

- Protocol majors for IPC, coordination, direct service, dashboard manifest, helper manifest, and event cursor are independent.
- Within one major, minor versions are additive and capability-negotiated.
- Worker serves the current and immediately previous coordination-protocol major for at least **180 days after the newer major reaches GA**.
- Every supported Discord Waifus release declares exact minimum/maximum component versions and required capabilities.
- CI tests current root/current helper, current root/previous helper, previous root/current compatible helper, current/previous Worker major, and rollback fixtures.
- Old helper npm versions and manifests signed inside a still-trusted historical sequence/time
  interval remain available and verifiable indefinitely; current wall-clock expiry is not used.
- No identity/trust storage migration becomes write-only until current/N-1 downgrade recovery passes.

---

**Hard entry gate:** Task 1 below does not begin until all non-packaging functional/security gates
in plans 01–06 have passed, including the public-fork feasibility report and private helper,
staging coordination, host bridge, gateway/dashboard, and assistant gates. Plan 06 acceptance items
that explicitly require a signed package, source/npm byte identity, real release matrix, or
post-publication proof are owned and closed by this plan and are not a circular prerequisite.
Test-only public manifest fixtures or fake-helper resolver work created earlier by plans 01/06 is
not production packaging and grants no permission to scaffold private packaging, sign, deploy, or
publish.

## Task 1: Lock package and signature fixtures before production keys

**Private waifucave/ts-connect files:**

- Consume without redefining: public **contracts/remote/v1/helper-manifest.schema.json** and helper-manifest fixtures at the exact **CONTRACTS.lock** commit
- Create: **packaging/testkeys/** containing test-only keys clearly marked nonproduction
- Create: **packaging/fixtures/** only for private package-inventory/platform-signature cases not already in the public contract
- Create: **packaging/npm/** package templates
- Create: **internal/releasemanifest/** encoder/validator
- Test: manifest canonicalization/signature suites

**Public waifucave/discord-waifus files introduced by plans 01 and 06:**

- Consume: **contracts/remote/v1/helper-manifest.schema.json** and public valid/invalid fixtures from plan 01
- Consume/complete: **src/remote/helperPackageManifest.ts** from plan 06
- Test: **tests/helperBinary.test.ts**

- [ ] Re-run the public cross-language goldens first. Go and Node must verify the same canonical manifest bytes/test signatures byte-for-byte. The private repository may add cases but cannot fork, weaken, or replace the public schema authority.
- [ ] Cover wrong package/target, Linux ARM without GOARM 7, duplicate/unsorted capabilities, noncanonical JSON, path traversal, symlink, oversize binary/manifest, bad hash, unknown/missing key, malformed/backdated/future/out-of-window signed `releasedAt`, invalid sequence/time overlap, release-sequence rollback, current-wall-clock independence for a historical valid fixture, compromise-window narrowing, wrong fork/upstream/Go/tag, app version below the minimum or at/above the maximum-exclusive bound, and embedded-version mismatch.
- [ ] Add package-content fixtures proving install scripts, npm bin mappings, extra executables, private source, signing keys, endpoint data, and debug symbols/source paths are rejected.
- [ ] Implement deterministic manifest generation and strict validation.
- [ ] Run:

~~~bash
go test ./internal/releasemanifest/... ./packaging/...
npx vitest run tests/helperBinary.test.ts
~~~

Expected: the same valid fixture passes Go and Node; every invalid fixture fails before launch.

**Suggested commits:**

- Private helper: **feat: lock signed helper manifest and package contracts**
- Public app: **test: consume signed helper package vectors**

## Task 2: Build unsigned reproducible target artifacts

**Private files:**

- Create: **scripts/build-release.sh** or an equivalent argument-safe Go release command
- Create: **.github/workflows/helper-ci.yml**
- Create: **.github/workflows/helper-build.yml**
- Create/modify: **internal/control/worker_trust.go**, **internal/control/worker_trust_test.go**
- Create: **WORKER_KEYS.lock**
- Modify: **cmd/ts-connect/** build-info injection

- [ ] Before any immutable build, pin both approved raw 32-byte Worker certificate public keys in
  **internal/control/worker_trust.go** and canonical **WORKER_KEYS.lock**: production ID
  **waifucave-pair-certificate-2026-01** with enum-1 origins and staging ID
  **waifucave-pair-staging-certificate-2026-01** with enum-2 origins. Record both reviewed
  fingerprints, exact origin/profile bindings, validity/rotation states, and plan-04 artifact
  hashes. Reject placeholder/test keys, duplicate keys across profiles, swapped/cross-profile
  origin/key IDs, unknown profile/URL, or a lock/build-info mismatch; private key material is
  impossible in source/lock/binary.
- [ ] Add a failing build-info test requiring helper version, release sequence, signed `releasedAt`, helper/fork/upstream/
  contract commits, Worker trust-ring hash, both compiled control profiles, Go version, direct-only tag, target, and capabilities.
- [ ] Add a build audit that fails on CGO for Linux, missing direct-only tag, absolute source paths,
  dirty source, floating module replacement, Worker key/origin placeholder or lock mismatch.
- [ ] Build all targets:

~~~bash
go test -tags=waifus_direct_only ./...
go test -race -tags=waifus_direct_only ./internal/...
go build -trimpath -tags=waifus_direct_only ./cmd/ts-connect
~~~

CI supplies exact GOOS/GOARCH/GOARM and release ldflags through fixed workflow inputs; it never interpolates an untrusted shell string.

- [ ] Rebuild unsigned Linux x64 twice on clean runners and require identical SHA-256.
- [ ] Run **go version -m**, binary string/source-path audit, static-link audit, forbidden egress/symbol audit, license inventory, and SBOM generation.
- [ ] Cross-compile all six, but do not treat cross-compilation as the platform gate.

Expected: six unsigned artifacts and draft manifest metadata exist only as short-lived CI
artifacts; no draft manifest is release-signed and no publication occurs.

**Suggested commit:** **build: produce pinned direct-only helper artifacts**

## Task 3: Provision approval-gated signing and notarization

**External setup — requires user approval before each provider/account mutation.**

**Private files after setup:**

- Create: **.github/workflows/sign-helper.yml**
- Create: **docs/release-signing-runbook.md**

**Public waifucave/discord-waifus trust source before package smoke:**

- Create/modify: **src/remote/helperReleaseTrust.ts**
- Create: **tests/helperReleaseTrust.test.ts**

- [ ] Decide/approve the helper binary distribution license before any public package. Set package **license** to **SEE LICENSE IN LICENSE.txt**; do not invent proprietary terms.
- [ ] Generate Ed25519 release key **waifucave-ts-connect-release-2026-01** in the protected release environment; record and independently compare the public key fingerprint.
- [ ] Put only the reviewed raw 32-byte public key, exact key ID, inclusive sequence/signed-release-
  time bounds, and initial release-sequence floor in public **src/remote/helperReleaseTrust.ts**. The fingerprint is exactly
  lowercase hex of **SHA-256(ASCII "waifus/helper-release-key/v1" || 0x00 || ASCII key ID || raw
  public key)**. Tests rederive it, require 32 bytes, reject duplicate/unknown/placeholder keys and
  invalid sequence/time overlap, and verify the production cross-language manifest fixture. Tests
  set the current clock years later and still accept a historically in-window immutable fixture.
- [ ] Commit that public trust source/test with suggested commit **chore: trust initial ts-connect
  release key**. Show the exact diff/commit/fingerprint and obtain approval before pushing it; then
  record the pushed Discord Waifus commit SHA in protected signing evidence. Private signing/
  package CI checks out that exact public commit. No Task 4 package smoke or manifest signing starts
  until the reviewed fingerprint and commit SHA match independently.
- [ ] Provision Apple Developer ID Application signing and App Store Connect notary credentials.
- [ ] Provision a Windows Authenticode code-signing identity usable on protected x64 and ARM64 runners, with RFC 3161 timestamping.
- [ ] Restrict signing jobs to protected tags, clean exact commits, approved GitHub Environment, and non-fork events.
- [ ] Before signing the first helper manifests, lock the exact planned Discord Waifus beta SemVer
  and reviewed maximum-exclusive compatible app version. Put those exact bounds in all six
  manifests; the later root release must use the already recorded SemVer rather than choosing a new
  one after helpers are immutable.
- [ ] macOS ARM64:
  - Sign Mach-O with hardened runtime and trusted timestamp.
  - Submit a ZIP containing the signed binary to **notarytool** and wait for acceptance.
  - Validate the extracted binary with **codesign --verify --strict --verbose=2** and **spctl -a -vv -t exec**.
- [ ] Windows x64/ARM64:
  - Authenticode-sign with SHA-256 file digest and RFC 3161 timestamp.
  - Verify with **signtool verify /pa /all /v** and PowerShell Authenticode status.
- [ ] Linux: detached manifest signature is the executable integrity boundary.
- [ ] Only after every platform binary has its final byte sequence, regenerate each canonical
  manifest from that final binary hash/size and final notice inventory, then Ed25519-sign the exact
  canonical manifest bytes. Never sign a manifest produced before code signing/timestamping.
- [ ] Re-run platform verification, binary hash, manifest signature, and embedded-metadata checks
  against the same immutable final files that Task 4 will pack.
- [ ] Delete signing workspaces and revoke ephemeral credentials after the job.

Expected: platform verification and detached-manifest verification pass; a one-byte binary/manifest mutation fails.

**Suggested commit:** **ci: add approval-gated helper signing**

## Task 4: Assemble and smoke all six npm tarballs

**Private files:**

- Create: one package template/metadata generator per target under **packaging/npm/**
- Create: **scripts/pack-npm.mjs**
- Test: tarball inventory and install tests

- [ ] Generate package metadata with exact name/version/os/cpu from the locked table. ARMv7 uses npm cpu **arm** plus signed GOARM 7 verification.
- [ ] Set each package repository metadata to the exact private build repository **github.com/waifucave/ts-connect** as required by its npm trusted-publisher binding; do not claim that private source is publicly auditable.
- [ ] Include no lifecycle scripts, npm bin field, network downloader, JavaScript loader, source file, source map, private repository credential, or extra target binary.
- [ ] Run **npm pack --json** for all six and audit the exact file list, modes, hashes, license, and unpacked size.
- [ ] Before the first install smoke, verify the public app checkout is the recorded trust-ring
  commit and **tests/helperReleaseTrust.test.ts** independently matches the manifest signature key;
  a different commit, key, or fingerprint blocks every tarball.
- [ ] Install each tarball into a clean matching target environment and resolve it through the public Discord Waifus helper resolver.
- [ ] Install the root package with **--omit=optional** and prove ordinary **waifus help/start** remain usable while remote/doctor report an actionable missing helper.
- [ ] On a supported normal install, prove npm selects exactly one helper package and source checkout/npm install resolve byte-identical helper hashes.
- [ ] Verify unsupported darwin/x64 and unknown architectures select none.

Expected: six distinct tarballs at helper **0.1.0**, one executable each, and no target ambiguity.

**Suggested commit:** **build: package six signed ts-connect targets**

## Task 5: Establish the real platform release matrix

**Runner ownership:**

- Linux x64 glibc/musl: GitHub-hosted x64 plus containers.
- macOS ARM64: protected real ARM64 macOS runner.
- Windows x64: protected real x64 Windows runner.
- Windows ARM64: protected real ARM64 Windows runner.
- Linux ARM64 and ARMv7: protected representative real hardware; run both glibc and musl where applicable.

Runner provisioning is an explicit external infrastructure action. Cross-compilation or QEMU alone cannot close this gate.

- [ ] For every target, install the packed tarball, verify signatures/metadata, launch the exact
  signed binary with authenticated-IPC profile enum 2, complete activation against staging, pair
  host/remote, carry API JSON + binary upload/download + SSE, roam networks, reconnect, revoke, and
  prove zero prohibited/inactive-profile/third-origin routes, connections, and bytes. Record the
  binary/tarball hashes as the immutable release-candidate set; profile testing may not rebuild it.
- [ ] Run suspend/resume and helper/Node crash cleanup.
- [ ] Run current/N-1 compatibility fixtures and previous-helper rollback.
- [ ] Capture sanitized evidence: target/OS, artifact hashes, versions, direct state, packet classification, and test result. Do not capture endpoint plaintext or keys.
- [ ] Repeat Linux on representative glibc and musl systems.
- [ ] Open the Intel macOS follow-up only after explicit approval. Required title: **Remote: add signed darwin/x64 ts-connect target**. Link it from release notes; it does not block the six-target V1 matrix.

Expected: all six targets install, verify, launch, pair, carry direct management traffic, roam, and revoke on real target environments.

**Suggested private commit:** **test: gate helper release on six real targets**

## Task 6: Prepare helper publication without publishing

**No package publication or dist-tag mutation occurs in this task.** Any npm account/trusted-
publisher setup remains an external action requiring explicit user approval.

**Private files:**

- Create: **.github/workflows/publish-helper.yml**
- Create: **scripts/verify-published-packages.mjs**

- [ ] Verify all six package names are still controlled/available under **@waifucave** and the
  intended authenticated npm owner can perform the later first publication.
- [ ] Use a GitHub-hosted Node 24/npm 11.5.1-or-newer publish job. Private-source packages may use npm OIDC trusted publishing, but npm provenance is not available for a public package from a private repository; the detached signature remains mandatory.
- [ ] Build the approval-gated workflow so it accepts only the six exact signed tarballs produced
  by the approved build, never rebuilds, requires the production-Worker gate artifact, and stops
  before **npm publish** in dry-run mode.
- [ ] Prepare the exact first-publication bootstrap/trusted-publisher procedure and commands, but
  do not create packages, publish, configure a trusted publisher, revoke a credential, or mutate
  a dist-tag yet.
- [ ] Run local-registry or **npm publish --dry-run** checks for all six. Verify the prospective:
  - name/version/os/cpu/license/dist integrity
  - exact manifest/signature/binary hashes
  - package inventory
  - detached and platform signatures
  - initial **next** tag and absence of **latest** mutation
- [ ] Save one immutable approved artifact-set manifest listing every tarball SHA-256, package
  integrity, helper/source/fork/contract commit, Worker protocol range, and release workflow run.

Expected: the exact six-package **0.1.0** set is ready for publication and dry-run verified, while
registry queries still prove **0.1.0** was not published or dist-tagged by this task.

**Suggested commit before the workflow dry run:** **ci: prepare verified helper publication**

## Task 7: Deploy the compatible Worker, then publish and promote helpers

**External Cloudflare and npm actions — separate confirmations required.**

- [ ] Complete plan 04 staging and security gates.
- [ ] Byte-compare the six immutable signed 0.1.0 tarballs/binaries with the Task 5 staging-tested
  hashes. Any rebuild, resign, retimestamp, manifest change, or profile-specific byte change returns
  to Task 5; production testing/publication cannot continue.
- [ ] Show the exact backward-compatible production Worker deployment, migrations, hash, and rollback.
- [ ] After approval, deploy production Worker first.
- [ ] Using those same binaries with authenticated-IPC profile enum 1/default, verify current and
  previous supported coordination major against production synthetic pairs; established direct
  traffic must survive a Worker restart/outage. Prove staging/cross-profile/redirect/third-origin
  egress remains zero.
- [ ] Reconfirm the immutable six-tarball manifest from Task 6 and show the exact npm identity,
  bootstrap/trusted-publisher process, package names, version, hashes, and publication commands.
- [ ] After separate npm approval, publish all six exact tarballs as **0.1.0** with
  **--access public --tag next**. Configure each package's trusted publisher to the exact
  **publish-helper.yml** workflow when npm permits it, then revoke the one-time bootstrap
  credential.
- [ ] Independently query/download every **next** package and verify name/version/os/cpu/license,
  registry integrity, approved tarball hash, inventory, detached signature, platform signature,
  and absence of a **latest** tag.
- [ ] Re-run the six-target install/activation/pair/direct/roam/revoke smoke against npm downloads,
  not CI-local tarballs.
- [ ] Complete a default 24-consecutive-hour beta soak against the unchanged production Worker and
  immutable **next** hashes. Record start/end UTC, Worker deployment hash, all tarball hashes, and
  test runs. Run the full six-target smoke at both boundaries and hourly current/N-1 activation,
  pair, direct JSON/binary/SSE, reconnect, and revoke synthetics on the protected representative
  matrix. Require zero prohibited/relay egress or auth/signature/replay invariant failure, no quota
  saturation, no unexplained failed synthetic, and production Worker 5xx below 1% excluding named
  deliberate outage probes. Any code/config/key/artifact change or gate failure resets the 24-hour
  clock; an external-provider outage invalidates the interval and a fresh interval begins after
  recovery. Save the sanitized evidence artifact before promotion.
- [ ] After the soak and a separate dist-tag confirmation, move all six **0.1.0** packages from
  **next** to **latest** as one release set.
- [ ] Re-query every dist-tag and tarball hash. If any package differs/fails, stop; do not release Discord Waifus.

Expected: production coordination was deployed and verified before the first public helper byte;
then all six exact helpers became independently verifiable under **next**, passed soak, and were
promoted together to **latest**. Discord Waifus is still unpublished.

## Task 8: Pin helpers and harden the Discord Waifus release path

**Public waifucave/discord-waifus files:**

- Modify: **package.json**, **package-lock.json**
- Modify: **remote-compatibility.json** and **src/remote/componentCompatibility.ts** from plan 06
- Modify: **scripts/release.mjs**
- Modify: **.github/workflows/npm-root-package.yml**
- Create/modify: **.github/workflows/ci.yml**
- Test: **tests/packageRemoteHelper.test.ts**, **tests/helperBinary.test.ts**, CLI/doctor suites

- [ ] Add all six exact optional dependencies at **0.1.0**. Regenerate the lockfile and prove all six entries retain optional/os/cpu metadata.
- [ ] Update canonical **remote-compatibility.json** so its exact Discord Waifus version equals
  **package.json** and its bounded helper min/max-exclusive SemVer, minimum release sequence,
  protocol ranges, and sorted capabilities match the intended 0.1.0 set. Reject version drift,
  unbounded ranges, and one-way compatibility before packing.
- [ ] Make the release script's version transaction update **package.json**, **package-lock.json**,
  and the exact-version field in **remote-compatibility.json** atomically before validation. Dry-run
  exercises the same generated bytes without leaving tracked residue; failure restores only the
  script's own version edits and never unrelated work.
- [ ] Ensure **scripts/check-no-file-deps.mjs** still checks optional dependencies.
- [ ] Extend release preflight to query all six exact registry versions and validate their package
  metadata, signed manifests, release sequence, capabilities, hashes, and app min/max-exclusive
  bounds before root packing. Every helper must accept this exact root version and the root
  compatibility table must accept that helper; verify both directions.
- [ ] Keep the current **--omit=optional** tarball smoke for graceful degradation, then add a normal
  current-platform install that loads the packed compatibility file, proves its version equals the
  installed package, verifies both compatibility directions, and launches the signed helper.
- [ ] Restructure **npm-root-package.yml** so the GitHub release tarball is installed and smoked on the real six-target matrix before the publish job. Publishing depends on every required target.
- [ ] Restrict self-hosted release-matrix jobs to the manually dispatched protected release workflow and verified release asset; never run untrusted pull-request code on those runners.
- [ ] Public CI consumes published binaries only. It never checks out private helper source or receives a private-repository token.
- [ ] Private helper CI may check out the public app and test local signed tarballs before publication.
- [ ] Run:

~~~bash
node scripts/check-no-file-deps.mjs
npm run test
npm run typecheck
npm run build
npm pack --dry-run --json
~~~

Expected: app/package tests pass; root tarball includes public contracts/dashboard assets/helper trust metadata but no private helper source or secret.

**Suggested commit:** **chore: pin signed ts-connect 0.1.0 packages**

## Task 9: Cut the Discord Waifus beta release

**External release action — use the repository's beta release workflow only after explicit user instruction to publish.**

- [ ] Inspect branch, origin/main, exact version, package/helper/Worker state, npm versions/dist-tags, release tag absence, and dirty/untracked files. Preserve unrelated **new providers.md** and **research/**.
- [ ] Prepare user-facing notes covering direct-only availability, hard-NAT offline behavior, six targets, Intel macOS follow-up, pairing security, source/npm identical helper, and rollback.
- [ ] Run the non-mutating release dry run first; inspect its packed package/lock/compatibility
  versions and prove all three equal the proposed SemVer with two-way helper bounds still passing.
- [ ] Show the exact new Discord Waifus SemVer/tag/commit, helper **0.1.0** hashes, Worker version, and release command.
- [ ] Only after the user explicitly says publish, run the full release script.
- [ ] Watch the root workflow through the six-target pre-publish matrix and npm publish.
- [ ] Independently verify npm version/dist-tags/license, GitHub tag/asset/target commit, fresh
  install, packed root compatibility metadata/package-version equality, two-way helper bounds,
  helper resolution/signature/version, **waifus doctor**, and real direct smoke.
- [ ] Confirm the worktree contains no unexpected tracked release residue and unrelated untracked files remain untouched.

Expected: the immutable public root release points to exact verified helper packages and every post-publish check passes.

**Suggested root release commit:** use the actual user-visible feature subject, for example **feat: add direct remote management**.

## Rollback Runbook

### Before Discord Waifus publication

- Do not promote or reference a failed helper.
- Leave bad immutable helper version untagged/deprecated; publish a new helper patch.
- Keep production Worker backward compatible or disable only new activation/pairing.

### After Discord Waifus publication

1. Never mutate/unpublish the released root/helper artifacts.
2. If app integration is faulty, publish a new Discord Waifus patch pinning the last verified helper set or disabling remote enable while preserving local host operation.
3. If helper is faulty, publish a new helper patch, pass the complete matrix, then publish a new root patch pinning it.
4. If Worker is faulty, deploy a forward schema-compatible Worker restoring prior behavior; do not destructively roll back a DO migration.
5. Keep current and previous control-protocol major for the 180-day window.
6. Identity/trust migrations must support current/N-1 recovery; never silently reset identity.
7. For signing-key compromise, stop helper promotion, disable new activation/pairing if needed, add a new root trust key/revocation floor, release newly signed helper/root patches, and document affected immutable versions.

Existing direct sessions continue through control-plane rollback when their path remains valid. Revocation must remain available.

## Final Release Gate

- [ ] Contract, security baseline, fork, helper, coordination, host bridge, gateway/dashboard, assistant, and browser-isolation gates all pass.
- [ ] Direct-only structural and observed proofs show zero DERP/peer-relay routes, connections, and bytes.
- [ ] Six public packages are signed, immutable, byte-verified, and tested on real target environments.
- [ ] Those exact six signed binary hashes passed staging profile 2 and production/default profile
  1 without rebuild, with zero inactive-profile/cross-profile/third-origin egress.
- [ ] Source and npm installs resolve identical helper bytes.
- [ ] Worker is deployed first and supports the compatibility window.
- [ ] Current/N-1 and rollback pass without identity loss.
- [ ] Security, privacy, crypto, supply-chain, and license reviews pass.
- [ ] Intel macOS is explicitly linked as a later follow-up, never treated as supported.
- [ ] Every deployment/publish/tag/issue mutation received its own explicit authorization.
- [ ] Independent post-publish verification passes.

## External Inputs Still Required

These are intentional stop points, not implementation guesses:

1. Actual Ed25519 release public key bytes/fingerprint for key ID **waifucave-ts-connect-release-2026-01**.
2. Actual distinct Worker certificate-signing public key bytes/fingerprints for production key ID
   **waifucave-pair-certificate-2026-01** and staging key ID
   **waifucave-pair-staging-certificate-2026-01**, plus the two reviewed public Turnstile site keys.
3. Approved helper binary distribution license text.
4. Apple Developer ID/notary identifiers and Windows Authenticode provider/certificate/timestamp details.
5. Exact protected runner inventory for macOS ARM64, Windows ARM64, Linux ARM64, and Linux ARMv7.
6. npm scope ownership/trusted-publisher configuration and one-time first-publication method.
7. The exact Discord Waifus beta SemVer and helper maximum-exclusive app bound, chosen before Task
   3 helper-manifest signing and reused unchanged by the later root release.
8. User approval for production Worker deployment, helper publication/promotion, root publication, and Intel macOS follow-up issue creation.
