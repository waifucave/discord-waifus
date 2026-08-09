import {
  WIPC_DATA_PAYLOAD_MAX_BYTES,
  WIPC_FRAME_TYPES,
  WIPC_INITIAL_STREAM_CREDIT_BYTES,
  WIPC_MAX_CONCURRENT_STREAMS,
  WipcProtocolError,
  WipcStreamHighWater,
  encodeWipcWindowUpdate,
  type WipcFrameType,
  type WipcStreamCreator,
  type WipcWindowDirection,
  type WipcWindowUpdate
} from "./wipc.js";

export type WipcRequestState = "open" | "ended" | "cancelled" | "response_closed" | "failed";
export type WipcResponseState = "none" | "open" | "succeeded" | "failed";

export type WipcStreamFailureCode =
  | "unexpected_frame_sender"
  | "invalid_stream_frame"
  | "request_chunk_after_terminal"
  | "duplicate_request_end"
  | "duplicate_response_start"
  | "response_chunk_before_start"
  | "response_chunk_after_terminal"
  | "response_terminal_before_start"
  | "duplicate_response_terminal";

export interface WipcReceivedStreamFrame {
  sender: WipcStreamCreator;
  frameType: WipcFrameType;
  streamId: bigint;
  payloadLength?: number;
  windowUpdate?: WipcWindowUpdate;
}

export interface WipcStreamSnapshot {
  initiator: WipcStreamCreator;
  requestState: WipcRequestState;
  responseState: WipcResponseState;
  cancelled: boolean;
  protocolFailed: boolean;
  requestCredit: number;
  responseCredit: number;
}

export type WipcStreamOutcome =
  | "request_started"
  | "stream_limit"
  | "request_chunk_delivered"
  | "request_chunk_discarded"
  | "request_ended"
  | "request_cancelled"
  | "cancel_ignored"
  | "response_started"
  | "response_chunk_delivered"
  | "response_ended"
  | "response_failed"
  | "window_updated"
  | "window_ignored"
  | "stream_failed"
  | "inactive_frame_ignored";

export interface WipcStreamTransition {
  outcome: WipcStreamOutcome;
  streamId: bigint;
  dispatch?: boolean;
  byteLength?: number;
  direction?: WipcWindowDirection;
  abortRequest?: boolean;
  closeRequestInput?: boolean;
  responseErrorCode?: "stream_limit";
  errorCode?: WipcStreamFailureCode;
  responseErrorPermitted?: boolean;
}

interface MutableStreamState extends WipcStreamSnapshot {
  responder: WipcStreamCreator;
}

function connectionError(
  code: "frame_before_authentication" | "invalid_stream_frame" | "unknown_stream" | "failed_stream_frame" | "flow_control_error",
  message: string
): never {
  throw new WipcProtocolError(code, message);
}

function oppositeSide(side: WipcStreamCreator): WipcStreamCreator {
  return side === "node" ? "helper" : "node";
}

function creatorForStreamId(streamId: bigint): WipcStreamCreator {
  if (streamId <= 0n) {
    connectionError("invalid_stream_frame", "Stream state requires a nonzero stream ID.");
  }
  return (streamId & 1n) === 1n ? "node" : "helper";
}

function isResponseTerminal(state: MutableStreamState): boolean {
  return state.responseState === "succeeded" || state.responseState === "failed";
}

function isRequestTerminal(state: MutableStreamState): boolean {
  return state.requestState !== "open";
}

function requireChunkLength(frame: WipcReceivedStreamFrame): number {
  const byteLength = frame.payloadLength;
  if (
    !Number.isInteger(byteLength)
    || byteLength === undefined
    || byteLength < 1
    || byteLength > WIPC_DATA_PAYLOAD_MAX_BYTES
  ) {
    connectionError(
      "invalid_stream_frame",
      "A WIPC chunk transition requires a decoded 1 to 65,536 byte payload length."
    );
  }
  return byteLength;
}

