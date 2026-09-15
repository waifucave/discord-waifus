import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  InjectOptions
} from "fastify";
import {
  parseAssistantDelegation,
  parseRequestPrincipal,
  type AssistantDelegation,
  type RequestPrincipal
} from "./requestPrincipal.js";

export type InternalDispatchContext = {
  readonly principal: RequestPrincipal;
  readonly delegation?: AssistantDelegation;
  readonly signal?: AbortSignal;
  readonly responseDrain?: InternalResponseDrain;
};

type InternalResponseDrain = {
  register: (callback: () => void) => void;
  settle: () => void;
};

export type InternalStreamingInjectOptions = Omit<InjectOptions, "payloadAsStream" | "signal"> & {
  readonly signal?: AbortSignal;
};

export type InternalDispatchResponse = {
  readonly raw: {
    readonly res: ServerResponse;
    readonly req: IncomingMessage;
  };
  readonly rawPayload: Buffer;
  readonly headers: OutgoingHttpHeaders;
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly trailers: Readonly<Record<string, string>>;
  readonly payload: string;
  readonly body: string;
  json: <T = unknown>() => T;
  stream: () => Readable;
  readonly cookies: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly expires?: Date;
    readonly maxAge?: number;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly sameSite?: string;
  }>;
};

export type InternalStreamingResponse = Pick<
  InternalDispatchResponse,
  "raw" | "headers" | "statusCode" | "statusMessage" | "trailers" | "stream"
>;

const internalDispatchStorage = new AsyncLocalStorage<InternalDispatchContext>();
const authenticatedDispatchReceivers = new WeakSet<FastifyInstance>();

export function registerInternalDispatchReceiver(app: FastifyInstance): void {
  authenticatedDispatchReceivers.add(app);
}

export function getInternalDispatchContext(): InternalDispatchContext | undefined {
  return internalDispatchStorage.getStore();
}

export function afterInternalResponseDrained(callback: () => void): boolean {
  const responseDrain = internalDispatchStorage.getStore()?.responseDrain;
  if (!responseDrain) return false;
  responseDrain.register(callback);
  return true;
}

function prepareInternalDispatch(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation: AssistantDelegation | undefined,
  signal?: AbortSignal,
  responseDrain?: InternalResponseDrain
): InternalDispatchContext {
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
  const effectiveResponseDrain = responseDrain
    ?? internalDispatchStorage.getStore()?.responseDrain;
  return Object.freeze({
    principal: parsedPrincipal,
    ...(parsedDelegation ? { delegation: parsedDelegation } : {}),
    ...(signal ? { signal } : {}),
    ...(effectiveResponseDrain ? { responseDrain: effectiveResponseDrain } : {})
  });
}

function createInternalResponseDrain(): InternalResponseDrain {
  const callbacks: Array<() => void> = [];
  let settled = false;
  return {
    register(callback) {
      if (settled) {
        queueMicrotask(callback);
        return;
      }
      callbacks.push(callback);
    },
    settle() {
      if (settled) return;
      settled = true;
      for (const callback of callbacks.splice(0)) callback();
    }
  };
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Internal request was aborted.");
  error.name = "AbortError";
  return error;
}

export function bindInternalDispatchAbort(
  request: FastifyRequest,
  reply: FastifyReply,
  signal: AbortSignal
): void {
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    signal.removeEventListener("abort", onAbort);
    reply.raw.removeListener("finish", cleanup);
    reply.raw.removeListener("close", cleanup);
  };
  const onAbort = (): void => {
    if (request.raw.aborted || reply.raw.writableEnded) {
      cleanup();
      return;
    }
    request.raw.aborted = true;
    request.raw.emit("aborted");
    request.raw.emit("close");
    if (!reply.raw.destroyed) reply.raw.destroy(abortReason(signal));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  reply.raw.once("finish", cleanup);
  reply.raw.once("close", cleanup);
  if (signal.aborted) onAbort();
}

export async function dispatchInternal(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation: AssistantDelegation | undefined,
  options: InjectOptions
): Promise<InternalDispatchResponse> {
  const context = prepareInternalDispatch(app, principal, delegation);
  // Fastify's inject result is a lazy thenable. Await it inside the ALS callback so request
  // creation happens while the authenticated context is active rather than after run() returns.
  return internalDispatchStorage.run(context, async () => await app.inject(options));
}

export async function dispatchInternalStreaming(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation: AssistantDelegation | undefined,
  options: InternalStreamingInjectOptions
): Promise<InternalStreamingResponse> {
  const responseDrain = createInternalResponseDrain();
  const context = prepareInternalDispatch(
    app,
    principal,
    delegation,
    options.signal,
    responseDrain
  );
  // light-my-request resolves this promise when response headers are written. Its stream mode
  // forwards every later chunk through a backpressured Readable instead of accumulating body.
  // Await inside the ALS scope so both the initial request and async handler resources inherit the
  // authenticated principal without placing it in a forgeable HTTP header.
  const response = await internalDispatchStorage.run(
    context,
    async () => await app.inject({ ...options, payloadAsStream: true })
  );
  const body = response.stream();
  const settle = () => responseDrain.settle();
  body.once("end", settle);
  body.once("error", settle);
  body.once("close", settle);
  if (body.readableEnded || body.destroyed) settle();
  return {
    raw: response.raw,
    headers: response.headers,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    trailers: response.trailers,
    stream: () => body
  };
}
