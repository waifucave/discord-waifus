import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asEventCursor,
  compareEventCursors,
  latestEventCursor,
  parseEventCursor
} from "../src/frontend/api/eventCursor.js";
import {
  ResumableEventFeed,
  SseParser
} from "../src/frontend/api/resumableEventFeed.js";
import {
  reduceActivityFeed,
  type ActivityFeedState
} from "../src/frontend/screens/ActivityScreen.js";
import { reduceRuntimeFeed } from "../src/frontend/state/runtimeStore.js";
import { RemoteAccessStore } from "../src/frontend/state/remoteAccessStore.js";
import type { RemoteAccessStatus } from "../src/frontend/api/types.js";

const EPOCH_A = Buffer.alloc(16, 0x31).toString("base64url");
const EPOCH_B = Buffer.alloc(16, 0x32).toString("base64url");

describe("frontend event cursors", () => {
  it("parses canonical 128-bit epochs and uint64 sequences without Number narrowing", () => {
    const maximum = `v1:${EPOCH_A}:18446744073709551615`;
    expect(parseEventCursor(maximum)).toEqual({
      streamEpoch: EPOCH_A,
      sequence: 18_446_744_073_709_551_615n
    });
    expect(compareEventCursors(`v1:${EPOCH_A}:9007199254740992`, `v1:${EPOCH_A}:9007199254740993`))
      .toBe(-1);
    expect(compareEventCursors(`v1:${EPOCH_A}:1`, `v1:${EPOCH_B}:1`)).toBeUndefined();
    expect(latestEventCursor([
      `v1:${EPOCH_A}:9007199254740992`,
      `v1:${EPOCH_A}:9007199254740993`
    ])).toBe(`v1:${EPOCH_A}:9007199254740993`);
  });

  it("rejects padded/noncanonical epochs, leading zeroes, overflow, and malformed cursors", () => {
    for (const value of [
      `v1:${EPOCH_A}=:1`,
      `v1:${EPOCH_A.slice(0, -1)}B:1`,
      `v1:${EPOCH_A}:01`,
      `v1:${EPOCH_A}:18446744073709551616`,
      `v2:${EPOCH_A}:1`,
      "1"
    ]) {
      expect(() => asEventCursor(value)).toThrow(TypeError);
    }
  });
});

describe("incremental SSE parsing", () => {
  it("handles fragmented fields, CRLF, comments, and multiline data", () => {
    const parser = new SseParser();
    expect(parser.push(": hello\r\nid: one\r\nevent: qu")).toEqual([]);
    expect(parser.push("ery\r\ndata: first\r\ndata: second\r\n\r\n")).toEqual([{
      event: "query",
      id: "one",
      data: "first\nsecond"
    }]);
  });
});

