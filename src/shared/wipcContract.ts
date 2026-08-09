import {
  WIPC_ABSOLUTE_PAYLOAD_MAX_BYTES,
  WIPC_CONTROL_PAYLOAD_MAX_BYTES,
  WIPC_DATA_PAYLOAD_MAX_BYTES,
  WIPC_ENCODED_HEADERS_MAX_BYTES,
  WIPC_FRAME_TYPES,
  WIPC_HEADER_BYTES,
  WIPC_INITIAL_STREAM_CREDIT_BYTES,
  WIPC_MAX_CONCURRENT_STREAMS,
  WIPC_PROTOCOL_VERSION,
  WIPC_WINDOW_UPDATE_BYTES,
  deriveWipcHelperProof,
  deriveWipcParentProof,
  encodeWipcHeader,
  encodeWipcWindowUpdate,
  type WipcFrameHeader,
  type WipcFrameType
} from "./wipc.js";
import type { ContractJson } from "./schemas/remoteProtocolContract.js";

function sequentialBytes(start: number): Buffer {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => start + index));
}

function encodedHeaderFields(header: WipcFrameHeader): ContractJson {
  return {
    major: header.major,
    minor: header.minor,
    frameType: header.frameType,
    flags: header.flags,
    streamId: header.streamId.toString(10),
    payloadLength: header.payloadLength
  };
}

function headerVector(
  name: string,
  frameType: WipcFrameType,
  streamId: bigint,
  payloadLength: number
): ContractJson {
  const header: WipcFrameHeader = {
    ...WIPC_PROTOCOL_VERSION,
    frameType,
    flags: 0,
    streamId,
    payloadLength
  };
  return {
    name,
    fields: encodedHeaderFields(header),
    wireHex: encodeWipcHeader(header).toString("hex")
  };
}

function mutateHeader(
  source: Buffer,
  mutation: (bytes: Buffer) => void
): string {
  const bytes = Buffer.from(source);
  mutation(bytes);
  return bytes.toString("hex");
}

function invalidHeaderVectors(): ContractJson[] {
  const requestChunk = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
    flags: 0,
    streamId: 1n,
    payloadLength: WIPC_DATA_PAYLOAD_MAX_BYTES
  });
  const hello = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.HELLO,
    flags: 0,
    streamId: 0n,
    payloadLength: 2
  });
  const requestStart = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.REQUEST_START,
    flags: 0,
    streamId: 1n,
    payloadLength: 2
  });
  const event = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.EVENT,
    flags: 0,
    streamId: 0n,
    payloadLength: 2
  });
  const responseEnd = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.RESPONSE_END,
    flags: 0,
    streamId: 1n,
    payloadLength: 0
  });
  const windowUpdate = encodeWipcHeader({
    ...WIPC_PROTOCOL_VERSION,
    frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
    flags: 0,
    streamId: 1n,
    payloadLength: WIPC_WINDOW_UPDATE_BYTES
  });

  return [
    {
      name: "short-header",
      wireHex: requestChunk.subarray(0, WIPC_HEADER_BYTES - 1).toString("hex"),
      errorCode: "invalid_header_length"
    },
    {
      name: "wrong-magic",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes[0] = 0; }),
      errorCode: "invalid_magic"
    },
    {
      name: "unsupported-version",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes.writeUInt16BE(2, 4); }),
      errorCode: "unsupported_version"
    },
    {
      name: "unknown-frame-type",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes[8] = 0xff; }),
      errorCode: "unknown_frame_type"
    },
    {
      name: "reserved-flag",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes[9] = 1; }),
      errorCode: "reserved_flags"
    },
    {
      name: "nonzero-reserved-header",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes[11] = 1; }),
      errorCode: "reserved_bytes"
    },
    {
      name: "connection-frame-on-stream",
      wireHex: mutateHeader(hello, (bytes) => { bytes.writeBigUInt64BE(1n, 12); }),
      errorCode: "invalid_stream_id"
    },
    {
      name: "stream-frame-on-zero",
      wireHex: mutateHeader(requestStart, (bytes) => { bytes.writeBigUInt64BE(0n, 12); }),
      errorCode: "invalid_stream_id"
    },
    {
      name: "absolute-payload-overflow",
      wireHex: mutateHeader(requestChunk, (bytes) => {
        bytes.writeUInt32BE(WIPC_ABSOLUTE_PAYLOAD_MAX_BYTES + 1, 20);
      }),
      errorCode: "payload_too_large"
    },
    {
      name: "control-payload-overflow",
      wireHex: mutateHeader(event, (bytes) => {
        bytes.writeUInt32BE(WIPC_CONTROL_PAYLOAD_MAX_BYTES + 1, 20);
      }),
      errorCode: "control_payload_too_large"
    },
    {
      name: "empty-data-frame",
      wireHex: mutateHeader(requestChunk, (bytes) => { bytes.writeUInt32BE(0, 20); }),
      errorCode: "invalid_data_payload_length"
    },
    {
      name: "terminal-with-payload",
      wireHex: mutateHeader(responseEnd, (bytes) => { bytes.writeUInt32BE(1, 20); }),
      errorCode: "invalid_terminal_payload_length"
    },
    {
      name: "wrong-window-update-length",
      wireHex: mutateHeader(windowUpdate, (bytes) => {
        bytes.writeUInt32BE(WIPC_WINDOW_UPDATE_BYTES - 1, 20);
      }),
      errorCode: "invalid_window_update_length"
    }
  ];
}

