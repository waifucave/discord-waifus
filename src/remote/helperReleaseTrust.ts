import type { HelperReleaseTrustEntryV1 } from "../shared/helperManifestTrust.js";

/**
 * Reviewed production Ed25519 keys that may sign immutable ts-connect release
 * manifests. This list intentionally remains empty until the approval-gated
 * production signing setup records the real public key and its bounded release
 * window. An empty list makes production helper verification fail closed.
 */
export const HELPER_RELEASE_TRUST_ROOTS: readonly HelperReleaseTrustEntryV1[] = Object.freeze([]);
