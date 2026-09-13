# Assistant Backbone (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backend assistant agent — its own config slot, a chat API with SSE, a gateway tool loop, and a self-REST tool registry that reads and directly writes app state — plus the API additions (`/api/logs`, `/api/docs*`) that make the whole app operable by any external agent.

**Architecture:** The assistant is a fourth agent config (`user/assistant/config.json`) resolved to the orchestrator's model when unset. Chat turns run through a new `generateAssistantTurn` on `GatewayModelPipeline`: a tool loop over `gateway.chat` (toolChoice auto) with an injected `executeTool` callback. Tools dispatch in-process to the app's own Fastify handlers via `app.inject`, so zod bodies, `gateway.validate()` 400s, and `expectedRevision` 409s all apply unchanged; writes are read-modify-write with one 412 retry. Conversations are in-memory (LRU), with per-conversation SSE.

**Tech Stack:** TypeScript ESM (NodeNext — `.js` import specifiers), Fastify, Zod, `@waifucave/gateway` 0.1.5, Vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-dashboard-redesign-design.md` (Phase 1 section is normative).
- Agent writes are DIRECT — no proposal/approval layer.
- Provider API keys are write-only to the agent (list shows redacted status; no read-back).
- All new endpoints mirror existing error conventions (`conflict()` 409, zod 400s).
- `dist/` is generated — never edit; backend changes need `npm run build:backend` for the shipped CLI.
- Tests use isolated temp roots via `tests/testUtils.ts` helpers.

---

### Task 1: Assistant agent config slot

**Files:**
- Modify: `src/api/server.ts` (readAgentConfig/updateAgentConfig unions ~line 833/852; routes after reviewer block ~line 372)
- Modify: `src/shared/queryLog.ts:1-8` (QueryRole union)
- Modify: `src/config/layout.ts` (add `user/assistant` dir)
- Test: `tests/api.test.ts`

**Interfaces:**
- Produces: `GET/PUT /api/assistant/config` (AgentConfig shape, `expectedRevision` semantics); `readAgentConfig(storage, "assistant")` usable by later tasks; QueryRole `"assistant"`.

- [x] **Step 1: Write the failing test** — in `tests/api.test.ts` after the reviewer/orchestrator config tests:

```ts
  it("serves and updates the assistant agent config", async () => {
    const { app } = await makeApp();
    try {
      const initial = await app.inject({ method: "GET", url: "/api/assistant/config" });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({ enabled: false, contextWindow: 20 });

      const put = await app.inject({
        method: "PUT",
        url: "/api/assistant/config",
        payload: { expectedRevision: initial.json().revision, providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().modelId).toBe("claude-haiku-4-5-20251001");

      const stale = await app.inject({
        method: "PUT",
        url: "/api/assistant/config",
        payload: { expectedRevision: initial.json().revision, modelId: "claude-haiku-4-5-20251001" }
      });
      expect(stale.statusCode).toBe(412);
    } finally {
      await app.close();
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api.test.ts -t "assistant agent config"`
Expected: FAIL — 404 on GET /api/assistant/config.

- [x] **Step 3: Implement**

`src/shared/queryLog.ts` — extend the union:

```ts
export type QueryRole =
  | "orchestrator"
  | "waifu"
  | "stage_manager_observer"
  | "stage_manager_librarian"
  | "dream"
  | "reviewer"
  | "assistant";
```

`src/api/server.ts` — widen both helper unions to include `"assistant"`:

```ts
async function readAgentConfig(
  storage: StorageService,
  agent: "orchestrator" | "stage-manager" | "reviewer" | "assistant"
): Promise<AgentConfig> {
```

(same union in `updateAgentConfig`), and add routes after the reviewer block:

```ts
  app.get("/api/assistant/config", async () => readAgentConfig(storage, "assistant"));
  app.put("/api/assistant/config", async (request) => {
    const body = AgentConfigBodySchema.parse(request.body);
    return updateAgentConfig(storage, request, "assistant", body, 20);
  });
```

`src/config/layout.ts` — add `"user/assistant"` to the directories list next to `"user/orchestrator"`.

- [x] **Step 4: Run tests**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS (all).

- [x] **Step 5: Commit**

```bash
git add src/api/server.ts src/shared/queryLog.ts src/config/layout.ts tests/api.test.ts
git commit -m "feat: assistant agent config slot (/api/assistant/config)"
```

---

### Task 2: `GET /api/logs` + docs KB endpoints + KB content

**Files:**
- Create: `docs/assistant-kb/` — `getting-started.md`, `providers-and-models.md`, `waifus.md`, `orchestrator-and-direction.md`, `memory.md`, `discord-setup.md`, `troubleshooting.md`, `api.md`
- Create: `src/api/docsKb.ts`
- Modify: `src/api/server.ts` (routes), `package.json` (`files` array)
- Test: `tests/api.test.ts`

**Interfaces:**
- Produces: `GET /api/logs?limit=N` → `{ entries: [{time, level, message, context}] }` (newest last, from `logger.recent()`); `GET /api/docs` → `{ docs: [{slug, title, description}] }`; `GET /api/docs/:slug` → `{ slug, title, content }` (404 unknown slug); `searchDocs(query): Array<{slug, title, score}>` and `readDoc(slug)` exported from `docsKb.ts` for Task 5's tools.

- [x] **Step 1: Write the failing tests** — in `tests/api.test.ts`:

```ts
  it("serves recent logs and the assistant docs KB", async () => {
    const { app } = await makeApp();
    try {
      const logs = await app.inject({ method: "GET", url: "/api/logs?limit=5" });
      expect(logs.statusCode).toBe(200);
      expect(Array.isArray(logs.json().entries)).toBe(true);

      const index = await app.inject({ method: "GET", url: "/api/docs" });
      expect(index.statusCode).toBe(200);
      const slugs = index.json().docs.map((d: { slug: string }) => d.slug);
      expect(slugs).toContain("getting-started");
      expect(slugs).toContain("api");

      const doc = await app.inject({ method: "GET", url: "/api/docs/waifus" });
      expect(doc.statusCode).toBe(200);
      expect(doc.json().content).toContain("persona");

      const missing = await app.inject({ method: "GET", url: "/api/docs/nope" });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/api.test.ts -t "docs KB"`
Expected: FAIL — 404 on /api/logs.

- [x] **Step 3: Implement `src/api/docsKb.ts`**

```ts
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/api/docsKb.js and src/api/docsKb.ts sit at the same depth from the package root.
const KB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "assistant-kb");

export type DocMeta = { slug: string; title: string; description: string };

function parseHeader(content: string): { title: string; description: string } {
  const lines = content.split("\n");
  const title = lines.find((l) => l.startsWith("# "))?.slice(2).trim() ?? "Untitled";
  const description = lines.find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? "";
  return { title, description };
}

export async function listDocs(): Promise<DocMeta[]> {
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith(".md")).sort();
  return Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(KB_DIR, file), "utf8");
      return { slug: file.replace(/\.md$/, ""), ...parseHeader(content) };
    })
  );
}

export async function readDoc(slug: string): Promise<{ slug: string; title: string; content: string } | undefined> {
  if (!/^[a-z0-9-]+$/.test(slug)) return undefined;
  try {
    const content = await readFile(path.join(KB_DIR, `${slug}.md`), "utf8");
    return { slug, title: parseHeader(content).title, content };
  } catch {
    return undefined;
  }
}

// Naive scoring: count query-term occurrences, title hits weighted 5x.
export async function searchDocs(query: string): Promise<Array<DocMeta & { score: number }>> {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const docs = await listDocs();
  const scored = await Promise.all(
    docs.map(async (doc) => {
      const content = (await readDoc(doc.slug))!.content.toLowerCase();
      const title = doc.title.toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += (content.split(term).length - 1) + (title.includes(term) ? 5 : 0);
      }
      return { ...doc, score };
    })
  );
  return scored.filter((d) => d.score > 0).sort((a, b) => b.score - a.score);
}
```

Routes in `src/api/server.ts` (near the events route), using the existing `logger` option (`options.logger`):

```ts
  app.get("/api/logs", async (request) => {
    const limit = Math.min(Number((request.query as Record<string, string>).limit ?? 100), 500);
    const entries = options.logger?.recent?.() ?? [];
    return { entries: entries.slice(-limit) };
  });

  app.get("/api/docs", async () => ({ docs: await listDocs() }));
  app.get("/api/docs/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const doc = await readDoc(slug);
    if (!doc) return reply.code(404).send({ error: "unknown doc" });
    return doc;
  });
```

(import `listDocs, readDoc` from `./docsKb.js`).

- [x] **Step 4: Write the KB files** — 8 markdown files under `docs/assistant-kb/`. Each opens with `# Title` + one-line description, then task-oriented sections. Content is drawn from CLAUDE.md, the spec, and the live API surface; `api.md` documents every REST endpoint (method, path, body shape, revision semantics) so external agents can drive the app. Required coverage per file:
  - `getting-started.md` — what the app is, data root, start/stop, dashboard URL, first-run steps.
  - `providers-and-models.md` — provider keys (write-only), gateway registry, model capability lookup, per-model params & validation errors.
  - `waifus.md` — waifu config fields (persona, model, params, contextWindow, availability, tools, promptLayout), digests, prompt-layout slots.
  - `orchestrator-and-direction.md` — orchestrator decisions/directives, stage-manager observer + dreams, reviewer, assistant slot + model fallback.
  - `memory.md` — MemoryRecord kinds, retrieval, pinning, dream consolidation, /api/memories CRUD.
  - `discord-setup.md` — creating bot applications, tokens, intents, inviting bots, per-channel enablement.
  - `troubleshooting.md` — common failures (missing provider key, model 400s incl. thinking×forced-tools, Discord connect issues, revision conflicts), where logs/queries live.
  - `api.md` — full endpoint table + `expectedRevision` explanation + example curl for read-modify-write.

- [x] **Step 5: Ship the KB** — `package.json` `files` array: add `"docs/assistant-kb/"`.

- [x] **Step 6: Run tests**

Run: `npx vitest run tests/api.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/api/docsKb.ts src/api/server.ts docs/assistant-kb package.json tests/api.test.ts
git commit -m "feat: /api/logs + assistant docs KB (/api/docs)"
```

---

### Task 3: In-memory conversation store with SSE hub

**Files:**
- Create: `src/api/assistant/conversations.ts`
- Test: `tests/assistantConversations.test.ts`

**Interfaces:**
- Produces:
```ts
export type AssistantEvent =
  | { type: "turn_started" }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "turn_completed" }
  | { type: "error"; message: string };
export type StoredMessage = { role: "user" | "assistant"; content: string; at: string }
  | { role: "event"; event: AssistantEvent; at: string };
export class ConversationStore {
  create(): { id: string };
  get(id: string): { id: string; messages: StoredMessage[]; chat: ChatMessage[]; busy: boolean } | undefined;
  appendChat(id: string, messages: ChatMessage[]): void;      // replaces the model-facing transcript
  appendStored(id: string, message: StoredMessage): void;      // display transcript + fanned out to SSE subscribers when role === "event"
  setBusy(id: string, busy: boolean): void;
  subscribe(id: string, listener: (event: AssistantEvent) => void): () => void;
  emit(id: string, event: AssistantEvent): void;               // fan out + record as StoredMessage
}
```
(`ChatMessage` is `@waifucave/gateway`'s type.) LRU cap 20 conversations, 200 stored messages each (oldest dropped).

- [x] **Step 1: Write the failing test** — `tests/assistantConversations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/api/assistant/conversations.js";

describe("ConversationStore", () => {
  it("creates, records messages, and fans out events to subscribers", () => {
    const store = new ConversationStore();
    const { id } = store.create();
    const seen: string[] = [];
    const unsubscribe = store.subscribe(id, (event) => seen.push(event.type));

    store.emit(id, { type: "turn_started" });
    store.emit(id, { type: "tool_call", name: "list_waifus", arguments: "{}" });
    unsubscribe();
    store.emit(id, { type: "turn_completed" });

    expect(seen).toEqual(["turn_started", "tool_call"]);
    const convo = store.get(id)!;
    expect(convo.messages.filter((m) => m.role === "event")).toHaveLength(3);
  });

  it("evicts the oldest conversation past the cap of 20", () => {
    const store = new ConversationStore();
    const first = store.create().id;
    for (let i = 0; i < 20; i++) store.create();
    expect(store.get(first)).toBeUndefined();
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/assistantConversations.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Implement** — `src/api/assistant/conversations.ts` per the interface above (Map insertion order for LRU; `randomUUID()` ids; `emit` = push StoredMessage `{role:"event"}` + notify listeners; drop oldest stored messages past 200).

- [x] **Step 4: Run tests** — Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/api/assistant/conversations.ts tests/assistantConversations.test.ts
git commit -m "feat: assistant conversation store with SSE fan-out"
```

---

### Task 4: `generateAssistantTurn` pipeline tool loop

**Files:**
- Modify: `src/providers/types.ts` (types + optional ModelPipeline method)
- Modify: `src/orchestration/pipeline/gatewayPipeline.ts` (implementation)
- Test: `tests/assistantTurn.test.ts`

**Interfaces:**
- Produces (in `src/providers/types.ts`):
```ts
export type AssistantTurnEvent =
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string };
export type AssistantTurnRequest = {
  modelId: string;
  messages: import("@waifucave/gateway").ChatMessage[]; // full transcript incl. system + new user turn
  tools: import("@waifucave/gateway").ToolDef[];
  executeTool: (name: string, argsJson: string) => Promise<string>;
  onEvent?: (event: AssistantTurnEvent) => void;
  params?: Record<string, unknown>;
  maxToolCalls?: number; // default 12
  signal?: AbortSignal;
};
export type AssistantTurnResult = {
  content: string;                                        // final text reply
  messages: import("@waifucave/gateway").ChatMessage[];   // transcript with assistant/tool turns appended
};
// on ModelPipeline:
generateAssistantTurn?(request: AssistantTurnRequest): Promise<AssistantTurnResult>;
```

- [x] **Step 1: Write the failing test** — `tests/assistantTurn.test.ts` with a scripted fake gateway (uses `GatewayPipelineOptions.gateway` injection):

```ts
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
  id: "r", provider: "deepseek", model: "deepseek-v4-pro", content, finishReason,
  usage: { inputTokens: 1, outputTokens: 1 }, warnings: []
});

describe("generateAssistantTurn", () => {
  it("loops on tool calls, executes them, and returns the final text", async () => {
    const { gateway, calls } = fakeGateway([
      response([{ type: "toolCall", id: "c1", name: "list_waifus", arguments: "{}" }], "tool_calls"),
      response([{ type: "text", text: "You have 5 waifus." }], "stop")
    ]);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek", modelId: "deepseek-v4-pro", queryRole: "assistant", gateway: gateway as never
    });
    const executed: string[] = [];
    const events: string[] = [];
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-pro",
      messages: [{ role: "system", content: "You are the assistant." }, { role: "user", content: "how many waifus?" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async (name) => { executed.push(name); return "[5 waifus]"; },
      onEvent: (event) => events.push(event.type)
    });
    expect(executed).toEqual(["list_waifus"]);
    expect(events).toEqual(["tool_call", "tool_result"]);
    expect(result.content).toBe("You have 5 waifus.");
    // Second gateway call carries the tool result turn.
    const second = calls[1] as { messages: Array<{ role: string }> };
    expect(second.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("stops after maxToolCalls and returns a best-effort message", async () => {
    const loopy = Array.from({ length: 3 }, (_, i) =>
      response([{ type: "toolCall", id: `c${i}`, name: "list_waifus", arguments: "{}" }], "tool_calls")
    );
    const { gateway } = fakeGateway(loopy);
    const pipeline = createGatewayModelPipeline({
      providerId: "deepseek", modelId: "deepseek-v4-pro", queryRole: "assistant", gateway: gateway as never
    });
    const result = await pipeline.generateAssistantTurn!({
      modelId: "deepseek-v4-pro",
      messages: [{ role: "user", content: "loop forever" }],
      tools: [{ name: "list_waifus", parameters: { type: "object", properties: {} } }],
      executeTool: async () => "ok",
      maxToolCalls: 2
    });
    expect(result.content).toContain("tool call limit");
  });
});
```

- [x] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/assistantTurn.test.ts`
Expected: FAIL — `generateAssistantTurn` is undefined.

- [x] **Step 3: Implement** — in `GatewayModelPipeline`:

```ts
  async generateAssistantTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
    const transcript = [...request.messages];
    const limit = request.maxToolCalls ?? 12;
    let executedCalls = 0;
    for (let round = 0; round < limit + 1; round++) {
      const response = await this.chat({
        messages: transcript,
        tools: request.tools,
        sampling: { params: request.params },
        signal: request.signal
      });
      const toolCalls = response.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("");
      if (toolCalls.length === 0) {
        transcript.push({ role: "assistant", content: text });
        return { content: text, messages: transcript };
      }
      transcript.push({ role: "assistant", content: response.content.filter((b) => b.type !== "reasoning") });
      for (const call of toolCalls) {
        if (executedCalls >= limit) {
          transcript.push({ role: "tool", toolCallId: call.id, content: "Tool call limit reached for this turn." });
          continue;
        }
        executedCalls += 1;
        request.onEvent?.({ type: "tool_call", name: call.name, arguments: call.arguments });
        let result: string;
        try {
          result = await request.executeTool(call.name, call.arguments);
        } catch (error) {
          result = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (result.length > 6000) result = `${result.slice(0, 6000)}\n[truncated]`;
        request.onEvent?.({ type: "tool_result", name: call.name, result });
        transcript.push({ role: "tool", toolCallId: call.id, content: result });
      }
      if (executedCalls >= limit) {
        const summary = "I hit the tool call limit for this turn — here's where I got to.";
        transcript.push({ role: "assistant", content: summary });
        return { content: summary, messages: transcript };
      }
    }
    const fallback = "I hit the tool call limit for this turn.";
    return { content: fallback, messages: [...transcript, { role: "assistant", content: fallback }] };
  }
```

(import `ToolCallBlock` type from the gateway; add `AssistantTurnRequest/Result` to the types import from `providers/types.js`.) Note the loop guard: `executedCalls >= limit` finishes the turn with an explicit limit message rather than spinning.

- [x] **Step 4: Run tests** — `npx vitest run tests/assistantTurn.test.ts` — Expected: PASS. Also `npx vitest run tests/gatewayPipeline.test.ts` — Expected: PASS (no regressions).

- [x] **Step 5: Commit**

```bash
git add src/providers/types.ts src/orchestration/pipeline/gatewayPipeline.ts tests/assistantTurn.test.ts
git commit -m "feat: generateAssistantTurn gateway tool loop"
```

---

### Task 5: Tool registry with self-REST dispatch

**Files:**
- Create: `src/api/assistant/tools.ts`
- Test: `tests/assistantTools.test.ts`

**Interfaces:**
- Produces:
```ts
export type AssistantToolContext = { app: FastifyInstance };
export type AssistantTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;           // JSON schema
  execute: (ctx: AssistantToolContext, args: Record<string, unknown>) => Promise<string>;
};
export const ASSISTANT_TOOLS: AssistantTool[];
export function toolDefs(): ToolDef[];           // gateway shape
export async function executeAssistantTool(ctx, name, argsJson): Promise<string>; // parse args, find tool, run; never throws
```
- Tool list (names must match the spec table): `get_runtime_status`, `list_providers`, `set_provider_key`, `clear_provider_key`, `list_models`, `list_waifus`, `get_waifu`, `create_waifu`, `update_waifu`, `delete_waifu`, `regenerate_waifu_digest`, `list_servers`, `update_channel`, `list_discord_bots`, `update_discord_bots`, `get_agent_config`, `update_agent_config`, `search_memories`, `add_memory`, `update_memory`, `delete_memory`, `trigger_orchestrator`, `trigger_stage_manager`, `runtime_pause`, `runtime_resume`, `runtime_reload`, `read_logs`, `docs_search`, `docs_read`.

**Core mechanics (same for every tool):**

```ts
async function inject(ctx: AssistantToolContext, options: { method: "GET"|"PUT"|"POST"|"PATCH"|"DELETE"; url: string; payload?: unknown }): Promise<{ status: number; body: string }> {
  const response = await ctx.app.inject({ method: options.method, url: options.url, ...(options.payload === undefined ? {} : { payload: options.payload as Record<string, unknown> }) });
  return { status: response.statusCode, body: response.body };
}

// Read-modify-write for revisioned resources: GET → caller merges → PUT with expectedRevision;
// one retry on 409 with a fresh GET.
async function revisionedPut(ctx: AssistantToolContext, url: string, merge: (current: Record<string, unknown>) => Record<string, unknown>): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await inject(ctx, { method: "GET", url });
    if (current.status !== 200) return `GET ${url} failed: ${current.body}`;
    const parsed = JSON.parse(current.body) as Record<string, unknown>;
    const result = await inject(ctx, { method: "PUT", url, payload: { ...merge(parsed), expectedRevision: parsed.revision } });
    if (result.status !== 409) return result.body;
  }
  return "Conflict: the resource changed twice while I was writing. Try again.";
}
```

Redaction: `list_providers` maps the /api/providers response to `{providerId, configured, hint}` only — never key material. `set_provider_key` PUTs `/api/providers/:providerId/credentials` with the user-supplied key and returns only "configured".

- [x] **Step 1: Write the failing tests** — `tests/assistantTools.test.ts` using the same `makeApp()` pattern as `tests/api.test.ts` (copy the helper; it builds `createApiServer` with a temp root):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { executeAssistantTool, toolDefs } from "../src/api/assistant/tools.js";
// makeApp helper copied from tests/api.test.ts (temp root + createApiServer)

describe("assistant tools", () => {
  it("exposes every spec tool as a gateway ToolDef", () => {
    const names = toolDefs().map((tool) => tool.name);
    for (const required of ["list_waifus", "create_waifu", "update_channel", "set_provider_key", "docs_search", "read_logs"]) {
      expect(names).toContain(required);
    }
  });

  it("creates and updates a waifu through the real API handlers", async () => {
    const { app } = await makeApp();
    try {
      const ctx = { app };
      const created = await executeAssistantTool(ctx, "create_waifu", JSON.stringify({ id: "momo", name: "Momo", persona: "sunny chaos gremlin" }));
      expect(JSON.parse(created).id).toBe("momo");
      const updated = await executeAssistantTool(ctx, "update_waifu", JSON.stringify({ id: "momo", changes: { displayName: "Momo!" } }));
      expect(JSON.parse(updated).displayName).toBe("Momo!");
      const list = await executeAssistantTool(ctx, "list_waifus", "{}");
      expect(list).toContain("momo");
    } finally {
      await app.close();
    }
  });

  it("never leaks provider keys through list_providers", async () => {
    const { app } = await makeApp();
    try {
      const ctx = { app };
      await executeAssistantTool(ctx, "set_provider_key", JSON.stringify({ providerId: "deepseek", apiKey: "sk-super-secret" }));
      const listed = await executeAssistantTool(ctx, "list_providers", "{}");
      expect(listed).not.toContain("sk-super-secret");
      expect(listed).toContain("deepseek");
    } finally {
      await app.close();
    }
  });

  it("returns tool errors as strings instead of throwing", async () => {
    const { app } = await makeApp();
    try {
      const result = await executeAssistantTool({ app }, "get_waifu", JSON.stringify({ id: "ghost" }));
      expect(result.toLowerCase()).toContain("not found");
    } finally {
      await app.close();
    }
  });
});
```

