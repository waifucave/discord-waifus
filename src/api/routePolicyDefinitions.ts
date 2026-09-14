import type { HTTPMethods } from "fastify";

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
  readonly persistResponse?: boolean;
  readonly gatewaySemanticRoutes?: readonly GatewaySemanticRoutePolicy[];
  readonly synthetic?: "not_found";
};

const GATEWAY_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE"];

function inventoryKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

export function expectedRoutePolicyInventory(
  manifest: readonly RoutePolicyDefinition[]
): string[] {
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