function invalidWindowUpdateVectors(): ContractJson[] {
  const valid = encodeWipcWindowUpdate({ direction: "request", creditIncrement: 1 });
  return [
    {
      name: "short-window-update",
      wireHex: valid.subarray(0, WIPC_WINDOW_UPDATE_BYTES - 1).toString("hex"),
      errorCode: "invalid_window_update_length"
    },
    {
      name: "unknown-window-direction",
      wireHex: mutateHeader(valid, (bytes) => { bytes[0] = 3; }),
      errorCode: "invalid_window_direction"
    },
    {
      name: "nonzero-window-reserved",
      wireHex: mutateHeader(valid, (bytes) => { bytes[2] = 1; }),
      errorCode: "reserved_bytes"
    },
    {
      name: "zero-window-credit",
      wireHex: mutateHeader(valid, (bytes) => { bytes.writeUInt32BE(0, 4); }),
      errorCode: "invalid_credit_increment"
    },
    {
      name: "excess-window-credit",
      wireHex: mutateHeader(valid, (bytes) => {
        bytes.writeUInt32BE(WIPC_INITIAL_STREAM_CREDIT_BYTES + 1, 4);
      }),
      errorCode: "invalid_credit_increment"
    }
  ];
}

function authFixture(): ContractJson {
  const parentCapability = sequentialBytes(0x00);
  const clientNonce = sequentialBytes(0x20);
  const helperNonce = sequentialBytes(0x40);
  const helloBytes = Buffer.from(
    "{\"component\":\"discord_waifus\",\"nonce\":\"client\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const helloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"nonce\":\"helper\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const parentProof = deriveWipcParentProof({
    parentCapability,
    clientNonce,
    helperNonce,
    helloBytes,
    helloAckBytes
  });
  const helperProof = deriveWipcHelperProof({
    parentCapability,
    clientNonce,
    helperNonce,
    helloBytes,
    helloAckBytes,
    parentProof
  });
  const wrongHelperProof = Buffer.from(helperProof);
  wrongHelperProof[0] ^= 1;
  const replayedHelloBytes = Buffer.concat([helloBytes, Buffer.from(" ", "ascii")]);

  return {
    parentCapabilityB64: parentCapability.toString("base64url"),
    clientNonceB64: clientNonce.toString("base64url"),
    helperNonceB64: helperNonce.toString("base64url"),
    helloBytesB64: helloBytes.toString("base64url"),
    helloAckBytesB64: helloAckBytes.toString("base64url"),
    parentProofB64: parentProof.toString("base64url"),
    helperProofB64: helperProof.toString("base64url"),
    rejectionVectors: [
      {
        name: "wrong-helper-proof",
        proofKind: "helper",
        helloBytesB64: helloBytes.toString("base64url"),
        proofB64: wrongHelperProof.toString("base64url"),
        outcome: "reject"
      },
      {
        name: "reflected-parent-proof",
        proofKind: "helper",
        helloBytesB64: helloBytes.toString("base64url"),
        proofB64: parentProof.toString("base64url"),
        outcome: "reject"
      },
      {
        name: "replayed-proof-on-changed-hello",
        proofKind: "parent",
        helloBytesB64: replayedHelloBytes.toString("base64url"),
        proofB64: parentProof.toString("base64url"),
        outcome: "reject"
      }
    ]
  };
}

