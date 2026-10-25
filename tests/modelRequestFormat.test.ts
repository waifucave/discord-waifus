// The wire shape of a life request for every curated route (Living cast spec §5.4, §9.1): a log in
// which one turn ended on a user message (here a capped round) and the next turn's notifications
// follow goes through winter's history renderer and each family's REAL adapter to a loopback
// server. No family receives two user messages in a row (DeepSeek's reasoning models refuse
// successive same-role messages; winter's chat-completions mapper does not join them), nothing is
// lost, and the tool results still open the message that answers the tool calls.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { catalogModel } from "../src/models/catalog.js";
import { ModelClient } from "../src/models/client.js";
import { DEFAULT_ALLOWED_ROUTES } from "../src/models/defaults.js";
import { joinAdjacentUserMessages } from "../src/models/messageShape.js";
import { createWinterRuntime } from "../src/models/winter.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

/** A loopback endpoint that keeps each request body and refuses it (so no stream format is needed). */
async function capture(): Promise<{ baseUrl: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "captured" } }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

const TIME = "[Sat 24 Oct 14:06 · awake]";
/** Turn 1: a wake, a tool call, its results and the cap line; turn 2: new notifications. */
const LOG: ProviderMessageLike[] = [
  { role: "user", content: [{ type: "text", text: "<notifications>\n- mention · bake-club/#general · from Kevin\n</notifications>" }, { type: "text", text: TIME }] },
  { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "list_places", input: {} }] },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_1", content: "rooms: bake-club/#general" },
      { type: "text", text: "[system] turn ended: max tool rounds" },
      { type: "text", text: TIME }
    ]
  },
  { role: "user", content: [{ type: "text", text: "<notifications>\n- dm · Kevin · \"SECOND-TURN\"\n</notifications>" }, { type: "text", text: TIME }] }
];
const TOOLS = [{ name: "list_places", description: "Your places.", inputSchema: { type: "object", properties: {} } }];

/** The conversation's role sequence as each wire format spells it. */
function roles(body: Record<string, unknown>): string[] {
  if (Array.isArray(body.messages)) return (body.messages as Array<{ role: string }>).map((message) => message.role).filter((role) => role !== "system" && role !== "developer");
  if (Array.isArray(body.input)) return (body.input as Array<{ role?: string; type?: string }>).map((item) => item.role ?? item.type ?? "?").filter((role) => role !== "system" && role !== "developer");
  if (Array.isArray(body.contents)) return (body.contents as Array<{ role: string }>).map((content) => content.role);
  throw new Error(`unknown wire format: ${Object.keys(body).join(", ")}`);
}

const routes = DEFAULT_ALLOWED_ROUTES.map((key) => {
  const slash = key.indexOf("/");
  return { providerId: key.slice(0, slash), modelId: key.slice(slash + 1) };
}).filter((route) => catalogModel(route) !== undefined);

describe("life request format per curated route", () => {
  it("joins adjacent user messages, never a tool-results message onto the one before", () => {
    const joined = joinAdjacentUserMessages(LOG);
    expect(joined.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect((joined[2]!.content as Array<{ type: string }>).map((block) => block.type)).toEqual(["tool_result", "text", "text", "text", "text"]);
    // Request k (ending at the capped results) stays a block prefix of request k+1.
    expect(JSON.stringify(joined[2]!.content).startsWith(JSON.stringify(LOG[2]!.content).slice(0, -1))).toBe(true);
    expect(joinAdjacentUserMessages([LOG[0]!, LOG[2]!]).map((message) => message.role)).toEqual(["user", "user"]);
  });

  it.each(routes)("$providerId/$modelId: no two user messages in a row, nothing lost", async (route) => {
    const { baseUrl, bodies } = await capture();
    const client = new ModelClient({ winter: createWinterRuntime(), credentials: () => "sk-test", providerAlerts: new ProviderAlerts(), connection: () => ({ baseUrl, local: true }) });
    await client.call({ route, system: ["A", "B"], messages: LOG, tools: TOOLS, attribution: { purpose: "life", waifuId: "ella" } }).catch(() => undefined);
    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies[bodies.length - 1]!;
    const sequence = roles(body);
    for (let index = 1; index < sequence.length; index += 1) expect(`${sequence[index - 1]} → ${sequence[index]}`).not.toBe("user → user");
    const wire = JSON.stringify(body);
    expect(wire).toContain("SECOND-TURN");
    expect(wire).toContain("rooms: bake-club/#general");
    expect(wire.indexOf("rooms: bake-club/#general")).toBeLessThan(wire.indexOf("SECOND-TURN"));
  });
});
