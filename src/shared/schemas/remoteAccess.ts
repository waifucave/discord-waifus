import { z } from "zod";
import {
  Base64Url16BytesSchema,
  Base64Url32BytesSchema,
  Base64Url64BytesSchema,
  CanonicalTargetSchema,
  CapabilityNameListSchema,
  DeviceRoleV1Schema,
  HttpMethodSchema,
  PrincipalStableIdSchema,
  ProtocolVersionSchema,
  SemVerSchema,
  Uint64DecimalSchema
} from "./remoteProtocol.js";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GIT_SHA1_PATTERN = /^[0-9a-f]{40}$/;
const RELEASE_KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,95}$/;
const WHOLE_SECOND_UTC_PATTERN = /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]Z$/;
const SEMVER_CAPTURE_PATTERN = /^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const Sha256HexSchema = z.string().length(64).regex(SHA256_HEX_PATTERN);
export const GitCommitSha1Schema = z.string().length(40).regex(GIT_SHA1_PATTERN);
export const PositiveUint64DecimalSchema = Uint64DecimalSchema.refine(
  (value) => value !== "0",
  "Expected a positive uint64 decimal string."
);

export const CanonicalReleasedAtSchema = z
  .string()
  .length(20)
  .regex(WHOLE_SECOND_UTC_PATTERN, "Expected an RFC 3339 whole-second UTC timestamp.")
  .refine((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      && new Date(timestamp).toISOString().replace(".000Z", "Z") === value;
  }, "Expected a real calendar timestamp.");

export const ProtocolRangeSchema = z
  .object({
    major: z.number().int().min(1).max(65_535),
    minimumMinor: z.number().int().min(0).max(65_535),
    maximumMinor: z.number().int().min(0).max(65_535)
  })
  .strict()
  .refine(
    (value) => value.minimumMinor <= value.maximumMinor,
    "minimumMinor must not exceed maximumMinor."
  );

export type ProtocolRange = z.infer<typeof ProtocolRangeSchema>;

const DarwinArm64TargetSchema = z.object({
  os: z.literal("darwin"),
  arch: z.literal("arm64")
}).strict();
const Win32X64TargetSchema = z.object({
  os: z.literal("win32"),
  arch: z.literal("x64")
}).strict();
const Win32Arm64TargetSchema = z.object({
  os: z.literal("win32"),
  arch: z.literal("arm64")
}).strict();
const LinuxX64TargetSchema = z.object({
  os: z.literal("linux"),
  arch: z.literal("x64")
}).strict();
const LinuxArm64TargetSchema = z.object({
  os: z.literal("linux"),
  arch: z.literal("arm64")
}).strict();
const LinuxArmV7TargetSchema = z.object({
  os: z.literal("linux"),
  arch: z.literal("arm"),
  goarm: z.literal(7)
}).strict();

export const HelperTargetSchema = z.union([
  DarwinArm64TargetSchema,
  Win32X64TargetSchema,
  Win32Arm64TargetSchema,
  LinuxX64TargetSchema,
  LinuxArm64TargetSchema,
  LinuxArmV7TargetSchema
]);

export type HelperTarget = z.infer<typeof HelperTargetSchema>;

export const HELPER_PACKAGE_TARGETS = Object.freeze([
  {
    packageName: "@waifucave/ts-connect-darwin-arm64",
    target: { os: "darwin", arch: "arm64" }
  },
  {
    packageName: "@waifucave/ts-connect-win32-x64",
    target: { os: "win32", arch: "x64" }
  },
  {
    packageName: "@waifucave/ts-connect-win32-arm64",
    target: { os: "win32", arch: "arm64" }
  },
  {
    packageName: "@waifucave/ts-connect-linux-x64",
    target: { os: "linux", arch: "x64" }
  },
  {
    packageName: "@waifucave/ts-connect-linux-arm64",
    target: { os: "linux", arch: "arm64" }
  },
  {
    packageName: "@waifucave/ts-connect-linux-armv7",
    target: { os: "linux", arch: "arm", goarm: 7 }
  }
] as const);

const HelperPackageNameSchema = z.enum([
  "@waifucave/ts-connect-darwin-arm64",
  "@waifucave/ts-connect-win32-x64",
  "@waifucave/ts-connect-win32-arm64",
  "@waifucave/ts-connect-linux-x64",
  "@waifucave/ts-connect-linux-arm64",
  "@waifucave/ts-connect-linux-armv7"
]);