export function createWipcV1Fixture(): ContractJson {
  return {
    schemaVersion: 1,
    protocol: WIPC_PROTOCOL_VERSION,
    limits: {
      absolutePayloadBytes: WIPC_ABSOLUTE_PAYLOAD_MAX_BYTES,
      controlPayloadBytes: WIPC_CONTROL_PAYLOAD_MAX_BYTES,
      dataPayloadBytes: WIPC_DATA_PAYLOAD_MAX_BYTES,
      encodedHeadersBytes: WIPC_ENCODED_HEADERS_MAX_BYTES,
      headerBytes: WIPC_HEADER_BYTES,
      initialStreamCreditBytes: WIPC_INITIAL_STREAM_CREDIT_BYTES,
      maxConcurrentStreams: WIPC_MAX_CONCURRENT_STREAMS,
      windowUpdateBytes: WIPC_WINDOW_UPDATE_BYTES
    },
    frameTypes: {
      hello: WIPC_FRAME_TYPES.HELLO,
      helloAck: WIPC_FRAME_TYPES.HELLO_ACK,
      command: WIPC_FRAME_TYPES.COMMAND,
      result: WIPC_FRAME_TYPES.RESULT,
      event: WIPC_FRAME_TYPES.EVENT,
      requestStart: WIPC_FRAME_TYPES.REQUEST_START,
      requestChunk: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      requestEnd: WIPC_FRAME_TYPES.REQUEST_END,
      requestCancel: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      responseStart: WIPC_FRAME_TYPES.RESPONSE_START,
      responseChunk: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
      responseEnd: WIPC_FRAME_TYPES.RESPONSE_END,
      responseError: WIPC_FRAME_TYPES.RESPONSE_ERROR,
      windowUpdate: WIPC_FRAME_TYPES.WINDOW_UPDATE
    },
    validHeaders: [
      headerVector("hello", WIPC_FRAME_TYPES.HELLO, 0n, 2),
      headerVector("hello-ack", WIPC_FRAME_TYPES.HELLO_ACK, 0n, 2),
      headerVector("command", WIPC_FRAME_TYPES.COMMAND, 0n, 2),
      headerVector("result", WIPC_FRAME_TYPES.RESULT, 0n, 2),
      headerVector("event", WIPC_FRAME_TYPES.EVENT, 0n, WIPC_CONTROL_PAYLOAD_MAX_BYTES),
      headerVector("request-start", WIPC_FRAME_TYPES.REQUEST_START, 1n, 321),
      headerVector("request-chunk", WIPC_FRAME_TYPES.REQUEST_CHUNK, 1n, WIPC_DATA_PAYLOAD_MAX_BYTES),
      headerVector("request-end", WIPC_FRAME_TYPES.REQUEST_END, 1n, 0),
      headerVector("request-cancel", WIPC_FRAME_TYPES.REQUEST_CANCEL, 1n, 2),
      headerVector("response-start", WIPC_FRAME_TYPES.RESPONSE_START, 1n, 2),
      headerVector("response-chunk", WIPC_FRAME_TYPES.RESPONSE_CHUNK, 1n, WIPC_DATA_PAYLOAD_MAX_BYTES),
      headerVector("response-end", WIPC_FRAME_TYPES.RESPONSE_END, 1n, 0),
      headerVector("response-error", WIPC_FRAME_TYPES.RESPONSE_ERROR, 1n, 2),
      headerVector("window-update", WIPC_FRAME_TYPES.WINDOW_UPDATE, 1n, WIPC_WINDOW_UPDATE_BYTES)
    ],
    invalidHeaders: invalidHeaderVectors(),
    validWindowUpdates: [
      {
        direction: "request",
        creditIncrement: WIPC_INITIAL_STREAM_CREDIT_BYTES,
        wireHex: encodeWipcWindowUpdate({
          direction: "request",
          creditIncrement: WIPC_INITIAL_STREAM_CREDIT_BYTES
        }).toString("hex")
      },
      {
        direction: "response",
        creditIncrement: 1,
        wireHex: encodeWipcWindowUpdate({ direction: "response", creditIncrement: 1 }).toString("hex")
      }
    ],
    invalidWindowUpdates: invalidWindowUpdateVectors(),
    streamIdVectors: [
      {
        creator: "node",
        highestBefore: "0",
        streamId: "1",
        outcome: "accept",
        highestAfter: "1"
      },
      {
        creator: "helper",
        highestBefore: "0",
        streamId: "2",
        outcome: "accept",
        highestAfter: "2"
      },
      {
        creator: "node",
        highestBefore: "1",
        streamId: "9007199254740993",
        outcome: "accept",
        highestAfter: "9007199254740993"
      },
      {
        creator: "helper",
        highestBefore: "2",
        streamId: "18446744073709551614",
        outcome: "accept",
        highestAfter: "18446744073709551614"
      },
      {
        creator: "node",
        highestBefore: "9",
        streamId: "3",
        outcome: "stream_id_reused",
        highestAfter: "9"
      },
      {
        creator: "node",
        highestBefore: "9",
        streamId: "10",
        outcome: "stream_id_parity",
        highestAfter: "9"
      }
    ],
    allocatorVectors: [
      { creator: "node", highestBefore: "0", nextStreamId: "1", outcome: "accept" },
      { creator: "helper", highestBefore: "0", nextStreamId: "2", outcome: "accept" },
      {
        creator: "node",
        highestBefore: "18446744073709551613",
        nextStreamId: "18446744073709551615",
        outcome: "accept"
      },
      {
        creator: "helper",
        highestBefore: "18446744073709551612",
        nextStreamId: "18446744073709551614",
        outcome: "accept"
      },
      {
        creator: "node",
        highestBefore: "18446744073709551615",
        outcome: "stream_id_exhausted"
      },
      {
        creator: "helper",
        highestBefore: "18446744073709551614",
        outcome: "stream_id_exhausted"
      }
    ],
    authentication: authFixture()
  };
}

