import type { FastifyInstance, FastifyRequest, HTTPMethods } from "fastify";
import { ApiError, badRequest } from "./errors.js";
import {
  getInternalDispatchContext,
  registerInternalDispatchReceiver
} from "./internalDispatch.js";
import {
  LOCAL_REQUEST_PRINCIPAL,
  isLoopbackAddress,
  type RemoteRequestPrincipal,
  type RequestPrincipal
} from "./requestPrincipal.js";
import type { BrowserSecurity } from "./browserSecurity.js";

export type RemotePolicy = "full_admin" | "local_only" | "never_proxy";
export type RetryClass =
  | "safe"
  | "transactional"
  | "reconciled"
  | "non_replayable"
  | "invitation_recovery";
export type RouteFieldPolicy = "app_config";

export type GatewaySemanticRoutePolicy = {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly pathPattern?: RegExp;
  readonly retryClass: RetryClass;
  readonly auditAction?: string;
};

export type RoutePolicyDefinition = {
  readonly method: HTTPMethods | "*";
  readonly path: string;
  readonly remotePolicy: RemotePolicy;
  readonly retryClass?: RetryClass;
  readonly auditAction?: string;
  readonly fieldPolicy?: RouteFieldPolicy;
  readonly gatewaySemanticRoutes?: readonly GatewaySemanticRoutePolicy[];
  readonly synthetic?: "not_found";
};

type RoutePolicyInstallOptions = {
  manifest: readonly RoutePolicyDefinition[];
  browserSecurity: BrowserSecurity;
  authorizeRemotePrincipal?: (principal: RemoteRequestPrincipal) => boolean | Promise<boolean>;
};

type RoutePolicyRegistration = {
  assertComplete: () => void;
  registerNotFound: () => void;
};

const GATEWAY_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];
const registrations = new WeakMap<FastifyInstance, Set<string>>();

function inventoryKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function expectedInventory(manifest: readonly RoutePolicyDefinition[]): string[] {
  const result: string[] = [];
  for (const definition of manifest) {
    if (definition.synthetic === "not_found") {
      result.push(inventoryKey("*", definition.path));
    } else if (definition.method === "*") {
      result.push(...GATEWAY_METHODS.map((method) => inventoryKey(method, definition.path)));
    } else {
      result.push(inventoryKey(definition.method, definition.path));
      if (definition.method === "GET") result.push(inventoryKey("HEAD", definition.path));
    }
  }
  return result.sort();
}

export function expectedRoutePolicyInventory(
  manifest: readonly RoutePolicyDefinition[]
): string[] {
  return expectedInventory(manifest);
}

function findDefinition(
  manifest: readonly RoutePolicyDefinition[],
  method: string,
  path: string
): RoutePolicyDefinition | undefined {
  return manifest.find((definition) => {
    if (definition.synthetic || definition.path !== path) return false;
    if (definition.method === "*") return true;
    return definition.method === method || (method === "HEAD" && definition.method === "GET");
  });
}

function assertDefinitionComplete(definition: RoutePolicyDefinition): void {
  if (definition.synthetic || definition.method === "GET") return;
  if (definition.method === "*") {
    if (!definition.gatewaySemanticRoutes || definition.gatewaySemanticRoutes.length === 0) {
      throw new Error(`Gateway route ${definition.path} has no semantic policy allowlist.`);
    }
    for (const semantic of definition.gatewaySemanticRoutes) {
      if (semantic.retryClass !== "safe" && !semantic.auditAction) {
        throw new Error(`Gateway semantic route ${semantic.method} ${semantic.path} lacks auditAction.`);
      }
    }
    return;
  }
  if (!definition.retryClass || definition.retryClass === "safe" || !definition.auditAction) {
    throw new Error(`Unsafe route ${definition.method} ${definition.path} lacks retry/audit policy.`);
  }
}

function containsForgedPrincipalHeader(request: FastifyRequest): boolean {
  return Object.keys(request.headers).some((name) => {
    const lower = name.toLowerCase();
    return lower.startsWith("x-device-")
      || lower.startsWith("x-waifus-principal")
      || lower.startsWith("x-waifus-internal")
      || lower.startsWith("x-waifus-actor")
      || lower.startsWith("x-waifus-browser-context")
      || lower.startsWith("x-waifus-helper");
  });
}

function gatewaySemanticPolicy(
  definition: RoutePolicyDefinition,
  method: string,
  url: string
): GatewaySemanticRoutePolicy | undefined {
  const pathname = new URL(url, "http://waifus.invalid").pathname;
  return definition.gatewaySemanticRoutes?.find((semantic) => {
    if (semantic.method !== method) return false;
    return semantic.pathPattern ? semantic.pathPattern.test(pathname) : semantic.path === pathname;
  });
}