const HelperBinarySchema = z.object({
  relativePath: z.enum(["bin/ts-connect", "bin/ts-connect.exe"]),
  byteSize: PositiveUint64DecimalSchema,
  sha256: Sha256HexSchema
}).strict();

const HelperProtocolsSchema = z.object({
  ipc: ProtocolRangeSchema,
  coordination: ProtocolRangeSchema,
  directService: ProtocolRangeSchema,
  helperManifest: ProtocolRangeSchema
}).strict();

const ReleaseKeyIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(RELEASE_KEY_ID_PATTERN);

function isAsciiSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

export const ReleaseKeyIdListSchema = z
  .array(ReleaseKeyIdSchema)
  .min(1)
  .max(8)
  .refine(isAsciiSortedUnique, "Release key IDs must be ASCII-sorted and unique.");

interface ParsedSemVer {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease?: string[];
}

function parseSemVer(value: string): ParsedSemVer {
  const match = SEMVER_CAPTURE_PATTERN.exec(value);
  if (!match) {
    throw new TypeError(`Invalid SemVer: ${value}`);
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".")
  };
}

function comparePrerelease(left?: string[], right?: string[]): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return 1;
  }
  if (!right) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumeric = /^[0-9]+$/.test(leftPart);
    const rightNumeric = /^[0-9]+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function compareSemVer(left: string, right: string): number {
  const parsedLeft = parseSemVer(SemVerSchema.parse(left));
  const parsedRight = parseSemVer(SemVerSchema.parse(right));
  for (const field of ["major", "minor", "patch"] as const) {
    if (parsedLeft[field] !== parsedRight[field]) {
      return parsedLeft[field] < parsedRight[field] ? -1 : 1;
    }
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function targetsEqual(left: HelperTarget, right: HelperTarget): boolean {
  return left.os === right.os
    && left.arch === right.arch
    && ("goarm" in left ? left.goarm : undefined) === ("goarm" in right ? right.goarm : undefined);
}

export const HelperManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    helperVersion: SemVerSchema,
    releaseSequence: PositiveUint64DecimalSchema,
    releasedAt: CanonicalReleasedAtSchema,
    packageName: HelperPackageNameSchema,
    target: HelperTargetSchema,
    binary: HelperBinarySchema,
    protocols: HelperProtocolsSchema,
    capabilities: CapabilityNameListSchema,
    minimumDiscordWaifusVersion: SemVerSchema,
    maximumDiscordWaifusVersionExclusive: SemVerSchema,
    sourceCommit: GitCommitSha1Schema,
    contractCommit: GitCommitSha1Schema,
    forkCommit: GitCommitSha1Schema,
    workerTrustRingSha256: Sha256HexSchema,
    tailscale: z.object({
      tag: z.literal("v1.102.2"),
      commit: z.literal("eb67e5dcbe145d63e1128b9b4b630f8a82da101f")
    }).strict(),
    goVersion: z.literal("go1.26.5"),
    directOnlyBuildTag: z.literal("waifus_direct_only"),
    ossNoticeSha256: Sha256HexSchema,
    releaseKeyIds: ReleaseKeyIdListSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const packageTarget = HELPER_PACKAGE_TARGETS.find(
      (entry) => entry.packageName === value.packageName
    );
    if (!packageTarget || !targetsEqual(value.target, packageTarget.target)) {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Target does not match the helper package name."
      });
    }

    const expectedBinary = value.target.os === "win32"
      ? "bin/ts-connect.exe"
      : "bin/ts-connect";
    if (value.binary.relativePath !== expectedBinary) {
      ctx.addIssue({
        code: "custom",
        path: ["binary", "relativePath"],
        message: "Binary path does not match the target operating system."
      });
    }

    if (compareSemVer(
      value.minimumDiscordWaifusVersion,
      value.maximumDiscordWaifusVersionExclusive
    ) >= 0) {
      ctx.addIssue({
        code: "custom",
        path: ["maximumDiscordWaifusVersionExclusive"],
        message: "Maximum Discord Waifus version must be above the minimum version."
      });
    }
  });

