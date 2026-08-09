import { z } from "zod";

export const REMOTE_PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const UINT64_MAX = 18_446_744_073_709_551_615n;
export const MAX_CAPABILITIES_PER_SET = 128;
export const MAX_CANONICAL_TARGET_BYTES = 2_048;

function decimalRangePattern(maximum: bigint): RegExp {
  const maximumText = maximum.toString(10);
  const alternatives = ["0"];
  if (maximumText.length > 1) {
    alternatives.push(`[1-9][0-9]{0,${maximumText.length - 2}}`);
  }
  for (let index = 0; index < maximumText.length; index += 1) {
    const maximumDigit = Number.parseInt(maximumText[index], 10);
    const minimumDigit = index === 0 ? 1 : 0;
    if (maximumDigit <= minimumDigit) {
      continue;
    }
    const prefix = maximumText.slice(0, index);
    const upperDigit = maximumDigit - 1;
    const digitRange = minimumDigit === upperDigit
      ? `${minimumDigit}`
      : `[${minimumDigit}-${upperDigit}]`;
    const remainingDigits = maximumText.length - index - 1;
    alternatives.push(
      `${prefix}${digitRange}${remainingDigits === 0 ? "" : `[0-9]{${remainingDigits}}`}`
    );
  }
  alternatives.push(maximumText);
  return new RegExp(`^(?:${alternatives.join("|")})$`);
}

const UINT64_DECIMAL_PATTERN = decimalRangePattern(UINT64_MAX);
const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v(?:0|[1-9][0-9]*)$/;
const SEMVER_PATTERN = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const VISIBLE_ASCII_PATTERN = /^[\x21-\x7e]+$/;
const TARGET_RAW_CHARACTER_PATTERN = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?]$/;
const UNRESERVED_BYTE_PATTERN = /^[A-Za-z0-9\-._~]$/;

export const SemVerSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(SEMVER_PATTERN, "Expected SemVer.");

export type SemVer = z.infer<typeof SemVerSchema>;

export const Uint64DecimalSchema = z
  .string()
  .max(20)
  .regex(UINT64_DECIMAL_PATTERN, "Expected a canonical unsigned decimal string.")
  .brand<"Uint64Decimal">();

export type Uint64Decimal = z.infer<typeof Uint64DecimalSchema>;

export function parseUint64Decimal(value: Uint64Decimal): bigint {
  return BigInt(value);
}

export function formatUint64Decimal(value: bigint): Uint64Decimal {
  if (value < 0n || value > UINT64_MAX) {
    throw new RangeError("Value is outside the uint64 range.");
  }
  return Uint64DecimalSchema.parse(value.toString(10));
}

function fixedWidthBase64UrlSchema(bytes: number) {
  const encodedLength = Math.ceil((bytes * 8) / 6);
  const remainder = bytes % 3;
  const finalCharacterPattern = remainder === 1
    ? "[AQgw]"
    : remainder === 2
      ? "[AEIMQUYcgkosw048]"
      : "[A-Za-z0-9_-]";
  const pattern = new RegExp(
    `^[A-Za-z0-9_-]{${encodedLength - 1}}${finalCharacterPattern}$`
  );
  return z
    .string()
    .length(encodedLength)
    .regex(pattern, "Expected canonical unpadded base64url.")
    .refine((value) => {
      const decoded = Buffer.from(value, "base64url");
      return decoded.byteLength === bytes && decoded.toString("base64url") === value;
    }, `Expected canonical unpadded base64url encoding of exactly ${bytes} bytes.`);
}

export const Base64Url16BytesSchema = fixedWidthBase64UrlSchema(16).brand<"Base64Url16Bytes">();
export const Base64Url32BytesSchema = fixedWidthBase64UrlSchema(32).brand<"Base64Url32Bytes">();

export type Base64Url16Bytes = z.infer<typeof Base64Url16BytesSchema>;
export type Base64Url32Bytes = z.infer<typeof Base64Url32BytesSchema>;

export const ProtocolVersionSchema = z
  .object({
    major: z.number().int().min(0).max(65_535),
    minor: z.number().int().min(0).max(65_535)
  })
  .strict();