- [x] **Step 2: Run to verify it fails** — module not found. Expected: FAIL.

- [x] **Step 3: Implement `src/api/assistant/tools.ts`** — the two helpers above plus the tool table. Each tool is a thin mapping; representative entries (the rest follow the same shape against their routes):

```ts
  {
    name: "list_waifus",
    description: "List all configured waifus with id, name, model, and enabled state.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (ctx) => {
      const result = await inject(ctx, { method: "GET", url: "/api/waifus" });
      const waifus = (JSON.parse(result.body).waifus as Array<Record<string, unknown>>).map((w) => ({
        id: w.id, name: w.name, displayName: w.displayName, enabled: w.enabled,
        providerId: w.providerId, modelId: w.modelId
      }));
      return JSON.stringify(waifus);
    }
  },
  {
    name: "update_waifu",
    description: "Update fields on an existing waifu (persona, model, params, availability, tools...). Pass only the fields to change.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, changes: { type: "object" } },
      required: ["id", "changes"], additionalProperties: false
    },
    execute: async (ctx, args) =>
      revisionedPut(ctx, `/api/waifus/${encodeURIComponent(String(args.id))}`, (current) => ({
        ...(args.changes as Record<string, unknown>)
      }))
  },
```

`docs_search`/`docs_read` call `searchDocs`/`readDoc` from `../docsKb.js` directly (no HTTP hop). `read_logs` GETs `/api/logs?limit=N`. `executeAssistantTool` wraps: unknown tool → `"Unknown tool: <name>"`; JSON parse failure → `"Invalid arguments: <error>"`; handler throw → `"Tool failed: <message>"`.

