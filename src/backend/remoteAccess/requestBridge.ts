import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { dispatchInternalStreaming } from "../../api/internalDispatch.js";
import type { WipcParentAuthSession } from "../../shared/wipcAuthSession.js";
import {
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE,
  RemoteBridgeProtocolError,
  parseRemoteBridgeRequestStart,
  sanitizeRemoteResponseHeaders,
  type RemoteBridgeRequestStart,
  type RemoteHeaderTuple
} from "./bridgeProtocol.js";

export {
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION,
  REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE
} from "./bridgeProtocol.js";

export type RemoteBridgeDispatch = {
  readonly streamId: bigint;
  readonly requestStart: unknown;
  readonly body?: Readable;
  readonly signal?: AbortSignal;
};

export type RemoteBridgeResponse = {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly headers: readonly RemoteHeaderTuple[];
  readonly body: Readable;
  cancel: (reason?: unknown) => void;
};

export type RemoteBridgeConnection = {
  dispatch: (input: RemoteBridgeDispatch) => Promise<RemoteBridgeResponse>;
  close: (reason?: unknown) => void;
};

type ActiveDispatch = {
  readonly streamId: bigint;
  readonly deviceId: string;
  readonly controller: AbortController;
  readonly body?: Readable;
  finish: () => void;
};

function abortError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === "string" ? reason : fallback);
  error.name = "AbortError";
  return error;
}

function assertConnectionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new RemoteBridgeProtocolError(
      "connection_id_invalid",
      "Authenticated helper connection ID is invalid."
    );
  }
}

function assertHelperStreamId(streamId: bigint, highest: bigint): void {
  if (typeof streamId !== "bigint" || streamId <= 0n || (streamId & 1n) !== 0n) {
    throw new RemoteBridgeProtocolError(
      "invalid_stream_id",
      "Host-side helper requests require a positive even WIPC stream ID."
    );
  }
  if (streamId <= highest) {
    throw new RemoteBridgeProtocolError(
      "stream_id_reused",
      "WIPC stream IDs must increase and cannot be reused."
    );
  }
}

class AuthenticatedRemoteBridgeConnection implements RemoteBridgeConnection {
  readonly #bridge: RemoteRequestBridge;
  readonly #connectionId: string;
  readonly #active = new Map<bigint, ActiveDispatch>();
  #highestStreamId = 0n;
  #closed = false;

  constructor(bridge: RemoteRequestBridge, connectionId: string) {
    this.#bridge = bridge;
    this.#connectionId = connectionId;
  }

  async dispatch(input: RemoteBridgeDispatch): Promise<RemoteBridgeResponse> {
    if (this.#closed) {
      throw new RemoteBridgeProtocolError("connection_closed", "Helper connection is closed.");
    }
    try {
      assertHelperStreamId(input.streamId, this.#highestStreamId);
    } catch (error) {
      // Stream parity/reuse is connection-fatal in WIPC V1. Closing here also cancels every
      // request already owned by the compromised or desynchronized helper connection.
      this.close(error);
      throw error;
    }
    this.#highestStreamId = input.streamId;
    if (this.#active.size >= REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_CONNECTION) {
      throw new RemoteBridgeProtocolError(
        "connection_stream_limit",
        "Authenticated helper connection has reached the 128-stream WIPC limit."
      );
    }
    const parsed = parseRemoteBridgeRequestStart(input.requestStart);
    const deviceId = parsed.start.principal.deviceId;
    if (this.#bridge.activeStreamCount(deviceId) >= REMOTE_BRIDGE_MAX_ACTIVE_STREAMS_PER_DEVICE) {
      throw new RemoteBridgeProtocolError(
        "device_stream_limit",
        "Remote device has reached the 32-stream application limit."
      );
    }
    if (input.signal?.aborted) {
      throw abortError(input.signal.reason, "Remote request was cancelled before dispatch.");
    }

    const controller = new AbortController();
    let finished = false;
    const onExternalAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });
    const active: ActiveDispatch = {
      streamId: input.streamId,
      deviceId,
      controller,
      ...(input.body ? { body: input.body } : {}),
      finish: () => {
        if (finished) return;
        finished = true;
        input.signal?.removeEventListener("abort", onExternalAbort);
        this.#active.delete(input.streamId);
        this.#bridge.release(deviceId);
      }
    };
    this.#active.set(input.streamId, active);
    this.#bridge.retain(deviceId);