function stateSnapshot(
  overrides: Partial<{
    initiator: "node" | "helper";
    requestState: "open" | "ended" | "cancelled" | "response_closed" | "failed";
    responseState: "none" | "open" | "succeeded" | "failed";
    cancelled: boolean;
    protocolFailed: boolean;
    requestCredit: number;
    responseCredit: number;
  }> = {}
): ContractJson {
  return {
    initiator: "node",
    requestState: "open",
    responseState: "none",
    cancelled: false,
    protocolFailed: false,
    requestCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES,
    responseCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES,
    ...overrides
  };
}

export function createWipcStateV1Fixture(): ContractJson {
  const startNode = {
    action: "frame",
    sender: "node",
    frameType: WIPC_FRAME_TYPES.REQUEST_START,
    streamId: "1",
    expectedOutcome: "request_started",
    expectedDispatch: true
  };
  return {
    schemaVersion: 1,
    initialStreamCreditBytes: WIPC_INITIAL_STREAM_CREDIT_BYTES,
    maxConcurrentStreams: WIPC_MAX_CONCURRENT_STREAMS,
    scenarios: [
      {
        name: "full-duplex-delayed-credit",
        steps: [
          { ...startNode, expectedSnapshot: stateSnapshot() },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 60_000,
            expectedOutcome: "request_chunk_delivered",
            expectedSnapshot: stateSnapshot({ requestCredit: 988_576 })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "request", creditIncrement: 60_000 },
            expectedOutcome: "window_updated",
            expectedSnapshot: stateSnapshot()
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started",
            expectedSnapshot: stateSnapshot({ responseState: "open" })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 65_536,
            expectedOutcome: "response_chunk_delivered",
            expectedSnapshot: stateSnapshot({
              responseState: "open",
              responseCredit: 983_040
            })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "response", creditIncrement: 65_536 },
            expectedOutcome: "window_updated",
            expectedSnapshot: stateSnapshot({ responseState: "open" })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_END,
            streamId: "1",
            expectedOutcome: "request_ended",
            expectedSnapshot: stateSnapshot({ requestState: "ended", responseState: "open" })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "response_ended",
            expectedCloseRequestInput: false,
            expectedSnapshot: stateSnapshot({ requestState: "ended", responseState: "succeeded" })
          }
        ]
      },
      {
        name: "cancel-discard-remove-and-late-frames",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
            streamId: "1",
            expectedOutcome: "request_cancelled",
            expectedAbortRequest: true,
            expectedSnapshot: stateSnapshot({ requestState: "cancelled", cancelled: true })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
            streamId: "1",
            expectedOutcome: "cancel_ignored",
            expectedAbortRequest: false
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 100,
            expectedOutcome: "request_chunk_discarded",
            expectedSnapshot: stateSnapshot({
              requestState: "cancelled",
              cancelled: true,
              requestCredit: 1_048_476
            })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_ERROR,
            streamId: "1",
            expectedOutcome: "response_failed",
            expectedCloseRequestInput: false,
            expectedSnapshot: stateSnapshot({
              requestState: "cancelled",
              responseState: "failed",
              cancelled: true,
              requestCredit: 1_048_476
            })
          },
          { action: "remove", streamId: "1", expectedOutcome: "removed" },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
            streamId: "1",
            expectedOutcome: "inactive_frame_ignored"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "request", creditIncrement: 1 },
            expectedOutcome: "inactive_frame_ignored"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "connection_error",
            expectedConnectionError: "unknown_stream"
          }
        ]
      },
      {
        name: "response-terminal-closes-request-input",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "response_ended",
            expectedCloseRequestInput: true,
            expectedSnapshot: stateSnapshot({
              requestState: "response_closed",
              responseState: "succeeded"
            })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 10,
            expectedOutcome: "request_chunk_discarded",
            expectedSnapshot: stateSnapshot({
              requestState: "response_closed",
              responseState: "succeeded",
              requestCredit: 1_048_566
            })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
            streamId: "1",
            expectedOutcome: "cancel_ignored",
            expectedAbortRequest: false
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "request", creditIncrement: 10 },
            expectedOutcome: "window_ignored",
            expectedSnapshot: stateSnapshot({
              requestState: "response_closed",
              responseState: "succeeded",
              requestCredit: 1_048_566
            })
          }
        ]
      },
      {
        name: "invalid-transition-escalates",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "stream_failed",
            expectedStreamError: "response_chunk_before_start",
            expectedAbortRequest: true,
            expectedResponseErrorPermitted: true,
            expectedSnapshot: stateSnapshot({ requestState: "failed", protocolFailed: true })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
            streamId: "1",
            expectedOutcome: "cancel_ignored",
            expectedAbortRequest: false
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "connection_error",
            expectedConnectionError: "failed_stream_frame"
          }
        ]
      },
      {
        name: "duplicate-request-terminal",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_END,
            streamId: "1",
            expectedOutcome: "request_ended"
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_END,
            streamId: "1",
            expectedOutcome: "stream_failed",
            expectedStreamError: "duplicate_request_end"
          }
        ]
      },
      {
        name: "duplicate-response-start",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "stream_failed",
            expectedStreamError: "duplicate_response_start"
          }
        ]
      },
      {
        name: "duplicate-response-terminal",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "response_ended"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_ERROR,
            streamId: "1",
            expectedOutcome: "stream_failed",
            expectedStreamError: "duplicate_response_terminal",
            expectedAbortRequest: false,
            expectedResponseErrorPermitted: false
          }
        ]
      },
      {
        name: "unexpected-frame-sender",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "stream_failed",
            expectedStreamError: "unexpected_frame_sender",
            expectedAbortRequest: true,
            expectedResponseErrorPermitted: true
          }
        ]
      },
      {
        name: "request-chunk-after-end",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_END,
            streamId: "1",
            expectedOutcome: "request_ended"
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "stream_failed",
            expectedStreamError: "request_chunk_after_terminal",
            expectedAbortRequest: true,
            expectedResponseErrorPermitted: true
          }
        ]
      },
      {
        name: "response-terminal-before-start",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "stream_failed",
            expectedStreamError: "response_terminal_before_start",
            expectedAbortRequest: true,
            expectedResponseErrorPermitted: true
          }
        ]
      },
      {
        name: "response-chunk-after-terminal",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_END,
            streamId: "1",
            expectedOutcome: "response_ended"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "stream_failed",
            expectedStreamError: "response_chunk_after_terminal",
            expectedAbortRequest: false,
            expectedResponseErrorPermitted: false
          }
        ]
      },
      {
        name: "request-credit-overrun",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 65_536,
            repeat: 16,
            expectedOutcome: "request_chunk_delivered",
            expectedSnapshot: stateSnapshot({ requestCredit: 0 })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "connection_error",
            expectedConnectionError: "flow_control_error"
          }
        ]
      },
      {
        name: "response-credit-overrun",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_START,
            streamId: "1",
            expectedOutcome: "response_started"
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 65_536,
            repeat: 16,
            expectedOutcome: "response_chunk_delivered",
            expectedSnapshot: stateSnapshot({ responseState: "open", responseCredit: 0 })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
            streamId: "1",
            payloadLength: 1,
            expectedOutcome: "connection_error",
            expectedConnectionError: "flow_control_error"
          }
        ]
      },
      {
        name: "wrong-side-window-update",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "request", creditIncrement: 1 },
            expectedOutcome: "connection_error",
            expectedConnectionError: "flow_control_error"
          }
        ]
      },
      {
        name: "window-credit-overflow",
        steps: [
          startNode,
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "1",
            windowUpdate: { direction: "request", creditIncrement: 1 },
            expectedOutcome: "connection_error",
            expectedConnectionError: "flow_control_error"
          }
        ]
      },
      {
        name: "helper-created-stream-symmetry",
        steps: [
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.REQUEST_START,
            streamId: "2",
            expectedOutcome: "request_started",
            expectedDispatch: true,
            expectedSnapshot: stateSnapshot({ initiator: "helper" })
          },
          {
            action: "frame",
            sender: "helper",
            frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
            streamId: "2",
            payloadLength: 1,
            expectedOutcome: "request_chunk_delivered",
            expectedSnapshot: stateSnapshot({ initiator: "helper", requestCredit: 1_048_575 })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
            streamId: "2",
            windowUpdate: { direction: "request", creditIncrement: 1 },
            expectedOutcome: "window_updated",
            expectedSnapshot: stateSnapshot({ initiator: "helper" })
          },
          {
            action: "frame",
            sender: "node",
            frameType: WIPC_FRAME_TYPES.RESPONSE_ERROR,
            streamId: "2",
            expectedOutcome: "response_failed",
            expectedCloseRequestInput: true,
            expectedSnapshot: stateSnapshot({
              initiator: "helper",
              requestState: "response_closed",
              responseState: "failed"
            })
          }
        ]
      }
    ],
    streamLimit: {
      creator: "node",
      firstStreamId: "1",
      streamIdIncrement: "2",
      acceptedCount: WIPC_MAX_CONCURRENT_STREAMS,
      rejectedStreamId: "257",
      expectedOutcome: "stream_limit",
      expectedDispatch: false,
      expectedHighWater: "257"
    }
  };
}

