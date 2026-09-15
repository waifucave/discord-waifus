import { TextDecoder } from "node:util";
import {
  assertHelperComponentCompatibility,
  parseRemoteCompatibilityV1,
  type RemoteCompatibilityV1
} from "./componentCompatibility.js";
import {
  HELPER_CONTROL_PROFILES_V1,
  verifyHelperManifestTrustV1,
  type HelperEmbeddedBuildInfoV1,
  type HelperReleaseTrustEntryV1,
  type VerifiedHelperManifestV1
} from "../shared/helperManifestTrust.js";
import {
  HelperManifestSchema,
  type HelperManifest,
  type HelperTarget
} from "../shared/schemas/remoteAccess.js";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type VerifyHelperPackageManifestInput = Readonly<{
  manifestBytes: Uint8Array;
  signatures: ReadonlyMap<string, Uint8Array>;
  binaryBytes: Uint8Array;
  noticesBytes: Uint8Array;
  embeddedBuildInfo: HelperEmbeddedBuildInfoV1;
  trustRoots: readonly HelperReleaseTrustEntryV1[];
  packageName: HelperManifest["packageName"];
  packageVersion: string;
  target: HelperTarget;
  appVersion: string;
  compatibility: RemoteCompatibilityV1;
}>;

export type VerifyHelperPackageBeforeExecutionInput = Omit<
  VerifyHelperPackageManifestInput,
  "embeddedBuildInfo"
>;

function parseUntrustedManifest(bytes: Uint8Array): HelperManifest {
  let value: unknown;
  try {
    value = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    value = undefined;
  }
  return HelperManifestSchema.parse(value);
}

function expectedBuildInfo(manifest: HelperManifest): HelperEmbeddedBuildInfoV1 {
  return {
    schemaVersion: 1,
    helperVersion: manifest.helperVersion,
    releaseSequence: manifest.releaseSequence,
    releasedAt: manifest.releasedAt,
    packageName: manifest.packageName,
    target: manifest.target,
    sourceCommit: manifest.sourceCommit,
    contractCommit: manifest.contractCommit,
    forkCommit: manifest.forkCommit,
    workerTrustRingSha256: manifest.workerTrustRingSha256,
    tailscale: manifest.tailscale,
    goVersion: manifest.goVersion,
    directOnlyBuildTag: manifest.directOnlyBuildTag,
    protocols: manifest.protocols,
    capabilities: manifest.capabilities,
    controlProfiles: HELPER_CONTROL_PROFILES_V1
  };
}

function trustInput(
  input: VerifyHelperPackageBeforeExecutionInput,
  manifest: HelperManifest,
  embeddedBuildInfo: HelperEmbeddedBuildInfoV1
) {
  return {
    manifestBytes: input.manifestBytes,
    signatures: input.signatures,
    binaryBytes: input.binaryBytes,
    noticesBytes: input.noticesBytes,
    embeddedBuildInfo,
    trustEntries: input.trustRoots,
    expected: {
      packageName: input.packageName,
      target: input.target,
      appVersion: input.appVersion,
      pinnedHelperVersion: input.packageVersion,
      minimumReleaseSequence: input.compatibility.helper.minimumReleaseSequence,
      workerTrustRingSha256: input.compatibility.helper.workerTrustRingSha256,
      protocols: manifest.protocols,
      capabilities: manifest.capabilities
    }
  };
}

export function verifyHelperPackageBeforeExecution(
  input: VerifyHelperPackageBeforeExecutionInput
): Readonly<{
  verified: VerifiedHelperManifestV1;
  expectedBuildInfo: HelperEmbeddedBuildInfoV1;
}> {
  const compatibility = parseRemoteCompatibilityV1(input.compatibility, input.appVersion);
  const normalizedInput = { ...input, compatibility };
  const manifest = parseUntrustedManifest(input.manifestBytes);
  const buildInfo = expectedBuildInfo(manifest);
  const verified = verifyHelperManifestTrustV1(trustInput(normalizedInput, manifest, buildInfo));
  assertHelperComponentCompatibility(verified.manifest, compatibility);
  return Object.freeze({ verified, expectedBuildInfo: buildInfo });
}

export function verifyHelperPackageManifest(
  input: VerifyHelperPackageManifestInput
): VerifiedHelperManifestV1 {
  const compatibility = parseRemoteCompatibilityV1(input.compatibility, input.appVersion);
  const beforeExecution = verifyHelperPackageBeforeExecution(input);
  return verifyHelperManifestTrustV1(trustInput(
    { ...input, compatibility },
    beforeExecution.verified.manifest,
    input.embeddedBuildInfo
  ));
}
