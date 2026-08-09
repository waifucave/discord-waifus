import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  WIPC_FRAME_TYPES,
  WIPC_INITIAL_STREAM_CREDIT_BYTES,
  WIPC_MAX_CONCURRENT_STREAMS,
  WipcProtocolError
} from "../src/shared/wipc.js";
import { createWipcStateV1Fixture } from "../src/shared/wipcContract.js";
import { WipcConnectionState } from "../src/shared/wipcState.js";
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

function authenticatedConnection(): WipcConnectionState {
  const connection = new WipcConnectionState();
  connection.markAuthenticated();
  return connection;
}

describe("WIPC authenticated stream admission", () => {
  it("rejects every stream frame before mutual authentication", () => {
    const connection = new WipcConnectionState();
    expectProtocolError(() => connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: 1n
    }), "frame_before_authentication");
  });

  it("creates exact initial state and supports both stream-ID parities", () => {
    const connection = authenticatedConnection();
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: 1n
    })).toMatchObject({ outcome: "request_started", dispatch: true });
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: 2n
    })).toMatchObject({ outcome: "request_started", dispatch: true });

    expect(connection.snapshot(1n)).toEqual({
      initiator: "node",
      requestState: "open",
      responseState: "none",
      cancelled: false,
      protocolFailed: false,
      requestCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES,
      responseCredit: WIPC_INITIAL_STREAM_CREDIT_BYTES
    });
    expect(connection.snapshot(2n)?.initiator).toBe("helper");
    expect(connection.activeStreamCount).toBe(2);
    expect(connection.highWaterSnapshot()).toEqual({
      highestNodeStreamId: 1n,
      highestHelperStreamId: 2n
    });
  });

  it("advances high water before rejecting the 129th active stream", () => {
    const connection = authenticatedConnection();
    for (let index = 0; index < WIPC_MAX_CONCURRENT_STREAMS; index += 1) {
      const streamId = BigInt(index * 2 + 1);
      expect(connection.receive({
        sender: "node",
        frameType: WIPC_FRAME_TYPES.REQUEST_START,
        streamId
      }).outcome).toBe("request_started");
    }

    const rejectedStreamId = BigInt(WIPC_MAX_CONCURRENT_STREAMS * 2 + 1);
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: rejectedStreamId
    })).toEqual({
      outcome: "stream_limit",
      streamId: rejectedStreamId,
      dispatch: false,
      responseErrorCode: "stream_limit"
    });
    expect(connection.activeStreamCount).toBe(WIPC_MAX_CONCURRENT_STREAMS);
    expect(connection.highWaterSnapshot().highestNodeStreamId).toBe(rejectedStreamId);
    expectProtocolError(() => connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: rejectedStreamId
    }), "stream_id_reused");
  });
});

describe("WIPC request/response lifecycle", () => {
  it("supports full-duplex chunks, delayed replenishment, and normal terminals", () => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });

    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      streamId: 1n,
      payloadLength: 60_000
    })).toMatchObject({ outcome: "request_chunk_delivered", byteLength: 60_000 });
    expect(connection.snapshot(1n)?.requestCredit).toBe(988_576);
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "request", creditIncrement: 60_000 }
    })).toMatchObject({ outcome: "window_updated", direction: "request" });
    expect(connection.snapshot(1n)?.requestCredit).toBe(WIPC_INITIAL_STREAM_CREDIT_BYTES);

    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_START,
      streamId: 1n
    }).outcome).toBe("response_started");
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
      streamId: 1n,
      payloadLength: 65_536
    }).outcome).toBe("response_chunk_delivered");
    expect(connection.snapshot(1n)?.responseCredit).toBe(983_040);
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "response", creditIncrement: 65_536 }
    }).outcome).toBe("window_updated");
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_END,
      streamId: 1n
    }).outcome).toBe("request_ended");
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_END,
      streamId: 1n
    })).toMatchObject({ outcome: "response_ended", closeRequestInput: false });
    expect(connection.snapshot(1n)).toMatchObject({
      requestState: "ended",
      responseState: "succeeded"
    });
  });

  it("allows a response before request end and discards bounded in-flight request bytes", () => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    connection.receive({ sender: "helper", frameType: WIPC_FRAME_TYPES.RESPONSE_START, streamId: 1n });
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_END,
      streamId: 1n
    })).toMatchObject({ outcome: "response_ended", closeRequestInput: true });
    expect(connection.snapshot(1n)?.requestState).toBe("response_closed");

    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      streamId: 1n,
      payloadLength: 10
    })).toMatchObject({ outcome: "request_chunk_discarded", byteLength: 10 });
    expect(connection.snapshot(1n)?.requestCredit).toBe(WIPC_INITIAL_STREAM_CREDIT_BYTES - 10);
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 1n
    }).outcome).toBe("cancel_ignored");
  });

  it("cancels exactly once, discards bounded in-flight bytes, and permits a response error", () => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 1n
    })).toMatchObject({ outcome: "request_cancelled", abortRequest: true });
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 1n
    })).toMatchObject({ outcome: "cancel_ignored", abortRequest: false });
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      streamId: 1n,
      payloadLength: 100
    }).outcome).toBe("request_chunk_discarded");
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_ERROR,
      streamId: 1n
    })).toMatchObject({ outcome: "response_failed", closeRequestInput: false });
    expect(connection.snapshot(1n)).toMatchObject({
      requestState: "cancelled",
      responseState: "failed",
      cancelled: true
    });
  });
});

