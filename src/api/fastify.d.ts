import type {
  AssistantDelegation,
  RequestPrincipal
} from "./requestPrincipal.js";
import type { RoutePolicyDefinition } from "./routePolicy.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: RequestPrincipal;
    assistantDelegation?: AssistantDelegation;
  }

  interface FastifyContextConfig {
    waifusRoutePolicy?: RoutePolicyDefinition;
  }
}
