// The captured model traffic (Activity, /api/events, diagnostics) never carries reasoning or its
// opaque replay state, while the provider still receives it (review I1).
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderEvent } from "@yanlinglabs/winter-provider-runtime";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { ModelClient } from "../src/models/client.js";
import { recentQueries, recentReplies, withoutReasoningPayloads } from "../src/shared/queryLog.js";
import { StorageService } from "../src/storage/storageService.js";
import { SseParser, type ParsedSseEvent } from "../src/frontend/api/resumableEventFeed.js";
import { ANTHROPIC_MESSAGES, fakeAdapter, fakeWinter } from "./modelFakes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const OPAQUE = ["SIG-OPAQUE-123", "ENC-OPAQUE-XYZ", "REDACTED-DATA-777", "secret plan"];

const thinkingTurn = (): ProviderEvent[] => [
  { type: "message_start", id: "r1" },
  { type: "native_thinking_block", block: { type: "thinking", thinking: "secret plan", signature: "SIG-OPAQUE-123" } },
  { type: "native_thinking_block", block: { type: "redacted_thinking", data: "REDACTED-DATA-777" } },
  { type: "text_delta", text: "hi" },
  { type: "native_state", items: [{ type: "reasoning", encrypted_content: "ENC-OPAQUE-XYZ" }] },
  { type: "usage", inputTokens: 10, outputTokens: 5 },
  { type: "done", stopReason: "end_turn" }
];

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

async function readSnapshot(address: string): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(`${address}/api/events`, { signal: controller.signal });
  const reader = response.body!.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const queued: ParsedSseEvent[] = [];
  try {
    while (queued.length === 0) {
      const chunk = await reader.read();
      if (chunk.done) break;
      queued.push(...parser.push(decoder.decode(chunk.value, { stream: true })));
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => undefined);
  }
  const snapshot = queued.find((event) => event.event === "snapshot");
  if (!snapshot) throw new Error("no snapshot frame");
  return snapshot.data;
}

describe("query log reasoning safety", () => {
  it("logs neither reasoning blocks nor nativeState for a two-turn Anthropic call; the provider still gets the replay", async () => {
    const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [thinkingTurn]);
    const client = new ModelClient({ winter: fakeWinter(anthropic), credentials: () => "sk-test" });
    const route = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
    const first = await client.call({ route, system: ["A"], messages: [{ role: "user", content: "hello" }], attribution: { purpose: "assistant" } });
    expect(first.message.nativeState).toBeDefined();
    await client.call({
      route,
      system: ["A"],
      messages: [{ role: "user", content: "hello" }, first.message, { role: "user", content: "again" }],
      attribution: { purpose: "assistant" }
    });

    // The provider got the replay state (the log copy is the only thing stripped).
    const sent = JSON.stringify(anthropic.calls[1]!.request.messages);
    expect(sent).toContain("SIG-OPAQUE-123");

    const logged = JSON.stringify({ queries: recentQueries(), replies: recentReplies() });
    for (const marker of OPAQUE) expect(logged).not.toContain(marker);
    expect(logged).not.toContain("nativeState");
    expect(logged).toContain('"omitted":true');
    expect(logged).toContain("again");

    const root = await makeTempRoot("waifus-log-safety-");
    roots.push(root);
    await ensureDataLayout(root);
    const runtime = createRuntimeState({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      packageVersion: "0.1.0",
      port: 3888,
      dataRoot: root,
      mode: "test",
      paused: false,
      discord: { connected: false, houseConnected: false, waifuBotCount: 0, warnings: [] },
      queues: { active: 0, configuredGuilds: 0 }
    });
    const app = await createApiServer({ dataRoot: root, runtime, storage: new StorageService(root) });
    closers.push(() => app.close());
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const snapshot = await readSnapshot(address);
    const parsed = JSON.parse(snapshot) as { queries: unknown[]; replies: unknown[] };
    expect(parsed.queries.length).toBeGreaterThanOrEqual(2);
    for (const marker of OPAQUE) expect(snapshot).not.toContain(marker);
    expect(snapshot).not.toContain("nativeState");
  });

  it("a life, maintenance, compaction or web call is captured as metadata only; the assistant keeps its content (M14)", async () => {
    const reply = (): ProviderEvent[] => [
      { type: "message_start", id: "r2" },
      { type: "text_delta", text: "PRIVATE-REPLY" },
      { type: "usage", inputTokens: 12, outputTokens: 3 },
      { type: "done", stopReason: "end_turn" }
    ];
    const anthropic = fakeAdapter(ANTHROPIC_MESSAGES, [reply, reply, reply, reply, reply]);
    const client = new ModelClient({ winter: fakeWinter(anthropic), credentials: () => "sk-test" });
    const route = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
    const messages = [{ role: "user" as const, content: "PRIVATE-DM from Kevin" }];
    for (const purpose of ["life", "maintenance", "compaction", "web"] as const) {
      const before = recentQueries().length;
      await client.call({ route, system: ["PRIVATE-NOTES"], messages, attribution: { purpose, waifuId: "ella" } });
      const query = recentQueries().at(-1)!;
      const answer = recentReplies().at(-1)!;
      expect(recentQueries().length).toBe(before + 1);
      expect(query).toMatchObject({ role: purpose, providerId: "anthropic", modelId: "claude-sonnet-5-5", metadataOnly: true, payload: { messageCount: 1 } });
      expect(answer).toMatchObject({ metadataOnly: true, ok: true, payload: { finishReason: "stop", usage: { inputTokens: 12, outputTokens: 3 } } });
      expect(typeof (answer.payload as { durationMs?: unknown }).durationMs).toBe("number");
      expect(JSON.stringify([query, answer])).not.toMatch(/PRIVATE/u);
    }
    await client.call({ route, system: ["A"], messages, attribution: { purpose: "assistant" } });
    expect(JSON.stringify(recentQueries().at(-1))).toContain("PRIVATE-DM from Kevin");
    expect(JSON.stringify(recentReplies().at(-1))).toContain("PRIVATE-REPLY");
  });

  it("strips opaque keys at any depth and keeps everything else", () => {
    expect(
      withoutReasoningPayloads({
        messages: [
          { role: "assistant", nativeState: { items: [1] }, content: [{ type: "text", text: "ok" }, { type: "reasoning", summary: "x" }] },
          { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "r", reasoning_details: [{ text: "x" }] }] }
        ]
      })
    ).toEqual({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "reasoning", omitted: true }] },
        { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "r" }] }
      ]
    });
  });
});
