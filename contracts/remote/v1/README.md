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
- `remote-access.schema.json` currently freezes attended `ApprovalReceiptV1` plus the strict
  helper identity-reset command, status lookup, and crash-journal receipt records. Its fixtures
  cover both local and trusted-remote browser bindings and impossible reset stages.
- `fixtures/crypto/wipc-v1.json` freezes all 14 V1 frame-type headers, valid and invalid
  24-byte header boundaries, the exact eight-byte `WINDOW_UPDATE`, odd/even high-water and
  exhaustion cases, and the capability-derived `parentProof`/`helperProof` bytes. Connection
  control, START, CANCEL, and ERROR frames carry nonempty canonical JSON; CHUNK frames carry raw
  bytes; REQUEST_END and RESPONSE_END carry no payload.
- `conformance-go/` independently recreates and validates that WIPC fixture using Go 1.26.5.
  It pins `github.com/flynn/noise` v1.1.0 now so later Noise vectors cannot silently select a
  different implementation.

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

This remains an incomplete contract gate. The full WIPC stream state machine/credit-accounting
vectors, remaining remote-access/dashboard DTOs, pairing and service crypto fixtures,
signed-manifest trust vectors, and SAS wordlist must land before production helper, pairing,
Cloudflare, host bridge, or remote gateway work may rely on this directory.
