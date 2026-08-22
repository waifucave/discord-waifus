import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
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

  it("contains no legacy EventSource or Number(lastEventId) path in the assistant consumer", async () => {
    const source = await readFile("src/frontend/state/assistantChat.ts", "utf8");
    expect(source).not.toContain("new EventSource");
    expect(source).not.toContain("Number(message.lastEventId");
  });
});
