import {
  loadRemoteCompatibilityV1,
  type RemoteCompatibilityV1
} from "./componentCompatibility.js";
import {
  createTsConnectPackageResolver,
  type ResolveTsConnectBinaryOptions
} from "./helperBinary.js";
import { ProtectedHelperProcessFactory } from "./helperClient.js";
import { HelperSupervisor } from "./helperSupervisor.js";
import {
  HelperSupervisorError,
  type HelperPackageResolver,
  type HelperProcessFactory,
  type HelperRole,
  type ResolveHelperPackageInput
} from "./helperTypes.js";
import type { Logger } from "../backend/logger.js";
import type { HelperReleaseTrustEntryV1 } from "../shared/helperManifestTrust.js";

/** Populated with reviewed production public keys by plan 07 before helper publication. */
export const HELPER_RELEASE_TRUST_ROOTS: readonly HelperReleaseTrustEntryV1[] = Object.freeze([]);

export type ProductionHelperPackageResolverOptions = Omit<
  ResolveTsConnectBinaryOptions,
  "compatibility"
> & Readonly<{
  compatibilityFilePath?: string;
  compatibility?: RemoteCompatibilityV1;
}>;

/**
 * Create the only production helper resolver used by host and remote roles.
 * It always binds package verification to the running app's exact shipped
 * compatibility table; callers cannot silently substitute an open range.
 */
export async function createProductionHelperPackageResolver(
  options: ProductionHelperPackageResolverOptions
): Promise<HelperPackageResolver> {
  const compatibility = options.compatibility ?? await loadRemoteCompatibilityV1(
    options.appVersion,
    options.compatibilityFilePath
  );
  const resolver = createTsConnectPackageResolver({
    compatibility,
    trustRoots: options.trustRoots,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.armVersion === undefined ? {} : { armVersion: options.armVersion }),
    ...(options.resolvePackageJson === undefined
      ? {}
      : { resolvePackageJson: options.resolvePackageJson }),
    ...(options.probeBinary === undefined ? {} : { probeBinary: options.probeBinary })
  });
  return Object.freeze({
    resolve: async (input: ResolveHelperPackageInput) => {
      if (input.appVersion !== options.appVersion) {
        throw new HelperSupervisorError(
          "helper_incompatible",
          "The helper resolver does not match the running app version."
        );
      }
      return resolver.resolve(input);
    }
  });
}

export type CreateProductionHelperSupervisorOptions = Readonly<{
  role: HelperRole;
  dataRoot: string;
  appVersion: string;
  buildId: string;
  logger: Logger;
  packageResolver?: HelperPackageResolver;
  processFactory?: HelperProcessFactory;
  trustRoots?: readonly HelperReleaseTrustEntryV1[];
  compatibilityFilePath?: string;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  armVersion?: number;
}>;

/** Construct the normal-profile supervisor shared by the host and remote gateway. */
export async function createProductionHelperSupervisor(
  options: CreateProductionHelperSupervisorOptions
): Promise<HelperSupervisor> {
  const packageResolver = options.packageResolver ?? await createProductionHelperPackageResolver({
    appVersion: options.appVersion,
    trustRoots: options.trustRoots ?? HELPER_RELEASE_TRUST_ROOTS,
    ...(options.compatibilityFilePath === undefined
      ? {}
      : { compatibilityFilePath: options.compatibilityFilePath }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.arch === undefined ? {} : { arch: options.arch }),
    ...(options.armVersion === undefined ? {} : { armVersion: options.armVersion })
  });
  return new HelperSupervisor({
    role: options.role,
    dataRoot: options.dataRoot,
    appVersion: options.appVersion,
    buildId: options.buildId,
    controlProfile: 1,
    runtimePurpose: "normal",
    packageResolver,
    processFactory: options.processFactory ?? new ProtectedHelperProcessFactory(),
    logger: options.logger
  });
}
