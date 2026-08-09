import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WIPC_CONTROL_PAYLOAD_MAX_BYTES,
  WIPC_DATA_PAYLOAD_MAX_BYTES,
  WIPC_ENCODED_HEADERS_MAX_BYTES,
  WIPC_FRAME_TYPES,
  WIPC_HEADER_BYTES,
  WIPC_INITIAL_STREAM_CREDIT_BYTES,
  WIPC_MAX_CONCURRENT_STREAMS,
  WIPC_PROTOCOL_VERSION,
  WIPC_WINDOW_UPDATE_BYTES,
  WipcProtocolError,
  WipcStreamHighWater,
  acceptWipcStreamId,
  assertWipcEncodedHeadersLength,
  decodeWipcHeader,
  decodeWipcWindowUpdate,
  deriveWipcHelperProof,
  deriveWipcParentProof,
  encodeWipcHeader,
  encodeWipcWindowUpdate,
  nextWipcStreamId,
  verifyWipcHelperProof,
  verifyWipcParentProof
} from "../src/shared/wipc.js";
import { createWipcV1Fixture } from "../src/shared/wipcContract.js";
import { serializeCanonicalContractJson } from "../src/shared/schemas/remoteProtocolContract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function expectProtocolError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(WipcProtocolError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected WIPC protocol error ${code}.`);
}

describe("WIPC V1 header", () => {
  it("pins the exact 24-byte network-order representation", () => {
    const encoded = encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      flags: 0,
      streamId: 1n,
      payloadLength: 321
    });

    expect(encoded).toHaveLength(WIPC_HEADER_BYTES);
    expect(encoded.toString("hex")).toBe(
      "574950430001000010000000000000000000000100000141"
    );
    expect(decodeWipcHeader(encoded)).toEqual({
      major: 1,
      minor: 0,
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      flags: 0,
      streamId: 1n,
      payloadLength: 321
    });
  });

  it("accepts every frozen frame type with its required stream class", () => {
    for (const frameType of Object.values(WIPC_FRAME_TYPES)) {
      const streamId = frameType <= WIPC_FRAME_TYPES.EVENT ? 0n : 1n;
      const payloadLength = frameType === WIPC_FRAME_TYPES.WINDOW_UPDATE
        ? WIPC_WINDOW_UPDATE_BYTES
        : frameType === WIPC_FRAME_TYPES.REQUEST_CHUNK
            || frameType === WIPC_FRAME_TYPES.RESPONSE_CHUNK
          ? 1
          : frameType === WIPC_FRAME_TYPES.REQUEST_END
              || frameType === WIPC_FRAME_TYPES.RESPONSE_END
            ? 0
            : 2;
      const encoded = encodeWipcHeader({
        ...WIPC_PROTOCOL_VERSION,
        frameType,
        flags: 0,
        streamId,
        payloadLength
      });
      expect(decodeWipcHeader(encoded).frameType).toBe(frameType);
    }
  });

  it("rejects malformed headers before payload allocation", () => {
    const valid = encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      flags: 0,
      streamId: 1n,
      payloadLength: WIPC_DATA_PAYLOAD_MAX_BYTES
    });

    const mutation = (offset: number, value: number) => {
      const bytes = Buffer.from(valid);
      bytes[offset] = value;
      return bytes;
    };

    expectProtocolError(() => decodeWipcHeader(valid.subarray(0, 23)), "invalid_header_length");
    expectProtocolError(() => decodeWipcHeader(mutation(0, 0)), "invalid_magic");
    expectProtocolError(() => decodeWipcHeader(mutation(5, 2)), "unsupported_version");
    expectProtocolError(() => decodeWipcHeader(mutation(8, 0xff)), "unknown_frame_type");
    expectProtocolError(() => decodeWipcHeader(mutation(9, 1)), "reserved_flags");
    expectProtocolError(() => decodeWipcHeader(mutation(11, 1)), "reserved_bytes");

    const oversized = Buffer.from(valid);
    oversized.writeUInt32BE(WIPC_DATA_PAYLOAD_MAX_BYTES + 1, 20);
    expectProtocolError(() => decodeWipcHeader(oversized), "payload_too_large");
  });

  it("enforces stream classes and payload-class boundaries", () => {
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.HELLO,
      flags: 0,
      streamId: 1n,
      payloadLength: 2
    }), "invalid_stream_id");
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      flags: 0,
      streamId: 0n,
      payloadLength: 2
    }), "invalid_stream_id");
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.EVENT,
      flags: 0,
      streamId: 0n,
      payloadLength: WIPC_CONTROL_PAYLOAD_MAX_BYTES + 1
    }), "control_payload_too_large");
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      flags: 0,
      streamId: 1n,
      payloadLength: 0
    }), "invalid_data_payload_length");
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.RESPONSE_END,
      flags: 0,
      streamId: 1n,
      payloadLength: 1
    }), "invalid_terminal_payload_length");
    expectProtocolError(() => encodeWipcHeader({
      ...WIPC_PROTOCOL_VERSION,
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      flags: 0,
      streamId: 1n,
      payloadLength: WIPC_WINDOW_UPDATE_BYTES - 1
    }), "invalid_window_update_length");

    expect(() => assertWipcEncodedHeadersLength(WIPC_ENCODED_HEADERS_MAX_BYTES)).not.toThrow();
    expectProtocolError(
      () => assertWipcEncodedHeadersLength(WIPC_ENCODED_HEADERS_MAX_BYTES + 1),
      "encoded_headers_too_large"
    );
  });
});

