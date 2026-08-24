# Waifus Remote Management — Cloudflare Coordination and Pairing

> **For agentic workers:** REQUIRED SUB-SKILL: use test-driven development. Treat every accepted route, message type, byte, and quota as part of the security boundary.

**Status:** ready for staged execution

**Repository owner:** private **waifucave/ts-connect/worker**

**Deployment targets:** **pair-staging.waifucave.com**, then **pair.waifucave.com**

**Depends on:** public contract lock and helper crypto/control fixtures from plan 03

**Blocks:** real Internet pairing, endpoint roaming, helper publication, and beta release

**Goal:** Deploy a small Cloudflare Worker and SQLite-backed Durable Object coordination plane that activates anonymous installations, crash-safely pairs attended devices, carries only fixed encrypted endpoint/presence/revocation records, resists casual abuse, and has no operation capable of carrying dashboard/API/WireGuard data.

## Explicit Action Boundary

Creating Cloudflare resources, custom hostnames, Turnstile sites, secrets, Durable Object migrations, or deployments is an explicit later external action. Local Worker code, tests, and dry-run bundles do not authorize staging or production deployment. Before each mutation, show the account, zone, environment, routes, bindings, migration, secret names, and exact command, then obtain user confirmation.

## Locked Infrastructure

- Cloudflare Worker with compatibility date pinned in **wrangler.jsonc**.
- SQLite-backed Durable Objects.
- Hibernating WebSockets for prompt control updates.
- Ordinary HTTPS reconnect always supported.
- Production hostname: **pair.waifucave.com**
- Staging hostname: **pair-staging.waifucave.com**
- STUN is external discovery at **stun.cloudflare.com:3478** and is never proxied through this Worker.
- No TURN binding or credential.
- Free-plan launch is an operational assumption, not an availability promise.

### Exact deployment/control profiles

The same Worker source and same signed helper bytes support exactly two isolated profiles:

| Enum | Wrangler environment/host | HTTPS origin | WebSocket origin | Certificate key ID |
|---:|---|---|---|---|
| `1` | production / `pair.waifucave.com` | `https://pair.waifucave.com` | `wss://pair.waifucave.com` | `waifucave-pair-certificate-2026-01` |
| `2` | staging / `pair-staging.waifucave.com` | `https://pair-staging.waifucave.com` | `wss://pair-staging.waifucave.com` | `waifucave-pair-staging-certificate-2026-01` |

The private canonical `WORKER_KEYS.lock` pins both distinct raw Ed25519 public keys/fingerprints,
origins, and key IDs. Each deployment accepts only its own Host/origin, issues only its own key ID,
and never redirects or signs across profiles. Production is helper enum 1/default; enum 2 is only an
explicit authenticated-IPC development/release-validation selection. There is no request-provided
origin/key/URL. Egress and signature fixtures prove the inactive profile and every third origin see
zero connections/bytes. Release validation runs the identical signed helper 0.1.0 bytes against
staging and later production; no profile-specific rebuild is permitted.

## Non-Relay Route Rule

The Worker accepts only the exact routes in the V1 route table below, whose operations are:

1. Activation challenge/Turnstile/certificate operations.
2. Invitation create/claim/cancel/expire/consume.
3. Bounded Noise mailbox records and approval/rejection state.
4. Pair capability/presence/reconnect state.
5. One latest encrypted endpoint envelope per pair side.
6. Revocation state and acknowledgement.

There is no arbitrary room message, destination URL, callback URL, file/blob, byte stream, broadcast, user-selected socket, management request, or packet-forwarding route. Any route or schema capable of accepting an opaque payload larger than the fixed control envelope is a release blocker.

## Locked HTTP and WebSocket Envelope

All API routes are under **/v1/** and their request/response bodies are strict JSON, including
browser Turnstile completion. **GET /activate** is the one HTML document outside `/v1`; completion
alone receives the larger body/string exceptions below:

- **Content-Type: application/json**
- Maximum raw body before parsing: **2,048 bytes**
- Turnstile completion raw body maximum: **4,096 bytes**
- Unknown fields rejected
- Nesting depth maximum: **8**
- Strings maximum **256 UTF-8 bytes** unless a smaller field limit applies
- Sole larger-string exception: **/v1/activation/complete** field `turnstileToken` is 1–2,048
  printable non-whitespace ASCII bytes to match the provider-compatible token ceiling. It remains
  inside the 4,096-byte raw-body cap; no other field inherits this exception.
- Arrays have explicit per-schema limits
- WebSocket control record maximum: **2,048 bytes**
- Noise mailbox bytes are unpadded base64url inside a typed record and at most **1,200 decoded bytes**
- Endpoint ciphertext is at most **1,200 decoded bytes**
- Error responses contain a fixed code, safe message, request ID, and optional retry-after; never echo the rejected body

Certificate-authenticated control requests and Worker responses use the exact LP-framed byte inputs
defined in plan 03 and its shared cross-language fixtures. In order, a request binds domain label,
uppercase method, exact concrete request pathname without query, SHA-256 of exact raw body, uint16
major/minor, full-certificate SHA-256, 16-byte serial, uint64 credential epoch, 32-byte installation
public key, Worker signing-key ID, uint64 timestamp, and 16-byte request nonce; the installation key
signs the exact bytes. The Worker verifies this before strict-body parsing.

For parameterized routes, that signed pathname contains the actual canonical 22-character ID, not
the route template. The router supplies the untouched concrete pathname to signature verification
before parameter decoding; ID substitution, template signing, percent-encoded aliases, or replay
across invitations/pairs fails.

Activation begin and poll have no certificate. Their distinct domain labels bind method, fixed
route, raw-body hash, protocol, installation public key, timestamp, and request nonce in that exact
order. Browser completion is the only unsigned helper-protocol request. Every syntactically
complete helper request receives a signed success/error response binding response domain, exact
concrete request pathname, uint16 status, raw-body hash, protocol, Worker key ID, timestamp, 16-byte
response nonce, and the hash of the exact signed request; its selected Worker key signs the exact
bytes. Timestamps are within plus/minus 60 seconds.

### Exact authentication metadata headers

There is no `Authorization` alias. V1 senders emit these literal lower-case names. Receivers compare
names after ASCII case-folding because HTTP header names are case-insensitive; case never selects a
different field or credential. An ingress layer with raw tuples rejects a non-lower-case
application name. At Cloudflare's normalized Fetch boundary, exactly one normalized logical field
is allowed. Exact or mixed-case duplicates are rejected after case-folding; if the platform
coalesces them, the comma makes the value invalid.

Every value is printable ASCII without leading/trailing optional whitespace, internal space/tab,
comma, CR/LF, or obsolete folding. Base64url uses only `[A-Za-z0-9_-]`, contains no padding, decodes
to the stated width, and must re-encode byte-identically as canonical unpadded base64url. Decimal
values have no sign or leading zero except `0`. Unknown `x-waifus-*` names, body/query auth aliases,
missing or request-class-inapplicable fields, and more than **1,024 ASCII bytes** across all
application-auth header values are rejected before any Durable Object mutation.