function validateWindowUpdate(update: WipcWindowUpdate | undefined): WipcWindowUpdate {
  if (!update) {
    connectionError("flow_control_error", "WINDOW_UPDATE transition is missing its decoded payload.");
  }
  try {
    encodeWipcWindowUpdate(update);
  } catch (error) {
    if (error instanceof WipcProtocolError) {
      connectionError("flow_control_error", error.message);
    }
    throw error;
  }
  return update;
}

export class WipcConnectionState {
  #authenticated = false;
  readonly #highWater = new WipcStreamHighWater();
  readonly #streams = new Map<bigint, MutableStreamState>();

  get activeStreamCount(): number {
    return this.#streams.size;
  }

  markAuthenticated(): void {
    this.#authenticated = true;
  }

  highWaterSnapshot(): Readonly<{
    highestNodeStreamId: bigint;
    highestHelperStreamId: bigint;
  }> {
    return this.#highWater.snapshot();
  }

  snapshot(streamId: bigint): WipcStreamSnapshot | undefined {
    const state = this.#streams.get(streamId);
    if (!state) {
      return undefined;
    }
    return {
      initiator: state.initiator,
      requestState: state.requestState,
      responseState: state.responseState,
      cancelled: state.cancelled,
      protocolFailed: state.protocolFailed,
      requestCredit: state.requestCredit,
      responseCredit: state.responseCredit
    };
  }

  removeStream(streamId: bigint): void {
    const state = this.#streams.get(streamId);
    if (!state) {
      throw new RangeError(`Cannot remove unknown WIPC stream ${streamId}.`);
    }
    if (!state.protocolFailed && !isResponseTerminal(state)) {
      throw new RangeError(`Cannot remove nonterminal WIPC stream ${streamId}.`);
    }
    this.#streams.delete(streamId);
  }

  receive(frame: WipcReceivedStreamFrame): WipcStreamTransition {
    if (!this.#authenticated) {
      connectionError(
        "frame_before_authentication",
        "No WIPC stream frame is accepted before mutual connection authentication."
      );
    }
    if (frame.streamId <= 0n) {
      connectionError("invalid_stream_frame", "Stream frames require a nonzero stream ID.");
    }
    if (frame.frameType === WIPC_FRAME_TYPES.REQUEST_START) {
      return this.#receiveRequestStart(frame);
    }

    const state = this.#streams.get(frame.streamId);
    if (!state) {
      return this.#receiveInactiveFrame(frame);
    }
    if (state.protocolFailed) {
      return this.#receiveFailedStreamFrame(state, frame);
    }

    switch (frame.frameType) {
      case WIPC_FRAME_TYPES.REQUEST_CHUNK:
        return this.#receiveRequestChunk(state, frame);
      case WIPC_FRAME_TYPES.REQUEST_END:
        return this.#receiveRequestEnd(state, frame);
      case WIPC_FRAME_TYPES.REQUEST_CANCEL:
        return this.#receiveRequestCancel(state, frame);
      case WIPC_FRAME_TYPES.RESPONSE_START:
        return this.#receiveResponseStart(state, frame);
      case WIPC_FRAME_TYPES.RESPONSE_CHUNK:
        return this.#receiveResponseChunk(state, frame);
      case WIPC_FRAME_TYPES.RESPONSE_END:
        return this.#receiveResponseTerminal(state, frame, "succeeded");
      case WIPC_FRAME_TYPES.RESPONSE_ERROR:
        return this.#receiveResponseTerminal(state, frame, "failed");
      case WIPC_FRAME_TYPES.WINDOW_UPDATE:
        return this.#receiveWindowUpdate(state, frame);
      default:
        return this.#failStream(state, frame.streamId, "invalid_stream_frame");
    }
  }

