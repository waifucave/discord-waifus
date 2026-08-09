# Waifus Remote Management — Private ts-connect Helper

> **For agentic workers:** REQUIRED SUB-SKILL: use test-driven development for every protocol and storage task. Do not advance past the fork gate from plan 02 on assumptions.

**Status:** ready for staged execution

**Repository owner:** private GitHub repository **waifucave/ts-connect**

**Depends on:** plan 01 contracts and the completed plan 02 feasibility gate

**Blocks:** Cloudflare production pairing, Discord Waifus host/remote integration, and binary package release

**Goal:** Build the private Go helper that owns device keys, speaks the constrained WaifuCave coordination protocol, embeds the reviewed direct-only fork, authenticates its Node parent, exposes one direct Waifus management service, and fails closed on every incompatible or forbidden state.

## Locked Inputs

- Go: **1.26.5**
- Tailscale base: **v1.102.2**, upstream SHA **eb67e5dcbe145d63e1128b9b4b630f8a82da101f**
- Fork dependency: exact reviewed **HeavenllyDemon/tsnet** commit produced by plan 02
- Noise library: **github.com/flynn/noise v1.1.0**, commit **4d9f71cd4ba1fe81415efac312664ccc4bc79b46**
- Noise cipher suite: **25519 / ChaChaPoly / SHA-256**
- Full-token handshake: **Noise_XXpsk0_25519_ChaChaPoly_SHA256**
- Short-code handshake: **Noise_XX_25519_ChaChaPoly_SHA256**
- Installation signatures: **Ed25519**
- Initial production Worker certificate-signing key ID:
  **waifucave-pair-certificate-2026-01**; staging uses the distinct exact profile-table key ID.
  Both approved public keys are pinned before release and private keys are never shipped.
- Pair endpoint envelopes: **ChaCha20-Poly1305** with direction-separated keys and monotonic epochs
- Helper is always built with **waifus_direct_only**.
- No Intel macOS binary in V1.

## Compiled Control Profiles

One helper binary contains exactly two immutable `ControlProfileV1` entries:

| Enum | Name | HTTPS origin | WebSocket origin | Worker certificate key ID |
|---:|---|---|---|---|
| `1` | `production` | `https://pair.waifucave.com` | `wss://pair.waifucave.com` | `waifucave-pair-certificate-2026-01` |
| `2` | `staging` | `https://pair-staging.waifucave.com` | `wss://pair-staging.waifucave.com` | `waifucave-pair-staging-certificate-2026-01` |

`WORKER_KEYS.lock` pins both exact origins, key IDs, raw 32-byte Ed25519 public keys and
fingerprints. Production is the default and the only profile reachable from ordinary `waifus start`
or `waifus remote`. The Node parent selects only numeric `controlProfile:1|2` plus exact
`runtimePurpose:normal|development|release_validation` in the mutually authenticated IPC HELLO;
there is no URL/hostname/key in argv, environment, config, IPC, or later command. Profile 2 is
accepted only for `development` or the package release-validation harness. Selection is immutable
for the helper process, certificate/response verification uses only that profile's key ring, and
HTTP/WS redirects or dials to the other profile or any third origin fail. The same compiled and
signed bytes can therefore exercise staging and then production without a rebuild.

## Explicit Action Boundary

Creating the private repository, granting collaborators or Actions access, provisioning secrets,
pushing a branch/tag, or publishing a binary is an explicit later external action. **No Task in this
plan, private working directory, Go scaffold, real-helper dependency, or repository creation begins
until plan 02's public-fork feasibility completion gate passes.** Before that gate, only plan 01's
public contract fixtures and the public app's deterministic fake-helper work are allowed. After the
gate, the user must still confirm the private repository location/ownership before creation. No
local task authorizes GitHub creation, Cloudflare changes, signing, or npm publication.

## Repository Layout

Create these owned surfaces after repository creation:

| Path | Responsibility |
|---|---|
| **cmd/ts-connect/** | Process entrypoint and host/remote mode selection |
| **internal/buildinfo/** | Helper, contract, fork, Go, and capability metadata |
| **internal/ipc/** | Authenticated parent IPC and framed multiplexing |
| **internal/identity/** | Installation identity, vault adapters, repair/reset, trust epoch |
| **internal/pairing/** | Invitation parsing, Noise, identity binding, SAS, pair keys |
| **internal/control/** | Activation certificate and pair.waifucave.com client |
| **internal/transport/** | Fork adapter, candidate generations, roaming state |
| **internal/service/** | Direct Waifus request/stream/cancel service |
| **internal/platform/** | Key storage, parent death, network/suspend monitors |
| **internal/testcontrol/** | Local fake coordinator; never linked into release builds |
| **worker/** | Cloudflare implementation described in plan 04 |
| **contracts/** | Vendored public fixtures plus exact source lock |
| **packaging/** | Binary/npm work described in plan 07 |
| **FORK.lock** | Exact public fork commit and upstream lineage |
| **CONTRACTS.lock** | Exact public contract commit/hash |
| **CRYPTO.lock** | Noise dependency, pattern, wordlist hash, and protocol constants |

---

## Locked Parent IPC Protocol

The local Node process is the sole parent and supervisor. The helper never accepts ordinary loopback HTTP and never trusts an HTTP header as a principal.

### Process launch and parent proof

1. Node generates a fresh 32-byte random capability.
2. Node creates a mode-0600 Unix-domain listener inside a mode-0700 data-root runtime directory, or a Windows named pipe whose DACL permits only the current user and creator context.
3. Node spawns the helper with an extra anonymous inherited pipe. Node writes exactly 32 capability bytes, then keeps the pipe write end open without writing further bytes solely as the parent-liveness signal until orderly shutdown. The helper uses an exact-length read for the first 32 bytes, then a separate blocking read on that same descriptor; EOF means the parent died or closed.
4. No capability, key, token, endpoint, or pair secret appears in argv, environment variables, process title, logs, or a temporary file.
5. The helper connects to Node within 5 seconds. The helper exits if the inherited parent pipe closes unexpectedly or the authenticated parent session ends.

### Frame header and types

Every frame, including the first frame on a connection, starts with this exact 24-byte network-order header:

| Field | Size | Encoding |
|---|---:|---|
| magic | 4 bytes | ASCII **WIPC** |
| major | 2 bytes | unsigned big-endian, initially 1 |
| minor | 2 bytes | unsigned big-endian, initially 0 |
| frameType | 1 byte | enum below |
| flags | 1 byte | unknown/reserved bits rejected |
| reserved | 2 bytes | must be zero |
| streamId | 8 bytes | unsigned big-endian; zero only for connection control |
| payloadLength | 4 bytes | unsigned big-endian; validate before allocation |

Frame types:

| Hex | Name | Stream |
|---:|---|---|
| 01 | HELLO | 0 |
| 02 | HELLO_ACK | 0 |
| 03 | COMMAND | 0 |
| 04 | RESULT | 0 |
| 05 | EVENT | 0 |
| 10 | REQUEST_START | nonzero |
| 11 | REQUEST_CHUNK | nonzero |
| 12 | REQUEST_END | nonzero |
| 13 | REQUEST_CANCEL | nonzero |
| 20 | RESPONSE_START | nonzero |
| 21 | RESPONSE_CHUNK | nonzero |
| 22 | RESPONSE_END | nonzero |
| 23 | RESPONSE_ERROR | nonzero |
| 30 | WINDOW_UPDATE | nonzero |

Locked limits:

- Canonical JSON control payload: **32 KiB**
- Encoded HTTP header block inside REQUEST_START or RESPONSE_START: **16 KiB**
- Raw data payload per frame: **64 KiB**
- Decoder absolute payload length: **65,536 bytes**; validate before allocating
- Concurrent streams: **128**
- Initial per-stream send credit: **1 MiB**
- Unknown required type, flag, duplicate terminal, invalid stream transition, credit overrun, noncanonical JSON, or oversized frame closes the affected stream or connection according to the public V1 fixture

### Flow control and stream state

Each stream has independent request and response byte credit. On accepted REQUEST_START both begin
at exactly **1,048,576 bytes**. REQUEST_CHUNK decrements request credit and RESPONSE_CHUNK decrements
response credit by the raw payload length; headers, control JSON, and frame headers consume no
credit. A chunk is 1–65,536 bytes and may not exceed available credit.

WINDOW_UPDATE payload is exactly eight bytes:

| Byte | Width | Rule |
|---:|---:|---|
| direction | 1 | `1=request`, `2=response` |
| reserved | 3 | all zero |
| creditIncrement | 4 | uint32BE, 1–1,048,576 |

The frame header stream ID selects the stream. Only the receiver of that direction may grant
credit, and only after the downstream consumer releases those raw bytes. Resulting outstanding
credit may never exceed 1,048,576. Zero/oversized increments, nonzero reserved bytes, wrong-side or
unknown-stream updates, integer overflow, chunks over credit, and credit above the maximum are
connection-fatal flow-control errors. A valid update arriving after its known direction/stream is
terminal is ignored without changing credit.

On parent IPC, Node-created stream IDs are odd and helper-created IDs are even; zero is connection
control only. Across the direct one-request connection the remote creates exactly stream ID 1.
Each connection retains only two uint64 high-water marks—highest accepted odd and highest accepted
even—plus at most 128 active stream states. REQUEST_START must have correct parity and be strictly
greater than its creator's high-water mark; the high-water mark advances before application
dispatch. Zero, wraparound/exhaustion, wrong parity, or a REQUEST_START ID at or below that side's
high-water mark closes the connection, so IDs are never reused without an unbounded tombstone set.
The 129th simultaneous REQUEST_START still advances the high-water mark, receives one RESPONSE_ERROR
`stream_limit`, and is not dispatched.

The per-stream state machine is exact:

1. REQUEST_START creates `request=open,response=none`; it occurs once.
2. REQUEST_CHUNK is valid only while request is open and not cancelled. REQUEST_END changes request
   `open -> ended` exactly once.
3. RESPONSE_START may occur once after REQUEST_START, before or after REQUEST_END, and changes
   response `none -> open`. RESPONSE_CHUNK is valid only while response is open.
4. RESPONSE_END changes `open -> succeeded`; RESPONSE_ERROR may change `none|open -> failed` and
   carries bounded canonical JSON. Either is the one response terminal and closes unfinished
   request input.
5. REQUEST_CANCEL from the stream initiator is valid after REQUEST_START and before response
   terminal. The first sets cancelled and triggers the abort exactly once; duplicate cancel is a
   no-op. Cancel after response terminal is a no-op.
6. Raw request frames already in flight after cancel/response terminal are discarded, never
   delivered or credited again, and still may not exceed the last request credit. Valid late
   WINDOW_UPDATE is ignored. A duplicate REQUEST_END, RESPONSE_START, or response terminal, a chunk
   before its start/after its direction terminal, or a frame forbidden by the state marks that
   stream failed; emit at most one safe RESPONSE_ERROR when possible. Any further
   non-cancel/non-window frame on that failed stream closes the connection.
7. Once a stream is removed from the active map, a late CANCEL or valid WINDOW_UPDATE for an ID at
   or below the correct side's high-water mark is ignored; every other frame for an inactive/unknown
   ID closes the connection. Any frame received before mutual connection authentication also closes
   the connection.

The **8 MiB aggregate queued-payload cap**, five-second HELLO/auth deadline, and twenty-second
graceful parent drain are local implementation policy rather than peer-granted credit. At the queue
cap the implementation stops reading/granting windows and relies on socket backpressure; it never
enlarges protocol credit.

HELLO and HELLO_ACK exchange 32-byte nonces plus exact version/capability/build metadata. HELLO also
contains only the compiled `controlProfile` numeric enum and `runtimePurpose` enum locked above;
HELLO_ACK echoes the accepted profile or fails before networking. Node then sends a stream-zero
COMMAND named **authenticate_parent** carrying **parentProof**:

**HMAC-SHA-256(parentCapability, "waifus-ipc-auth-v1" || clientNonce || helperNonce || exact HELLO bytes || exact HELLO_ACK bytes)**

The helper compares **parentProof** in constant time. Its RESULT carries **helperProof**:

**HMAC-SHA-256(parentCapability, "waifus-ipc-helper-v1" || clientNonce || helperNonce || exact HELLO bytes || exact HELLO_ACK bytes || parentProof)**

Node compares **helperProof** in constant time and accepts no command/event/stream before it
matches. Only then do both sides erase the one-launch capability. A process that merely wins the
socket race or observes **parentProof** cannot impersonate the helper, and a second client cannot
authenticate.

Control payloads use RFC 8785 canonical JSON and strict schemas from the public contract; data
frames and the fixed-width WINDOW_UPDATE payload are raw bytes.

### Direct application protocol

V1 opens **one authenticated TCP application connection per HTTP or SSE request** over the direct WireGuard path. It uses the same 24-byte WIPC header and request/response frame grammar, but does not use yamux or multiplex multiple HTTP/SSE requests on that connection. After stream-zero application authentication, the sole request uses stream ID 1. TCP and the 64 KiB chunks provide backpressure; a path change may break the connection and higher-level cursor/retry rules recover it. The parent capability is never used across the peer path.

After WireGuard path authentication, both peers perform this exact stream-zero application
challenge before REQUEST_START. The remote is the dialer; the host is the responder. Each creates
a fresh 32-byte nonce and a fresh 16-byte transport session ID for this application connection.
Pair ID and service ID are each exactly 16 bytes, bundle hashes are each 32 bytes, and trust epochs
are unsigned 64-bit values.

Define **LP(x) = uint32BE(byteLength(x)) || x** and these canonical byte strings:

- **protocolBytes = uint16BE(1) || uint16BE(negotiatedMinor)**
- **hostEpochBytes = uint64BE(hostTrustEpoch)**
- **remoteEpochBytes = uint64BE(remoteTrustEpoch)**

The exact signed bytes are:

~~~text
LP(ASCII "waifus-app-session-v1")
|| LP(protocolBytes)
|| LP(pairID)
|| LP(serviceID)
|| LP(hostNonce) || LP(remoteNonce)
|| LP(hostInstallationBundleHash) || LP(remoteInstallationBundleHash)
|| LP(hostEpochBytes) || LP(remoteEpochBytes)
|| LP(hostTransportSessionID) || LP(remoteTransportSessionID)
~~~

Both sides sign **SHA-256(exact signed bytes)** with their pinned Ed25519 installation key. Host
then remote order is mandatory independently for nonces, bundle hashes, trust epochs, and session
IDs; role-local or dialer-first ordering is never substituted. The decoder rejects any wrong
length, missing/extra field, integer-width change, trailing byte, or non-negotiated protocol value.

V1 installation Ed25519 and role-specific WireGuard node/discovery keys have `keySequence = 1` and
never auto-rotate. The embedded fork runs with node-key expiry disabled. A map/certificate asking
for node-key expiry/rotation, a missing/corrupt private key, or an operational requirement to rotate
enters typed `repair_required`; it never silently generates a replacement. Recovery is the typed
full identity reset plus attended re-pairing defined in Task 3. Trust epochs still increase for
per-pair revocation and are not key-rotation counters.

The remote HELLO carries its context; host HELLO_ACK supplies the host context plus host signature;
the remote verifies it and sends COMMAND **authenticate_peer** with the remote signature; the host
verifies and returns RESULT. Both sides recheck current local trust, key sequence, and revocation.
No REQUEST_START is accepted until the four-message state reaches authenticated, and the host
derives the Node principal using both transport session IDs plus the current trust record.

The remote helper may address exactly one pinned host service. The host helper derives the Node principal from this authenticated session and current trust record.

### Authenticated remote-browser context

The remote gateway validates its unexposed per-launch cookie, exact local origin/Fetch Metadata,
and session-bound CSRF policy before opening parent IPC. It then supplies exactly one strict
`RemoteBrowserContextV1` in REQUEST_START control JSON; browser headers, dashboard JavaScript,
assistant text/tool arguments, and peer HTTP headers can never supply or override it. Its RFC 8785
canonical JSON fields are exactly:

| Field | Exact V1 rule |
|---|---|
| `version` | integer `1` |
| `gatewayLaunchId` | 43-character canonical unpadded base64url decoding to 32 random bytes; current gateway launch only |
| `browserSessionId` | 43-character canonical unpadded base64url decoding to the current 32-byte server-side browser session ID |
| `requestNonce` | 22-character canonical unpadded base64url decoding to 16 fresh random bytes; one use per launch/session |
| `method` | exactly one of `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `canonicalTarget` | 1–2,048 ASCII bytes of exact origin-form pathname plus optional query, as defined below |
| `csrfValidated` | literal `true`; for a safe method this means the gateway evaluated the policy and no token was required |

The canonical target begins `/`, contains no scheme, authority, userinfo, fragment, backslash,
control/space, invalid percent escape, dot segment, or encoded `/` or `\\`. Percent escapes use
uppercase hex and are forbidden for RFC 3986 unreserved bytes; the query's pair order and duplicate
keys are otherwise byte-preserved. The gateway rejects an input whose parsed pathname/query does
not already equal this canonical serialization. These exact method/target bytes are also the
REQUEST_START method/target; absolute-form URLs and normalization after authentication fail.

Before serving that launch, Node sends one authenticated stream-zero `register_gateway_launch`
command containing exactly `gatewayLaunchId` and its absolute-expiry uint64 decimal string. The
helper keeps only the current unexpired ID, invalidates the prior ID before acknowledging a new one,
and refuses launch replacement while its request streams are active. REQUEST_START must match it;
restart has no implicit current launch and requires a new registration.

After the four-message application authentication, define:

~~~text
appSessionHash = SHA-256(exact app-session signed bytes || hostSignature64 || remoteSignature64)

browserContextKey = HKDF-SHA-256(
  IKM = pairRoot,
  salt = appSessionHash,
  info = ASCII "waifus/browser-context-key/v1" || 0x00
         || pairID || serviceID
         || hostInstallationBundleHash || remoteInstallationBundleHash
         || uint64BE(hostTrustEpoch) || uint64BE(remoteTrustEpoch)
         || hostTransportSessionID || remoteTransportSessionID,
  length = 32)
~~~

This is an ephemeral per-application-session key, not a fifth persistent pair key. The remote
helper generates a fresh 16-byte `directRequestId`, uses direct stream ID `1`, and MACs:

~~~text
HMAC-SHA-256(browserContextKey,
  LP(ASCII "waifus/remote-browser-context/v1")
  || LP(exact RFC 8785 RemoteBrowserContextV1 bytes)
  || LP(pairID)
  || LP(UTF-8 remoteDeviceId from the pinned identity bundle)
  || LP(remoteInstallationBundleHash)
  || LP(uint64BE(hostTrustEpoch)) || LP(uint64BE(remoteTrustEpoch))
  || LP(appSessionHash)
  || LP(directRequestId)
  || LP(uint64BE(remoteParentStreamId))
  || LP(uint64BE(1)))
~~~

`remoteParentStreamId` is the odd, strictly increasing WIPC stream that carried this request. The
peer REQUEST_START carries the exact context bytes, `directRequestId`, that parent stream ID,
direct stream ID `1`, and the 32-byte MAC as fields outside the forwarded HTTP header block. The
host helper verifies the MAC, pair/device/bundle/trust record, app-session hash, stream IDs,
single-use request nonce/directRequestId, method, and byte-identical concrete target before it emits
an immutable authenticated browser context with the derived `remote_device` principal to Node over
parent IPC. It strips/rejects lookalike ordinary HTTP headers and never reconstructs this context
from them. No REQUEST_DATA reaches Node before verification.

The public Plan 01 contract and vectors use these exact field names and encodings. Valid and invalid
Go/TypeScript vectors cover stale `gatewayLaunchId`, expired/browser-session replacement, replayed
request nonce, different remote device/bundle/trust epoch, other app session, parent/direct stream,
direct request ID, method, path, query/order/percent alias, `csrfValidated:false`, MAC substitution,
forged `X-Device-*`/context headers, and assistant-supplied lookalikes.

---

## Locked Pairing Encodings and Cryptography

### Invitation constants

- Invitation ID: 16 random bytes.
- Expiry: exactly 5 minutes from Worker acceptance.
- Full secret: 32 random bytes.
- Short code: 40 random bits encoded as eight uppercase Crockford Base32 characters in two groups, **XXXX-XXXX**, using alphabet **0123456789ABCDEFGHJKMNPQRSTVWXYZ**.
- The short code is lookup only and never authorizes a peer.

### Full token

The copied/QR token is **WF1.** followed by unpadded base64url of RFC 8949 deterministic/canonical CBOR. The CBOR value is a map with these integer keys and no others:

| Key | Field | Encoding |
|---:|---|---|
| 1 | v | unsigned integer, exactly 1 |
| 2 | invitation ID | byte string, exactly 16 bytes |
| 3 | expiry Unix seconds | unsigned integer |
| 4 | host installation public key | byte string, exactly 32 bytes |
| 5 | host installation fingerprint | byte string, exactly 16 bytes |
| 6 | host pairing public material | byte string, exactly 32-byte invitation X25519 public key |
| 7 | full secret | byte string, exactly 32 bytes |
| 8 | host signature | byte string, exactly 64 bytes |

The fingerprint is the first 16 bytes of **SHA-256("waifus/install/fingerprint/v1" || hostInstallationPublicKey)**. The host signature is Ed25519 over **"waifus/full-token/v1" || canonicalCBOR(map keys 1 through 7)**.

The decoder rejects duplicate keys, indefinite lengths, non-shortest integers, reordered/noncanonical map encodings, extra/missing fields, invalid sizes/signature/fingerprint, padding/noncanonical base64url, wrong prefix/version, or expiry. It re-encodes and requires byte equality. The token is never an HTTPS URL/query value and is never sent to Cloudflare.

The 32-byte Noise PSK is:

**HKDF-SHA-256(IKM = fullSecret, salt = invitationID, info = "waifus-noise-xxpsk0-v1", length = 32)**

### Noise transcript

Both flows use independent per-invitation X25519 Noise static/ephemeral material. Long-lived Ed25519 installation keys are not reused as X25519 keys.

The exact Noise prologue is the byte concatenation:

1. ASCII **WAIFUS-PAIR**
2. one zero byte
3. protocol major **1** and minor **0**, each unsigned big-endian uint16
4. invitation ID
5. invitation generation as unsigned big-endian uint64, initially **1** and never reused after
   cancel/consume/expiry
6. the 16-byte pending pair ID assigned when InvitationDO locks the joiner
7. one-byte initiator role **2** for joining remote
8. one-byte responder role **1** for host

Encrypted Noise payloads carry strict contract records. Each installation bundle contains and signs:

- Bundle version.
- Canonical data-root-scoped device ID.
- Role.
- Trust epoch.
- Ed25519 installation public key.
- Tailscale/WireGuard node public key.
- Discovery public key.
- Key sequence, exactly **1** in V1.
- Current protocol/capability vector.

The exact identity-bundle encoding is RFC 8949 deterministic/canonical CBOR with an unsigned map
of keys **1–10** and a signed map of keys **1–11**:

| Key | Field | Encoding |
|---:|---|---|
| 1 | version | unsigned integer, exactly 1 |
| 2 | device ID | UTF-8 text matching the public `DeviceId` contract |
| 3 | role | unsigned integer, exactly 1 host or 2 remote |
| 4 | trust epoch | unsigned uint64 |
| 5 | installation public key | exactly 32-byte Ed25519 public-key bstr |
| 6 | node public key | exactly 32-byte WireGuard public-key bstr |
| 7 | discovery public key | exactly 32-byte discovery public-key bstr |
| 8 | key sequence | unsigned integer, exactly 1 in V1 |
| 9 | protocol | map `{1: uint16 major, 2: uint16 minor}` |
| 10 | capabilities | map `{1: required tstr array, 2: optional tstr array}` using the public sorted/disjoint rules |
| 11 | signature | exactly 64-byte Ed25519 signature bstr |

The signature input is ASCII **waifus/identity-bundle/v1** followed by canonical CBOR of the
unsigned keys **1–10**. The decoder rejects duplicate/unknown keys and every noncanonical form
before verifying the signature.

The three XX handshake payloads are also exact canonical-CBOR maps. Message 1 is
`{1:1, 2:2, 3:remoteBundleHash}`. Message 2 is
`{1:1, 2:1, 3:hostBundleCbor, 4:remoteBundleHash}`. Message 3 is
`{1:1, 2:2, 3:remoteBundleCbor, 4:hostBundleHash}`. The first field is the record version and the
second is the sender role. Bundle hashes are 32-byte SHA-256 bstr values; bundle CBOR fields are
the exact signed bytes above. Define **LP(x)=uint32BE(byteLength(x))||x** and
**transcriptHash=SHA-256(LP(message1)||LP(message2)||LP(message3))** over the exact encoded Noise
messages, including their Noise keys, ciphertext, payload, and tags. This transcript hash is
distinct from, and never substituted for, the Noise library's final 32-byte channel binding.

Each complete Noise handshake/mailbox record is at most **1,200 decoded bytes**. The helper
rejects an oversized record before allocation, encoding, or Worker submission.

### Pair root and separated keys

Noise channel binding alone is not treated as secret. Before closing the Noise transport, each
side sends exactly one independent 32-byte random pair contribution as the entire plaintext of its
first encrypted Noise transport message (transport nonce zero in that direction).

Derive:

**pairRoot = HKDF-SHA-256(IKM = hostContribution || remoteContribution, salt =
NoiseChannelBinding, info = ASCII "waifus-pair-root-v1" || 0x00 || invitationID ||
uint64BE(invitationGeneration) || pairID || hostBundleHash || remoteBundleHash, length = 32)**

Host contribution, bundle hash, and identity always precede remote. Define:

**pairKeySalt = SHA-256(ASCII "waifus/pair-key-salt/v1" || 0x00 || NoiseChannelBinding || pairID)**

For each exact ASCII label below derive:

**key(label) = HKDF-SHA-256(IKM = pairRoot, salt = pairKeySalt, info = label || 0x00 ||
invitationID || uint64BE(invitationGeneration) || pairID || hostBundleHash || remoteBundleHash,
length = 32)**

The four persistent labels and resulting 32-byte keys are:

- **waifus-coordination-host-to-remote-v1**
- **waifus-coordination-remote-to-host-v1**
- **waifus-confirmation-v1**
- **waifus-revocation-v1**

No salt, context field, separator, role order, or output length is optional. Each key must differ;
using one label's output for another purpose fails the crypto vectors.

The **confirmation key** is used only for `PairConfirmationV1`. Each side's signed
`.../consume` JSON body contains exactly `version:1`, canonical 22-character `invitationId` and
`pairId`, canonical uint64-decimal `invitationGeneration`, `side` (`1` or `2`), 43-character
base64url transcript hash, channel binding, host bundle hash, remote bundle hash, and
approval-context hash, a 22-character 16-byte `confirmationNonce`, and a 43-character 32-byte
`confirmationMac`. Its MAC input is:

~~~text
HMAC-SHA-256(confirmationKey,
  LP(ASCII "waifus/pair-confirmation/v1")
  || LP(invitationID) || LP(uint64BE(invitationGeneration)) || LP(pairID)
  || LP(sideByte) || LP(transcriptHash) || LP(NoiseChannelBinding)
  || LP(hostBundleHash) || LP(remoteBundleHash) || LP(approvalContextHash)
  || LP(confirmationNonce16))
~~~

The Worker cannot derive this key: it validates the outer installation-signed request, strict
widths/context equality, one confirmation per side/nonce, and stores only the MAC/commitment. Each
helper first publishes its own typed `pair_confirmation` mailbox record, then polls and locally
verifies the peer's exact record, and only then sends its own idempotent `/consume`
acknowledgement. Publishing never waits for the peer, so there is no mutual-wait deadlock. Two
locally verified confirmations are required in addition to the Worker's two idempotent consume
records. A Worker never interprets a MAC as proof it can independently verify.

`pair_confirmation` is a distinct post-approval/pre-consume invitation-mailbox type, not a
`noise_transport` payload. Its payload is exactly the RFC 8785 `PairConfirmationV1` JSON above,
at most **1,024 raw bytes**; the full strict mailbox request remains within **2,048 raw bytes**.
Exactly one record per side/confirmation nonce is accepted, and polling returns at most one. It is
rejected before approval, before pair contributions/key derivation, after consume/cancel/expiry, or
with any extra field. The public
**contracts/remote/v1/fixtures/crypto/pair-confirmation-v1.json** fixture pins exact canonical bytes,
MAC, phase, size 1,024/1,025, publish-first ordering, duplicate/idempotent behavior, and every
context substitution in Go and Worker TypeScript.

The **revocation key** is used only by PairControl `revocation` and `revocation_ack`. Their payloads
include a 43-character `revocationMac`. For `revocation`, compute:

~~~text
HMAC-SHA-256(revocationKey,
  LP(ASCII "waifus/pair-revocation/v1") || LP(pairID)
  || LP(senderRoleByte) || LP(uint64BE(revocationEpoch)) || LP(ASCII reason)
  || LP(hostBundleHash) || LP(remoteBundleHash)
  || LP(uint64BE(hostTrustEpoch)) || LP(uint64BE(remoteTrustEpoch))
  || LP(recordNonce16))
~~~

For `revocation_ack`, use label **waifus/pair-revocation-ack/v1**, the same ordered fields with the
acknowledging role as sender, omit `reason`, and retain the exact revocation epoch/record nonce. The
Worker structurally validates and durably forwards the MAC but cannot verify it; it applies the
outer installation-signed monotonic revoke so a corrupt/lost pair secret cannot prevent cutoff.
The receiving helper requires both the sender's Ed25519 record signature and the revocation MAC
before accepting the peer-authenticated intent/ack into local trust state. Missing/wrong/cross-pair/
cross-role/epoch/reason/nonce MACs fail the shared vectors and never weaken Worker-side cutoff.

The invitation secret and Noise transport cipher states are erased after derivation. V1 defines no
pair-key or identity-bundle rotation protocol; changing any installation/node/discovery key requires
the full reset and new attended pairing.

Before reporting pairing success, the helper vault-persists one crash-safe pair record for the
selected canonical data root. It contains the secret **pairRoot** (or byte-identical independently
derived separated keys), exact pinned host/remote canonical identity bundles and hashes, invitation
ID/generation, pair ID, 16-byte service ID, transcript hash/channel binding, both trust epochs/key
sequences, local deny/revocation state, endpoint send-next epoch, receive-highest epoch/ciphertext
hash, a prepared/applied receive phase plus recoverable latest ciphertext/validated candidate state,
and schema version. Pair secret material never enters Node storage. A send epoch is durably reserved before
encryption; a crash may skip an epoch but can never reuse a nonce. A received epoch/hash is durably
committed before acknowledgement/application. Missing, corrupt, rolled-back, wrong-root, or
partially migrated state fails closed and requires attended repair, never silent key regeneration.
On restart, a prepared same-epoch/same-hash receive resumes application and acknowledgement;
same-epoch/different-hash and every lower epoch remain rejected.

### Safety phrase and attended approval

Both token flows display the same SAS, and attended comparison of all five words plus the
12-character fingerprint followed by explicit host approval is mandatory for **both** the full
token and short-code flow. Possession of the full token/PSK prevents an unauthenticated join but
never auto-approves identity or skips the attended comparison.

1. Compute **canonicalIdentityBundleHash = SHA-256(canonicalCBOR(hostIdentityBundle) || canonicalCBOR(remoteIdentityBundle))** in host-then-remote role order.
2. Compute **sasBytes = HKDF-SHA-256(IKM = NoiseChannelBinding, salt = pairID, info = "waifus/sas/v1" || canonicalIdentityBundleHash, length = 7)**.
3. Take exactly the first 50 bits in big-endian order and require the low six unused bits of the seventh byte to be ignored, not used as another check value.
4. Split the 50 bits into five 10-bit indices.
5. Map them to **contracts/wordlists/sas-v1.txt**, the checked-in fixed 1,024-line unambiguous lowercase English list from the public contract lock. The private **CONTRACTS.lock** pins the exact file SHA-256.
6. Compute the short fingerprint as the first six bytes of **SHA-256("waifus/sas-fingerprint/v1" || pairID || NoiseChannelBinding || canonicalIdentityBundleHash)** and render exactly 12 lowercase hexadecimal characters.
7. Display five lowercase words separated by single spaces, the 12-character hex fingerprint, device name, platform, and installation fingerprint.

The host service creates one strict **ApprovalReceiptV1** only after the approving browser submits
the comparison. Byte strings in its RFC 8785 canonical JSON are unpadded base64url; unsigned
64-bit values are shortest unsigned decimal strings with no leading zero. Its fields are exactly:

- `version: 1`, a 32-byte random `receiptId`, `issuedAt`, and `expiresAt`; expiry is the earlier of
  120 seconds after issue or invitation expiry.
- Exact 16-byte invitation ID, unsigned 64-bit invitation generation, and 16-byte pending pair ID.
- Exact canonical-CBOR host and remote identity-bundle bytes plus each 32-byte SHA-256 hash, always
  in host-then-remote order.
- Noise pattern, protocol major/minor, 32-byte transcript hash, and 32-byte channel binding.
- The exact five unsigned 10-bit SAS indices in display order and six-byte SAS fingerprint.
- Host and remote trust epochs as canonical uint64-decimal strings; both key-sequence fields are
  integer `1`.
- Approving principal kind/stable ID and, for a remote approver, device fingerprint/trust epoch.
- One strict `browserBinding` union is always required: local approvals carry exactly
  `{kind:"local", hostServerLaunchId:<32 bytes>, browserSessionId:<32 bytes>}` from the current
  authenticated host browser server; remote approvals carry exactly
  `{kind:"remote", gatewayLaunchId:<32 bytes>, browserSessionId:<32 bytes>}` copied from the
  host-helper-verified `RemoteBrowserContextV1`. A local value cannot fill the remote branch or vice
  versa.
- The 16-byte confirmation request nonce, uppercase method, and canonical concrete confirmation
  target are required and must match the authenticated `RemoteBrowserContextV1` (or the equivalent
  locally authenticated browser context) that submitted this one approval.
- Optional assistant conversation/tool/pending-action IDs plus the confirmed action-payload hash;
  these augment but never replace the approving principal and browser session.
- A 32-byte single-use nonce and literal action **approve_pair**.

Define **approvalContextHash = SHA-256(ASCII "waifus/approval-receipt/v1" || exact canonical
ApprovalReceiptV1 bytes)**. Node sends the exact receipt only over the already mutually
authenticated parent IPC after rechecking the current actor, browser launch/session, request
binding, and expiry. The helper re-derives every cryptographic field from its locked pending state,
requires the strict Node-attested browser binding without pretending it can query browser state,
consumes `receiptId` and nonce once, and signs the Worker approval over `approvalContextHash`; only
the hash, not raw browser/session metadata, leaves the host. The administrative audit records the
receipt ID, actor ID, a keyed browser-session correlation hash, and outcome without raw session
IDs, identity-bundle bytes, or secrets.

A mismatch, missing comparison, expired approval, or unapproved identity is rejected and consumes
no endpoint exchange.

### Endpoint envelopes

After exact approval only, each direction encrypts a strict endpoint-generation record using its
direction-specific ChaCha20-Poly1305 key: host sends only with
`waifus-coordination-host-to-remote-v1`, and remote only with
`waifus-coordination-remote-to-host-v1`.

- Epoch starts at 1 and strictly increases.
- Nonce is four zero bytes followed by epoch as unsigned big-endian uint64.
- Plaintext is RFC 8949 canonical CBOR map with integer keys: **1** version (exactly 1), **2**
  endpoint epoch (uint64), **3** connection generation (uint64), and **4** candidates (array of at
  most 12). Each candidate is a canonical map with **1** kind (`1=interface`, `2=server_reflexive`,
  `3=port_mapped`), **2** family (`4` or `6`), **3** network-order address bytes (4 or 16 bytes),
  **4** UDP port (1–65535), and **5** priority (uint32). No field is optional or extensible in V1.
- Candidates are unique and sorted by priority descending, then kind, family, address bytes, and
  port ascending. Unspecified, loopback, link-local, multicast, broadcast, non-UDP, malformed, and
  relay candidates are rejected before encryption/probing.
- Define **LP(x) = uint32BE(byteLength(x)) || x**. Associated data is exactly:

~~~text
LP(ASCII "waifus-endpoint-envelope/v1")
|| LP(uint16BE(1) || uint16BE(negotiatedMinor))
|| LP(pairID)
|| LP(senderRoleByte) || LP(receiverRoleByte)
|| LP(hostInstallationBundleHash) || LP(remoteInstallationBundleHash)
|| LP(uint64BE(hostTrustEpoch)) || LP(uint64BE(remoteTrustEpoch))
|| LP(uint64BE(endpointEpoch))
~~~

  Roles are `1=host`, `2=remote`; bundle hashes and trust epochs remain host-then-remote regardless
  of sender. Pair ID is 16 bytes, role fields one byte, and hashes 32 bytes. Wrong length/order,
  trailing bytes, epoch mismatch between nonce/plaintext/AD, or protocol mismatch fails closed.
- Plaintext allows at most 12 validated candidates and is at most 1,184 bytes.
- Ciphertext is at most 1,200 bytes. This leaves bounded space for the required signed-control
  fields after unpadded-base64url encoding inside the Worker's 2,048-byte JSON/WS envelope.
- Same epoch with different bytes, rollback, malformed candidates, multicast/broadcast/unspecified destinations, or an unapproved sender is rejected.

---

## Task 1: Create the private repository and pin immutable inputs

**External action — do not execute without user confirmation.**

- [ ] Confirm authenticated GitHub organization **waifucave**, requested visibility **private**, and that **waifucave/ts-connect** is absent.
- [ ] Ask the user, then create the repository with private visibility and branch protection.
- [ ] Add the layout above, Go **1.26.5**, and release-build defaults.
- [ ] Add the exact public fork commit to **go.mod** using a versioned replacement while retaining imports under **tailscale.com/...**.
- [ ] Add **FORK.lock**, **CONTRACTS.lock**, and **CRYPTO.lock**.
- [ ] Pin Noise:

~~~bash
go get github.com/flynn/noise@v1.1.0
go mod verify
go list -m -json github.com/flynn/noise
~~~

Expected: version **v1.1.0** resolves to commit **4d9f71cd...**.

- [ ] Add CI that fails if Go, fork, contract, or Noise pins drift.
- [ ] Confirm release builds always use **-tags=waifus_direct_only**.

**Suggested commit:** **chore: establish pinned ts-connect foundation**

## Task 2: Implement and fuzz authenticated parent IPC

**Files in waifucave/ts-connect:**

- Create: **internal/ipc/frame.go**, **codec.go**, **auth.go**, **session.go**
- Create platform socket/pipe implementations
- Test: **internal/ipc/*_test.go**, fuzz tests

- [ ] Write failing golden tests for every frame type, the exact 24-byte header on every frame,
  fragmented/coalesced reads, the exact eight-byte WINDOW_UPDATE payload, initial/max credit and
  byte accounting in both directions, delayed consumer replenishment, strictly monotonic per-side
  high-water IDs/parity/reuse/exhaustion/limit without tombstone growth, every request/response/
  cancel transition, late frames, duplicate cancel/terminals, and protocol negotiation.
- [ ] Add failing adversarial tests for oversized length before allocation, invalid UTF-8, unknown JSON fields, stream reuse, window overflow, auth replay, wrong parent/helper HMAC, socket-race impersonation, second client, and parent-pipe loss.
- [ ] Implement the codec and state machine exactly as locked above.
- [ ] Implement mode-0600 UDS/mode-0700 parent directory and current-user Windows named-pipe DACL.
- [ ] Add fuzz targets seeded with all valid/invalid public fixtures.
- [ ] Add an integration harness that spawns the real helper, writes the 32-byte inherited capability, authenticates, starts a stream, cancels it, and closes the parent pipe.

Verification:

~~~bash
go test ./internal/ipc/...
go test -race ./internal/ipc/...
go test -fuzz=FuzzFrameDecoder -fuzztime=30s ./internal/ipc
~~~

Expected: bounded memory, exact fixture bytes, no orphan process, and zero secret-bearing diagnostic output.

**Suggested commit:** **feat: add authenticated framed parent IPC**

## Task 3: Implement per-data-root identity and trust storage

**Files:**

- Create: **internal/identity/** and **internal/platform/** vault adapters
- Test: identity, migration, corruption, and real-platform smoke tests

- [ ] First write tests for:
  - Independent canonical data roots receive independent installation IDs and keys.
  - The same data root restores one installation Ed25519 identity after restart while keeping
    independent host-role and remote-role node/discovery keys, runtime state, and locks.
  - Host and remote helpers for one data root run concurrently without key or state-file races.
  - Installation/node/discovery/WireGuard keys restore byte-identically with `keySequence = 1` and
    never auto-rotate; expiry/rotation requests and missing/corrupt keys enter `repair_required`.
  - Trust-epoch rollback and corrupt state fail closed.
  - Ordinary clean/cache deletion does not remove identity or pair trust.
  - Pair success vault-persists pairRoot/separated keys, pinned transcript/bundles, both trust
    epochs and fixed key sequences `1`, endpoint send/receive epochs, and deny/revocation state
    before success is reported.
  - Crash/restart before and after send-epoch reservation, encryption, publish, receive commit,
    acknowledgement, clean, and migration never reuses an AEAD nonce or accepts epoch rollback.
  - Two canonical data roots cannot open, derive, migrate, revoke, or reset each other's pair state.
  - Individual device revoke/remote-host forget removes only that pair's secret/trust and writes
    its deny tombstone; it never rotates the installation identity or removes unrelated pairs.
  - The explicit local full installation-identity reset removes/replaces the installation identity
    and all pair trust only for the selected canonical data root; it is not the individual-revoke
    operation.
- [ ] Implement macOS Keychain, Windows DPAPI/Credential Manager, Linux Secret Service, and a mode-0600 Linux fallback with an explicit warning.
- [ ] Keep installation, role-specific node/discovery private keys, pairRoot/separated keys, and
  recoverable endpoint plaintext only in OS vault or mode-0600 helper-private encrypted storage.
  Node and the nonsecret app trees receive only opaque vault references, public keys/fingerprints,
  hashes, epochs, and redacted metadata. Add a recursive sentinel test proving no private/secret
  bytes appear under **app/remote-access/**, **app/remote-gateway/**, cache, logs, or diagnostics.
- [ ] Store nonsecret host-role helper state under the per-data-root **app/remote-access/**
  subtree and remote-role helper state under **app/remote-gateway/**. Keep their node/discovery
  public metadata/vault references, runtime files, sockets, and locks separate; their
  node/discovery private keys never live there. Only the vault-owned installation Ed25519 identity
  is shared for that canonical data root. Runtime helper logs are ordinary logs under
  exact **app/logs/remote-host.log** and **app/logs/remote-gateway.log** files,
  never under either preserved state tree; `waifus clean --include-logs` removes them. The separate
  administrative audit is preserved. Dashboard cache remains separate from both.
- [ ] Add crash-safe atomic writes and a versioned migration journal.
- [ ] Implement the public parent-IPC commands **reset_identity** and **get_reset_status**. The
  strict `reset_identity` payload has exactly `resetTombstone` (canonical uint64 decimal string,
  strictly above the selected root's persisted high-water) and `expectedOldFingerprint` (the exact
  22-character unpadded-base64url 16-byte installation fingerprint already used by V1). A lower or
  repeated-but-different tombstone, wrong fingerprint, extra field, or another canonical data root
  fails without mutation. `get_reset_status` accepts exactly that tombstone and returns only its
  journaled status/receipt.
- [ ] Define strict **IdentityResetReceiptV1** with exactly: `version:1`, `resetTombstone`, a
  22-character random `resetId`, old and new 43-character installation public keys, old and new
  22-character fingerprints, canonical uint64-decimal `clearedActivationCount`,
  `clearedPairCount`, `clearedHostRoleSecretCount`, and `clearedRemoteRoleSecretCount`, exact stage
  enum `prepared|old_state_cleared|new_identity_committed|complete`, and canonical uint64-decimal
  `completedAt` (present only at `complete`). Unknown fields and impossible stage/field combinations
  fail. The complete receipt is immutable and byte-identical on every retry.
- [ ] Reset while the helper is alive, spawning the same binary in reset-only mode if no helper is
  running. It first writes a crash-safe `prepared` tombstone and stops all advertisement/normal
  commands; clears the old activation certificate, every pair secret/trust record, both roles'
  node/discovery/WireGuard private state, and endpoint state; creates a fresh unactivated
  installation identity plus fresh host/remote role state at `keySequence = 1`; durably commits the
  complete receipt; returns it; then drains and self-exits. Node-owned state trees are not cleared by
  the helper. A crash at every stage causes reset-only startup to resume the same tombstone
  idempotently, never advertise the old/new identity early, never resurrect cleared secrets, and
  never create a second new identity.

Expected: restart and migration fixtures preserve identity; corruption never silently generates replacement identity.

**Suggested commit:** **feat: add data-root-scoped device identity and trust store**

## Task 4: Implement both attended pairing flows

**Files:**

- Create: **internal/pairing/token.go**, **noise.go**, **bundle.go**, **sas.go**, **keys.go**
- Test: golden vectors shared with public contracts plus negative/race tests

- [ ] Write exact **WF1.** canonical-CBOR token encoding/decoding/signature goldens plus duplicate-key, noncanonical-form, malformed, and expiry cases.
- [ ] Write Noise full-token vectors using **XXpsk0** and short-code vectors using **XX**, both against the pinned library.
- [ ] Pin maximum-size Noise mailbox vectors at 1,200 decoded bytes and reject 1,201 bytes
  before transport; consume the matching public maximum-width JSON-envelope fixtures.
- [ ] Write failing transcript-substitution tests for role, invitation ID/generation, pair ID,
  bundle, node key, discovery key, trust epoch, protocol, and fixed key sequence `1`.
- [ ] Reject a join whose installation Ed25519 key/device ID equals the host installation, even
  though its role-specific node/discovery keys differ; one data root cannot pair its remote role to
  its own host role.
- [ ] Write SAS vector tests that pin the exact 50 bits, all five 10-bit indices/words, 12-character fingerprint, and the 1,024-word-list checksum.
- [ ] Require the displayed five-word SAS and fingerprint plus an explicit attended approval in
  both XXpsk0/full-token and XX/short-code success vectors; prove neither flow can auto-approve.
- [ ] Write ApprovalReceiptV1 canonical-byte/hash goldens and substitution tests for exact host and
  remote bundles/hashes, invitation ID/generation, pair ID, Noise pattern/protocol/transcript/
  channel binding, all SAS indices/fingerprint, actor, both trust epochs/fixed key sequences `1`,
  local-host-launch or remote-gateway-launch/browser-session/confirmation-request binding, assistant provenance/
  action hash, nonce, issue/expiry, replay, and cross-flow reuse.
- [ ] Write pair-root and all four persistent separated-key vectors pinning contribution/identity role order,
  salt, every info byte/label/separator, invitation generation, 32-byte output, and distinctness;
  prove channel binding alone cannot derive any pair key.
- [ ] Write exact `PairConfirmationV1`, revocation, and revocation-ack HMAC vectors for both roles,
  every domain/LP/context byte and Worker-versus-receiver behavior; reject key reuse, missing MAC,
  and pair/role/epoch/reason/nonce/transcript substitution.
- [ ] Write deterministic endpoint vectors shared with public contracts for the exact canonical
  CBOR bytes, candidate ordering, nonce, length-prefixed AD, host/remote role order, ciphertext,
  decrypt result, and a maximum 1,184-byte plaintext/1,200-byte ciphertext. Tamper every field,
  swap host/remote order, reorder candidates, use 1,185/1,201 bytes, replay/roll back epochs, and
  reuse one epoch with different bytes; every invalid case must fail.
- [ ] Write invitation race tests: one joiner, idempotent consume/finalization reconciliation,
  expiry, cancellation, and no endpoint publication/probe before approval/PairDO activation.
- [ ] Implement the locked protocol.
- [ ] Require the exact single-use ApprovalReceiptV1 from the host service. Either the local host
  browser or an already trusted remote administrator may approve, but the current actor and exact
  discriminated local-host/remote-gateway browser launch, browser session, and confirmation
  request must match; an assistant cannot manufacture or replace the receipt.
- [ ] Erase invitation secret, Noise state, and pair contributions after success/failure.

Verification:

~~~bash
go test ./internal/pairing/...
go test -race ./internal/pairing/...
go test -fuzz=FuzzInvitationToken -fuzztime=30s ./internal/pairing
~~~

**Suggested commit:** **feat: add bound full-token and SAS pairing protocols**

## Task 5: Implement the activation-certificate client

**Files:**

- Create: **internal/control/activation.go**, **certificate.go**, **signed_request.go**
- Test against the helper-owned deterministic fake Worker under **internal/testcontrol/**, generated
  from plan 01 public contracts. Plan 04 later consumes the same vectors; plan 03 never waits on a
  plan 04 implementation.

ActivationCertificateV1 is RFC 8949 canonical CBOR. The unsigned map has exactly these integer
keys: **1** version (1), **2** serial (16-byte bstr), **3** installation Ed25519 public key
(32-byte bstr), **4** issued-at Unix seconds (uint64), **5** expires-at (uint64), **6** credential
epoch (uint64), **7** coordination major (uint16), **8** coordination minor (uint16), **9** quota
tier (`1=free` in V1), and **10** active-profile Worker signing-key ID (1–64 printable ASCII bytes;
initial production/staging IDs are exactly the compiled-profile table values). Define
**LP(x)=uint32BE(byteLength(x))||x**. The Worker
signature is:

**Ed25519.Sign(workerKey, LP(ASCII "waifus/activation-certificate/v1") ||
LP(canonicalCBOR(map keys 1–10)))**

The full certificate is canonical CBOR of keys 1–10 plus **11** signature (64-byte bstr). Decoders
reject noncanonical CBOR, unknown/duplicate keys, wrong widths/ranges/key ID, or re-encoding drift.
The certificate hash below is SHA-256 of those exact full-certificate bytes.

For ordinary certificate-authenticated control requests define **protocolBytes = uint16BE(major)
|| uint16BE(minor)** and the exact signing input. Authentication metadata is carried only by the
fixed HTTP headers below; it is not copied into query parameters or JSON fields:

~~~text
LP(ASCII "waifus/control-request/v1")
|| LP(uppercase ASCII method)
|| LP(exact concrete ASCII request pathname, with canonical IDs substituted and no query)
|| LP(SHA-256(exact raw request body))
|| LP(protocolBytes)
|| LP(SHA-256(exact full certificate bytes))
|| LP(certificateSerial)
|| LP(uint64BE(credentialEpoch))
|| LP(installationPublicKey)
|| LP(ASCII workerSigningKeyID)
|| LP(uint64BE(unixTimestampSeconds))
|| LP(requestNonce16)
~~~

For parameterized routes, the signed pathname contains the actual canonical 22-character
unpadded-base64url invitation/pair ID; it is never the `:invitationId`/`:pairId` template, a decoded
then re-encoded alias, a percent-encoded form, or a query-bearing value. The installation key
Ed25519-signs those exact bytes. The Worker reconstructs them from the concrete incoming URL
pathname and fixed authentication metadata before parsing the body, verifies certificate/key/
epoch, then parses the strict body. Method/path/ID case, field order, key ID, widths, body bytes, or
protocol substitution fails.

Activation begin and poll happen before a certificate exists. They use the same layout with no
certificate fields and distinct first labels **waifus/activation-begin/v1** and
**waifus/activation-poll/v1**; their fixed routes are respectively
**/v1/activation/challenges** and **/v1/activation/poll**. The remaining ordered fields are method,
route, raw-body SHA-256, protocolBytes, installation public key, uint64BE timestamp, and 16-byte
request nonce. The installation key signs the exact LP bytes. Browser completion is Turnstile-
authenticated and is the only unsigned helper-protocol exception.

