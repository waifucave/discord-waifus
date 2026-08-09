# Waifus Remote Protocol V1

This directory contains the public, cross-repository contract for Waifus remote management.
The checked-in JSON files are generated from the strict Zod schemas in
`src/shared/schemas/remoteProtocol.ts` and `src/shared/schemas/remoteAccess.ts`; edit those
TypeScript authorities, not the generated files.

Current foundation:

- `protocol.schema.json` defines canonical JSON uint64 values, protocol/capability negotiation,
  the closed control-profile/runtime-purpose values, signed V1 device identity bundles,
  helper-derived request principals, and `RemoteBrowserContextV1`.
- `capabilities.json` freezes protocol `1.0` and the initial required capability set.
- `helper-manifest.schema.json` freezes the signed helper release manifest, its six exact
  package/target combinations, direct-only build pins, compatibility ranges, and bounded hashes.
- `fixtures/helper-manifest/` contains generated structural accept/reject examples for both the
  Node resolver and the private Go packager. Signature/trust-window fixtures land with the crypto
  conformance layer. Each fixture file itself uses RFC 8785 canonical JSON bytes.
- `remote-access.schema.json` currently freezes attended `ApprovalReceiptV1`, exact
  `PairConfirmationV1`, all nine signed `PairControlRecordV1` variants, plus the strict helper
  identity-reset command, status lookup, and crash-journal receipt records. Its fixtures cover both
  local and trusted-remote browser bindings and impossible reset stages.
- `fixtures/crypto/wipc-v1.json` freezes all 14 V1 frame-type headers, valid and invalid
  24-byte header boundaries, the exact eight-byte `WINDOW_UPDATE`, odd/even high-water and
  exhaustion cases, and the capability-derived `parentProof`/`helperProof` bytes. Connection
  control, START, CANCEL, and ERROR frames carry nonempty canonical JSON; CHUNK frames carry raw
  bytes; REQUEST_END and RESPONSE_END carry no payload.
- `fixtures/crypto/wipc-state-v1.json` freezes authenticated stream admission, both initiating
  parities, request/response transitions, cancellation and bounded discarded input, terminal and
  inactive-frame behavior, independent request/response credits, wrong-side/overflow failures,
  and the high-water-before-limit rule for the 129th stream.
- `fixtures/crypto/wipc-auth-session-v1.json` freezes parent/helper proof sequencing, traffic
  gating, capability retention after a rejected candidate, capability erasure after success,
  replay/reflection rejection, socket-race recovery, and second-client refusal.
- `fixtures/crypto/pairing-v1.json` freezes strict canonical CBOR, signed `WF1.` full tokens,
  signed identity bundles, the exact XXpsk0 and XX messages/channel bindings, transcript hashes,
  contribution transport ciphertext, pair root and all four separated keys, and 50-bit SAS
  indices/fingerprint. Embedded private keys and seeds are deterministic test-only vector inputs,
  never production material.
- `fixtures/crypto/pair-confirmation-v1.json` freezes the exact confirmation-key MAC inputs for
  both roles, every bound-context substitution, canonical JSON and 1,024-byte boundaries, the
  distinct mailbox record type, and publish-local/verify-peer/consume ordering and idempotency.
- `fixtures/crypto/pair-control-record-v1.json` freezes all nine canonical signed control records,
  type-specific payload hashes, the WebSocket/HTTPS transport matrix, per-side generation/sequence
  and nonce replay state across restart, delayed-poll timestamps, endpoint size limits, and the
  domain-separated revocation/revocation-ack MACs that remain opaque to the Worker.
- `conformance-go/` independently recreates and validates the WIPC and pairing fixtures using Go
  1.26.5. It pins `github.com/flynn/noise` v1.1.0 and independently rejects the token, identity,
  canonical-CBOR, pair-confirmation, PairControl, and revocation negative vectors.

Run `npm run contracts:remote:generate` after an intentional contract change and
`npm run contracts:remote:check` in validation. Schema documents are recursively key-sorted,
pretty-printed, and LF-terminated. Wire fixtures use compact RFC 8785 canonical JSON without a
trailing newline so another repository can pin the exact signed bytes.

Run the independent WIPC gate with Go 1.26.5:

```bash
go -C contracts/remote/v1/conformance-go test ./...
go -C contracts/remote/v1/conformance-go run ./cmd/generate-vectors --check
```

The JSON Schemas use named `x-waifus-*` extension keywords and named formats for invariants that
standard JSON Schema cannot express by itself. These currently cover:

- bytewise ASCII ordering and disjoint sets;
- ordered protocol/SemVer fields, derived principal IDs, and distinct old/new identities;
- approval-expiry windows and decoded-CBOR byte ceilings;
- whole-second UTC timestamps, canonical base64url CBOR, and exact origin-form request targets.

Consumers must enforce those annotations or use the public conformance fixtures. A generic JSON
Schema validator that ignores them is not a complete protocol validator.

This remains an incomplete contract gate. The reviewed 1,024-word SAS artifact and word mapping,
remaining remote-access/dashboard DTOs, service crypto,
activation/control envelopes, and signed-manifest trust vectors must land before production helper,
pairing, Cloudflare, host bridge, or remote gateway work may rely on this directory as a complete
V1 authority.