export type HelperManifest = z.infer<typeof HelperManifestSchema>;
export type HelperManifestInput = z.input<typeof HelperManifestSchema>;

export const CanonicalIdentityBundleCborSchema = z
  .string()
  .min(1)
  .max(1_600)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected canonical unpadded base64url.")
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength > 0
      && decoded.byteLength <= 1_200
      && decoded.toString("base64url") === value;
  }, "Expected canonical base64url encoding of at most 1,200 identity-bundle bytes.");

const ApprovalBrowserBindingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    hostServerLaunchId: Base64Url32BytesSchema,
    browserSessionId: Base64Url32BytesSchema
  }).strict(),
  z.object({
    kind: z.literal("remote"),
    gatewayLaunchId: Base64Url32BytesSchema,
    browserSessionId: Base64Url32BytesSchema
  }).strict()
]);

const ApprovingPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    stableId: z.literal("local")
  }).strict(),
  z.object({
    kind: z.literal("remote_device"),
    stableId: PrincipalStableIdSchema,
    peerFingerprint: Base64Url16BytesSchema,
    trustEpoch: Uint64DecimalSchema
  }).strict()
]);

const AssistantProvenanceSchema = z.object({
  conversationId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/),
  toolCallId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/).optional(),
  pendingActionId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/).optional(),
  confirmedActionPayloadHash: Base64Url32BytesSchema
}).strict();

const SasIndicesSchema = z.tuple([
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023),
  z.number().int().min(0).max(1_023)
]);

export const ApprovalReceiptV1Schema = z
  .object({
    version: z.literal(1),
    receiptId: Base64Url32BytesSchema,
    issuedAt: Uint64DecimalSchema,
    expiresAt: Uint64DecimalSchema,
    invitationId: Base64Url16BytesSchema,
    invitationGeneration: Uint64DecimalSchema,
    pendingPairId: Base64Url16BytesSchema,
    hostIdentityBundleCbor: CanonicalIdentityBundleCborSchema,
    hostIdentityBundleHash: Base64Url32BytesSchema,
    remoteIdentityBundleCbor: CanonicalIdentityBundleCborSchema,
    remoteIdentityBundleHash: Base64Url32BytesSchema,
    noisePattern: z.enum([
      "Noise_XXpsk0_25519_ChaChaPoly_SHA256",
      "Noise_XX_25519_ChaChaPoly_SHA256"
    ]),
    protocol: ProtocolVersionSchema,
    transcriptHash: Base64Url32BytesSchema,
    channelBinding: Base64Url32BytesSchema,
    sasIndices: SasIndicesSchema,
    sasFingerprint: z.string().length(12).regex(/^[0-9a-f]{12}$/),
    hostTrustEpoch: Uint64DecimalSchema,
    remoteTrustEpoch: Uint64DecimalSchema,
    hostKeySequence: z.literal(1),
    remoteKeySequence: z.literal(1),
    approvingPrincipal: ApprovingPrincipalSchema,
    browserBinding: ApprovalBrowserBindingSchema,
    confirmationRequestNonce: Base64Url16BytesSchema,
    confirmationMethod: HttpMethodSchema,
    confirmationTarget: CanonicalTargetSchema,
    assistantProvenance: AssistantProvenanceSchema.optional(),
    nonce: Base64Url32BytesSchema,
    action: z.literal("approve_pair")
  })
  .strict()
  .superRefine((value, ctx) => {
    const issuedAt = BigInt(value.issuedAt);
    const expiresAt = BigInt(value.expiresAt);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 120n) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Approval receipt expiry must be within 120 seconds after issue."
      });
    }
    if (
      value.hostIdentityBundleCbor === value.remoteIdentityBundleCbor
      || value.hostIdentityBundleHash === value.remoteIdentityBundleHash
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["remoteIdentityBundleHash"],
        message: "Host and remote identity bundles must be distinct."
      });
    }
    if (
      (value.approvingPrincipal.kind === "local" && value.browserBinding.kind !== "local")
      || (value.approvingPrincipal.kind === "remote_device" && value.browserBinding.kind !== "remote")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["browserBinding", "kind"],
        message: "Approval browser binding must match the approving principal source."
      });
    }
  });

export type ApprovalReceiptV1 = z.infer<typeof ApprovalReceiptV1Schema>;

