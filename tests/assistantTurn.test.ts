// The dashboard assistant on the Living cast ModelClient: the real service, the real self-REST
// tools and a real ModelClient whose winter adapter is a scripted fake.
import type { ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantActionStore } from "../src/api/assistant/actions.js";
import { conversationOwner, ConversationStore, type AssistantEvent } from "../src/api/assistant/conversations.js";
import { ASSISTANT_MAX_TOOL_CALLS, AssistantTurnError, runAssistantTurn } from "../src/api/assistant/service.js";
import { LOCAL_REQUEST_PRINCIPAL } from "../src/api/requestPrincipal.js";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { ModelClient } from "../src/models/client.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import type { UsageLedger } from "../src/orchestration/usageLedger.js";
import type { UsageLedgerEntry } from "../src/shared/schemas/usage.js";
import { StorageService } from "../src/storage/storageService.js";
import { CHAT_COMPLETIONS, fakeAdapter, fakeWinter, textTurn, type ScriptedTurn } from "./modelFakes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const roots: string[] = [];
const apps: Array<{ close(): Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map(removeTempRoot));
});

const toolCallTurn = (name: string, args: Record<string, unknown> = {}, id = `call-${name}`): ProviderEvent[] => [
  { type: "message_start" },
  { type: "tool_call_start", id, name },
  { type: "tool_call_delta", id, argumentsJsonDelta: JSON.stringify(args) },
  { type: "tool_call_end", id },
  { type: "usage", inputTokens: 10, outputTokens: 5 },
  { type: "done", stopReason: "tool_use" }
];

async function setup(scripts: ScriptedTurn[], o: { assistantModel?: Record<string, unknown> | null } = {}) {
  const root = await makeTempRoot();
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
  apps.push(app);
  await app.inject({ method: "PUT", url: "/api/providers/deepseek/credentials", payload: { apiKey: "sk-assistant-test" } });
  if (o.assistantModel !== null) {
    const saved = await app.inject({
      method: "PUT",
      url: "/api/assistant/config",
      payload: { model: o.assistantModel ?? { providerId: "deepseek", modelId: "deepseek-flash", effort: "high" } }
    });
    expect(saved.statusCode, saved.body).toBe(200);
  }
  const adapter = fakeAdapter(CHAT_COMPLETIONS, scripts);
  const lines: UsageLedgerEntry[] = [];
  const ledger: UsageLedger = { record: async (entry) => void lines.push(entry as UsageLedgerEntry), flush: async () => undefined };
  const modelClient = new ModelClient({ winter: fakeWinter(adapter), dataRoot: root, usageLedger: ledger, providerAlerts: new ProviderAlerts() });
  const store = new ConversationStore();
  const actor = conversationOwner(LOCAL_REQUEST_PRINCIPAL);
  const { id } = store.create(actor);
  const events: AssistantEvent[] = [];
  store.subscribe(id, actor, (event) => events.push(event));
  const deps = {
    app,
    store,
    actions: new AssistantActionStore(),
    dataRoot: root,
    actor,
    principal: LOCAL_REQUEST_PRINCIPAL,
    authorizationPrincipal: LOCAL_REQUEST_PRINCIPAL,
    delegation: { conversationId: id },
    authorizePrincipal: () => true,
    modelClient
  };
  const turn = (content: string) => runAssistantTurn(deps, id, content);
  return { app, root, adapter, lines, store, actor, id, events, turn };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 120));