- [x] **Step 4: Run tests** — `npx vitest run tests/assistantTools.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/api/assistant/tools.ts tests/assistantTools.test.ts
git commit -m "feat: assistant tool registry with self-REST dispatch"
```

---

### Task 6: Assistant service + chat routes

**Files:**
- Create: `src/api/assistant/service.ts`
- Create: `src/api/assistant/routes.ts`
- Modify: `src/api/server.ts` (register routes, pass options), `src/api/server.ts` ApiServerOptions (+ `assistant?: { createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline }` test hook)
- Test: `tests/assistantApi.test.ts`

**Interfaces:**
- Produces routes: `POST /api/assistant/conversations` → `{ conversationId }`; `GET /api/assistant/conversations/:id` → `{ id, messages: StoredMessage[] }` (404 unknown); `GET /api/assistant/conversations/:id/stream` → SSE of AssistantEvents; `POST /api/assistant/conversations/:id/messages` `{ content: string }` → `{ reply: string }` (409 if a turn is already running; 503 `{ error }` when no model resolves).
- `service.ts` exports `resolveAssistantTarget(storage, dataRoot)` → `{ ok: true; providerId; modelId; params } | { ok: false; reason: string }` (assistant config → orchestrator fallback → resolveModelTarget → credentials check, mirroring `resolvePersonaDigestPipeline`) and `runAssistantTurn(deps, conversationId, userContent)`.

