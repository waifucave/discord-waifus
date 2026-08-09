# Waifus Remote Protocol V1

This directory contains the public, cross-repository contract for Waifus remote management.
The checked-in JSON files are generated from the strict Zod schemas in
`src/shared/schemas/remoteProtocol.ts`; edit the TypeScript authority, not the generated files.

Current foundation:

- `protocol.schema.json` defines canonical JSON uint64 values, protocol/capability negotiation,
  the closed control-profile/runtime-purpose values, and `RemoteBrowserContextV1`.
- `capabilities.json` freezes protocol `1.0` and the initial required capability set.
- `helper-manifest.schema.json` freezes the signed helper release manifest, its six exact
  package/target combinations, direct-only build pins, compatibility ranges, and bounded hashes.
- `fixtures/helper-manifest/` contains generated structural accept/reject examples for both the
  Node resolver and the private Go packager. Signature/trust-window fixtures land with the crypto
  conformance layer. Each fixture file itself uses RFC 8785 canonical JSON bytes.

Run `npm run contracts:remote:generate` after an intentional contract change and
`npm run contracts:remote:check` in validation. Generation is recursively key-sorted and
LF-terminated so another repository can pin exact bytes.

The JSON Schema uses two named extension keywords and one named format for invariants that standard
JSON Schema cannot express by itself:

- `x-waifus-ascii-sorted` requires bytewise ASCII ordering.
- `x-waifus-disjoint-properties` requires the named arrays to be disjoint.
- `waifus-origin-form-target-v1` applies the exact request-target canonicalization implemented by
  `isCanonicalOriginFormTarget`.

Consumers must enforce those annotations or use the public conformance fixtures. A generic JSON
Schema validator that ignores them is not a complete protocol validator.

This is the first implementation slice, not the completed contract gate. Remote-access DTOs,
helper/dashboard manifests, WIPC and crypto fixtures, the SAS wordlist, and the independent Go
conformance harness still have to land before production helper, pairing, Cloudflare, host bridge,
or remote gateway work may rely on this directory.
