import { describe, expect, it } from "vitest";
import {
  EventStream,
  EventStreamClosedError,
  EventStreamEventTooLargeError,
  serializeSseEvent
} from "../src/api/eventStream.js";
import { parseEventCursor } from "../src/shared/eventCursor.js";

const bytes16 = (value: number) => Buffer.alloc(16, value).toString("base64url");

describe("EventStream", () => {
  it("allocates exact epoch-aware cursors without narrowing large uint64 sequences", () => {
    const stream = new EventStream<{ value: number }>({
      streamEpoch: bytes16(0x11),
      initialSequence: 9_007_199_254_740_992n
    });
    const cursor = stream.publish("item", { value: 1 });
    expect(cursor).toBe(`v1:${bytes16(0x11)}:9007199254740993`);
    expect(parseEventCursor(cursor)).toEqual({
      streamEpoch: bytes16(0x11),
      sequence: "9007199254740993"
    });
  });

  it("replays only the suffix after Last-Event-ID", () => {
    const stream = new EventStream<{ value: number }>({ streamEpoch: bytes16(0x12) });
    const first = stream.publish("item", { value: 1 });
    stream.publish("item", { value: 2 });
    stream.publish("item", { value: 3 });
    const recovery = stream.recover(first);
    expect(recovery.snapshotRequired).toBe(false);
    expect(recovery.records.map((record) => record.data.value)).toEqual([2, 3]);
    expect(recovery.records.map((record) => record.cursor)).toEqual([
      `v1:${bytes16(0x12)}:2`,
      `v1:${bytes16(0x12)}:3`
    ]);
  });

  it("requires a snapshot for first use, epoch mismatch, malformed/future cursors, and replay gaps", () => {
    const stream = new EventStream<{ value: number }>({
      streamEpoch: bytes16(0x13),
      maxRecords: 2
    });
    expect(stream.recover()).toMatchObject({ snapshotRequired: true });
    expect(stream.recover().reset).toBeUndefined();
    stream.publish("item", { value: 1 });
    stream.publish("item", { value: 2 });
    stream.publish("item", { value: 3 });

    expect(stream.recover(`v1:${bytes16(0x14)}:1`).reset).toMatchObject({
      reason: "epoch_mismatch",
      streamEpoch: bytes16(0x13),
      latestSequence: "3"
    });
    for (const cursor of ["not-a-cursor", `v1:${bytes16(0x13)}:0`, `v1:${bytes16(0x13)}:4`]) {
      expect(stream.recover(cursor).reset).toMatchObject({ reason: "cursor_gap" });
    }
  });

  it("evicts at count and byte bounds and rejects an oversized event before consuming sequence", () => {
    const countBounded = new EventStream<{ value: string }>({
      streamEpoch: bytes16(0x15),
      maxRecords: 2
    });
    countBounded.publish("item", { value: "one" });
    countBounded.publish("item", { value: "two" });
    countBounded.publish("item", { value: "three" });
    expect(countBounded.retainedCount()).toBe(2);

    const byteBounded = new EventStream<{ value: string }>({
      streamEpoch: bytes16(0x16),
      maxReplayBytes: 180
    });
    byteBounded.publish("item", { value: "a".repeat(40) });
    byteBounded.publish("item", { value: "b".repeat(40) });
    byteBounded.publish("item", { value: "c".repeat(40) });
    expect(byteBounded.retainedBytes()).toBeLessThanOrEqual(180);
    expect(byteBounded.retainedCount()).toBeLessThan(3);

    const eventBounded = new EventStream<{ value: string }>({
      streamEpoch: bytes16(0x17),
      maxEventBytes: 100
    });
    expect(() => eventBounded.publish("item", { value: "x".repeat(200) }))
      .toThrow(EventStreamEventTooLargeError);
    expect(eventBounded.latestCursor()).toBe(`v1:${bytes16(0x17)}:0`);
  });

  it("orders reset, canonical snapshot, replay, and live delivery with authorization per event", async () => {
    const stream = new EventStream<{ value: string }>({ streamEpoch: bytes16(0x18) });
    stream.publish("item", { value: "before" });
    const order: string[] = [];
    let allowed = true;
    let authorizationChecks = 0;
    const subscription = stream.subscribeAuthorized({
      principal: { stableId: "remote:travel-mac" },
      lastEventId: `v1:${bytes16(0x19)}:1`,
      authorize: () => {
        authorizationChecks += 1;
        return allowed;
      },
      project: (_principal, _event, data) => ({ value: data.value.toUpperCase() }),
      snapshot: () => ({ value: "snapshot" }),
      projectSnapshot: (_principal, snapshot) => ({ value: snapshot.value.toUpperCase() }),
      onReset: (reset) => { order.push(`reset:${reset.reason}`); },
      onSnapshot: (snapshot, cursor) => { order.push(`snapshot:${snapshot.value}:${cursor}`); },
      onEvent: (_event, data, cursor) => { order.push(`event:${data.value}:${cursor}`); },
      onUnauthorized: () => { order.push("unauthorized"); }
    });
    await subscription.ready;
    expect(order).toEqual([
      "reset:epoch_mismatch",
      `snapshot:SNAPSHOT:v1:${bytes16(0x18)}:1`
    ]);

    stream.publish("item", { value: "live" });
    await subscription.heartbeat(() => { order.push("heartbeat"); });
    expect(order.slice(-2)).toEqual([
      `event:LIVE:v1:${bytes16(0x18)}:2`,
      "heartbeat"
    ]);
    expect(authorizationChecks).toBe(4);

    allowed = false;
    stream.publish("item", { value: "protected" });
    await subscription.heartbeat(() => { order.push("must-not-run"); });
    expect(order).toContain("unauthorized");
    expect(order).not.toContainEqual(expect.stringContaining("PROTECTED"));
    expect(order).not.toContain("must-not-run");
    expect(stream.subscriberCount()).toBe(0);
  });

  it("cleans up cancellation and closes active subscribers when the stream is destroyed", async () => {
    const stream = new EventStream<{ value: number }>({ streamEpoch: bytes16(0x1a) });
    let closed = 0;
    const subscription = stream.subscribeAuthorized({
      principal: "local",
      authorize: () => true,
      project: (_principal, _event, data) => data,
      snapshot: () => ({ value: 0 }),
      projectSnapshot: (_principal, snapshot) => snapshot,
      onReset: () => undefined,
      onSnapshot: () => undefined,
      onEvent: () => undefined,
      onUnauthorized: () => undefined,
      onClose: () => { closed += 1; }
    });
    await subscription.ready;
    expect(stream.subscriberCount()).toBe(1);
    subscription.close();
    expect(stream.subscriberCount()).toBe(0);

    const second = stream.subscribeAuthorized({
      principal: "local",
      authorize: () => true,
      project: (_principal, _event, data) => data,
      snapshot: () => ({ value: 0 }),
      projectSnapshot: (_principal, snapshot) => snapshot,
      onReset: () => undefined,
      onSnapshot: () => undefined,
      onEvent: () => undefined,
      onUnauthorized: () => undefined,
      onClose: () => { closed += 1; }
    });
    await second.ready;
    stream.close();
    expect(closed).toBe(1);
    expect(stream.subscriberCount()).toBe(0);
    expect(() => stream.publish("item", { value: 1 })).toThrow(EventStreamClosedError);
  });

  it("captures a canonical snapshot before later source mutation and live publication", async () => {
    const stream = new EventStream<{ value: string }>({ streamEpoch: bytes16(0x1c) });
    const source = { values: [] as string[] };
    const seen: string[] = [];
    const subscription = stream.subscribeAuthorized({
      principal: "local",
      authorize: async () => true,
      project: (_principal, _event, data) => data,
      snapshot: () => source,
      projectSnapshot: (_principal, snapshot) => snapshot,
      onReset: () => undefined,
      onSnapshot: (snapshot) => { seen.push(`snapshot:${snapshot.values.join(",")}`); },
      onEvent: (_event, data) => { seen.push(`event:${data.value}`); },
      onUnauthorized: () => undefined
    });
    source.values.push("mutated-after-capture");
    stream.publish("item", { value: "live" });
    await subscription.heartbeat(() => undefined);
    expect(seen).toEqual(["snapshot:", "event:live"]);
    subscription.close();
  });

  it("serializes SSE frames without allowing event-name or JSON ambiguity", () => {
    expect(serializeSseEvent({
      event: "assistant",
      cursor: `v1:${bytes16(0x1b)}:2`,
      data: { text: "one\ntwo" }
    })).toBe(
      `id: v1:${bytes16(0x1b)}:2\nevent: assistant\ndata: {"text":"one\\ntwo"}\n\n`
    );
    expect(() => serializeSseEvent({ event: "bad\nevent", data: {} })).toThrow();
    expect(() => serializeSseEvent({ event: "item", data: undefined })).toThrow();
  });
});