**System prompt** (in `service.ts`):

```ts
export function assistantSystemPrompt(snapshot: { waifuCount: number; serverCount: number; providerIds: string[]; discordConnected: boolean }): string {
  return [
    "You are the Discord Waifus dashboard assistant. You operate a locally-hosted multi-character Discord bot app on the user's behalf.",
    "You have tools that read AND directly modify live configuration (waifus, servers, providers, agent configs, memories) plus a docs knowledge base (docs_search/docs_read).",
    "Rules:",
    "- Changes apply immediately. For destructive or hard-to-reverse actions (deleting a waifu, replacing a bot token, clearing a provider key), restate what you are about to do and ask the user to confirm in chat before calling the tool.",
    "- Never echo API keys or bot tokens back to the user, even if they appear in tool output.",
    "- Prefer docs_search before answering how-to questions you are not certain about.",
    "- Be concise. Report what you changed with the field values that matter.",
    `Current state: ${snapshot.waifuCount} waifus, ${snapshot.serverCount} servers, providers configured: ${snapshot.providerIds.join(", ") || "none"}, discord ${snapshot.discordConnected ? "connected" : "disconnected"}.`
  ].join("\n");
}
```

`runAssistantTurn` flow: store.get → 404/409 guards → resolve target → pipeline (options.assistant?.createPipeline ?? `createGatewayModelPipeline({ providerId, modelId, queryRole: "assistant", dataRoot })`) → build snapshot (inject GET /api/runtime, /api/waifus, /api/servers, /api/providers) → transcript = existing `chat` messages or fresh `[system]` → append user turn → `emit(turn_started)` → `generateAssistantTurn({ ..., executeTool: (name, args) => executeAssistantTool({ app }, name, args), onEvent: (e) => store.emit(id, e) })` → persist transcript via `appendChat`, stored user/assistant messages, `emit(text)`, `emit(turn_completed)` → return reply. Errors: emit `{type:"error"}` + rethrow as 500 with message. `setBusy` guards concurrency.