### Exact HTTP and WebSocket authentication envelope

V1 uses these literal lower-case application header names and no `Authorization` alias. Header
names are compared after ASCII case-folding because HTTP field names are case-insensitive, so case
can never select a different credential or field meaning. The helper emits the lower-case spelling.
At an ingress layer that exposes raw header tuples, a non-lower-case application name is rejected;
at Cloudflare's normalized Fetch boundary it is the one normalized logical field. In both cases,
two occurrences of the same name after case-folding, including mixed-case duplicates, are rejected.
If a platform unfolds or coalesces duplicates, the resulting comma makes the value invalid.

Every listed value is printable ASCII with no leading/trailing optional whitespace, internal space
or tab, comma, CR/LF, or obsolete folding. A base64url value uses only `[A-Za-z0-9_-]`, has no `=`,
decodes to the stated width, and must equal an unpadded base64url re-encoding of those bytes. Decimal
values have no sign and no leading zero except the value `0`. An unknown `x-waifus-*` header,
authentication value in a query/body field, missing field, extra field for that request class, or
aggregate application-auth header values over **1,024 ASCII bytes** is rejected before mutation.

| Header | Exact V1 grammar and limit |
|---|---|
| `x-waifus-protocol` | Exactly `1.0` |
| `x-waifus-certificate` | 1–512 canonical unpadded-base64url characters; decoded bytes at most 384 and exactly one valid full `ActivationCertificateV1` |
| `x-waifus-installation-key` | Exactly 43 canonical unpadded-base64url characters decoding to 32 bytes |
| `x-waifus-timestamp` | Canonical uint64 decimal, 1–20 characters |
| `x-waifus-request-nonce` | Exactly 22 canonical unpadded-base64url characters decoding to 16 bytes |
| `x-waifus-request-signature` | Exactly 86 canonical unpadded-base64url characters decoding to the 64-byte installation-key signature |
| `x-waifus-worker-key-id` | 1–64 characters matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `x-waifus-response-nonce` | Exactly 22 canonical unpadded-base64url characters decoding to 16 bytes |
| `x-waifus-response-signature` | Exactly 86 canonical unpadded-base64url characters decoding to the 64-byte Worker signature |

