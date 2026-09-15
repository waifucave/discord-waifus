import { z } from "zod";
import {
  PositiveUint64DecimalSchema,
  ProtocolRangeSchema,
  Sha256HexSchema,
  compareSemVer,
  type HelperManifest
} from "../shared/schemas/remoteAccess.js";
import {
  CapabilityNameListSchema,
  SemVerSchema
} from "../shared/schemas/remoteProtocol.js";

const RemoteComponentProtocolsV1Schema = z.object({
  ipc: ProtocolRangeSchema,
  coordination: ProtocolRangeSchema,
  directService: ProtocolRangeSchema,
  helperManifest: ProtocolRangeSchema,
  dashboardManifest: ProtocolRangeSchema
}).strict();

export const RemoteCompatibilityV1Schema = z.object({
  schemaVersion: z.literal(1),
  discordWaifusVersion: SemVerSchema,
  helper: z.object({
    minimumVersion: SemVerSchema,
    maximumVersionExclusive: SemVerSchema,
    minimumReleaseSequence: PositiveUint64DecimalSchema,
    workerTrustRingSha256: Sha256HexSchema
  }).strict(),
  protocols: RemoteComponentProtocolsV1Schema,
  requiredCapabilities: CapabilityNameListSchema
}).strict().superRefine((value, ctx) => {
  if (compareSemVer(value.helper.minimumVersion, value.helper.maximumVersionExclusive) >= 0) {
    ctx.addIssue({
      code: "custom",
      path: ["helper", "maximumVersionExclusive"],
      message: "Helper compatibility must have a bounded increasing SemVer interval."
    });
  }
  if (
    value.protocols.helperManifest.major !== 1
    || value.protocols.helperManifest.minimumMinor > 0
    || value.protocols.helperManifest.maximumMinor < 0
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["protocols", "helperManifest"],
      message: "The app must support helper manifest protocol 1.0."
    });
  }
});

type ParsedRemoteCompatibilityV1 = z.infer<typeof RemoteCompatibilityV1Schema>;

export type RemoteCompatibilityV1 = Readonly<{
  schemaVersion: 1;
  discordWaifusVersion: string;
  helper: Readonly<ParsedRemoteCompatibilityV1["helper"]>;
  protocols: Readonly<ParsedRemoteCompatibilityV1["protocols"]>;
  requiredCapabilities: readonly string[];
}>;

export class RemoteComponentCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteComponentCompatibilityError";
  }
}

function fail(message: string): never {
  throw new RemoteComponentCompatibilityError(message);
}

export function parseRemoteCompatibilityV1(
  value: unknown,
  expectedAppVersion: string
): RemoteCompatibilityV1 {
  const appVersionResult = SemVerSchema.safeParse(expectedAppVersion);
  const parsedResult = RemoteCompatibilityV1Schema.safeParse(value);
  if (!appVersionResult.success || !parsedResult.success) {
    return fail("Remote compatibility metadata is invalid.");
  }
  const appVersion = appVersionResult.data;
  const parsed = parsedResult.data;
  if (parsed.discordWaifusVersion !== appVersion) {
    return fail("Remote compatibility metadata does not match the running app version.");
  }
  return Object.freeze({
    ...parsed,
    helper: Object.freeze({ ...parsed.helper }),
    protocols: Object.freeze({
      ipc: Object.freeze({ ...parsed.protocols.ipc }),
      coordination: Object.freeze({ ...parsed.protocols.coordination }),
      directService: Object.freeze({ ...parsed.protocols.directService }),
      helperManifest: Object.freeze({ ...parsed.protocols.helperManifest }),
      dashboardManifest: Object.freeze({ ...parsed.protocols.dashboardManifest })
    }),
    requiredCapabilities: Object.freeze([...parsed.requiredCapabilities])
  });
}

function rangesOverlap(
  left: HelperManifest["protocols"]["ipc"],
  right: HelperManifest["protocols"]["ipc"]
): boolean {
  return left.major === right.major
    && left.minimumMinor <= right.maximumMinor
    && right.minimumMinor <= left.maximumMinor;
}

export function assertHelperComponentCompatibility(
  manifest: HelperManifest,
  compatibility: RemoteCompatibilityV1
): void {
  if (
    compareSemVer(manifest.helperVersion, compatibility.helper.minimumVersion) < 0
    || compareSemVer(manifest.helperVersion, compatibility.helper.maximumVersionExclusive) >= 0
  ) {
    return fail("Signed helper version is outside the app compatibility interval.");
  }
  if (BigInt(manifest.releaseSequence) < BigInt(compatibility.helper.minimumReleaseSequence)) {
    return fail("Signed helper release sequence is below the app rollback floor.");
  }
  if (manifest.workerTrustRingSha256 !== compatibility.helper.workerTrustRingSha256) {
    return fail("Signed helper Worker trust ring does not match the app compatibility metadata.");
  }
  for (const name of ["ipc", "coordination", "directService", "helperManifest"] as const) {
    if (!rangesOverlap(manifest.protocols[name], compatibility.protocols[name])) {
      return fail(`Signed helper ${name} protocol is incompatible with this app.`);
    }
  }
  for (const capability of compatibility.requiredCapabilities) {
    if (!manifest.capabilities.includes(capability)) {
      return fail(`Signed helper is missing required capability ${capability}.`);
    }
  }
}
