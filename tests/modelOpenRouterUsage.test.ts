// winter 0.0.56 breaking change: on OpenRouter, `prompt_tokens_details.cache_write_tokens` is reported
// as `cacheWriteTokens` and no longer counted inside `inputTokens`. The real Chat Completions
// adapter runs against a loopback OpenRouter; the usage-ledger line must split the prompt without
// double- or under-counting, and the cost must be OpenRouter's own figure when it reports one, else
// the list-price estimate over the disjoint counts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { estimateCostUsd } from "@yanlinglabs/winter-provider-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { catalogModel } from "../src/models/catalog.js";
import { ModelClient } from "../src/models/client.js";
import { createWinterRuntime } from "../src/models/winter.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import { usageFields, type UsageLedger } from "../src/orchestration/usageLedger.js";
import type { UsageLedgerEntry } from "../src/shared/schemas/usage.js";

const ROUTE = { providerId: "openrouter", modelId: "anthropic/claude-sonnet-5.5" };
const PROMPT = 8_000;
const CACHED = 5_000;
const WRITTEN = 2_000;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A loopback OpenRouter whose stream ends with a usage chunk carrying cache reads and writes. */
async function openRouter(o: { cost?: number }): Promise<{ baseUrl: string; bodies: unknown[] }> {
  const bodies: unknown[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(raw));
      response.writeHead(200, { "content-type": "text/event-stream" });
      const usage = {
        prompt_tokens: PROMPT,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: CACHED, cache_write_tokens: WRITTEN },
        ...(o.cost !== undefined ? { cost: o.cost } : {})
      };
      response.write(`data: ${JSON.stringify({ id: "gen-1", model: ROUTE.modelId, choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, bodies };
}

function client(baseUrl: string) {
  const lines: UsageLedgerEntry[] = [];
  const ledger: UsageLedger = { record: async (entry) => void lines.push(entry as UsageLedgerEntry), flush: async () => undefined };
  const modelClient = new ModelClient({
    winter: createWinterRuntime(),
    credentials: () => "sk-or-test",
    usageLedger: ledger,
    providerAlerts: new ProviderAlerts(),
    connection: () => ({ baseUrl, local: true })
  });
  return { modelClient, lines };
}

const call = (modelClient: ModelClient) =>
  modelClient.call({ route: ROUTE, system: ["A"], messages: [{ role: "user", content: "hi" }], attribution: { purpose: "life", waifuId: "aria" } });

describe("OpenRouter usage with cache writes (winter 0.0.56)", () => {
  it("splits the prompt into disjoint input / cache read / cache write counts and bills OpenRouter's reported cost", async () => {
    const { baseUrl } = await openRouter({ cost: 0.0123 });
    const { modelClient, lines } = client(baseUrl);
    const result = await call(modelClient);
    expect(result.text).toBe("hi");
    expect(result.usage).toMatchObject({ inputTokens: PROMPT - CACHED - WRITTEN, cacheReadTokens: CACHED, cacheWriteTokens: WRITTEN, reportedCostUsd: 0.0123 });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({ status: "ok", usageKnown: true, inputTokens: 1_000, cacheReadTokens: CACHED, cacheWriteTokens: WRITTEN, outputTokens: 50, costUsd: 0.0123 });
    // Nothing counted twice, nothing lost: the three prompt counts add up to OpenRouter's prompt_tokens.
    expect(line.inputTokens + (line.cacheReadTokens ?? 0) + (line.cacheWriteTokens ?? 0)).toBe(PROMPT);
  });

  it("without a reported cost, prices the disjoint counts at the list rates", async () => {
    const { baseUrl } = await openRouter({});
    const { modelClient, lines } = client(baseUrl);
    const result = await call(modelClient);
    const descriptor = catalogModel(ROUTE)!;
    const pricing = descriptor.pricing!.value;
    const expected =
      (1_000 * pricing.inputPerMTokUsd + CACHED * (pricing.cacheReadPerMTokUsd ?? pricing.inputPerMTokUsd) + WRITTEN * (pricing.cacheWritePerMTokUsd ?? pricing.inputPerMTokUsd) + 50 * pricing.outputPerMTokUsd) / 1e6;
    expect(lines[0]!.costUsd).toBeCloseTo(expected, 9);
    expect(estimateCostUsd(result.usage!, descriptor).costUsd).toBeCloseTo(expected, 9);
  });

  it("a cache-only prompt is still known usage", () => {
    expect(usageFields({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 900 })).toMatchObject({ usageKnown: true, cacheReadTokens: 900 });
    expect(usageFields({ inputTokens: 0, outputTokens: 0 })).toMatchObject({ usageKnown: false });
  });
});
