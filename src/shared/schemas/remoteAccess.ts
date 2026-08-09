import { z } from "zod";
import {
  CapabilityNameListSchema,
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