describe("ResumableEventFeed", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("invokes the browser fetch method with its global receiver", async () => {
    let feed!: ResumableEventFeed;
    const errors: unknown[] = [];
    const browserFetch = vi.fn(function (this: typeof globalThis): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      feed.close();
      return Promise.resolve(new Response(new Uint8Array(), { status: 200 }));
    });
    vi.stubGlobal("fetch", browserFetch);
    feed = new ResumableEventFeed({
      url: "/api/events",
      reconnectDelayMs: 0,
      onEvent: () => undefined,
      onError: (error) => {
        errors.push(error);
        feed.close();
      }
    });

    feed.start();
    await feed.settled();

    expect(browserFetch).toHaveBeenCalledOnce();
    expect(errors).toEqual([]);
  });

  it("uses same-origin fetch, decodes fragmented UTF-8, suppresses duplicates, and reconnects with an exact cursor", async () => {
    const snapshotCursor = `v1:${EPOCH_A}:0`;
    const eventCursor = `v1:${EPOCH_A}:1`;
    const bytes = new TextEncoder().encode([
      `id: ${snapshotCursor}`,
      "event: snapshot",
      "data: {\"label\":\"waifu-🌸\"}",
      "",
      `id: ${eventCursor}`,
      "event: log",
      "data: {\"value\":1}",
      "",
      `id: ${eventCursor}`,
      "event: log",
      "data: {\"value\":1}",
      "",
      ""
    ].join("\n"));
    const flowerStart = bytes.findIndex((value) => value === 0xf0);
    const chunks = [
      bytes.slice(0, flowerStart + 1),
      bytes.slice(flowerStart + 1, flowerStart + 3),
      bytes.slice(flowerStart + 3)
    ];
    const requests: RequestInit[] = [];
    const seen: string[] = [];
    let feed!: ResumableEventFeed;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          }
        }), { status: 200 });
      }
      feed.close();
      return new Response(new Uint8Array(), { status: 200 });
    };
    feed = new ResumableEventFeed({
      url: "/api/events",
      fetchImpl,
      reconnectDelayMs: 0,
      prepareHeaders: () => ({ "x-test": "ready" }),
      onEvent: (event) => seen.push(`${event.event}:${event.data}`)
    });
    feed.start();
    feed.start();
    await feed.settled();

    expect(seen).toEqual([
      "snapshot:{\"label\":\"waifu-🌸\"}",
      "log:{\"value\":1}"
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0].credentials).toBe("same-origin");
    expect(requests[0].cache).toBe("no-store");
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(requests[0].headers).get("x-test")).toBe("ready");
    expect(new Headers(requests[0].headers).get("last-event-id")).toBeNull();
    expect(new Headers(requests[1].headers).get("last-event-id")).toBe(eventCursor);
  });

  it("clears a gapped cursor and requires a canonical snapshot before continuing", async () => {
    const first = [
      `id: v1:${EPOCH_A}:5`,
      "event: snapshot",
      "data: {\"version\":1}",
      "",
      `id: v1:${EPOCH_A}:7`,
      "event: query",
      "data: {\"missed\":true}",
      "",
      ""
    ].join("\n");
    const second = [
      `id: v1:${EPOCH_B}:0`,
      "event: snapshot",
      "data: {\"version\":1,\"recovered\":true}",
      "",
      ""
    ].join("\n");
    const requestHeaders: Headers[] = [];
    const resets: string[] = [];
    const seen: string[] = [];
    let calls = 0;
    let feed!: ResumableEventFeed;
    feed = new ResumableEventFeed({
      url: "/api/events",
      reconnectDelayMs: 0,
      fetchImpl: async (_input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        calls += 1;
        return new Response(calls === 1 ? first : second, { status: 200 });
      },
      onReset: (reset) => resets.push(reset.reason),
      onEvent: (event) => {
        seen.push(event.event);
        if (calls === 2) feed.close();
      }
    });
    feed.start();
    await feed.settled();

    expect(seen).toEqual(["snapshot", "snapshot"]);
    expect(resets).toEqual(["cursor_gap"]);
    expect(requestHeaders[1].get("last-event-id")).toBeNull();
    expect(feed.cursor).toBe(`v1:${EPOCH_B}:0`);
  });

  it("handles the server reset marker and canonical snapshot in the same response", async () => {
    const snapshotCursor = `v1:${EPOCH_B}:4`;
    const body = [
      "event: snapshot_required",
      `data: {"version":1,"type":"snapshot_required","reason":"epoch_mismatch","streamEpoch":"${EPOCH_B}","latestSequence":"4"}`,
      "",
      `id: ${snapshotCursor}`,
      "event: snapshot",
      "data: {\"version\":1,\"fresh\":true}",
      "",
      ""
    ].join("\n");
    const resets: string[] = [];
    const seen: string[] = [];
    let calls = 0;
    let feed!: ResumableEventFeed;
    feed = new ResumableEventFeed({
      url: "/api/events",
      initialCursor: `v1:${EPOCH_A}:9`,
      reconnectDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return new Response(body, { status: 200 });
      },
      onReset: (reset) => resets.push(reset.reason),
      onEvent: (event) => {
        seen.push(event.event);
        feed.close();
      }
    });
    feed.start();
    await feed.settled();

    expect(calls).toBe(1);
    expect(resets).toEqual(["epoch_mismatch"]);
    expect(seen).toEqual(["snapshot"]);
    expect(feed.cursor).toBe(snapshotCursor);
  });

  it("owns one abort lifecycle and does not duplicate a pending fetch", async () => {
    let calls = 0;
    let aborts = 0;
    const feed = new ResumableEventFeed({
      url: "/api/events",
      reconnectDelayMs: 0,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborts += 1;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      },
      onEvent: () => undefined
    });
    feed.start();
    feed.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    feed.close();
    await feed.settled();
    expect(calls).toBe(1);
    expect(aborts).toBe(1);
    expect(feed.running).toBe(false);
  });

  it("discards a frame that resolves after the feed is aborted", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const seen: string[] = [];
    const feed = new ResumableEventFeed({
      url: "/api/events",
      reconnectDelayMs: 0,
      fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        }
      }), { status: 200 }),
      onEvent: (event) => seen.push(event.event)
    });
    feed.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    feed.close();
    controller!.enqueue(new TextEncoder().encode([
      `id: v1:${EPOCH_A}:0`,
      "event: snapshot",
      "data: {\"stale\":true}",
      "",
      ""
    ].join("\n")));
    controller!.close();
    await feed.settled();

    expect(seen).toEqual([]);
  });

  it("contains no legacy EventSource or Number(lastEventId) path in the assistant consumer", async () => {
    const source = await readFile("src/frontend/state/assistantChat.ts", "utf8");
    expect(source).not.toContain("new EventSource");
    expect(source).not.toContain("Number(message.lastEventId");
  });
});