The required request-header sets are exact:

| Request class | Required application-auth headers | Forbidden application-auth headers |
|---|---|---|
| Certificate-authenticated HTTPS request | `x-waifus-protocol`, `x-waifus-certificate`, `x-waifus-timestamp`, `x-waifus-request-nonce`, `x-waifus-request-signature` | `x-waifus-installation-key` and all response-only fields |
| Pre-certificate activation begin or poll | `x-waifus-protocol`, `x-waifus-installation-key`, `x-waifus-timestamp`, `x-waifus-request-nonce`, `x-waifus-request-signature` | `x-waifus-certificate` and all response-only fields |
| Pair-control WebSocket upgrade | The certificate-authenticated set above | The same forbidden set above |
| Browser `/activate` or `/v1/activation/complete` | None | Every `x-waifus-*` field |

The pre-certificate installation key, protocol, proof/signature, timestamp, and request nonce are
header-only; their strict JSON bodies contain only route payload such as `activationId`,
`helperNonce`, browser nonce, or Turnstile token. For a certificate-authenticated request, the
installation key, serial, credential epoch, and Worker key ID are read only from the validated
certificate and must not be repeated as alternative headers or body fields. HTTPS request bodies
use exactly `Content-Type: application/json`; the WebSocket GET has no body or Content-Type, so its
signed raw-body hash is SHA-256 of zero bytes.

