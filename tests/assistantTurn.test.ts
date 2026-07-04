import { describe, expect, it } from "vitest";
import { createGateway, type ChatResponse } from "@waifucave/gateway";
import { createGatewayModelPipeline } from "../src/orchestration/pipeline/gatewayPipeline.js";

function fakeGateway(responses: ChatResponse[]) {
  const real = createGateway({});
  const calls: unknown[] = [];
  return {
    gateway: new Proxy(real, {
      get(target, prop) {
        if (prop === "chat") {
          return async (request: unknown) => {
            calls.push(request);
            const next = responses.shift();
            if (!next) throw new Error("no scripted response left");
            return next;
          };
        }
        return Reflect.get(target, prop);
      }
    }),
    calls
  };
}

const response = (content: ChatResponse["content"], finishReason: ChatResponse["finishReason"]): ChatResponse => ({
  id: "r",
  provider: "deepseek",
  model: "deepseek-v4-pro",
  content,
  finishReason,
  usage: { inputTokens: 1, outputTokens: 1 },
  warnings: []
});

describe("generateAssistantTurn", () => {
  it("loops on tool calls, executes them, and returns the final text", async () => {
    const { gateway, calls } = fakeGateway([
      response([{ type: "toolCall", id: "c1", name: "list_waifus", arguments: "{}" }], "tool_calls"),
      response([{ type: "text", text: "You have 5 waifus." }], "stop")
    ]);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      queryRole: "assistant",
      gateway: gateway as never
    });
    const executed: string[] = [];
    const events: string[] = [];
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "You are the assistant." },
        { role: "user", content: "how many waifus?" }
      ],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async (name) => {
        executed.push(name);
        return "[5 waifus]";
      },
      onEvent: (event) => events.push(event.type)
    });
    expect(executed).toEqual(["list_waifus"]);
    expect(events).toEqual(["tool_call", "tool_result"]);
    expect(result.content).toBe("You have 5 waifus.");
    const second = calls[1] as { messages: Array<{ role: string }> };
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("stops after maxToolCalls and returns a best-effort message", async () => {
    const loopy = Array.from({ length: 3 }, (_, i) =>
      response([{ type: "toolCall", id: `c${i}`, name: "list_waifus", arguments: "{}" }], "tool_calls")
    );
    const { gateway } = fakeGateway(loopy);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      queryRole: "assistant",
      gateway: gateway as never
    });
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-pro",
      messages: [{ role: "user", content: "loop forever" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async () => "ok",
      maxToolCalls: 2
    });
    expect(result.content.toLowerCase()).toContain("tool call limit");
  });

  it("turns executeTool exceptions into tool-result strings instead of failing the turn", async () => {
    const { gateway } = fakeGateway([
      response([{ type: "toolCall", id: "c1", name: "explode", arguments: "{}" }], "tool_calls"),
      response([{ type: "text", text: "That tool failed, sorry." }], "stop")
    ]);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      queryRole: "assistant",
      gateway: gateway as never
    });
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-pro",
      messages: [{ role: "user", content: "boom" }],
      tools: [{ name: "explode", parameters: { type: "object", properties: {} } }],
      executeTool: async () => {
        throw new Error("kaboom");
      }
    });
    expect(result.content).toBe("That tool failed, sorry.");
    const toolTurn = result.messages.find((m) => m.role === "tool") as { content: string };
    expect(toolTurn.content).toContain("kaboom");
  });
});
