import { ROUTE_POLICY_MANIFEST } from "../../api/routePolicyManifest";
import type { RetryClass, RoutePolicyDefinition } from "../../api/routePolicyDefinitions";

export type { RetryClass } from "../../api/routePolicyDefinitions";

function targetPath(target: string): string {
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new TypeError("Mutation target must be a same-origin path.");
  }
  const parsed = new URL(target, "http://waifus.invalid");
  if (parsed.origin !== "http://waifus.invalid" || parsed.hash !== "") {
    throw new TypeError("Mutation target must be a same-origin path without a fragment.");
  }
  return parsed.pathname;
}

function templatePattern(template: string): RegExp {
  const pattern = template
    .split("/")
    .map((segment) => {
      if (segment === "*") return ".+";
      if (segment.startsWith(":")) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("/");
  return new RegExp(`^${pattern}$`, "u");
}

function matchesDefinition(
  definition: RoutePolicyDefinition,
  method: string,
  pathname: string
): RetryClass | undefined {
  if (definition.synthetic) return undefined;
  if (definition.method === "*") {
    return definition.gatewaySemanticRoutes?.find((semantic) => {
      if (semantic.method !== method) return false;
      return semantic.pathPattern
        ? semantic.pathPattern.test(pathname)
        : templatePattern(semantic.path).test(pathname);
    })?.retryClass;
  }
  if (definition.method !== method || !templatePattern(definition.path).test(pathname)) {
    return undefined;
  }
  return definition.retryClass;
}

export function classifyMutationRetry(methodValue: string, target: string): RetryClass {
  const method = methodValue.toUpperCase();
  const pathname = targetPath(target);
  for (const definition of ROUTE_POLICY_MANIFEST) {
    const retryClass = matchesDefinition(definition, method, pathname);
    if (retryClass) return retryClass;
  }
  throw new TypeError(`Mutation ${method} ${pathname} has no reviewed retry policy.`);
}