The pair-control upgrade additionally requires a standards-valid `Connection: Upgrade`,
`Upgrade: websocket`, a canonical 24-character standard-base64 `Sec-WebSocket-Key` decoding to 16
bytes, `Sec-WebSocket-Version: 13`, and exactly
`Sec-WebSocket-Protocol: waifus-control-v1`; `Sec-WebSocket-Extensions` is forbidden. HTTP token
header names/values are interpreted case-insensitively only where the WebSocket standard requires
it, duplicates are still rejected, and the selected subprotocol is echoed. These transport headers
are not signature fields. The GET method, concrete pair pathname, empty-body hash, protocol, fresh
request nonce, and certificate metadata remain covered by the ordinary request signature. A retry
uses a new request nonce and signature.

Every syntactically complete helper request receives a signed success or safe-error response with
exactly `x-waifus-protocol`, `x-waifus-worker-key-id`, `x-waifus-timestamp`,
`x-waifus-response-nonce`, and `x-waifus-response-signature`; request-only application headers are
forbidden. Let **requestBindingHash = SHA-256(exact request
signing input || 64-byte installation signature)**. The exact Worker response input is:

~~~text
LP(ASCII "waifus/control-response/v1")
|| LP(exact concrete request pathname)
|| LP(uint16BE(HTTP status))
|| LP(SHA-256(exact raw response body))
|| LP(protocolBytes)
|| LP(ASCII workerSigningKeyID)
|| LP(uint64BE(unixTimestampSeconds))
|| LP(responseNonce16)
|| LP(requestBindingHash)
~~~