  #receiveRequestStart(frame: WipcReceivedStreamFrame): WipcStreamTransition {
    this.#highWater.accept(frame.sender, frame.streamId);
    if (this.#streams.size >= WIPC_MAX_CONCURRENT_STREAMS) {
      return {
        outcome: "stream_limit",
        streamId: frame.streamId,
        dispatch: false,
        responseErrorCode: "stream_limit"
      };
    }
    this.#streams.set(frame.streamId, {
      initiator: frame.sender,
      responder: oppositeSide(frame.sender),
      requestState: "open",
      responseState: "none",
      cancelled: false,
      protocolFailed: false,
      requestCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES,
      responseCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES
    });
    return { outcome: "request_started", streamId: frame.streamId, dispatch: true };
  }

  #receiveInactiveFrame(frame: WipcReceivedStreamFrame): WipcStreamTransition {
    const initiator = creatorForStreamId(frame.streamId);
    const highWater = this.#highWater.snapshot();
    const knownHighWater = initiator === "node"
      ? highWater.highestNodeStreamId
      : highWater.highestHelperStreamId;
    if (frame.streamId > knownHighWater) {
      connectionError("unknown_stream", `Frame references unknown WIPC stream ${frame.streamId}.`);
    }

    if (frame.frameType === WIPC_FRAME_TYPES.REQUEST_CANCEL && frame.sender === initiator) {
      return { outcome: "inactive_frame_ignored", streamId: frame.streamId };
    }
    if (frame.frameType === WIPC_FRAME_TYPES.WINDOW_UPDATE) {
      const update = validateWindowUpdate(frame.windowUpdate);
      const expectedSender = update.direction === "request"
        ? oppositeSide(initiator)
        : initiator;
      if (frame.sender !== expectedSender) {
        connectionError("flow_control_error", "WINDOW_UPDATE was sent by the wrong stream side.");
      }
      return {
        outcome: "inactive_frame_ignored",
        streamId: frame.streamId,
        direction: update.direction
      };
    }
    connectionError("unknown_stream", `Frame is forbidden for inactive WIPC stream ${frame.streamId}.`);
  }

  #receiveFailedStreamFrame(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    if (frame.frameType === WIPC_FRAME_TYPES.REQUEST_CANCEL && frame.sender === state.initiator) {
      return {
        outcome: "cancel_ignored",
        streamId: frame.streamId,
        abortRequest: false
      };
    }
    if (frame.frameType === WIPC_FRAME_TYPES.WINDOW_UPDATE) {
      return this.#receiveWindowUpdate(state, frame);
    }
    connectionError(
      "failed_stream_frame",
      `Non-cancel/non-window frame received on failed WIPC stream ${frame.streamId}.`
    );
  }

  #expectedSenderOrFailure(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame,
    expected: WipcStreamCreator
  ): WipcStreamTransition | undefined {
    if (frame.sender === expected) {
      return undefined;
    }
    return this.#failStream(state, frame.streamId, "unexpected_frame_sender");
  }

  #receiveRequestChunk(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.initiator);
    if (senderFailure) {
      return senderFailure;
    }
    const byteLength = requireChunkLength(frame);
    if (state.requestState === "ended" || state.requestState === "failed") {
      return this.#failStream(state, frame.streamId, "request_chunk_after_terminal");
    }
    this.#consumeCredit(state, "request", byteLength);
    if (state.requestState === "cancelled" || state.requestState === "response_closed") {
      return {
        outcome: "request_chunk_discarded",
        streamId: frame.streamId,
        byteLength
      };
    }
    return {
      outcome: "request_chunk_delivered",
      streamId: frame.streamId,
      byteLength
    };
  }

  #receiveRequestEnd(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.initiator);
    if (senderFailure) {
      return senderFailure;
    }
    if (state.requestState !== "open") {
      return this.#failStream(state, frame.streamId, "duplicate_request_end");
    }
    state.requestState = "ended";
    return { outcome: "request_ended", streamId: frame.streamId };
  }

  #receiveRequestCancel(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.initiator);
    if (senderFailure) {
      return senderFailure;
    }
    if (state.cancelled || isResponseTerminal(state)) {
      return {
        outcome: "cancel_ignored",
        streamId: frame.streamId,
        abortRequest: false
      };
    }
    state.cancelled = true;
    state.requestState = "cancelled";
    return {
      outcome: "request_cancelled",
      streamId: frame.streamId,
      abortRequest: true
    };
  }

  #receiveResponseStart(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.responder);
    if (senderFailure) {
      return senderFailure;
    }
    if (state.responseState !== "none") {
      return this.#failStream(state, frame.streamId, "duplicate_response_start");
    }
    state.responseState = "open";
    return { outcome: "response_started", streamId: frame.streamId };
  }

  #receiveResponseChunk(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.responder);
    if (senderFailure) {
      return senderFailure;
    }
    const byteLength = requireChunkLength(frame);
    if (state.responseState === "none") {
      return this.#failStream(state, frame.streamId, "response_chunk_before_start");
    }
    if (state.responseState !== "open") {
      return this.#failStream(state, frame.streamId, "response_chunk_after_terminal");
    }
    this.#consumeCredit(state, "response", byteLength);
    return {
      outcome: "response_chunk_delivered",
      streamId: frame.streamId,
      byteLength
    };
  }

  #receiveResponseTerminal(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame,
    terminal: "succeeded" | "failed"
  ): WipcStreamTransition {
    const senderFailure = this.#expectedSenderOrFailure(state, frame, state.responder);
    if (senderFailure) {
      return senderFailure;
    }
    if (terminal === "succeeded" && state.responseState === "none") {
      return this.#failStream(state, frame.streamId, "response_terminal_before_start");
    }
    if (isResponseTerminal(state)) {
      return this.#failStream(state, frame.streamId, "duplicate_response_terminal");
    }
    state.responseState = terminal;
    const closeRequestInput = state.requestState === "open";
    if (closeRequestInput) {
      state.requestState = "response_closed";
    }
    return {
      outcome: terminal === "succeeded" ? "response_ended" : "response_failed",
      streamId: frame.streamId,
      closeRequestInput
    };
  }

  #receiveWindowUpdate(
    state: MutableStreamState,
    frame: WipcReceivedStreamFrame
  ): WipcStreamTransition {
    const update = validateWindowUpdate(frame.windowUpdate);
    const expectedSender = update.direction === "request"
      ? state.responder
      : state.initiator;
    if (frame.sender !== expectedSender) {
      connectionError("flow_control_error", "WINDOW_UPDATE was sent by the wrong stream side.");
    }
    const terminal = update.direction === "request"
      ? isRequestTerminal(state)
      : isResponseTerminal(state) || state.protocolFailed;
    if (terminal) {
      return {
        outcome: "window_ignored",
        streamId: frame.streamId,
        direction: update.direction
      };
    }
    const creditField = update.direction === "request" ? "requestCredit" : "responseCredit";
    if (state[creditField] + update.creditIncrement > WIPC_INITIAL_STREAM_CREDIT_BYTES) {
      connectionError("flow_control_error", "WINDOW_UPDATE would exceed maximum outstanding credit.");
    }
    state[creditField] += update.creditIncrement;
    return {
      outcome: "window_updated",
      streamId: frame.streamId,
      direction: update.direction
    };
  }

  #consumeCredit(
    state: MutableStreamState,
    direction: WipcWindowDirection,
    byteLength: number
  ): void {
    const creditField = direction === "request" ? "requestCredit" : "responseCredit";
    if (byteLength > state[creditField]) {
      connectionError("flow_control_error", `${direction} chunk exceeds outstanding stream credit.`);
    }
    state[creditField] -= byteLength;
  }

  #failStream(
    state: MutableStreamState,
    streamId: bigint,
    errorCode: WipcStreamFailureCode
  ): WipcStreamTransition {
    const responseErrorPermitted = !isResponseTerminal(state);
    const abortRequest = !isResponseTerminal(state) || state.requestState === "open";
    state.protocolFailed = true;
    state.requestState = "failed";
    return {
      outcome: "stream_failed",
      streamId,
      errorCode,
      responseErrorPermitted,
      abortRequest
    };
  }
}