SSE route follows the `/api/events` pattern (`reply.raw.writeHead`, replay stored `event` messages, subscribe, heartbeat every 30s, unsubscribe on close).

- [x] **Step 1: Write the failing test** — `tests/assistantApi.test.ts` (fake pipeline via the new `assistant.createPipeline` hook):

```ts
import { describe, expect, it } from "vitest";
import type { ModelPipeline } from "../src/providers/types.js";
// makeApp variant that passes assistant: { createPipeline: () => fakePipeline } and
// pre-seeds an orchestrator config via PUT /api/orchestrator/config + a provider key.

const fakePipeline: ModelPipeline = {
  async generateWaifu() { throw new Error("unused"); },
  async generateAssistantTurn(request) {
    const toolResult = await request.executeTool("list_waifus", "{}");
    request.onEvent?.({ type: "tool_call", name: "list_waifus", arguments: "{}" });
    request.onEvent?.({ type: "tool_result", name: "list_waifus", result: toolResult });
    return { content: `You have ${JSON.parse(toolResult).length} waifus.`, messages: [...request.messages, { role: "assistant", content: "done" }] };
  }
};

describe("assistant chat API", () => {
  it("runs a turn end-to-end through the fake pipeline and real tools", async () => {
    const { app } = await makeApp({ assistantPipeline: fakePipeline });
    try {
      await app.inject({ method: "PUT", url: "/api/providers/deepseek/credentials", payload: { apiKey: "sk-test" } });
      const orch = await app.inject({ method: "GET", url: "/api/orchestrator/config" });
      await app.inject({ method: "PUT", url: "/api/orchestrator/config", payload: { expectedRevision: orch.json().revision, providerId: "deepseek", modelId: "deepseek-v4-pro" } });

      const created = await app.inject({ method: "POST", url: "/api/assistant/conversations" });
      const conversationId = created.json().conversationId;

      const reply = await app.inject({
        method: "POST",
        url: `/api/assistant/conversations/${conversationId}/messages`,
        payload: { content: "how many waifus do I have?" }
      });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().reply).toBe("You have 0 waifus.");

      const transcript = await app.inject({ method: "GET", url: `/api/assistant/conversations/${conversationId}` });
      const roles = transcript.json().messages.map((m: { role: string }) => m.role);
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
      expect(roles).toContain("event");
    } finally {
      await app.close();
    }
  });

  it("503s with a reason when no model is configured anywhere", async () => {
    const { app } = await makeApp();
    try {
      const created = await app.inject({ method: "POST", url: "/api/assistant/conversations" });
      const reply = await app.inject({
        method: "POST",
        url: `/api/assistant/conversations/${created.json().conversationId}/messages`,
        payload: { content: "hi" }
      });
      expect(reply.statusCode).toBe(503);
      expect(reply.json().error).toMatch(/model/i);
    } finally {
      await app.close();
    }
  });
});
```