The selected Worker key signs the exact bytes. The helper verifies the pinned key ID, signature,
request binding, timestamp, and nonce before parsing or acting on the response body. A JSON response
uses exact `Content-Type: application/json`. A successful WebSocket response is status 101, has an
empty body and no Content-Type, carries the same five response-auth headers, and is verified before
the helper accepts any frame. If missing/duplicate/malformed request metadata makes the signing
input or request binding impossible to construct, the Worker returns a fixed empty no-store 400 and
closes without state mutation; the helper treats that unsigned reply as an unauthenticated
transport failure and never parses a body from it.

### Exact PairControlRecordV1

WebSocket authentication authorizes only the upgrade. Every later WS record and every HTTPS
fallback publish/poll item is independently authenticated as RFC 8785 canonical JSON. The unsigned
record has exactly `version` (integer `1`), `protocolMajor`/`protocolMinor` (uint16 integers),
`pairId` (22-character canonical unpadded base64url decoding to 16 bytes), `type` (enum below),
`side` (`1=host`, `2=remote`), `connectionGeneration`, `sequence`, and `timestamp` (canonical uint64
decimal strings), `nonce` (22-character canonical unpadded base64url decoding to 16 bytes), and the
strict type-specific `payload`. The full record adds only `signature`, exactly 86 canonical
unpadded-base64url characters decoding to the sender installation key's 64-byte Ed25519 signature.
Connection generation and sequence start at `"1"`; a new generation is strictly greater and its
first sequence is `"1"`; later sequences within that generation strictly increase.