export const PairConfirmationV1Schema = z
  .object({
    version: z.literal(1),
    invitationId: Base64Url16BytesSchema,
    invitationGeneration: Uint64DecimalSchema,
    pairId: Base64Url16BytesSchema,
    side: DeviceRoleV1Schema,
    transcriptHash: Base64Url32BytesSchema,
    channelBinding: Base64Url32BytesSchema,
    hostBundleHash: Base64Url32BytesSchema,
    remoteBundleHash: Base64Url32BytesSchema,
    approvalContextHash: Base64Url32BytesSchema,
    confirmationNonce: Base64Url16BytesSchema,
    confirmationMac: Base64Url32BytesSchema
  })
  .strict()
  .refine(
    (value) => value.hostBundleHash !== value.remoteBundleHash,
    { path: ["remoteBundleHash"], message: "Host and remote bundle hashes must be distinct." }
  );

export type PairConfirmationV1 = z.infer<typeof PairConfirmationV1Schema>;

export const PairControlTypeV1Schema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9)
]);

export type PairControlTypeV1 = z.infer<typeof PairControlTypeV1Schema>;

const Uint16Schema = z.number().int().min(0).max(65_535);

export const PairControlEndpointCiphertextSchema = z
  .string()
  .min(2)
  .max(1_600)
  .regex(/^[A-Za-z0-9_-]+$/, "Expected canonical unpadded base64url.")
  .refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength >= 1
      && decoded.byteLength <= 1_200
      && decoded.toString("base64url") === value;
  }, "Expected canonical base64url encoding of 1 to 1,200 bytes.");

export const PairControlHelloPayloadV1Schema = z.object({
  resumeConnectionGeneration: Uint64DecimalSchema,
  resumeSequence: Uint64DecimalSchema
}).strict();

export const PairControlCapabilitiesPayloadV1Schema = z.object({
  capabilitiesSha256: Base64Url32BytesSchema,
  coordinationMinor: Uint16Schema
}).strict();

export const PairControlEndpointGenerationPayloadV1Schema = z.object({
  endpointEpoch: Uint64DecimalSchema,
  ciphertext: PairControlEndpointCiphertextSchema,
  ciphertextSha256: Base64Url32BytesSchema
}).strict();

export const PairControlEndpointAckPayloadV1Schema = z.object({
  endpointEpoch: Uint64DecimalSchema,
  ciphertextSha256: Base64Url32BytesSchema
}).strict();

export const PairControlPresencePayloadV1Schema = z.object({
  state: z.enum(["online", "offline"]),
  validUntil: Uint64DecimalSchema
}).strict();

export const PairControlReconnectPayloadV1Schema = z.object({
  lastReceivedConnectionGeneration: Uint64DecimalSchema,
  lastReceivedSequence: Uint64DecimalSchema
}).strict();

export const PairControlRevocationPayloadV1Schema = z.object({
  revocationEpoch: Uint64DecimalSchema,
  reason: z.enum(["user_revoked", "identity_reset", "repair_required"]),
  revocationMac: Base64Url32BytesSchema
}).strict();

export const PairControlRevocationAckPayloadV1Schema = z.object({
  revocationEpoch: Uint64DecimalSchema,
  revocationMac: Base64Url32BytesSchema
}).strict();

export const PairControlErrorPayloadV1Schema = z.object({
  code: z.enum([
    "protocol_mismatch",
    "stale_generation",
    "sequence_gap",
    "revoked",
    "resync_required"
  ]),
  forConnectionGeneration: Uint64DecimalSchema,
  forSequence: Uint64DecimalSchema
}).strict();

const PairControlRecordBaseShape = {
  version: z.literal(1),
  protocolMajor: Uint16Schema,
  protocolMinor: Uint16Schema,
  pairId: Base64Url16BytesSchema,
  side: DeviceRoleV1Schema,
  connectionGeneration: PositiveUint64DecimalSchema,
  sequence: PositiveUint64DecimalSchema,
  timestamp: Uint64DecimalSchema,
  nonce: Base64Url16BytesSchema
};

function pairControlUnsignedRecord<
  Type extends PairControlTypeV1,
  Payload extends z.ZodType
>(type: Type, payload: Payload) {
  return z.object({
    ...PairControlRecordBaseShape,
    type: z.literal(type),
    payload
  }).strict();
}