- [x] **Step 2: Run to verify it fails** — Expected: FAIL (404 on POST /api/assistant/conversations).

- [x] **Step 3: Implement** `service.ts` + `routes.ts` per the interfaces above; register in `createApiServer` (`registerAssistantRoutes(app, { storage, options, store: new ConversationStore() })`).

- [x] **Step 4: Run tests** — `npx vitest run tests/assistantApi.test.ts tests/api.test.ts` — Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/api/assistant/service.ts src/api/assistant/routes.ts src/api/server.ts tests/assistantApi.test.ts
git commit -m "feat: assistant chat API — conversations, turns, SSE"
```

---

### Task 7: Validate, release 1.5.177, deploy Beta, live smoke

**Files:** none new.

- [x] **Step 1:** `npm run typecheck` && `npm run test` — both clean (never pipe through grep).
- [x] **Step 2:** `git push origin main && npm run release:beta -- 1.5.177 --yes --message "feat: assistant backbone — chat API, tool loop, self-REST tools, docs KB"`.
- [x] **Step 3:** Deploy Beta pinned + restart:
```bash
ssh <remote-user>@<tailscale-ip> 'export PATH="$PATH:/opt/homebrew/bin"; npm install -g @waifucave/discord-waifus@1.5.177 && waifus restart'
```
- [x] **Step 4: Live smoke on Beta** — real model end-to-end:
```bash
ssh <remote-user>@<tailscale-ip> 'CID=$(curl -s -X POST http://127.0.0.1:3888/api/assistant/conversations | python3 -c "import json,sys; print(json.load(sys.stdin)[\"conversationId\"])"); curl -s -X POST http://127.0.0.1:3888/api/assistant/conversations/$CID/messages -H "content-type: application/json" -d "{\"content\": \"How many waifus are configured and which models do they use? Do not change anything.\"}"'
```
Expected: JSON reply naming the five waifus/models; `/api/events` capture shows `role: "assistant"` queries; no errors in backend.log.
- [x] **Step 5:** Update memory (`live-server-access.md`): Phase 1 shipped in 1.5.177; note the assistant API surface for future sessions.

---

## Self-Review

- Spec coverage: config slot (T1), /api/logs + docs KB + files entry (T2), conversation store + SSE (T3), pipeline loop (T4), tool registry incl. every spec table row (T5), chat routes + system prompt + model fallback + test hook (T6), release/deploy/live verify (T7). Out-of-scope items (persistence, UI) correctly absent. ✓
- Placeholders: KB prose is outlined per file with required coverage (content written at execution from CLAUDE.md/spec/API knowledge) — acceptable for docs; all code steps carry code. ✓
- Type consistency: `AssistantEvent` shared between store and pipeline events via service mapping (`AssistantTurnEvent` ⊂ `AssistantEvent`); `executeAssistantTool(ctx, name, argsJson)` signature matches T6 usage; `createPipeline` hook returns `ModelPipeline`. ✓
