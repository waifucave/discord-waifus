// `committed` has one meaning on every failure path: part of the answer (text, a tool call or
// reasoning) arrived. A timeout after only `message_start` (Anthropic) or a role-only chunk (Chat
// Completions) is not committed and stays retryable; once text arrived it is neither. The real winter
// adapters run against loopback servers that start a stream and then hang.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ModelClient } from "../src/models/client.js";
import { ModelCallError } from "../src/models/errors.js";
import { createWinterRuntime } from "../src/models/winter.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import { NoopUsageLedger } from "../src/orchestration/usageLedger.js";
import { CHAT_COMPLETIONS, errorTurn, fakeAdapter, fakeWinter } from "./modelFakes.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A server that writes `frames` as an SSE stream and then never finishes it. */
async function hangingStream(frames: string[]): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of frames) response.write(frame);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function client(baseUrl: string): ModelClient {
  return new ModelClient({
    winter: createWinterRuntime(),
    credentials: () => "sk-test",
    usageLedger: NoopUsageLedger,
    providerAlerts: new ProviderAlerts(),
    connection: () => ({ baseUrl, local: true })
  });
}

async function timedOut(modelClient: ModelClient, route: { providerId: string; modelId: string }): Promise<ModelCallError> {
  const failure = await modelClient
    .call({ route, system: ["A"], messages: [{ role: "user", content: "hi" }], timeoutMs: 400, attribution: { purpose: "life" } })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ModelCallError);
  return failure as ModelCallError;
}

const sse = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

const ANTHROPIC = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
const anthropicStart = sse(
  { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
  "message_start"
);
const anthropicText = [
  sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start"),
  sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } }, "content_block_delta")
];

const OPENROUTER = { providerId: "openrouter", modelId: "anthropic/claude-sonnet-5.5" };
const roleOnly = sse({ id: "gen-1", model: OPENROUTER.modelId, choices: [{ index: 0, delta: { role: "assistant" } }] });
const someText = sse({ id: "gen-1", choices: [{ index: 0, delta: { content: "Hel" } }] });

describe("committed means part of the answer arrived", () => {
  it("Anthropic Messages: a timeout after only message_start is retryable; after text it is not", async () => {
    const early = await timedOut(client(await hangingStream([anthropicStart])), ANTHROPIC);
    expect(early).toMatchObject({ code: "timeout", committed: false, retryable: true });
    const late = await timedOut(client(await hangingStream([anthropicStart, ...anthropicText])), ANTHROPIC);
    expect(late).toMatchObject({ code: "timeout", committed: true, retryable: false });
  });

  it("Chat Completions (OpenRouter): a timeout after a role-only chunk is retryable; after text it is not", async () => {
    const early = await timedOut(client(`${await hangingStream([roleOnly])}/api/v1`), OPENROUTER);
    expect(early).toMatchObject({ code: "timeout", committed: false, retryable: true });
    const late = await timedOut(client(`${await hangingStream([roleOnly, someText])}/api/v1`), OPENROUTER);
    expect(late).toMatchObject({ code: "timeout", committed: true, retryable: false });
  });

  it("an error event after only message_start is not committed (winter's first-byte flag is)", async () => {
    const chat = fakeAdapter(CHAT_COMPLETIONS, [() => errorTurn({ code: "server", message: "overloaded", status: 503, retryable: true }, [{ type: "message_start" }])]);
    const modelClient = new ModelClient({ winter: fakeWinter(chat), credentials: () => "sk-test", usageLedger: NoopUsageLedger, providerAlerts: new ProviderAlerts() });
    const failure = await modelClient
      .call({ route: { providerId: "deepseek", modelId: "deepseek-flash" }, system: ["A"], messages: [{ role: "user", content: "hi" }], attribution: { purpose: "life" } })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "server", committed: false, retryable: true });
  });
});