export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;

export const CapabilityNameSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(CAPABILITY_NAME_PATTERN, "Expected a namespaced versioned capability name.");

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || compareAscii(values[index - 1], value) < 0);
}

export const CapabilityNameListSchema = z
  .array(CapabilityNameSchema)
  .max(MAX_CAPABILITIES_PER_SET)
  .refine(isSortedUnique, "Capabilities must be ASCII-sorted and unique.");

export const CapabilitySetSchema = z
  .object({
    required: CapabilityNameListSchema,
    optional: CapabilityNameListSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    const required = new Set(value.required);
    for (const capability of value.optional) {
      if (required.has(capability)) {
        ctx.addIssue({
          code: "custom",
          path: ["optional"],
          message: `Capability ${capability} cannot be both required and optional.`
        });
      }
    }
  });

export type CapabilitySet = z.infer<typeof CapabilitySetSchema>;

export const INITIAL_REQUIRED_CAPABILITIES = Object.freeze([
  "waifus.browser-context.v1",
  "waifus.dashboard.manifest.v1",
  "waifus.http.v1",
  "waifus.principal.v1",
  "waifus.sse.cursor.v1",
  "waifus.stream.cancel.v1"
] as const);

export const ProtocolCapabilitiesDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    protocol: ProtocolVersionSchema,
    capabilities: CapabilitySetSchema
  })
  .strict();

export type ProtocolCapabilitiesDocument = z.infer<typeof ProtocolCapabilitiesDocumentSchema>;

export const ControlProfileV1Schema = z.union([z.literal(1), z.literal(2)]);
export const RuntimePurposeSchema = z.enum(["normal", "development", "release_validation"]);
export const ComponentNameSchema = z.enum(["discord_waifus", "ts_connect"]);

export type ControlProfileV1 = z.infer<typeof ControlProfileV1Schema>;
export type RuntimePurpose = z.infer<typeof RuntimePurposeSchema>;
export type ComponentName = z.infer<typeof ComponentNameSchema>;

export const ComponentHelloSchema = z
  .object({
    protocol: ProtocolVersionSchema,
    component: ComponentNameSchema,
    componentVersion: SemVerSchema,
    buildId: z.string().min(1).max(128).regex(VISIBLE_ASCII_PATTERN, "Expected visible ASCII."),
    nonce: Base64Url32BytesSchema,
    capabilities: CapabilitySetSchema,
    controlProfile: ControlProfileV1Schema,
    runtimePurpose: RuntimePurposeSchema
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.controlProfile === 2 && value.runtimePurpose === "normal") {
      ctx.addIssue({
        code: "custom",
        path: ["controlProfile"],
        message: "The staging control profile is forbidden in normal runtime."
      });
    }
  });

export type ComponentHello = z.infer<typeof ComponentHelloSchema>;

const CompatibilityFailureCodeSchema = z.enum([
  "protocol_major_mismatch",
  "protocol_minor_downgrade",
  "missing_required_capability",
  "control_profile_mismatch",
  "runtime_purpose_mismatch"
]);

export const CompatibilityResultSchema = z.discriminatedUnion("compatible", [
  z
    .object({
      compatible: z.literal(true),
      protocol: ProtocolVersionSchema,
      capabilities: CapabilityNameListSchema
    })
    .strict(),
  z
    .object({
      compatible: z.literal(false),
      code: CompatibilityFailureCodeSchema,
      message: z.string().min(1).max(256),
      missingCapabilities: CapabilityNameListSchema.optional()
    })
    .strict()
]);

export type CompatibilityResult = z.infer<typeof CompatibilityResultSchema>;

export interface CompatibilityOptions {
  minimumMinor?: number;
}

function allCapabilities(value: CapabilitySet): string[] {
  return [...value.required, ...value.optional].sort(compareAscii);
}

function missingCapabilities(required: readonly string[], available: readonly string[]): string[] {
  const availableSet = new Set(available);
  return required.filter((capability) => !availableSet.has(capability));
}