| Type (byte) | Exact payload fields |
|---|---|
| `hello` (`1`) | `resumeConnectionGeneration`, `resumeSequence` as canonical uint64 decimal strings; both `"0"` means no cursor |
| `capabilities` (`2`) | `capabilitiesSha256` as 43-character base64url SHA-256; `coordinationMinor` as uint16 |
| `endpoint_generation` (`3`) | `endpointEpoch` uint64 string, `ciphertext` canonical base64url decoding to 1–1,200 bytes, `ciphertextSha256` 43-character base64url SHA-256 |
| `endpoint_ack` (`4`) | `endpointEpoch` uint64 string and matching `ciphertextSha256` |
| `presence` (`5`) | `state` exactly `online` or `offline`, and `validUntil` uint64 Unix-seconds string |
| `reconnect` (`6`) | `lastReceivedConnectionGeneration` and `lastReceivedSequence` uint64 strings |
| `revocation` (`7`) | `revocationEpoch` uint64 string, `reason` exactly `user_revoked`, `identity_reset`, or `repair_required`, and 43-character `revocationMac` |
| `revocation_ack` (`8`) | `revocationEpoch` uint64 string and 43-character `revocationMac` |
| `error` (`9`) | `code` exactly `protocol_mismatch`, `stale_generation`, `sequence_gap`, `revoked`, or `resync_required`, plus `forConnectionGeneration` and `forSequence` uint64 strings |

The transport/type matrix is closed: an authenticated WebSocket may carry all nine types;
HTTPS **/control/publish** may carry only ordinary types `1–6` and `9`; HTTPS **/revoke** carries
only type `7`; HTTPS **/revocation/ack** only type `8`; and HTTPS **/control/poll** may return at most
one retained type `1–9` addressed to the caller. Sending type `7/8` through ordinary publish (or
another type through a dedicated revocation route) is rejected and cannot consume the reserved
revocation replay/quota store. All transports use byte-identical record/signature semantics and one
PairDO high-water.

Every payload has exactly its listed fields; hashes must match decoded bytes. Define `typeByte` by
the table and `payloadBytes` as the exact RFC 8785 canonical payload object. The signature input is:

~~~text
LP(ASCII "waifus/pair-control-record/v1")
|| LP(uint16BE(protocolMajor) || uint16BE(protocolMinor))
|| LP(pairID)
|| LP(typeByte) || LP(sideByte)
|| LP(uint64BE(connectionGeneration)) || LP(uint64BE(sequence))
|| LP(uint64BE(timestamp)) || LP(nonce16)
|| LP(SHA-256(payloadBytes))
~~~

The Worker validates the certificate/trust side, concrete pair, type, complete payload hash,
signature, timestamp within plus/minus 60 seconds at first ingress, nonce, and
`(connectionGeneration, sequence)` high-water before durable acceptance. It records that
disposition before forwarding. The receiving helper verifies the signed timestamp value and
rejects one still more than 60 seconds in its future, but it does **not** reject a Worker-delivered
durably accepted endpoint/revocation/capability record solely because it was offline and the record
is now old; `presence` separately obeys `validUntil`. Sequence, nonce, semantic epoch/hash, and
signature remain mandatory after delay/restart. An exact already-accepted record hash at the same tuple is an
idempotent retry returning its prior disposition; different bytes at that tuple, an older tuple,
pair/type/payload/side substitution, or reused nonce fails without mutation. Unknown fields/types
and payload bytes capable of carrying a management request are impossible. The public
**contracts/remote/v1/fixtures/crypto/pair-control-record-v1.json** is consumed byte-for-byte by Go
and Worker TypeScript and includes all nine valid types plus later-frame replay, delayed poll after
more than 60 seconds, restart,
WS-to-HTTPS/HTTPS-to-WS retry, field/type/payload/pair substitution, boundary, and noncanonical
cases.