describe("assistant turn on ModelClient", () => {
  it("runs the tool loop through winter: frozen system prompt, cache key, effort, tools, tool results and text deltas", async () => {
    const h = await setup([
      () => toolCallTurn("list_waifus"),
      () => [
        { type: "text_delta", text: "You have " },
        { type: "text_delta", text: "some waifus." },
        { type: "usage", inputTokens: 20, outputTokens: 6 },
        { type: "done", stopReason: "end_turn" }
      ]
    ]);
    const reply = await h.turn("how many waifus?");
    expect(reply).toBe("You have some waifus.");
    expect(h.adapter.calls).toHaveLength(2);

    const [first, second] = h.adapter.calls.map((call) => call.request);
    expect(first!.system).toContain("You are Norma");
    expect(first!.systemBlocks?.[0]?.cacheScope).toBe("org");
    expect(first!.cacheTtl).toBe("1h");
    expect(first!.cacheKey).toBe(`assistant:${h.id}`);
    expect(first!.effort).toBe("high");
    expect(first!.tools?.map((tool) => tool.name)).toContain("list_waifus");
    expect(first!.tools?.every((tool) => typeof tool.inputSchema === "object")).toBe(true);
    for (const call of h.adapter.calls) expect(call.request.messages.some((message) => message.role === "system")).toBe(false);
    // The second round carries the tool call and its result.
    expect(JSON.stringify(second!.messages)).toContain("list_waifus");
    expect(second!.system).toBe(first!.system);

    await settle();
    const types = h.events.map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["turn_started", "tool_call", "tool_result", "text_delta", "text", "turn_completed"]));
    expect(h.events.filter((event) => event.type === "text_delta").map((event) => (event as { content: string }).content).join("")).toBe("You have some waifus.");
    const stored = h.store.get(h.id, h.actor)!;
    expect(stored.messages.some((message) => message.role === "event" && message.event.type === "text_delta")).toBe(false);
    expect(stored.messages.filter((message) => message.role !== "event").map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(stored.chat.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(h.lines.map((line) => line.purpose)).toEqual(["assistant", "assistant"]);
    expect(h.lines[0]).toMatchObject({ conversationKey: `assistant:${h.id}`, providerId: "deepseek", modelId: "deepseek-flash", status: "ok" });
  });

  it("freezes the system prompt for the whole conversation", async () => {
    const h = await setup([() => textTurn("first"), () => textTurn("second")]);
    await h.turn("hi");
    await h.app.inject({ method: "POST", url: "/api/waifus", payload: { id: "newcomer", name: "Newcomer", displayName: "Newcomer" } });
    await h.turn("again");
    const [first, second] = h.adapter.calls.map((call) => call.request);
    expect(second!.system).toBe(first!.system);
    expect(second!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
  });

  it("stops after the per-turn tool call limit with a best-effort reply", async () => {
    const h = await setup([() => toolCallTurn("get_runtime_status")]);
    const reply = await h.turn("loop forever");
    expect(reply.toLowerCase()).toContain("tool call limit");
    expect(h.adapter.calls).toHaveLength(ASSISTANT_MAX_TOOL_CALLS);
    await settle();
    expect(h.events.filter((event) => event.type === "tool_call")).toHaveLength(ASSISTANT_MAX_TOOL_CALLS);
  });

  it("cuts long tool results at 6000 characters before the model sees them", async () => {
    let secondRequest: TurnRequest | undefined;
    const h = await setup([
      () => toolCallTurn("get_waifu", { id: "long" }),
      (request) => {
        secondRequest = request;
        return textTurn("done");
      }
    ]);
    await h.app.inject({ method: "POST", url: "/api/waifus", payload: { id: "long", name: "Long", displayName: "Long", persona: "p".repeat(9000) } });
    await h.turn("show long");
    const sent = JSON.stringify(secondRequest!.messages);
    expect(sent).toContain("[truncated]");
    expect(sent).not.toContain("p".repeat(6001));
  });

  it("uses the first configured waifu's model when the assistant has none", async () => {
    const h = await setup([() => textTurn("borrowed")], { assistantModel: null });
    await h.app.inject({
      method: "POST",
      url: "/api/waifus",
      payload: { id: "ella", name: "Ella", displayName: "Ella", model: { providerId: "deepseek", modelId: "deepseek-flash", effort: "low" } }
    });
    expect(await h.turn("hi")).toBe("borrowed");
    expect(h.adapter.calls[0]!.request.effort).toBe("low");
    expect(h.lines[0]).toMatchObject({ providerId: "deepseek", modelId: "deepseek-flash" });
  });

  it("503s without a usable model or key, and reports model failures as a turn error", async () => {
    const none = await setup([() => textTurn("unused")], { assistantModel: null });
    await expect(none.turn("hi")).rejects.toMatchObject({ statusCode: 503 });
    expect(none.adapter.calls).toHaveLength(0);

    const noKey = await setup([() => textTurn("unused")], { assistantModel: { providerId: "openai", modelId: "gpt-6-luna" } });
    const failure = await noKey.turn("hi").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AssistantTurnError);
    expect((failure as AssistantTurnError).statusCode).toBe(503);
    expect(String((failure as Error).message)).toMatch(/openai/);

    const broken = await setup([() => [{ type: "error", error: { code: "server", message: "upstream down", status: 500, retryable: false } }]]);
    await expect(broken.turn("hi")).rejects.toMatchObject({ statusCode: 500 });
    await settle();
    expect(broken.events.some((event) => event.type === "error")).toBe(true);
    expect(broken.store.get(broken.id, broken.actor)!.busy).toBe(false);
  });
});
