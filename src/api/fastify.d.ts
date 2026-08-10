import type {
  AssistantDelegation,
  RequestPrincipal
} from "./requestPrincipal.js";
import type { RoutePolicyDefinition } from "./routePolicy.js";
import type { MutationRequestContext } from "./mutations.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: RequestPrincipal;
    assistantDelegation?: AssistantDelegation;
    mutationContext?: MutationRequestContext;
    rawMutationBodyHash?: string;
  }

  interface FastifyContextConfig {
    waifusRoutePolicy?: RoutePolicyDefinition;
  }
}
