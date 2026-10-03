import type { HelperReleaseTrustEntryV1 } from "../shared/helperManifestTrust.js";

/**
 * Reviewed production Ed25519 keys that may sign immutable ts-connect release
 * manifests. Initial trust is limited to the reviewed immutable 0.1.3 build's
 * release sequence and signed timestamp. A future helper release requires a
 * separately reviewed window update before it can be signed and distributed.
 */
export const HELPER_RELEASE_TRUST_ROOTS: readonly HelperReleaseTrustEntryV1[] = Object.freeze([
  Object.freeze({
    keyId: "waifucave-ts-connect-release-2026-01",
    publicKeyB64: "B4vOrn-ZZe9GdtOoiqbm1GG9ES2FJlFbEVMAhZqUePo",
    fingerprint: "6a0fdc6a96cb180a5e823a3e43cdcafe9cd2b65b22298965b42aa965fb82a381",
    sequenceFrom: "4",
    sequenceThrough: "4",
    releasedAtFrom: "2026-10-03T07:40:35Z",
    releasedAtThrough: "2026-10-03T07:40:35Z"
  })
]);