describe("WIPC V1 flow control and stream IDs", () => {
  it("pins the exact eight-byte WINDOW_UPDATE payload", () => {
    const encoded = encodeWipcWindowUpdate({
      direction: "request",
      creditIncrement: WIPC_INITIAL_STREAM_CREDIT_BYTES
    });
    expect(encoded.toString("hex")).toBe("0100000000100000");
    expect(decodeWipcWindowUpdate(encoded)).toEqual({
      direction: "request",
      creditIncrement: WIPC_INITIAL_STREAM_CREDIT_BYTES
    });

    expect(decodeWipcWindowUpdate(encodeWipcWindowUpdate({
      direction: "response",
      creditIncrement: 1
    }))).toEqual({ direction: "response", creditIncrement: 1 });
  });

  it("rejects invalid WINDOW_UPDATE direction, reserved bytes, length, and credit", () => {
    const valid = encodeWipcWindowUpdate({ direction: "request", creditIncrement: 1 });
    const invalidDirection = Buffer.from(valid);
    invalidDirection[0] = 3;
    const invalidReserved = Buffer.from(valid);
    invalidReserved[2] = 1;
    const zeroCredit = Buffer.from(valid);
    zeroCredit.writeUInt32BE(0, 4);
    const excessCredit = Buffer.from(valid);
    excessCredit.writeUInt32BE(WIPC_INITIAL_STREAM_CREDIT_BYTES + 1, 4);

    expectProtocolError(() => decodeWipcWindowUpdate(valid.subarray(0, 7)), "invalid_window_update_length");
    expectProtocolError(() => decodeWipcWindowUpdate(invalidDirection), "invalid_window_direction");
    expectProtocolError(() => decodeWipcWindowUpdate(invalidReserved), "reserved_bytes");
    expectProtocolError(() => decodeWipcWindowUpdate(zeroCredit), "invalid_credit_increment");
    expectProtocolError(() => decodeWipcWindowUpdate(excessCredit), "invalid_credit_increment");
  });

  it("tracks odd/even high-water marks without stream tombstones", () => {
    const highWater = new WipcStreamHighWater();
    highWater.accept("node", 1n);
    highWater.accept("helper", 2n);
    highWater.accept("node", 9_007_199_254_740_993n);
    highWater.accept("helper", 18_446_744_073_709_551_614n);

    expect(highWater.snapshot()).toEqual({
      highestNodeStreamId: 9_007_199_254_740_993n,
      highestHelperStreamId: 18_446_744_073_709_551_614n
    });
    expectProtocolError(() => highWater.accept("node", 3n), "stream_id_reused");
    expectProtocolError(() => highWater.accept("node", 10n), "stream_id_parity");
    expectProtocolError(() => highWater.accept("helper", 0n), "invalid_stream_id");
  });

  it("allocates strictly increasing IDs and fails before wrap", () => {
    expect(nextWipcStreamId("node", 0n)).toBe(1n);
    expect(nextWipcStreamId("helper", 0n)).toBe(2n);
    expect(nextWipcStreamId("node", 18_446_744_073_709_551_613n)).toBe(
      18_446_744_073_709_551_615n
    );
    expect(nextWipcStreamId("helper", 18_446_744_073_709_551_612n)).toBe(
      18_446_744_073_709_551_614n
    );
    expectProtocolError(
      () => nextWipcStreamId("node", 18_446_744_073_709_551_615n),
      "stream_id_exhausted"
    );
    expectProtocolError(
      () => nextWipcStreamId("helper", 18_446_744_073_709_551_614n),
      "stream_id_exhausted"
    );
    expect(WIPC_MAX_CONCURRENT_STREAMS).toBe(128);
  });
});

