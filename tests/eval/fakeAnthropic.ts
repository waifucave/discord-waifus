// A loopback Anthropic Messages server for the Living cast evaluation tests (spec §12). The REAL
// winter anthropic-messages adapter talks to it (ModelClient `connection: {baseUrl, local: true}`),
// so every request body is the exact wire body production would send. It answers scripted turns as
// an SSE stream (thinking with a signature, text, tool_use) and reports `usage` from the Anthropic
// cache simulation. Not a test file.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AnthropicCacheSim, type CacheUsage, type WireBody } from "./anthropicCacheSim.js";

export type ServerTurn = {
  thinking?: string;
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown }>;
  outputTokens?: number;
  /** Start the stream and never finish it (the caller aborts: a pause, a shutdown). */
  hang?: boolean;
};

export type Exchange = { body: WireBody; usage: CacheUsage; turn: ServerTurn; at: number };

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export class FakeAnthropic {
  readonly exchanges: Exchange[] = [];
  readonly sim: AnthropicCacheSim;
  private server: Server | undefined;
  private toolIds = 0;
  private signatures = 0;
  /** Turns to play, in order; a function is called with the request body. */
  next: (body: WireBody) => ServerTurn = () => ({ text: "ok" });

  constructor(private readonly now: () => number) {
    this.sim = new AnthropicCacheSim({ now });
  }

  /** Plays `turns` in order, then `fallback` for every later request. */
  script(turns: Array<ServerTurn | ((body: WireBody) => ServerTurn)>, fallback: ServerTurn = { text: "ok" }): void {
    const queue = [...turns];
    this.next = (body) => {
      const turn = queue.shift();
      if (!turn) return fallback;
      return typeof turn === "function" ? turn(body) : turn;
    };
  }

  async start(): Promise<string> {
    this.server = createServer((request: IncomingMessage, response: ServerResponse) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (raw += chunk));
      request.on("end", () => {
        const body = JSON.parse(raw) as WireBody;
        const usage = this.sim.process(body);
        const turn = this.next(body);
        this.exchanges.push({ body, usage, turn, at: this.now() });
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (turn.hang) {
          // Only the opening frame; the connection stays open until the client goes away.
          response.write(this.stream(body, usage, {}).split("\n\n")[0] + "\n\n");
          return;
        }
        response.end(this.stream(body, usage, turn));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server!.close(resolve));
  }

  private stream(body: WireBody, usage: CacheUsage, turn: ServerTurn): string {
    const frames: string[] = [];
    frames.push(
      sse("message_start", {
        type: "message_start",
        message: {
          id: `msg_${this.exchanges.length}`,
          type: "message",
          role: "assistant",
          model: body.model ?? "claude",
          content: [],
          stop_reason: null,
          usage: { input_tokens: usage.uncached, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 1 }
        }
      })
    );
    let index = 0;
    if (turn.thinking !== undefined) {
      this.signatures += 1;
      frames.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: turn.thinking } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: `sig-${this.signatures}-${"x".repeat(24)}` } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index }));
      index += 1;
    }
    if (turn.text) {
      frames.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index }));
      index += 1;
    }
    for (const call of turn.toolCalls ?? []) {
      this.toolIds += 1;
      frames.push(sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${String(this.toolIds).padStart(4, "0")}`, name: call.name, input: {} } }));
      frames.push(sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }));
      frames.push(sse("content_block_stop", { type: "content_block_stop", index }));
      index += 1;
    }
    frames.push(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: turn.toolCalls?.length ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: turn.outputTokens ?? 40 }
      })
    );
    frames.push(sse("message_stop", { type: "message_stop" }));
    return frames.join("");
  }
}