export type EffectiveRequestPolicy = {
  readonly retryClass: RetryClass;
  readonly auditAction?: string;
};

export function effectiveRequestPolicy(
  request: FastifyRequest
): EffectiveRequestPolicy | undefined {
  const definition = routePolicyForRequest(request);
  if (!definition) return undefined;
  if (definition.method === "*") {
    const semantic = gatewaySemanticPolicy(definition, request.method, request.url);
    return semantic
      ? {
          retryClass: semantic.retryClass,
          ...(semantic.auditAction ? { auditAction: semantic.auditAction } : {})
        }
      : undefined;
  }
  if (definition.method === "GET") return { retryClass: "safe" };
  if (!definition.retryClass) return undefined;
  return {
    retryClass: definition.retryClass,
    ...(definition.auditAction ? { auditAction: definition.auditAction } : {})
  };
}

async function authorize(
  request: FastifyRequest,
  principal: RequestPrincipal,
  definition: RoutePolicyDefinition
): Promise<void> {
  if (principal.kind === "local") return;
  if (definition.remotePolicy !== "full_admin") {
    throw new ApiError(403, "This route is not available to remote devices.", undefined, "RemoteRouteForbidden");
  }
  if (definition.method === "*" && !gatewaySemanticPolicy(definition, request.method, request.url)) {
    throw new ApiError(403, "Gateway route is not remotely authorized.", undefined, "RemoteGatewayRouteForbidden");
  }
}

export function installRoutePolicy(
  app: FastifyInstance,
  options: RoutePolicyInstallOptions
): RoutePolicyRegistration {
  for (const definition of options.manifest) assertDefinitionComplete(definition);
  const seen = new Set<string>();
  registrations.set(app, seen);
  registerInternalDispatchReceiver(app);

  app.addHook("onRoute", (routeOptions) => {
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method];
    const definitions = methods.map((method) => findDefinition(
      options.manifest,
      String(method).toUpperCase(),
      routeOptions.url
    ));
    const definition = definitions[0];
    if (!definition || definitions.some((candidate) => candidate !== definition)) {
      throw new Error(`Unclassified Fastify route: ${methods.join(",")} ${routeOptions.url}`);
    }
    for (const method of methods) seen.add(inventoryKey(String(method), routeOptions.url));
    routeOptions.config = {
      ...routeOptions.config,
      waifusRoutePolicy: definition
    };
  });

  app.addHook("onRequest", async (request) => {
    if (containsForgedPrincipalHeader(request)) {
      throw badRequest("Client-supplied principal metadata is forbidden.");
    }
    const internal = getInternalDispatchContext();
    let principal: RequestPrincipal;
    if (internal) {
      principal = internal.principal;
      request.assistantDelegation = internal.delegation;
    } else {
      if (!isLoopbackAddress(request.ip)) {
        throw new ApiError(403, "The API accepts only loopback clients.", undefined, "LoopbackRequired");
      }
      principal = LOCAL_REQUEST_PRINCIPAL;
    }
    principal = options.browserSecurity.authenticateRequest(request, principal, internal !== undefined);
    request.principal = principal;

    if (
      principal.kind === "remote_device"
      && (
        !options.authorizeRemotePrincipal
        || !await options.authorizeRemotePrincipal(principal)
      )
    ) {
      throw new ApiError(403, "Remote device is no longer trusted.", undefined, "RemotePrincipalUnauthorized");
    }

    const definition = request.routeOptions.config.waifusRoutePolicy;
    if (definition) {
      await authorize(request, principal, definition);
    }
  });

  return {
    registerNotFound: () => {
      const definition = options.manifest.find((entry) => entry.synthetic === "not_found");
      if (!definition) throw new Error("Route policy manifest has no not-found policy.");
      seen.add(inventoryKey("*", definition.path));
    },
    assertComplete: () => {
      const expected = expectedInventory(options.manifest);
      const actual = [...seen].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const missing = expected.filter((entry) => !seen.has(entry));
        const extra = actual.filter((entry) => !expected.includes(entry));
        throw new Error(
          `Route policy inventory mismatch; missing=${missing.join(",") || "none"}; `
            + `extra=${extra.join(",") || "none"}.`
        );
      }
    }
  };
}

export function getRegisteredRoutePolicyInventory(app: FastifyInstance): string[] {
  const seen = registrations.get(app);
  if (!seen) throw new Error("Route policy was not installed on this Fastify instance.");
  return [...seen].sort();
}

export function routePolicyForRequest(request: FastifyRequest): RoutePolicyDefinition | undefined {
  return request.routeOptions.config.waifusRoutePolicy;
}