| Header | Exact V1 grammar and limit |
|---|---|
| `x-waifus-protocol` | Exactly `1.0` |
| `x-waifus-certificate` | 1–512 canonical unpadded-base64url characters; decoded bytes at most 384 and exactly one valid full `ActivationCertificateV1` |
| `x-waifus-installation-key` | Exactly 43 canonical unpadded-base64url characters decoding to 32 bytes |
| `x-waifus-timestamp` | Canonical uint64 decimal, 1–20 characters |
| `x-waifus-request-nonce` | Exactly 22 canonical unpadded-base64url characters decoding to 16 bytes |
| `x-waifus-request-signature` | Exactly 86 canonical unpadded-base64url characters decoding to a 64-byte installation-key signature |
| `x-waifus-worker-key-id` | 1–64 characters matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` |
| `x-waifus-response-nonce` | Exactly 22 canonical unpadded-base64url characters decoding to 16 bytes |
| `x-waifus-response-signature` | Exactly 86 canonical unpadded-base64url characters decoding to a 64-byte Worker signature |

The allowed application-auth sets are exact:

| Request/response class | Exactly required | Forbidden |
|---|---|---|
| Certificate-authenticated HTTPS request | `x-waifus-protocol`, `x-waifus-certificate`, `x-waifus-timestamp`, `x-waifus-request-nonce`, `x-waifus-request-signature` | `x-waifus-installation-key` and every response-only field |
| Pre-certificate begin or poll | `x-waifus-protocol`, `x-waifus-installation-key`, `x-waifus-timestamp`, `x-waifus-request-nonce`, `x-waifus-request-signature` | `x-waifus-certificate` and every response-only field |
| Pair-control WebSocket request | The certificate-authenticated request set | The same forbidden set |
| Signed JSON response or signed 101 | `x-waifus-protocol`, `x-waifus-worker-key-id`, `x-waifus-timestamp`, `x-waifus-response-nonce`, `x-waifus-response-signature` | Every request-only field |
| Browser `/activate` and `/v1/activation/complete` | None | Every `x-waifus-*` field |

Protocol, certificate, installation key, signatures, timestamps, and nonces are header-only. The
pre-certificate JSON body contains only route payload such as `activationId` and `helperNonce`; an
ordinary request derives installation key, certificate serial, credential epoch, and Worker key ID
only from the validated certificate. An HTTPS body has exact
`Content-Type: application/json`. A signed JSON response has that same exact Content-Type. Missing,
duplicate, malformed, or oversized request metadata that prevents construction of the signing
input/request binding receives a fixed empty no-store 400 with no response-auth headers and no
state mutation; the helper treats it as an unauthenticated transport failure and parses no body.

The pair-control GET has no body or Content-Type and signs SHA-256 of zero bytes. Its upgrade also
requires standards-valid `Connection: Upgrade`, `Upgrade: websocket`, a canonical 24-character
standard-base64 `Sec-WebSocket-Key` decoding to 16 bytes, `Sec-WebSocket-Version: 13`, exactly
`Sec-WebSocket-Protocol: waifus-control-v1`, and no `Sec-WebSocket-Extensions`. Standard HTTP token
matching is case-insensitive where required, but duplicate values remain invalid. Upgrade transport
headers are not part of the application signature. A valid status-101 response echoes the selected
subprotocol, has no body/Content-Type, and carries the exact five signed response headers; the helper
verifies them before accepting a frame. Every retry uses a fresh request nonce and signature.

ActivationCertificateV1 is the exact canonical-CBOR integer-key map/signature from plan 03:
version, 16-byte serial, 32-byte installation key, uint64 issue/expiry/credential epoch, uint16
protocol major/minor, quota-tier enum, Worker key ID, then 64-byte Ed25519 signature. Its signing
input is domain-separated by **waifus/activation-certificate/v1**. The Worker and helper consume
the same byte fixtures; neither side has a second serializer.

The Worker retains request nonces and each helper retains response nonces for 10 minutes, each
capped at 1,024 per installation. Duplicate nonces fail before Durable Object mutation or helper
response handling.

## Exact V1 Internet Route Table

There are no wildcard, generic-message, arbitrary-room, generic relay, or user-selected callback
routes. `:invitationId` and `:pairId` are exactly 22-character canonical unpadded-base64url
encodings of 16 bytes;
every other identifier, including the activation ID and short code, is carried only in a bounded
strict body. Every POST except browser completion uses the signed installation request contract.

| Method | Exact path | One allowed operation/body |
|---|---|---|
| GET | **/activate** | No-store self-contained Turnstile shell; URL fragment never reaches the request and there are no asset subroutes |
| POST | **/v1/activation/challenges** | Begin: 32-byte activation ID and 32-byte helper nonce; installation key/protocol/proof are only in the fixed headers |
| POST | **/v1/activation/complete** | Browser-only activation ID, 32-byte browser nonce, Turnstile token |
| POST | **/v1/activation/poll** | Activation ID and helper nonce; installation key/proof are only in the fixed headers |
| POST | **/v1/certificates/renew** | Current certificate and installation-key renewal proof |
| POST | **/v1/invitations** | Create exactly one invitation commitment and reservation from normalized plaintext `shortCode`; Worker immediately derives/discards it |
| POST | **/v1/invitations/:invitationId/claim** | Lock one joiner and return invitation generation plus pending pair ID |
| POST | **/v1/invitations/:invitationId/mailbox/send** | Send one phase-valid typed **noise_1**, **noise_2**, **noise_3**, **noise_transport**, or post-approval **pair_confirmation** record |
| POST | **/v1/invitations/:invitationId/mailbox/poll** | Read at most one next typed record (or empty) for that invitation side; no long poll/stream |
| POST | **/v1/invitations/:invitationId/approve** | Host approval bound to receipt-context hash, generation, transcript/channel binding, both identities, roles, protocol, and epochs |
| POST | **/v1/invitations/:invitationId/reject** | Host rejection bound to the pending transcript |
| POST | **/v1/invitations/:invitationId/cancel** | Creator cancellation bound to invitation generation |
| POST | **/v1/invitations/:invitationId/consume** | One side's possession/confirmation acknowledgement; the second valid side starts/reconciles the fixed pair-finalization saga |
| POST | **/v1/short-codes/claim** | Claim one normalized plaintext eight-character `shortCode`; Worker immediately derives/discards it |
| GET | **/v1/pairs/:pairId/control** | Signed WebSocket upgrade carrying only the fixed Pair Control record union |
| POST | **/v1/pairs/:pairId/control/publish** | HTTPS fallback: exactly one ordinary PairControl type `1–6` or `9`; types `7/8` forbidden |
| POST | **/v1/pairs/:pairId/control/poll** | HTTPS fallback: at most one retained PairControl type `1–9` (or empty) above acknowledged cursor; no hanging response |
| POST | **/v1/pairs/:pairId/revoke** | Exactly PairControl type `7`, monotonic signed revocation; bypasses ordinary quotas |
| POST | **/v1/pairs/:pairId/revocation/ack** | Exactly PairControl type `8`, acknowledging one exact revocation epoch |

`HEAD`, automatic `OPTIONS`, alternate pluralization, ID-in-query variants, and trailing-path
variants are not registered. CORS is not enabled. Expiry and deletion alarms are internal Durable
Object callbacks, not Internet routes. Health/synthetic checks use deployment tooling and do not
create an unauthenticated protocol route.

## Durable Object Ownership and SQLite Schemas

Use one DO class per atomic ownership boundary. All identifiers used as DO names are HMAC-derived with a Worker-only routing key so public keys, IPs, and pair IDs do not appear in infrastructure names.

No cross-DO call shares a SQLite transaction. Every protocol uint64 in the schemas below—including
generation, epoch, sequence, credential/key/trust/revocation counters, and protocol-carried Unix
seconds—is stored as an exact **8-byte unsigned big-endian BLOB** with a `length = 8` constraint,
decoded to JavaScript `BigInt`, and serialized as its canonical decimal string. It is never a JS
`number` or signed SQLite INTEGER. Big-endian BLOB comparison supplies unsigned ordering; increment
happens inside the owning DO transaction and fails closed at `2^64-1`. Shared fixtures cover
`2^53-1`, `2^53`, `2^53+1`, `2^63`, `2^64-2`, `2^64-1`, overflow, short/long BLOBs, signed-integer
coercion, leading-zero decimal, transaction retry, and concurrent increment.

### InstallationDO

One object per installation public key. SQLite tables:

**installation**

- installation_id_hash primary key
- installation_public_key
- credential_epoch
- current_certificate, containing the exact bounded canonical certificate bytes
- current_certificate_serial
- current_certificate_signing_key_id
- certificate_expires_at
- quota_tier
- created_at
- last_seen_at
- suspended_at nullable
- protocol_major
- protocol_minor

**activation_challenge**

- challenge_id_hash primary key
- helper_nonce_hash
- browser_nonce_hash nullable until the one accepted browser completion
- expires_at
- turnstile_completed_at nullable
- consumed_at nullable
- attempt_count

**replay_nonce**

- nonce_hash primary key
- expires_at

**certificate_renewal**

- previous_certificate_serial primary key
- previous_certificate_hash
- previous_credential_epoch
- renewed_certificate, containing the exact bounded canonical replacement bytes
- expires_at, equal to the prior certificate expiry

The current certificate bytes and one renewal result per prior serial are persisted transactionally
with the credential-epoch advance. Concurrent renewals and retries after a lost response therefore
return the byte-identical replacement certificate without advancing the epoch twice. The retry row
is accepted only for the exact prior certificate hash/epoch and is removed once that prior
certificate expires.

**quota_bucket**

- bucket_name
- window_start
- count
- primary key over bucket_name and window_start

InstallationDO serializes activation, renewal, suspension, nonce, and per-installation quotas.

### ActivationDO

One short-lived object per activation ID, named from **HMAC(routingKey, activationId)**. This is the
minimum routing index required because the unsigned browser completion knows the random activation
ID but never receives the installation public key or stable InstallationDO name. SQLite table:

**activation_route**

- activation_id_hash primary key
- installation_id_hash
- state enum: prepared, active, completed, expired
- expires_at
- completed_at nullable

It never stores the plaintext activation ID, installation public key, helper nonce, browser nonce,
Turnstile token, or certificate. Begin first reserves this route, then InstallationDO atomically
opens/replaces its authoritative challenge, then the route becomes active. The activation hash is
the idempotent saga identity. A prepared route cannot consume Turnstile; retry reconciles it, and an
alarm deletes it at expiry. Browser completion first proves the route is active, validates and
immediately discards Turnstile, then ActivationDO forwards only keyed hashes plus an HMAC-authenticated
internal binding to the authoritative InstallationDO. Replacement makes an older route harmless
because InstallationDO accepts completion only for its one current activation hash.

### InvitationDO

One object per 16-byte invitation ID. SQLite tables:

**invitation**

- invitation_id_hash primary key
- generation_u64be, exact 8-byte unsigned big-endian BLOB, initially 1 and never reused
- host_installation_id_hash
- host_identity_commitment
- host_invitation_public_key
- protocol_major
- protocol_minor
- created_at
- expires_at
- state enum: preparing, open, claim_prepared, claimed, pending_approval, approved, finalizing, pair_finalized, consumed, rejected, cancelled, expired
- joiner_installation_id_hash nullable
- joiner_identity_commitment nullable
- pending_pair_id_hash nullable
- approval_context_hash nullable
- transcript_hash nullable
- channel_binding_hash nullable
- host_bundle_hash nullable
- remote_bundle_hash nullable
- host_trust_epoch nullable
- remote_trust_epoch nullable
- host_key_sequence nullable
- remote_key_sequence nullable
- wrong_claim_count
- creator_request_id_hash
- create_saga_id_hash
- quota_reservation_id_hash
- short_code_hash
- short_code_ownership_token_hash
- claim_id_hash nullable
- pair_initialization_token_hash nullable
- finalization_step

**mailbox_record**

- sequence primary key
- sender_role
- record_type enum: noise_1, noise_2, noise_3, noise_transport, approval, rejection, pair_confirmation
- payload
- created_at

Maximum 12 mailbox records and 12 KiB total per invitation. `pair_confirmation` is the distinct
post-approval/pre-consume RFC 8785 `PairConfirmationV1` type from plan 03, never Noise transport:
exactly one per side/nonce, at most 1,024 raw payload bytes and 2,048 bytes for the complete request,
with 1,025/phase/extra-field/late records rejected. InvitationDO is the source of truth for
one host, one joiner, one approval transcript, and the durable pair-finalization decision; it does
not claim a transaction over another DO.

### ShortCodeDO

One object named from **HMAC(routingKey, normalizedShortCode)**. SQLite table:

**short_code**

- code_hash primary key
- invitation_id_hash
- ownership_token_hash
- create_saga_id_hash
- state enum: prepared, active, claim_prepared, consumed, released
- claim_id_hash nullable
- claim_joiner_hash nullable
- expires_at
- claim_count
- consumed_at nullable

It maps one keyed code hash to one InvitationDO without storing plaintext. The signed strict create
and claim bodies contain `shortCode`, exactly eight uppercase Crockford characters without a
hyphen. Both helper and Worker normalize by accepting user input only as eight characters or
`XXXX-XXXX`, removing that one optional position-5 hyphen, ASCII-uppercasing, rejecting whitespace,
Unicode/confusables/other punctuation, and requiring the result match
`[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{8}`. Before routing/logging/metrics, the Worker computes
`codeHash = HMAC-SHA-256(routingKey, ASCII "waifus/short-code/v1" || 0x00 || ASCII normalizedCode)`,
uses that keyed hash for the DO name/storage, and discards plaintext. It never accepts helper-made
HMAC/routing material. A different invitation colliding with an active/prepared hash receives a
typed collision and the host helper generates a fresh code; an exact duplicate create request is
idempotently reconciled to its original invitation instead of consuming a second quota/code.

### PairDO

One object per 16-byte random pending pair ID allocated inside InvitationDO's transaction when it
locks the joiner. Both helpers bind that pair ID into the Noise transcript and SAS. PairDO starts
`prepared` under a single initialization token and accepts endpoint/control records only after the
crash-recoverable finalization saga makes it `active`. SQLite tables:

**pair**

- pair_id_hash primary key
- state enum: prepared, active, revoked
- initialization_token_hash
- finalization_receipt_hash nullable
- host_installation_id_hash
- remote_installation_id_hash
- invitation_generation
- approval_context_hash
- host_identity_commitment
- remote_identity_commitment
- host_bundle_hash
- remote_bundle_hash
- host_trust_epoch
- remote_trust_epoch
- host_key_sequence
- remote_key_sequence
- protocol_major
- protocol_minor
- host_capabilities_hash
- remote_capabilities_hash
- created_at
- last_seen_at
- revocation_epoch
- revoked_by nullable
- revoked_at nullable
- host_acknowledged_revocation_epoch
- remote_acknowledged_revocation_epoch

**endpoint_generation**

- side enum: host or remote, primary key
- epoch
- ciphertext
- ciphertext_hash
- created_at
- acknowledged_epoch

**presence**

- side primary key
- connection_generation
- protocol_minor
- capabilities_hash
- last_seen_at

**pair_replay_nonce**

- side
- nonce_hash
- expires_at
- primary key over side and nonce_hash

**pair_control_side**

- side primary key
- connection_generation_u64be
- accepted_sequence_u64be
- acknowledged_connection_generation_u64be
- acknowledged_sequence_u64be
- last_record_hash

**pair_control_latest**

- sender_side
- record_type enum: hello, capabilities, endpoint_generation, endpoint_ack, presence, reconnect, revocation, revocation_ack, error
- connection_generation_u64be
- sequence_u64be
- protocol_major
- protocol_minor
- nonce
- signature
- canonical_record
- payload_hash
- expires_at_u64be nullable
- acknowledged_at_u64be nullable
- primary key over sender_side and record_type

**revocation_replay_nonce**

- side
- route_kind enum: revoke or acknowledgement
- nonce_hash
- expires_at
- primary key over side, route_kind, and nonce_hash

The dedicated HTTPS revocation routes and WebSocket **revocation/revocation_ack** record dispatch
never read/write **pair_replay_nonce** or the installation's ordinary replay bucket. Signature/
certificate checks route valid revoke/ack inputs into this separate reserved store before any
ordinary control quota.

Only the latest endpoint generation per side is retained. PairDO never decrypts it. A stale/different same-epoch update fails atomically inside PairDO. Both stored key-sequence fields are immutable integer `1` in V1; another value rejects pair preparation/control, and there is no bundle/key rotation transition.

`pair_control_side` retains each side's connection-generation/sequence acceptance high-water and
the other side's acknowledged cursor across hibernation, Worker restart, and HTTPS fallback.
`pair_control_latest` retains at most one complete canonical signed record per sender/type—nine per
side—including protocol, nonce, signature, exact payload/ciphertext and hash. A new same-type record
replaces an older one only after signature/high-water acceptance. Poll returns the lowest retained
tuple above the receiver cursor, at most one record. Capabilities, endpoint generation, and
revocation persist until acknowledged or replaced (revocation until its exact acknowledgement);
hello/presence/reconnect/error expire after their signed validity or 10 minutes, whichever is
earlier; endpoint acknowledgements persist until acknowledged/replaced for at most 24 hours. An
ack advances only to a record actually delivered to that side and then prunes eligible records.
Switching WS to HTTPS or back never resets either high-water. PairDO stores no management payload.

### RateLimitDO

Shard by rotating HMAC of coarse IP prefix, ASN, route class, and time bucket. Store only keyed hashes, window, and counts. Never store raw IP in application tables.

### Crash-recoverable cross-DO sagas

Cross-DO correctness uses idempotent sagas, never an alleged shared transaction. Saga IDs are 16
random bytes; ownership/initialization tokens are 32 random bytes and only keyed hashes persist.
Every internal DO step takes the same saga ID plus token, stores its result before returning, and
returns that byte-identical result on retry. Conflicting IDs/tokens fail. DO alarms and every later
related request reconcile unfinished steps; terminal expiry also compensates them.

Invitation creation is exact:

1. InstallationDO reserves, but does not yet consume, the create quota under
   `creatorRequestIdHash` and returns one `quotaReservationId`.
2. InvitationDO writes `preparing` with one `createSagaId`, quota reservation, code hash, and
   ownership-token hash. A duplicate signed create request recovers this row.
3. ShortCodeDO idempotently writes `prepared` only if the code hash is unowned; a different owner is
   a collision. On collision/failure, InvitationDO cancels `preparing` and InstallationDO releases
   the reservation.
4. InvitationDO commits `open`; ShortCodeDO advances the matching token to `active`; InstallationDO
   commits exactly one quota use. A crash in either trailing step is reconciled from InvitationDO's
   durable `open` decision. A prepared code whose invitation never committed is released by alarm.

Short-code claim is exact:

1. ShortCodeDO reserves one `claimId` for the keyed joining-installation hash while leaving the code
   mapped to its invitation.
2. InvitationDO is the sole joiner source of truth: in one local transaction it either binds that
   claim/joiner, allocates the one pending pair ID, and commits `claimed`, or rejects it.
3. ShortCodeDO idempotently commits or compensates the reservation from that decision. Retry after
   any lost response uses the same claim ID; a second joiner can never acquire the invitation.

Pair finalization after both exact possession acknowledgements is exact:

1. InvitationDO writes `finalizing` with its already transcript-bound pair ID, one initialization
   token hash, and the complete immutable pair fields.
2. PairDO idempotently writes those fields as `prepared`; it rejects all endpoint/control input.
3. InvitationDO commits the durable `pair_finalized` decision and its receipt hash.
4. PairDO verifies that exact token/receipt and changes only that prepared row to `active`.
5. InvitationDO advances to `consumed`, clears mailbox bytes, and ShortCodeDO marks the matching
   owner consumed/released. Cleanup may retry, but the fixed pair ID/token means no second PairDO.

Expiry/reject/cancel compensates any uncommitted quota reservation, prepared code/claim, and
prepared PairDO. It never rolls back an active PairDO or a durable `pair_finalized` decision.
Crash-injection tests stop after every DO call and before/after every local commit, then retry and
run alarms; they must prove no orphan code/quota, double quota, second joiner/pair, lost finalization,
or endpoint acceptance before PairDO `active`.

## Locked Quotas

Durable Object counters are authoritative; Cloudflare edge limiting is only an additional burst shield.

### Installation and activation

- One open activation challenge per installation.
- Challenge expiry: **10 minutes**.
- Maximum 3 completed activations per installation per 24 hours.
- Maximum 6 completed activations per coarse IP prefix per 24 hours.
- Maximum 200 completed activations per ASN per hour.
- Global new-activation emergency ceiling: **2,000 per 24 hours** until explicitly raised.
- Certificate lifetime: **365 days**.
- Automatic proof-of-key renewal begins with **30 days** remaining.

### Invitations and trust graph

- One active invitation per installation.
- Invitation expiry: **5 minutes**.
- Maximum 3 invitation creations per installation per hour and 10 per 24 hours.
- Maximum 32 active remote pairs for a host installation.
- Maximum 16 remembered host pairs for a remote installation.
- One joiner per invitation.
- Five incorrect short-code claims destroy the invitation.
- Joining installation: 10 short-code claims per 10 minutes.
- Coarse IP prefix: 20 short-code claims per 10 minutes.
- ASN: 200 short-code claims per 10 minutes.
- Pairing mailbox: 12 records and 12 KiB total.

### Established control

- One live control WebSocket per pair side; a newly authenticated generation replaces the prior socket.
- Ordinary signed HTTPS requests, excluding the exact **.../revoke** and **.../revocation/ack**
  routes: 120 per installation per minute with burst 30.
- Ordinary WebSocket records, excluding **revocation/revocation_ack**: 120 per pair side per minute
  with burst 30.
- Endpoint generation publication: burst 3, minimum 5 seconds between ordinary updates, maximum 12 per 5 minutes; a signed network-change reason may bypass the minimum once per 10 seconds.
- Presence: maximum 12 per minute.
- Revocation: maximum 10 new monotonic revocation epochs per pair side per hour; acknowledgements do
  not consume that mutation quota.
- Ordinary control: maximum 1,024 replay nonces per installation or pair side per 10-minute window.
- Reserved revocation replay store: 64 **revoke** plus 64 **acknowledgement** nonces per pair side
  per 10 minutes, separate from ordinary nonce/request/WebSocket/route buckets. Ordinary saturation
  cannot consume this capacity; duplicates still fail.

Quota excess returns **429 quota_exceeded** with bounded retry-after. It never falls back to a larger arbitrary storage/message operation.

## Activation Certificate Flow

Worker signing uses Ed25519. Each profile uses only the exact certificate key ID in the profile
table; production initially uses **waifucave-pair-certificate-2026-01**. The helper embeds both
profile-separated Worker public-key rings; private
signing keys exist only as protected Cloudflare/GitHub deployment secrets. The actual initial
public-key bytes/fingerprint are a deployment input and must be pinned before a helper release.

1. Helper sends **POST /v1/activation/challenges** with only a 32-byte random activation ID and 32-byte helper nonce in strict JSON; installation public key, protocol, timestamp, request nonce, and installation-key signature live only in the exact pre-certificate headers. That activation ID is the challenge ID; the Worker stores only its keyed hash.
2. Production returns exactly `https://pair.waifucave.com/activate#<activationId>` and staging
   exactly `https://pair-staging.waifucave.com/activate#<activationId>`; either deployment rejects
   the other profile or an arbitrary origin.
3. CLI opens the URL. The activation ID exists only in the URL fragment, never a query, path parameter, Referer, server log, localhost callback, private key, or reusable credential. Page JavaScript reads the fragment locally, generates a fresh 32-byte browser nonce, and sends both only in the explicit completion body.
4. Browser completes Turnstile and sends **POST /v1/activation/complete** with activation ID, browser nonce, and token in the strict body.
5. Worker verifies Turnstile server-side, atomically marks the challenge, and stores no Turnstile token.
6. Helper polls **POST /v1/activation/poll**, putting the activation ID and helper nonce in the signed strict body and proving the installation key. The Worker accepts only the single stored browser completion and binds its browser nonce to this consumed challenge.
7. Worker issues the V1 certificate defined in plan 03 and atomically consumes the challenge.
8. A valid certificate renews by **POST /v1/certificates/renew**. Suspicious churn receives **turnstile_required** and a new challenge.

The browser never receives or forwards the certificate. Turnstile shows that a human completed activation; it does not attest official/unmodified code.

### Owned activation page

The Worker owns and tests the actual **GET /activate** response. It is one no-store HTML document
with embedded, build-hashed first-party JavaScript/status markup; there are no asset routes,
analytics, service worker, cookie, local-storage use, callback URL, or third-party resource except
Cloudflare Turnstile. Each profile injects only its separately reviewed public Turnstile site key
from deployment configuration and its same-origin completion path; staging/production site keys
cannot cross. Placeholder/wrong-profile site keys block deployment.

Required response headers are:

- `Cache-Control: no-store, max-age=0`
- `Pragma: no-cache`
- `Referrer-Policy: no-referrer`
- `X-Content-Type-Options: nosniff`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()`
- A CSP with `default-src 'none'`; `script-src` containing only the build-pinned SHA-256 of the
  embedded first-party script and `https://challenges.cloudflare.com`; `connect-src 'self'
  https://challenges.cloudflare.com`; `frame-src https://challenges.cloudflare.com`; build-pinned
  inline-style hash only if a style block exists; and `img-src 'none'; object-src 'none'; base-uri
  'none'; form-action 'self'; frame-ancestors 'none'; worker-src 'none'`. No wildcard, nonce copied
  into HTML, `unsafe-inline`, or other Turnstile/CDN origin is allowed.

Before rendering Turnstile or making any request, the embedded script accepts only a fragment of
`#` plus 43 canonical unpadded-base64url characters decoding to 32 bytes, keeps those bytes only in
memory, and immediately calls `history.replaceState(null, "", "/activate")`. Invalid fragments are
also cleared and produce a local error with zero network calls. It creates the 32-byte browser nonce
only with `crypto.getRandomValues`, explicitly renders Turnstile with the active profile's public
site key, and POSTs exact JSON `{activationId,browserNonce,turnstileToken}` to same-origin
`/v1/activation/complete` with exact Content-Type, `cache:"no-store"`,
`referrerPolicy:"no-referrer"`, and no credentials. It clears token/activation variables after the
one attempt and shows only bounded pending/success/expired/error status. The fragment, token,
nonces, body, and Turnstile response never enter URL/query/path, Referer, console, DOM attributes,
server logs, analytics, or error text.

## Pairing State Machines

### Invitation creation

1. Authenticated host calls **POST /v1/invitations** with invitation ID, expiry, host identity commitment, invitation X25519 public key, and the exact normalized plaintext `shortCode` in the signed no-log body; it never sends routing HMAC material.
2. Worker immediately derives/discards the plaintext code as specified above, then the creation saga reserves quota and code ownership.
3. InvitationDO becomes the durable **open** source of truth and trailing quota/code activation reconciles idempotently.
5. Response contains only accepted IDs/expiry. Full secret never reaches the Worker.

### Full-token claim

1. Joining helper parses the local token and calls **POST /v1/invitations/:invitationId/claim** with its activation certificate, identity commitment, and protocol.
2. InvitationDO locks that exact joiner, allocates the 16-byte pending pair ID, and returns it plus
   the invitation generation to both sides.
3. Helpers exchange the phase-valid typed Noise XXpsk0 records through only
   **.../mailbox/send** and bounded **.../mailbox/poll**.
4. Both derive and display the exact five-word SAS plus fingerprint. The host dashboard receives
   pending transcript metadata from its local helper and requires the same explicit attended
   actor/browser-server-launch/browser-session/request-bound approval as the short-code flow; the PSK never auto-approves.
5. No endpoint record or probe is accepted before that approval.

### Short-code claim

1. Joining helper applies the exact normalization above and calls **POST /v1/short-codes/claim** with only normalized `shortCode` plus its fixed joining payload in the signed no-log body.
2. Worker independently normalizes/requires equality, immediately derives/discards the plaintext code, and RateLimitDO/ShortCodeDO run the idempotent claim reservation.
3. InvitationDO remains the sole source that locks one joiner, allocates the 16-byte pending pair ID, and returns it plus the
   invitation generation to both sides.
4. Helpers exchange the phase-valid Noise XX records through only **.../mailbox/send** and
   bounded **.../mailbox/poll**.
5. Both display the exact five-word SAS from plan 03.
6. Exact actor-bound host approval is mandatory.

### Approval and consume

1. Host service submits **POST /v1/invitations/:invitationId/approve** signed by the host installation key and bound to invitation ID/generation, approval-context hash, transcript/channel binding, both identity commitments, roles, protocol, and host trust epoch.
2. InvitationDO accepts only the locked transcript/joiner.
3. Both helpers prove possession of pinned installation keys.
4. They exchange encrypted pair contributions inside Noise and derive the four persistent pair
   keys. Each helper then publishes its own typed `pair_confirmation` mailbox record without
   waiting, polls/locally verifies the peer's exact `PairConfirmationV1` confirmation-key MAC, and
   only then sends its own idempotent consume acknowledgement. Worker validates the outer signed
   strict fields/one nonce per side but stores/forwards the opaque fixed-width MAC because it cannot
   derive the pair key.
5. Each helper calls **POST /v1/invitations/:invitationId/consume** with its exact possession/confirmation
   acknowledgement. The second valid side starts or reconciles the exact finalization saga above.
6. Only PairDO `active`, reached after InvitationDO's durable `pair_finalized` decision, may accept
   an endpoint/control record; mailbox/code cleanup then finishes idempotently.

Rejection through **POST /v1/invitations/:invitationId/reject** or creator cancellation through
**POST /v1/invitations/:invitationId/cancel** clears mailbox records immediately. Expiry is
enforced on every operation and by an internal DO alarm; there is no public expire route.

## Pair Control WebSocket

Endpoint: **GET /v1/pairs/:pairId/control** with WebSocket upgrade and signed authentication.

Every later frame is the exact `PairControlRecordV1` from plan 03 and the shared public fixture; the
nine fixed types/payloads and type bytes are **hello(1), capabilities(2),
endpoint_generation(3), endpoint_ack(4), presence(5), reconnect(6), revocation(7),
revocation_ack(8), error(9)**. The domain-separated Ed25519 preimage binds protocol, concrete pair
ID, type byte, full canonical typed-payload SHA-256, side, connection generation, sequence,
timestamp, and nonce. The Worker verifies the sending pair-side installation key and record
signature/high-water and plus/minus-60-second timestamp at first ingress on every WS frame or HTTPS
fallback item; the signed upgrade is never enough. It durably records acceptance. A receiver later
polling a stored record verifies the signed timestamp but does not reject it solely for age after
offline delay/restart; presence alone expires by `validUntil`. Revocation/ack additionally carry
the exact plan-03 `revocationMac`; Worker enforces the outer signed monotonic cutoff while only the
peer helper can verify that pair-secret MAC.
Unknown fields/types, opaque payload, pair/type/payload substitution, stale generation/sequence,
nonce replay, and same-tuple different bytes fail before dispatch.

Hibernation attachments contain only pair hash, side, certificate serial/epoch, connection
generation, and acknowledged cursor; authoritative high-waters and bounded latest complete signed
records remain in PairDO. WS/HTTPS transitions and Worker restarts resume the same cursor. An
offline receiver polls and receives at most the lowest one retained tuple above its acknowledged
cursor; exact retry is idempotent, and acknowledgement/expiry follows the frozen table above. The
closed matrix is: WS accepts types `1–9`; ordinary HTTPS publish accepts only `1–6,9`; dedicated
revoke only `7`; dedicated revocation acknowledgement only `8`; poll returns at most one retained
`1–9`. Every route shares byte-identical records and PairDO high-waters. A wrong-route type fails
without touching the reserved store; revocation routes/WS dispatch use dedicated replay/quota state
so ordinary saturation cannot delay them.

The Worker forwards only the other approved side's fixed record. It cannot address any third device or destination.

---

## Task 1: Scaffold the Worker and local test runtime

**Files in private waifucave/ts-connect:**

- Create: **worker/package.json**, **worker/package-lock.json**, **worker/tsconfig.json**
- Create: **worker/wrangler.jsonc**
- Create: **worker/src/index.ts**, **env.ts**, **errors.ts**, **schemas.ts**
- Create: **worker/test/** using Cloudflare's supported Workers test runtime

- [ ] Pin Node/npm and Worker dependencies in the private lockfile.
- [ ] Declare separate staging and production environments and DO bindings, but do not create them yet.
- [ ] Write failing tests for content type, raw body limits before parsing, strict unknown-field rejection, safe errors, request IDs, and route-not-found behavior.
- [ ] Pin the Turnstile-only string exception at 2,048 bytes and reject empty, whitespace/control,
  2,049-byte, wrong-route, wrong-field, and second oversized-string cases before Turnstile calls.
- [ ] Implement the minimal router and schemas.
- [ ] Add a route-inventory test that compares every registered method/path byte-for-byte with
  the Exact V1 Internet Route Table and proves automatic HEAD/OPTIONS, wildcard, alternate,
  query-ID, public-expire, and trailing-path variants do not exist.
- [ ] Add a forbidden-operation test corpus containing arbitrary message, blob, callback URL, destination host, proxy, broadcast, and oversized envelope attempts.

Verification:

~~~bash
cd worker
npm ci
npm test
npx wrangler deploy --dry-run --env staging
~~~

Expected: tests pass and dry run produces a Worker bundle without deploying.

**Suggested commit:** **feat: scaffold the fixed coordination Worker surface**

## Task 2: Implement signed requests, activation, and certificate rotation

**Files:**

- Create: **worker/src/auth/**, **worker/src/durable/activation.ts**, **worker/src/durable/installation.ts**, **worker/src/turnstile.ts**, **worker/src/activationPage.ts**
- Create SQLite migrations and test fixtures

- [ ] Consume the helper-produced cross-language goldens for exact canonical certificate bytes and
  signature, full raw-header request envelope, ordinary request, pre-certificate begin/poll,
  signed success/error response, WebSocket upgrade, and signed 101. Fail
  every field/width/order/key-ID/body/concrete-path/request-binding substitution, replay on another
  invitation/pair ID or route alias/template, noncanonical CBOR, wrong/retired Worker key,
  certificate serial/epoch rollback, suspension, and renewal.
- [ ] Consume every valid/invalid HTTP/WS auth-envelope fixture, including exact/mixed-case
  duplicate fields, platform comma coalescing, whitespace/folding, canonical base64url and limits,
  exact concrete IDs, header-class presence, response metadata placement, and WS subprotocol/body.
- [ ] Test both compiled profiles against their distinct Host, HTTPS/WSS origin, certificate key
  ID/public key, and Turnstile site key. Wrong environment, cross-profile certificate/response,
  redirect, supplied URL/key, and placeholder input fails before state mutation.
- [ ] Write activation race tests: duplicate completion (including a changed browser nonce), token replay, wrong helper nonce, wrong installation proof, expiry, and challenge replacement.
- [ ] Add browser/request tests against the actual GET response proving exact no-store/security
  headers and CSP origins, active-profile public site key, no extra asset/third-party request,
  fragment canonical decode then immediate `history.replaceState`, invalid-fragment zero network,
  `crypto.getRandomValues` nonce, exact completion POST/status UI, and zero fragment/token/nonce leak
  to query/path/Referer/history/console/DOM/server log/localhost. Completion/poll carry IDs only in
  bounded bodies.
- [ ] Implement ActivationDO and InstallationDO schemas, the idempotent begin-routing saga, expiry
  alarms, and replacement reconciliation. Prove browser completion can locate only the exact active
  challenge without learning or accepting an installation key.
- [ ] Verify Turnstile server-side and discard the token immediately.
- [ ] Issue 365-day Ed25519 certificates and proof-of-key renewal inside 30 days.
- [ ] Add Worker signing-key ring support:
  - Current signing key writes.
  - Current plus next public keys may be advertised only inside a response signed by a currently
    pinned key. Advertisement is informational and never extends helper trust: a separately signed
    helper release must pin the next key in that profile's `WORKER_KEYS.lock` before accepting a
    response/certificate signed by it, and the Worker keeps signing with the old key while any
    supported helper lacks the next key.
  - The signed **201 activation-begin** body always contains `workerKeys` after `expiresAt`. It is an
    exact one-to-eight-entry array whose first entry is the current key and whose remaining entries
    are next keys sorted by `keyId`. Each entry has the exact canonical field order and shape
    `{"state":"current"|"next","keyId":"...","publicKey":"<32-byte canonical base64url>"}`.
    The current entry must name the response-signing key and exactly match the helper's pinned
    bytes. A next entry is syntax/namespace/duplicate checked; if its ID is already compiled into
    the helper, its bytes must also match. Unpinned advertised keys are discarded after validation
    and are never inserted into the live profile, persisted, or accepted for signatures.
  - A retired key remains verify-only until the later of the 180-day coordination compatibility
    window and 365 days plus 60 seconds after its last certificate issuance; no still-valid
    certificate becomes unverifiable during rotation.
  - Credential epoch prevents rollback.
- [ ] Add redacted audit metrics with rotating keyed installation/IP hashes only.

Expected: helper activation fixtures from plan 03 pass against the local Worker.

**Suggested commit:** **feat: issue anonymous installation-bound activation certificates**

## Task 3: Implement crash-safe invitation and short-code ownership

**Files:**

- Create: **worker/src/durable/invitation.ts**, **shortCode.ts**, **rateLimit.ts**
- Test: concurrency, expiry, and quota suites

- [ ] Write failing parallel tests proving one active invitation, one joiner, one short-code owner, one approval, and one finalization saga.
- [ ] Reject full-token and short-code claims whose joining installation hash equals the invitation
  host installation hash before allocating a pending pair ID or mailbox state.
- [ ] Write all locked quota boundary tests at limit minus one, limit, and limit plus one.
- [ ] Write exact normalization/keyed-hash vectors plus wrong-code destruction, Unicode/confusable,
  hyphen/case, plaintext-log, duplicate-create, expiry-alarm, cancellation, and collision tests.
- [ ] Inject a crash/lost response after every cross-DO call/local commit in creation, claim, and
  finalization; retry/alarms must leave no orphan code/quota, double count/joiner/pair, or prepared
  PairDO accepting control.
- [ ] Implement InvitationDO, ShortCodeDO, RateLimitDO, PairDO prepare/finalize, saga journals,
  idempotent ownership tokens, compensation, and alarms.
- [ ] Store only commitments and typed bounded mailbox records.
- [ ] Clear Noise records and code mappings immediately on reject/cancel/consume; keep only a short nonsecret replay tombstone for 10 minutes.

Verification:

~~~bash
cd worker
npm test -- invitation short-code quota
~~~

Expected: race tests deterministically admit one winner and no stale secret-bearing records remain.

**Suggested commit:** **feat: add crash-safe one-joiner invitation rooms**

## Task 4: Implement both Noise mailboxes and approval gating

**Files:**

- Create: **worker/src/pairing/** route/state handlers
- Test with fixed helper-produced Noise records; Worker never decrypts them

- [ ] Add failing tests for out-of-order/duplicate/oversized mailbox records, identity commitment
  replacement, invitation-generation/pair-ID replacement, role swap, protocol mismatch,
  transcript/channel-binding/approval-context replacement, stale trust epoch, key sequence other
  than fixed `1`, and
  approval by the wrong host.
- [ ] Encode a maximum 1,200-byte Noise record with maximum-width invitation/sequence/role/type
  fields and prove the complete unpadded-base64url JSON record remains at or below 2,048 raw
  bytes; reject 1,201 decoded bytes and do not raise the envelope limit to pass.
- [ ] Prove both full-token and short-code flows remain pending until the same exact five-word SAS
  plus fingerprint is displayed and a valid ApprovalReceiptV1 context is approved; PSK possession,
  a matching transcript, or a Worker claim alone never auto-approves.
- [ ] Add a failing test proving endpoint publication and candidate forwarding are impossible in every pre-approved state.
- [ ] Implement the full-token and short-code state transitions exactly above.
- [ ] Bind approval to the exact host, joiner, invitation ID/generation, pending pair ID,
  approval-context hash, transcript/channel binding, both identity commitments, roles, protocol,
  trust epochs, and host/remote key sequences exactly `1`. Worker stores only the context hash; the helper's installation
  signature proves it validated the actor/local-host-or-remote-gateway-launch/browser-session/confirmation-request-bound
  receipt from plan 03; a stale launch cannot approve or consume.
- [ ] Consume the exact `PairConfirmationV1` confirmation-key MAC vectors. Require each helper's
  publish-local-then-poll/verify-peer-then-consume order, test both sides concurrently without
  deadlock, and require both locally verified confirmations plus both idempotent Worker consume
  records before the PairDO prepare/finalize saga; Worker validates/stores fixed commitments but
  never pretends to verify a pair-secret MAC. Reject pre-approval/post-consume type use, second-side
  duplicate, 1,025-byte payload, and confusing it with `noise_transport`.
- [ ] Ensure the Worker never sees the full token secret, derived pair root, SAS key, endpoint plaintext, or installation private key.

Expected: public crypto/state fixtures agree between helper and Worker, while tampered transcripts fail.

**Suggested commit:** **feat: gate pair creation on exact attended transcript approval**

## Task 5: Implement PairDO and hibernating control sockets

**Files:**

- Create: **worker/src/durable/pair.ts**, **worker/src/pairControl.ts**
- Test: WebSocket hibernation/reconnect and pair isolation

- [ ] Consume all nine exact `PairControlRecordV1` cross-language types and write failing tests for
  one socket per side, per-frame signature/type/payload/pair substitution, connection-generation
  replacement, replayed sequence/nonce, endpoint epoch rollback, different same-epoch ciphertext,
  stale trust epoch, revocation MAC, and extra peer.
- [ ] Encode a maximum 1,200-byte endpoint ciphertext with maximum-width generation/sequence,
  nonce, signature, protocol, and role fields and prove the complete wire record remains at or
  below 2,048 bytes; the test must not raise the envelope limit to pass.
- [ ] Write pair isolation tests proving remotes never learn another remote's keys/envelopes/presence.
- [ ] Saturate every ordinary installation/pair nonce, HTTPS, WebSocket, endpoint, presence, and
  edge route-class budget, then prove one valid higher-epoch revoke and its acknowledgement still
  use the reserved stores and succeed. Replay each, exceed only the reserved revocation budget, and
  prove fail-closed behavior without reopening trust or consuming ordinary capacity.
- [ ] Implement only the fixed signed WebSocket/HTTPS record union; upgrade authentication alone
  grants no later frame. Test the exact WS/publish/poll/revoke/ack type matrix, especially type 7/8
  rejection on ordinary publish and ordinary-type rejection on reserved routes.
- [ ] Persist both side high-waters/cursors and at most one complete signed record per side/type with
  the exact acknowledgement/expiry rules. Test WS→HTTPS→WS fallback, hibernation, restart, an
  offline receiver polling after more than 60 seconds, valid old endpoint/revocation acceptance,
  expired presence, exact retry, replay, and lowest-one-record poll order.
- [ ] Make revocation/ack use the dedicated replay table and reserved route budget, bypass ordinary
  limits, advance monotonically, and close both sockets. Configure the edge burst shield with the
  same separate route class so ordinary saturation cannot block a valid revocation.
- [ ] Verify hibernation/restart restores only bounded nonsecret attachment data.
- [ ] Simulate Worker loss while a helper direct stream continues; only new coordination must fail.

Expected: PairDO is a two-party bounded mailbox, not a generic tailnet/control server.

**Suggested commit:** **feat: add pair-isolated encrypted endpoint coordination**

## Task 6: Abuse, privacy, and observability hardening

**Files:**

- Create/modify: rate-limit configuration, structured metrics, redaction tests, operational runbook

- [ ] Add property/fuzz tests over all strict schemas and body decoders.
- [ ] Add global/per-installation/per-pair/IP-prefix/ASN/route quota tests.
- [ ] Add a fail-closed emergency configuration for:
  - New activations.
  - New invitations.
  - New short-code claims.
  - Established pair coordination remains available unless separately disabled.
- [ ] Log only fixed error/route/outcome codes, duration, byte bucket, and rotating keyed correlation hashes.
- [ ] Prove logs never contain Turnstile token, certificate, full public key, code, Noise record, endpoint ciphertext/plaintext, candidate, device name, or request body.
- [ ] Add alarms/metrics for quota saturation, DO errors, certificate failures, pairing success/failure, and endpoint update latency.
- [ ] Document free-plan exhaustion behavior: new coordination fails closed; established direct paths are unaffected.

**Suggested commit:** **security: bound and redact the coordination plane**

## Task 7: Stage, compatibility-test, and prepare the production artifact

**External action — staging requires user confirmation. This task never deploys production.**

- [ ] Run all Worker and helper tests locally first.
- [ ] Use the one release-candidate helper byte sequence with compiled profile enum 2 for staging;
  prove default/normal selects production, staging requires development/release-validation, and
  inactive/cross-profile/redirect/third-origin dials and signatures fail with zero egress.
- [ ] Show the exact staging account/zone, custom hostname, Worker name, DO bindings/migrations, Turnstile site, secrets, and deployment command.
- [ ] After approval, create/deploy staging only.
- [ ] Run real-device activation, both pairing paths, endpoint updates, hibernation, roaming, revocation, abuse, and Worker-outage tests.
- [ ] Run the current helper against both the current and immediately previous supported
  coordination-protocol major on staging; retain the previous-major case for the full
  180-day compatibility window.
- [ ] Complete a security review and record the deployed Worker hash/migration IDs.
- [ ] Build one immutable production Worker bundle and append-only migration manifest from the
  reviewed exact commit. Record bundle SHA-256, compatibility date, route table, bindings, secret
  names, schema versions, previous-major proof, and forward-compatible rollback command.
- [ ] Run the production dry run and prove no Cloudflare production resource, route, binding,
  migration, secret, or hostname changed.
- [ ] Hand the immutable artifact/evidence to plan 07. Plan 07 alone shows the production target,
  asks separately, deploys/verifies the Worker, and only then permits first public helper bytes.

Verification:

~~~bash
cd worker
npm test
npx wrangler deploy --dry-run --env production
~~~

Expected: approved staging health/synthetic probes pass without management data; the exact
production artifact and dry run pass, and production remains unchanged.

**Suggested commit before handoff:** **docs: record coordination deployment and rollback runbook**

## Compatibility and Data Retention

- Within a coordination-protocol major, minor releases are additive and negotiate capabilities.
- Worker supports the current and immediately previous coordination-protocol **major** for at least **180 days after the newer major reaches GA**.
- No major is removed while any supported Discord Waifus root release still references it.
- Invitation secrets/mailbox bytes are deleted at consume/reject/cancel and at expiry.
- Replay tombstones live 10 minutes.
- Only latest endpoint ciphertext per side is retained.
- Pair/revocation metadata persists while trust exists; after both sides revoke, retain a minimal revocation tombstone for 400 days, then delete by alarm.
- Metrics retention is 30 days; application logs are 7 days and contain no control payload.

## Rollback

1. Do not roll back a SQLite migration destructively.
2. Deploy a forward-compatible Worker that reads the new schema but restores the prior behavior.
3. Keep both current and previous Worker code/protocol routes available.
4. If activation/pairing is unsafe, disable only new activation/pairing with the emergency switches.
5. Existing direct streams continue; existing pairs can still revoke.
6. Roll back helper/root selection before retiring any Worker protocol.

## Completion Gate

Plan 07's separately approved production-deployment task may begin only after:

- Local and staging activation/pairing fixtures match the helper.
- The actual activation page, full HTTP/WS auth envelope, both compiled profile/key/site-key
  bindings, and same-byte staging release-candidate tests pass with no leak/cross-profile egress.
- Every route and message is fixed, strict, and bounded.
- DO uint64 boundary, cross-DO crash/retry/compensation, PairControl persistence/fallback/offline,
  confirmation/revocation MAC, races, and quota tests pass.
- No endpoint is accepted before approval.
- Pair isolation and revocation pass.
- Worker outage leaves established direct traffic running.
- Security/privacy review passes.
- The immutable production bundle/migration evidence and dry run are complete; production was not
  deployed by this plan.