describe("WIPC invalid transitions and inactive streams", () => {
  it("marks the first invalid transition stream-failed, then closes on another data frame", () => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
      streamId: 1n,
      payloadLength: 1
    })).toMatchObject({
      outcome: "stream_failed",
      errorCode: "response_chunk_before_start",
      responseErrorPermitted: true,
      abortRequest: true
    });
    expect(connection.snapshot(1n)?.protocolFailed).toBe(true);
    expectProtocolError(() => connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
      streamId: 1n,
      payloadLength: 1
    }), "failed_stream_frame");
    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 1n
    }).outcome).toBe("cancel_ignored");
  });

  it.each([
    [WIPC_FRAME_TYPES.REQUEST_END, "duplicate_request_end", "node"],
    [WIPC_FRAME_TYPES.RESPONSE_START, "duplicate_response_start", "helper"],
    [WIPC_FRAME_TYPES.RESPONSE_END, "duplicate_response_terminal", "helper"]
  ] as const)("rejects duplicate frame type 0x%s as %s", (frameType, errorCode, sender) => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    if (frameType === WIPC_FRAME_TYPES.REQUEST_END) {
      connection.receive({ sender, frameType, streamId: 1n });
    } else {
      connection.receive({
        sender: "helper",
        frameType: WIPC_FRAME_TYPES.RESPONSE_START,
        streamId: 1n
      });
      if (frameType === WIPC_FRAME_TYPES.RESPONSE_END) {
        connection.receive({ sender, frameType, streamId: 1n });
      }
    }
    expect(connection.receive({ sender, frameType, streamId: 1n })).toMatchObject({
      outcome: "stream_failed",
      errorCode
    });
  });

  it("ignores only late cancel/window frames after removal or stream-limit rejection", () => {
    const connection = authenticatedConnection();
    connection.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    connection.receive({ sender: "helper", frameType: WIPC_FRAME_TYPES.RESPONSE_ERROR, streamId: 1n });
    connection.removeStream(1n);

    expect(connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 1n
    }).outcome).toBe("inactive_frame_ignored");
    expect(connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "request", creditIncrement: 1 }
    }).outcome).toBe("inactive_frame_ignored");
    expectProtocolError(() => connection.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_END,
      streamId: 1n
    }), "unknown_stream");
    expectProtocolError(() => connection.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CANCEL,
      streamId: 3n
    }), "unknown_stream");
  });
});

describe("WIPC flow-control failures", () => {
  it("treats chunk credit overrun as connection-fatal in both directions", () => {
    const request = authenticatedConnection();
    request.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    for (let index = 0; index < 16; index += 1) {
      request.receive({
        sender: "node",
        frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
        streamId: 1n,
        payloadLength: 65_536
      });
    }
    expect(request.snapshot(1n)?.requestCredit).toBe(0);
    expectProtocolError(() => request.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.REQUEST_CHUNK,
      streamId: 1n,
      payloadLength: 1
    }), "flow_control_error");

    const response = authenticatedConnection();
    response.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    response.receive({ sender: "helper", frameType: WIPC_FRAME_TYPES.RESPONSE_START, streamId: 1n });
    for (let index = 0; index < 16; index += 1) {
      response.receive({
        sender: "helper",
        frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
        streamId: 1n,
        payloadLength: 65_536
      });
    }
    expectProtocolError(() => response.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.RESPONSE_CHUNK,
      streamId: 1n,
      payloadLength: 1
    }), "flow_control_error");
  });

  it("rejects wrong-side and overflowing grants, but ignores valid terminal grants", () => {
    const wrongSide = authenticatedConnection();
    wrongSide.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    expectProtocolError(() => wrongSide.receive({
      sender: "node",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "request", creditIncrement: 1 }
    }), "flow_control_error");

    const overflow = authenticatedConnection();
    overflow.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    expectProtocolError(() => overflow.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "request", creditIncrement: 1 }
    }), "flow_control_error");

    const terminal = authenticatedConnection();
    terminal.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_START, streamId: 1n });
    terminal.receive({ sender: "node", frameType: WIPC_FRAME_TYPES.REQUEST_END, streamId: 1n });
    expect(terminal.receive({
      sender: "helper",
      frameType: WIPC_FRAME_TYPES.WINDOW_UPDATE,
      streamId: 1n,
      windowUpdate: { direction: "request", creditIncrement: 1 }
    })).toMatchObject({ outcome: "window_ignored", direction: "request" });
    expect(terminal.snapshot(1n)?.requestCredit).toBe(WIPC_INITIAL_STREAM_CREDIT_BYTES);
  });
});

