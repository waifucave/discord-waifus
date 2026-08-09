import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, InjectOptions } from "fastify";
import {
  parseAssistantDelegation,
  parseRequestPrincipal,
  type AssistantDelegation,
  type RequestPrincipal
} from "./requestPrincipal.js";

export type InternalDispatchContext = {
  readonly principal: RequestPrincipal;
  readonly delegation?: AssistantDelegation;
};

const internalDispatchStorage = new AsyncLocalStorage<InternalDispatchContext>();
const authenticatedDispatchReceivers = new WeakSet<FastifyInstance>();

export function registerInternalDispatchReceiver(app: FastifyInstance): void {
  authenticatedDispatchReceivers.add(app);
}

export function getInternalDispatchContext(): InternalDispatchContext | undefined {
  return internalDispatchStorage.getStore();
}

export async function dispatchInternal(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation: AssistantDelegation | undefined,
  options: InjectOptions
) {
  if (principal === undefined || principal === null) {
    throw new TypeError("Internal dispatch requires an explicit request principal.");
  }
  if (!authenticatedDispatchReceivers.has(app)) {
    throw new TypeError("Internal dispatch target has no authenticated principal receiver.");
  }
  const parsedPrincipal = parseRequestPrincipal(principal);
  const parsedDelegation = delegation === undefined
    ? undefined
    : parseAssistantDelegation(delegation);
  const context = Object.freeze({
    principal: parsedPrincipal,
    ...(parsedDelegation ? { delegation: parsedDelegation } : {})
  });
  // Fastify's inject result is a lazy thenable. Await it inside the ALS callback so request
  // creation happens while the authenticated context is active rather than after run() returns.
  return internalDispatchStorage.run(context, async () => await app.inject(options));
}