function pairControlRecord<
  Type extends PairControlTypeV1,
  Payload extends z.ZodType
>(type: Type, payload: Payload) {
  return z.object({
    ...PairControlRecordBaseShape,
    type: z.literal(type),
    payload,
    signature: Base64Url64BytesSchema
  }).strict();
}

export const PairControlUnsignedRecordV1Schema = z.discriminatedUnion("type", [
  pairControlUnsignedRecord(1, PairControlHelloPayloadV1Schema),
  pairControlUnsignedRecord(2, PairControlCapabilitiesPayloadV1Schema),
  pairControlUnsignedRecord(3, PairControlEndpointGenerationPayloadV1Schema),
  pairControlUnsignedRecord(4, PairControlEndpointAckPayloadV1Schema),
  pairControlUnsignedRecord(5, PairControlPresencePayloadV1Schema),
  pairControlUnsignedRecord(6, PairControlReconnectPayloadV1Schema),
  pairControlUnsignedRecord(7, PairControlRevocationPayloadV1Schema),
  pairControlUnsignedRecord(8, PairControlRevocationAckPayloadV1Schema),
  pairControlUnsignedRecord(9, PairControlErrorPayloadV1Schema)
]);

export type PairControlUnsignedRecordV1 = z.infer<typeof PairControlUnsignedRecordV1Schema>;

export const PairControlRecordV1Schema = z.discriminatedUnion("type", [
  pairControlRecord(1, PairControlHelloPayloadV1Schema),
  pairControlRecord(2, PairControlCapabilitiesPayloadV1Schema),
  pairControlRecord(3, PairControlEndpointGenerationPayloadV1Schema),
  pairControlRecord(4, PairControlEndpointAckPayloadV1Schema),
  pairControlRecord(5, PairControlPresencePayloadV1Schema),
  pairControlRecord(6, PairControlReconnectPayloadV1Schema),
  pairControlRecord(7, PairControlRevocationPayloadV1Schema),
  pairControlRecord(8, PairControlRevocationAckPayloadV1Schema),
  pairControlRecord(9, PairControlErrorPayloadV1Schema)
]);

export type PairControlRecordV1 = z.infer<typeof PairControlRecordV1Schema>;

export const ResetIdentityCommandSchema = z.object({
  resetTombstone: PositiveUint64DecimalSchema,
  expectedOldFingerprint: Base64Url16BytesSchema
}).strict();

export const GetResetStatusCommandSchema = z.object({
  resetTombstone: PositiveUint64DecimalSchema
}).strict();

const IdentityResetReceiptBaseShape = {
  version: z.literal(1),
  resetTombstone: PositiveUint64DecimalSchema,
  resetId: Base64Url16BytesSchema,
  oldInstallationPublicKey: Base64Url32BytesSchema,
  newInstallationPublicKey: Base64Url32BytesSchema,
  oldFingerprint: Base64Url16BytesSchema,
  newFingerprint: Base64Url16BytesSchema,
  clearedActivationCount: Uint64DecimalSchema,
  clearedPairCount: Uint64DecimalSchema,
  clearedHostRoleSecretCount: Uint64DecimalSchema,
  clearedRemoteRoleSecretCount: Uint64DecimalSchema
};

const IncompleteIdentityResetReceiptV1Schema = z.object({
  ...IdentityResetReceiptBaseShape,
  stage: z.enum(["prepared", "old_state_cleared", "new_identity_committed"])
}).strict();

const CompleteIdentityResetReceiptV1Schema = z.object({
  ...IdentityResetReceiptBaseShape,
  stage: z.literal("complete"),
  completedAt: Uint64DecimalSchema
}).strict();

export const IdentityResetReceiptV1Schema = z
  .union([
    IncompleteIdentityResetReceiptV1Schema,
    CompleteIdentityResetReceiptV1Schema
  ])
  .superRefine((value, ctx) => {
    if (
      value.oldInstallationPublicKey === value.newInstallationPublicKey
      || value.oldFingerprint === value.newFingerprint
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["newFingerprint"],
        message: "Identity reset must commit a distinct new installation identity."
      });
    }
  });

export type IdentityResetReceiptV1 = z.infer<typeof IdentityResetReceiptV1Schema>;