describe("epoch-aware dashboard consumers", () => {
  it("clears activity on reset and replaces all lanes from the canonical snapshot", () => {
    const initial: ActivityFeedState = {
      logs: [{ receivedAt: "old", data: { message: "stale" } }],
      queries: [{ receivedAt: "old", data: { model: "stale" } }],
      replies: []
    };
    const cleared = reduceActivityFeed(initial, { type: "reset" });
    expect(cleared).toEqual({ logs: [], queries: [], replies: [] });

    const snapshot = reduceActivityFeed(cleared, {
      type: "event",
      event: "snapshot",
      receivedAt: "now",
      data: JSON.stringify({
        logs: [{ message: "fresh" }],
        queries: [],
        replies: [{ content: "hello" }]
      })
    });
    expect(snapshot).toEqual({
      logs: [{ receivedAt: "now", data: { message: "fresh" } }],
      queries: [],
      replies: [{ receivedAt: "now", data: { content: "hello" } }]
    });
  });

  it("clears runtime state on reset before applying the next canonical snapshot", () => {
    const current = reduceRuntimeFeed(undefined, {
      type: "event",
      event: "runtime",
      data: JSON.stringify({ paused: false, port: 3888 })
    });
    expect(current?.running).toBe(true);
    expect(reduceRuntimeFeed(current, { type: "reset" })).toBeUndefined();
    expect(reduceRuntimeFeed(undefined, {
      type: "event",
      event: "snapshot",
      data: JSON.stringify({ runtime: { paused: true, port: 4999 } })
    })).toMatchObject({ paused: true, httpUrl: "http://127.0.0.1:4999" });
  });

  it("refreshes Remote Access after reset and ignores callbacks from a prior host", async () => {
    const hostA = Buffer.alloc(32, 0x41).toString("base64url");
    const hostB = Buffer.alloc(32, 0x42).toString("base64url");
    const context = (selectedHostId: string) => ({
      mode: "remote" as const,
      selectedHostId,
      connectionState: "direct" as const,
      connectionShellOrigin: `http://waifus-${"a".repeat(52)}.localhost:43123`
    });
    const status = (name: string): RemoteAccessStatus => ({
      version: 1,
      config: { revision: "1", enabled: true, displayName: name, updatedAt: "1" },
      identity: { deviceId: `device-${name}`, installationFingerprint: Buffer.alloc(16, 0x43).toString("base64url") },
      appVersion: "1.5.203",
      dashboardBuildId: "a".repeat(64),
      helperVersion: "0.1.0",
      helperReleaseSequence: "1",
      protocol: { major: 1, minor: 0 },
      capabilities: [],
      helperState: "ready",
      activationState: "active",
      controlState: "connected",
      directState: "direct",
      lastDirectAt: "1",
      lastErrorCode: null
    });
    let resolveReset: ((value: RemoteAccessStatus) => void) | undefined;
    const loads = vi.fn()
      .mockResolvedValueOnce(status("A"))
      .mockImplementationOnce(() => new Promise<RemoteAccessStatus>((resolve) => {
        resolveReset = resolve;
      }))
      .mockResolvedValue(status("B"));
    const feeds: Array<Parameters<Parameters<RemoteAccessStore["start"]>[1]>[0]> = [];
    const close = vi.fn();
    const store = new RemoteAccessStore(loads);
    const open = (options: Parameters<Parameters<RemoteAccessStore["start"]>[1]>[0]) => {
      feeds.push(options);
      return { close } as unknown as ReturnType<Parameters<RemoteAccessStore["start"]>[1]>;
    };

    store.start(context(hostA), open);
    await vi.waitFor(() => expect(store.get().status?.config.displayName).toBe("A"));
    const reset = feeds[0].onReset({ reason: "epoch_mismatch" });
    expect(store.get().status).toBeUndefined();
    resolveReset!(status("A refreshed"));
    await reset;
    expect(store.get().status?.config.displayName).toBe("A refreshed");

    store.start(context(hostB), open);
    await vi.waitFor(() => expect(store.get().status?.config.displayName).toBe("B"));
    const loadCount = loads.mock.calls.length;
    await feeds[0].onEvent({ event: "snapshot", data: "{}" });
    expect(loads).toHaveBeenCalledTimes(loadCount);
    expect(close).toHaveBeenCalled();
    store.stop();
  });
});
