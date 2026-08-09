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

export function createWipcFixtureSet(): ReadonlyMap<string, ContractJson> {
  return new Map([["fixtures/crypto/wipc-v1.json", createWipcV1Fixture()]]);
}