describe("WIPC V1 one-launch mutual authentication", () => {
  const parentCapability = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const clientNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x20 + index));
  const helperNonce = Buffer.from(Array.from({ length: 32 }, (_, index) => 0x40 + index));
  const helloBytes = Buffer.from(
    "{\"component\":\"discord_waifus\",\"nonce\":\"client\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );
  const helloAckBytes = Buffer.from(
    "{\"component\":\"ts_connect\",\"nonce\":\"helper\",\"protocol\":{\"major\":1,\"minor\":0}}",
    "utf8"
  );

  it("pins exact parent and helper proofs over exact HELLO bytes", () => {
    const parentProof = deriveWipcParentProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes
    });
    expect(parentProof.toString("hex")).toBe(
      "856eca8a258d7fa5943b008c7a49e80a73db05f72ac60e24ff8a1ccafdfdedf9"
    );

    const helperProof = deriveWipcHelperProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof
    });
    expect(helperProof.toString("hex")).toBe(
      "ea7116f9113ca9e2c1877ec446d06dd12ed5f83d6c9d1e6b4c3d31397978f5a5"
    );
    expect(verifyWipcParentProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof
    })).toBe(true);
    expect(verifyWipcHelperProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof,
      helperProof
    })).toBe(true);
  });

  it("rejects wrong, reflected, and transcript-replayed proofs", () => {
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

    expect(verifyWipcHelperProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof,
      helperProof: wrongHelperProof
    })).toBe(false);
    expect(verifyWipcHelperProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof,
      helperProof: parentProof
    })).toBe(false);
    expect(verifyWipcParentProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes: Buffer.concat([helloBytes, Buffer.from(" ")]),
      helloAckBytes,
      parentProof
    })).toBe(false);
  });

  it("requires exact 32-byte capabilities, nonces, and proofs", () => {
    expectProtocolError(() => deriveWipcParentProof({
      parentCapability: parentCapability.subarray(0, 31),
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes
    }), "invalid_auth_width");
    expectProtocolError(() => verifyWipcParentProof({
      parentCapability,
      clientNonce,
      helperNonce,
      helloBytes,
      helloAckBytes,
      parentProof: Buffer.alloc(31)
    }), "invalid_auth_width");
  });
});

describe("WIPC V1 public fixture", () => {
  it("is canonical, generated, and byte-stable", async () => {
    const expected = serializeCanonicalContractJson(createWipcV1Fixture());
    const actual = await readFile(
      path.join(repositoryRoot, "contracts", "remote", "v1", "fixtures", "crypto", "wipc-v1.json"),
      "utf8"
    );
    expect(actual).toBe(expected);
  });

  it("is consumed as accept/reject vectors by the TypeScript codec", async () => {
    const encoded = await readFile(
      path.join(repositoryRoot, "contracts", "remote", "v1", "fixtures", "crypto", "wipc-v1.json"),
      "utf8"
    );
    const fixture = JSON.parse(encoded) as {
      validHeaders: Array<{
        fields: {
          major: number;
          minor: number;
          frameType: number;
          flags: number;
          streamId: string;
          payloadLength: number;
        };
        wireHex: string;
      }>;
      invalidHeaders: Array<{ wireHex: string; errorCode: string }>;
      validWindowUpdates: Array<{
        direction: "request" | "response";
        creditIncrement: number;
        wireHex: string;
      }>;
      invalidWindowUpdates: Array<{ wireHex: string; errorCode: string }>;
      streamIdVectors: Array<{
        creator: "node" | "helper";
        highestBefore: string;
        streamId: string;
        highestAfter: string;
        outcome: string;
      }>;
      allocatorVectors: Array<{
        creator: "node" | "helper";
        highestBefore: string;
        nextStreamId?: string;
        outcome: string;
      }>;
    };

    for (const vector of fixture.validHeaders) {
      const decoded = decodeWipcHeader(Buffer.from(vector.wireHex, "hex"));
      expect(decoded).toEqual({
        ...vector.fields,
        streamId: BigInt(vector.fields.streamId)
      });
      expect(encodeWipcHeader(decoded).toString("hex")).toBe(vector.wireHex);
    }
    for (const vector of fixture.invalidHeaders) {
      expectProtocolError(
        () => decodeWipcHeader(Buffer.from(vector.wireHex, "hex")),
        vector.errorCode
      );
    }
    for (const vector of fixture.validWindowUpdates) {
      const decoded = decodeWipcWindowUpdate(Buffer.from(vector.wireHex, "hex"));
      expect(decoded).toEqual({
        direction: vector.direction,
        creditIncrement: vector.creditIncrement
      });
      expect(encodeWipcWindowUpdate(decoded).toString("hex")).toBe(vector.wireHex);
    }
    for (const vector of fixture.invalidWindowUpdates) {
      expectProtocolError(
        () => decodeWipcWindowUpdate(Buffer.from(vector.wireHex, "hex")),
        vector.errorCode
      );
    }
    for (const vector of fixture.streamIdVectors) {
      const action = () => acceptWipcStreamId(
        vector.creator,
        BigInt(vector.highestBefore),
        BigInt(vector.streamId)
      );
      if (vector.outcome === "accept") {
        expect(action()).toBe(BigInt(vector.highestAfter));
      } else {
        expectProtocolError(action, vector.outcome);
      }
    }
    for (const vector of fixture.allocatorVectors) {
      const action = () => nextWipcStreamId(vector.creator, BigInt(vector.highestBefore));
      if (vector.outcome === "accept") {
        expect(action()).toBe(BigInt(vector.nextStreamId ?? ""));
      } else {
        expectProtocolError(action, vector.outcome);
      }
    }
  });
});