    const onAbort = () => {
      if (input.body && !input.body.destroyed) {
        input.body.destroy(abortError(controller.signal.reason, "Remote upload was cancelled."));
      }
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await dispatchInternalStreaming(
        this.#bridge.app,
        parsed.start.principal,
        undefined,
        {
          method: parsed.start.method,
          url: parsed.start.canonicalTarget,
          headers: parsed.injectHeaders,
          ...(input.body ? { payload: input.body } : {}),
          signal: controller.signal
        }
      );
      if (controller.signal.aborted) {
        response.stream().destroy(abortError(
          controller.signal.reason,
          "Remote request was cancelled before response headers completed."
        ));
        throw abortError(
          controller.signal.reason,
          "Remote request was cancelled before response headers completed."
        );
      }
      const body = response.stream();
      // Cancellation destroys the light-my-request stream. Install an observer immediately so a
      // helper disconnect cannot turn an expected abort into an unhandled process error.
      body.on("error", () => {});
      const finish = () => {
        controller.signal.removeEventListener("abort", onAbort);
        active.finish();
      };
      body.once("end", finish);
      body.once("error", finish);
      body.once("close", () => {
        if (!body.readableEnded && !controller.signal.aborted) {
          controller.abort(new Error("Remote response consumer disconnected."));
        }
        finish();
      });
      const headers = sanitizeRemoteResponseHeaders(response.headers);
      return Object.freeze({
        statusCode: response.statusCode,
        statusMessage: response.statusMessage,
        headers,
        body,
        cancel: (reason?: unknown) => controller.abort(reason)
      });
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      controller.signal.removeEventListener("abort", onAbort);
      active.finish();
      throw error;
    }
  }

  close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#active.values()) {
      active.controller.abort(abortError(reason, "Authenticated helper disconnected."));
    }
    this.#bridge.connectionClosed(this.#connectionId, this);
  }
}

export class RemoteRequestBridge {
  readonly app: FastifyInstance;
  readonly #connections = new Map<string, AuthenticatedRemoteBridgeConnection>();
  readonly #activeByDevice = new Map<string, number>();
  #closed = false;

  constructor(app: FastifyInstance) {
    this.app = app;
    app.addHook("onClose", async () => this.close(new Error("Fastify server closed.")));
  }

  openAuthenticatedConnection(
    connectionId: string,
    authentication: WipcParentAuthSession
  ): RemoteBridgeConnection {
    if (this.#closed) {
      throw new RemoteBridgeProtocolError("bridge_closed", "Remote request bridge is closed.");
    }
    assertConnectionId(connectionId);
    authentication.assertTrafficAllowed();
    if (this.#connections.has(connectionId)) {
      throw new RemoteBridgeProtocolError(
        "connection_id_reused",
        "Authenticated helper connection ID is already active."
      );
    }
    const connection = new AuthenticatedRemoteBridgeConnection(this, connectionId);
    this.#connections.set(connectionId, connection);
    return connection;
  }

  activeStreamCount(deviceId: string): number {
    return this.#activeByDevice.get(deviceId) ?? 0;
  }

  retain(deviceId: string): void {
    this.#activeByDevice.set(deviceId, this.activeStreamCount(deviceId) + 1);
  }

  release(deviceId: string): void {
    const next = this.activeStreamCount(deviceId) - 1;
    if (next > 0) this.#activeByDevice.set(deviceId, next);
    else this.#activeByDevice.delete(deviceId);
  }

  connectionClosed(connectionId: string, connection: AuthenticatedRemoteBridgeConnection): void {
    if (this.#connections.get(connectionId) === connection) this.#connections.delete(connectionId);
  }

  close(reason?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const connection of [...this.#connections.values()]) connection.close(reason);
  }
}

export type { RemoteBridgeRequestStart };