describe("WIPC V1 public state-machine fixture", () => {
  it("is canonical, generated, and consumed as transition vectors", async () => {
    const fixturePath = path.join(
      repositoryRoot,
      "contracts",
      "remote",
      "v1",
      "fixtures",
      "crypto",
      "wipc-state-v1.json"
    );
    const actual = await readFile(fixturePath, "utf8");
    expect(actual).toBe(serializeCanonicalContractJson(createWipcStateV1Fixture()));
    const fixture = JSON.parse(actual) as {
      scenarios: Array<{
        name: string;
        steps: Array<{
          action: "frame" | "remove";
          sender?: "node" | "helper";
          frameType?: number;
          streamId: string;
          payloadLength?: number;
          windowUpdate?: { direction: "request" | "response"; creditIncrement: number };
          repeat?: number;
          expectedOutcome: string;
          expectedConnectionError?: string;
          expectedStreamError?: string;
          expectedDispatch?: boolean;
          expectedAbortRequest?: boolean;
          expectedCloseRequestInput?: boolean;
          expectedResponseErrorPermitted?: boolean;
          expectedSnapshot?: {
            initiator: "node" | "helper";
            requestState: "open" | "ended" | "cancelled" | "response_closed" | "failed";
            responseState: "none" | "open" | "succeeded" | "failed";
            cancelled: boolean;
            protocolFailed: boolean;
            requestCredit: number;
            responseCredit: number;
          };
        }>;
      }>;
      streamLimit: {
        creator: "node" | "helper";
        firstStreamId: string;
        streamIdIncrement: string;
        acceptedCount: number;
        rejectedStreamId: string;
        expectedOutcome: string;
        expectedDispatch: boolean;
        expectedHighWater: string;
      };
    };

    for (const scenario of fixture.scenarios) {
      const connection = authenticatedConnection();
      for (const step of scenario.steps) {
        const streamId = BigInt(step.streamId);
        if (step.action === "remove") {
          connection.removeStream(streamId);
          expect(step.expectedOutcome, scenario.name).toBe("removed");
        } else {
          const execute = () => connection.receive({
            sender: step.sender ?? "node",
            frameType: step.frameType as typeof WIPC_FRAME_TYPES.REQUEST_START,
            streamId,
            payloadLength: step.payloadLength,
            windowUpdate: step.windowUpdate
          });
          if (step.expectedConnectionError) {
            expectProtocolError(execute, step.expectedConnectionError);
          } else {
            const repeat = step.repeat ?? 1;
            for (let index = 0; index < repeat; index += 1) {
              const transition = execute();
              expect(transition.outcome, `${scenario.name} step ${step.frameType}`).toBe(
                step.expectedOutcome
              );
              if (step.expectedStreamError) {
                expect(transition.errorCode).toBe(step.expectedStreamError);
              }
              if (step.expectedDispatch !== undefined) {
                expect(transition.dispatch).toBe(step.expectedDispatch);
              }
              if (step.expectedAbortRequest !== undefined) {
                expect(transition.abortRequest).toBe(step.expectedAbortRequest);
              }
              if (step.expectedCloseRequestInput !== undefined) {
                expect(transition.closeRequestInput).toBe(step.expectedCloseRequestInput);
              }
              if (step.expectedResponseErrorPermitted !== undefined) {
                expect(transition.responseErrorPermitted).toBe(
                  step.expectedResponseErrorPermitted
                );
              }
            }
          }
        }
        if (step.expectedSnapshot) {
          expect(connection.snapshot(streamId), scenario.name).toEqual(step.expectedSnapshot);
        }
      }
    }

    const limit = fixture.streamLimit;
    const connection = authenticatedConnection();
    const first = BigInt(limit.firstStreamId);
    const increment = BigInt(limit.streamIdIncrement);
    for (let index = 0; index < limit.acceptedCount; index += 1) {
      const streamId = first + BigInt(index) * increment;
      expect(connection.receive({
        sender: limit.creator,
        frameType: WIPC_FRAME_TYPES.REQUEST_START,
        streamId
      }).outcome).toBe("request_started");
    }
    const rejectedStreamId = BigInt(limit.rejectedStreamId);
    const rejected = connection.receive({
      sender: limit.creator,
      frameType: WIPC_FRAME_TYPES.REQUEST_START,
      streamId: rejectedStreamId
    });
    expect(rejected.outcome).toBe(limit.expectedOutcome);
    expect(rejected.dispatch).toBe(limit.expectedDispatch);
    const highWater = connection.highWaterSnapshot();
    expect(
      limit.creator === "node" ? highWater.highestNodeStreamId : highWater.highestHelperStreamId
    ).toBe(BigInt(limit.expectedHighWater));
  });
});