export function negotiateComponentCompatibility(
  local: ComponentHello,
  peer: ComponentHello,
  options: CompatibilityOptions = {}
): CompatibilityResult {
  if (local.protocol.major !== peer.protocol.major) {
    return {
      compatible: false,
      code: "protocol_major_mismatch",
      message: "Protocol major versions do not match."
    };
  }

  if (local.controlProfile !== peer.controlProfile) {
    return {
      compatible: false,
      code: "control_profile_mismatch",
      message: "Control profiles do not match."
    };
  }

  if (local.runtimePurpose !== peer.runtimePurpose) {
    return {
      compatible: false,
      code: "runtime_purpose_mismatch",
      message: "Runtime purposes do not match."
    };
  }

  const negotiatedMinor = Math.min(local.protocol.minor, peer.protocol.minor);
  const minimumMinor = options.minimumMinor ?? 0;
  if (!Number.isInteger(minimumMinor) || minimumMinor < 0 || minimumMinor > 65_535) {
    throw new RangeError("minimumMinor must be a uint16 integer.");
  }
  if (negotiatedMinor < minimumMinor) {
    return {
      compatible: false,
      code: "protocol_minor_downgrade",
      message: "Negotiated protocol minor is below the required floor."
    };
  }

  const localCapabilities = allCapabilities(local.capabilities);
  const peerCapabilities = allCapabilities(peer.capabilities);
  const unavailableLocally = missingCapabilities(peer.capabilities.required, localCapabilities);
  if (unavailableLocally.length > 0) {
    return {
      compatible: false,
      code: "missing_required_capability",
      message: "Local component does not provide peer-required capabilities.",
      missingCapabilities: unavailableLocally
    };
  }

  const unavailableOnPeer = missingCapabilities(local.capabilities.required, peerCapabilities);
  if (unavailableOnPeer.length > 0) {
    return {
      compatible: false,
      code: "missing_required_capability",
      message: "Peer component does not provide local-required capabilities.",
      missingCapabilities: unavailableOnPeer
    };
  }

  const peerCapabilitySet = new Set(peerCapabilities);
  const negotiatedCapabilities = localCapabilities.filter((capability) => peerCapabilitySet.has(capability));
  return CompatibilityResultSchema.parse({
    compatible: true,
    protocol: {
      major: local.protocol.major,
      minor: negotiatedMinor
    },
    capabilities: negotiatedCapabilities
  });
}

export function isCanonicalOriginFormTarget(value: string): boolean {
  if (
    value.length < 1
    || value.length > MAX_CANONICAL_TARGET_BYTES
    || !value.startsWith("/")
    || value.startsWith("//")
    || value.includes("#")
    || value.includes("\\")
    || !VISIBLE_ASCII_PATTERN.test(value)
  ) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "%") {
      const encoded = value.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(encoded)) {
        return false;
      }
      const decoded = String.fromCharCode(Number.parseInt(encoded, 16));
      if (decoded === "/" || decoded === "\\" || UNRESERVED_BYTE_PATTERN.test(decoded)) {
        return false;
      }
      index += 2;
      continue;
    }
    if (!TARGET_RAW_CHARACTER_PATTERN.test(character)) {
      return false;
    }
  }

  const queryStart = value.indexOf("?");
  const pathname = queryStart === -1 ? value : value.slice(0, queryStart);
  return !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

export const HttpMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
export const CanonicalTargetSchema = z
  .string()
  .min(1)
  .max(MAX_CANONICAL_TARGET_BYTES)
  .refine(isCanonicalOriginFormTarget, "Expected a canonical origin-form request target.");

export const RemoteBrowserContextV1Schema = z
  .object({
    version: z.literal(1),
    gatewayLaunchId: Base64Url32BytesSchema,
    browserSessionId: Base64Url32BytesSchema,
    requestNonce: Base64Url16BytesSchema,
    method: HttpMethodSchema,
    canonicalTarget: CanonicalTargetSchema,
    csrfValidated: z.literal(true)
  })
  .strict();

export type RemoteBrowserContextV1 = z.infer<typeof RemoteBrowserContextV1Schema>;