The activation-certificate lifetime is **365 days**. A valid installation automatically renews
inside the final **30 days** by proving its installation key. The Worker may require a new
Turnstile completion for suspicious churn. Certificate expiration affects new coordination, not
an already authenticated established direct path.

- [ ] Write and consume the public
  **contracts/remote/v1/fixtures/crypto/http-auth-envelope-v1.json** cross-language goldens for the
  unsigned/full certificate, ordinary HTTPS request, activation begin, activation poll, signed
  success/error response, WebSocket upgrade, and signed 101 response. Each case contains ordered
  raw header tuples, normalized logical fields, exact raw body, concrete path, signing preimage,
  and expected bytes/signature or rejection code. Substitute every
  field, byte width/order, method/concrete path/body byte, protocol, key ID, certificate hash/
  serial/epoch, timestamp, nonce, request binding, and signature. Replay one valid signature on a
  different invitation/pair ID, route template, percent-encoded/alias path, or query and prove
  failure. Invalid cases cover missing/unknown/response-on-request fields, exact and mixed-case
  duplicates, platform-style comma coalescing, raw non-lower-case application names, leading or
  trailing whitespace, tabs/folding, padded/standard/noncanonical base64url, wrong decoded widths,
  leading-zero/overflow timestamps, over-limit individual/aggregate values, body/query auth
  aliases, ordinary replay, noncanonical CBOR, WebSocket body/extension/subprotocol drift, and a
  response-header substitution. Go and Worker TypeScript must agree on every valid and invalid row.
- [ ] Write failing tests for Worker-key pinning, unknown key, expiry, not-yet-valid certificate, serial revocation, credential epoch rollback, renewal, and key overlap.
- [ ] Implement activation challenge creation and polling; there is no browser callback into localhost.
- [ ] Validate the Worker response contains exactly the approved HTTPS origin, literal
  **/activate** path, no query/userinfo/alternate port, and one opaque fragment; return that no-store
  URL to the authenticated Node parent without parsing/persisting/logging the fragment. The helper
  never launches a browser. Node/CLI owns browser opening and the bound local operation described in
  plan 05. The browser never receives the issued certificate.
- [ ] Prove installation-key possession when polling; store the returned certificate with helper identity state.
- [ ] Implement the exact certificate, request, pre-activation, and response encodings/signatures
  above. Enforce plus/minus 60-second timestamps and 10-minute request/response nonce replay
  retention without logging signed bodies or credentials.

Expected: an open-source caller can activate only through the same human/quota flow; no shared client secret exists.

**Suggested commit:** **feat: add anonymous activation certificates and signed control requests**

## Task 6: Integrate the custom control client and direct service

**Files:**

- Create: **internal/control/client.go**, **mailbox.go**, **pair_state.go**
- Create: **internal/transport/** and **internal/service/**
- Test with **internal/testcontrol/** before any Cloudflare deployment

- [ ] Write failing tests proving the custom client implements the pinned fork's production seam and supplies only the minimal pair DTO.
- [ ] Load only the two compiled `ControlProfileV1` entries from canonical **WORKER_KEYS.lock**.
  Exercise production-default, explicit development/release-validation staging, wrong-purpose,
  unknown enum, arbitrary URL/argv/config injection, redirect, certificate/key cross-profile, and
  HTTPS/WSS cross-origin cases. Packet capture and dial interception must show only the active
  profile plus the separately allowed STUN/NAT/direct-peer classes; the inactive/third origin sees
  zero connections and bytes.
- [ ] Reject generic NetworkMap, DERP, route, DNS, SSH, Serve/Funnel, peer-relay, extra-peer, and arbitrary-service fields.
- [ ] Construct host-centered pair-isolated local maps.
- [ ] Implement direct candidate discovery, STUN, PCP/NAT-PMP/UPnP, bounded probing, endpoint epochs, and the states **direct**, **reconnecting**, and **direct_unavailable**.
- [ ] Cap a generation at 12 candidates, 24 candidate pairs, 3 authenticated probes per pair, 1,200-byte probe packets, and a 10-second direct attempt window.
- [ ] Use Cloudflare STUN at **stun.cloudflare.com:3478**; never request TURN credentials.
- [ ] Pin application-session byte/signature vectors for the exact LP encoding and four-message
  state. Reject host/remote order swaps, either session-ID substitution, wrong lengths/trailing
  bytes, stale bundle/trust, any key sequence other than `1`, service/pair mismatch, replay, and REQUEST_START before
  both signatures verify.
- [ ] Consume the exact public `RemoteBrowserContextV1`/MAC vectors. Prove cookie/CSRF-validated
  gateway context is bound to the pair, remote device/bundle, both trust epochs, app session,
  direct request/stream, gateway launch, browser session, nonce, method, and canonical target; no
  ordinary HTTP/header/assistant field can create or replace the immutable context delivered to
  host Node.
- [ ] Consume every `PairControlRecordV1` valid/invalid vector and verify each later WS or fallback
  record independently; upgrade-only authentication, replay after reconnect/restart, type/payload/
  pair substitution, or an opaque management payload fails.
- [ ] Implement the one-request-per-connection WIPC application challenge and request/stream/cancel bridge, with no yamux or cross-request multiplexing.
- [ ] On path loss, close/pause application streams and rediscover; never switch to a relay.
- [ ] On local revocation, close/refuse the peer without waiting for coordination.
- [ ] Add egress instrumentation and fail any undeclared Internet destination.

Verification:

~~~bash
go test -tags=waifus_direct_only ./internal/control/... ./internal/transport/... ./internal/service/...
go test -race -tags=waifus_direct_only ./internal/control/... ./internal/transport/... ./internal/service/...
~~~

Expected: fake-control direct pair connects, roams, and revokes with prohibited-path counters and bytes equal to zero.

**Suggested commit:** **feat: connect the pair-scoped control client to the direct service**

## Task 7: Helper process lifecycle and diagnostic surface

**Files:**

- Create/modify: **cmd/ts-connect/**, **internal/buildinfo/**, platform network monitors
- Test: process and platform integration tests

- [ ] Write failing tests for mode/control-profile selection only through authenticated IPC
  configuration, normal-mode staging rejection, helper hello/version compatibility, parent death,
  graceful drain, bounded crash restart inputs, and secret-free diagnostics.
- [ ] Add host and remote modes; neither exposes a general VPN or proxy.
- [ ] Add network/interface/default-route/suspend/resume monitors and immediate rediscovery triggers.
- [ ] Emit sanitized state: helper/fork/protocol versions, control state, STUN/UDP/port-mapping availability, direct state, last transition, prohibited counters, and actionable error codes.
- [ ] Never emit raw endpoints by default.
- [ ] Embed helper version, canonical uint64-decimal `releaseSequence`, signed canonical UTC
  RFC-3339 whole-second `releasedAt`, source commit, fork commit, upstream commit, contract commit,
  Go version, capability set, both compiled control profiles, and canonical Worker trust-ring hash;
  production values must equal the signed manifest rather than current wall clock.
- [ ] Build every target with the direct-only tag and run the fake-control launch smoke.

**Suggested commit:** **feat: finish supervised host and remote helper lifecycles**

## Completion Gate

Plan 04 coordination implementation may proceed only when:

- Fork and contract pins are exact and CI-enforced.
- IPC byte fixtures, auth, limits, fuzzing, and parent-death tests pass.
- Both exact Noise flows and SAS vectors pass.
- Identity persists correctly across supported platforms and data roots.
- Identity/node/discovery keys remain sequence 1 with fork expiry disabled; repair/reset crash and
  idempotency vectors pass without premature advertisement.
- `reset_identity`, `get_reset_status`, and immutable `IdentityResetReceiptV1` pass every staged
  crash, tombstone/fingerprint mismatch, selected-root isolation, complete-retry, drain, and
  reset-only restart test.
- Activation has no shared secret or localhost browser callback.
- Both compiled control profiles, HTTP/WS auth envelopes, browser-context MACs, and pair-control
  records pass cross-language fixtures with zero cross-profile egress.
- Minimal control rejects generic tailnet state.
- Direct service roams and revokes with no relay path.
- Release builds contain no test coordinator and no secrets.

This helper gate permits only plan 04 and helper-local build-info/package-fixture scaffolding needed
for testing. It does **not** open integrated plan 07 packaging, signing, deployment, or publication;
plan 07 remains blocked on its own non-circular plans 01–06 entry gate.

Intel macOS remains an explicit tracked follow-up; unsupported architecture detection must be actionable.