export function createWipcAuthSessionV1Fixture(): ContractJson {
  const parentCapability = sequentialBytes(0x00);
  const clientNonce = sequentialBytes(0x20);
  const helloBytes = Buffer.from(
    "{\"component\":\"discord_waifus\",\"nonce\":\"client\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const helperNonce = sequentialBytes(0x40);
  const helloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"nonce\":\"helper\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const parentProof = deriveWipcParentProof({
    parentCapability,
    clientNonce,
    helperNonce,
    helloBytes,
    helloAckBytes
  });
  const helperProof = deriveWipcHelperProof({
    parentCapability,
    clientNonce,
    helperNonce,
    helloBytes,
    helloAckBytes,
    parentProof
  });

  const replacementHelperNonce = sequentialBytes(0x60);
  const replacementHelloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"nonce\":\"replacement\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const replacementParentProof = deriveWipcParentProof({
    parentCapability,
    clientNonce,
    helperNonce: replacementHelperNonce,
    helloBytes,
    helloAckBytes: replacementHelloAckBytes
  });
  const replacementHelperProof = deriveWipcHelperProof({
    parentCapability,
    clientNonce,
    helperNonce: replacementHelperNonce,
    helloBytes,
    helloAckBytes: replacementHelloAckBytes,
    parentProof: replacementParentProof
  });

  const socketRaceHelperNonce = Buffer.alloc(32, 0x7f);
  const socketRaceHelloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"nonce\":\"socket-race\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const socketRaceParentProof = deriveWipcParentProof({
    parentCapability,
    clientNonce,
    helperNonce: socketRaceHelperNonce,
    helloBytes,
    helloAckBytes: socketRaceHelloAckBytes
  });

  const replayClientNonce = Buffer.from(clientNonce);
  replayClientNonce[0] ^= 1;
  const replayHelloBytes = Buffer.concat([helloBytes, Buffer.from(" ", "ascii")]);
  const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");

  return {
    schemaVersion: 1,
    parentCapabilityB64: encode(parentCapability),
    parent: {
      clientNonceB64: encode(clientNonce),
      helloBytesB64: encode(helloBytes)
    },
    candidates: {
      valid: {
        helperNonceB64: encode(helperNonce),
        helloAckBytesB64: encode(helloAckBytes),
        parentProofB64: encode(parentProof),
        helperProofB64: encode(helperProof),
        expectedParentOutcome: "authenticated",
        expectedHelperOutcome: "authenticated",
        expectedCapabilityState: "erased"
      },
      replacement: {
        helperNonceB64: encode(replacementHelperNonce),
        helloAckBytesB64: encode(replacementHelloAckBytes),
        parentProofB64: encode(replacementParentProof),
        helperProofB64: encode(replacementHelperProof),
        expectedParentOutcome: "authenticated",
        expectedHelperOutcome: "authenticated",
        expectedCapabilityState: "erased"
      },
      wrongHelperProof: {
        helperNonceB64: encode(helperNonce),
        helloAckBytesB64: encode(helloAckBytes),
        parentProofB64: encode(parentProof),
        helperProofB64: encode(Buffer.alloc(32, 0xff)),
        expectedParentError: "invalid_helper_proof",
        expectedCapabilityState: "retained"
      },
      reflectedParentProof: {
        helperNonceB64: encode(helperNonce),
        helloAckBytesB64: encode(helloAckBytes),
        parentProofB64: encode(parentProof),
        helperProofB64: encode(parentProof),
        expectedParentError: "invalid_helper_proof",
        expectedCapabilityState: "retained"
      },
      socketRaceImpersonator: {
        helperNonceB64: encode(socketRaceHelperNonce),
        helloAckBytesB64: encode(socketRaceHelloAckBytes),
        parentProofB64: encode(socketRaceParentProof),
        helperProofB64: encode(socketRaceParentProof),
        expectedParentError: "invalid_helper_proof",
        expectedCapabilityState: "retained"
      },
      replayedParentProof: {
        clientNonceB64: encode(replayClientNonce),
        helloBytesB64: encode(replayHelloBytes),
        helperNonceB64: encode(helperNonce),
        helloAckBytesB64: encode(helloAckBytes),
        parentProofB64: encode(parentProof),
        expectedHelperError: "invalid_parent_proof",
        expectedCapabilityState: "retained"
      }
    },
    rules: {
      trafficBeforeAuthenticationError: "frame_before_authentication",
      candidateAlreadyActiveError: "auth_sequence_error",
      completionWithoutCandidateError: "auth_sequence_error",
      secondClientError: "auth_capability_unavailable",
      recoveryOrder: ["socketRaceImpersonator", "replacement"]
    }
  };
}

export function createWipcFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([
    ["fixtures/crypto/wipc-v1.json", createWipcV1Fixture()],
    ["fixtures/crypto/wipc-state-v1.json", createWipcStateV1Fixture()],
    ["fixtures/crypto/wipc-auth-session-v1.json", createWipcAuthSessionV1Fixture()]
  ]);
}
