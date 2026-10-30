// `/norma <text>` (Living cast spec §36): Norma answers a Discord user that `permissions.norma`
// lists, through the real assistant service, tools and API, on a ModelClient whose winter adapter
// is a scripted fake. She can't make card changes from Discord, nor change who may use /norma.
import type { ProviderEvent, TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordNorma, DISCORD_NORMA_CARD_REFUSAL, DISCORD_NORMA_IDLE_MS } from "../src/api/assistant/discordNorma.js";
import { dispatchInternal } from "../src/api/internalDispatch.js";
import { LOCAL_REQUEST_PRINCIPAL } from "../src/api/requestPrincipal.js";
import { createApiServer } from "../src/api/server.js";
import { createRuntimeState } from "../src/backend/runtime.js";
import { loadAppConfig, updateAppConfig } from "../src/config/appConfig.js";
import { ensureDataLayout } from "../src/config/layout.js";
import { ModelClient } from "../src/models/client.js";
import { ProviderAlerts } from "../src/orchestration/providerAlerts.js";
import { CastRuntime } from "../src/orchestration/runtime.js";
import type { UsageLedger } from "../src/orchestration/usageLedger.js";
import { addDiscordUserId } from "../src/frontend/screens/settingsForm.js";
import { StorageService } from "../src/storage/storageService.js";
import { CHAT_COMPLETIONS, fakeAdapter, fakeWinter, textTurn, type ScriptedTurn } from "./modelFakes.js";
import { makeTempRoot, removeTempRoot } from "./testUtils.js";

const ALLOWED = "123456789012345678";
const OTHER = "876543210987654321";

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

function lastUserText(request: TurnRequest): string {
  const last = request.messages[request.messages.length - 1];
  const content = last?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => ("text" in block ? String(block.text) : "content" in block ? JSON.stringify(block.content) : "")).join("\n");
}

async function setup(scripts: ScriptedTurn[], o: { allowed?: string[] } = {}) {
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
  const reload = vi.fn(async () => undefined);
  const adapter = fakeAdapter(CHAT_COMPLETIONS, scripts);
  const ledger: UsageLedger = { record: async () => undefined, flush: async () => undefined };
  const modelClient = new ModelClient({ winter: fakeWinter(adapter), dataRoot: root, usageLedger: ledger, providerAlerts: new ProviderAlerts() });
  let registered: ((request: { userId: string; text: string }) => Promise<string>) | undefined;
  const app = await createApiServer({
    dataRoot: root,
    runtime,
    storage: new StorageService(root),
    assistant: { modelClient },
    runtimeControl: { pause: async () => undefined, resume: async () => undefined, reload },
    discordNorma: { register: (ask) => { registered = ask; } }
  });
  apps.push(app);
  await app.inject({ method: "PUT", url: "/api/providers/deepseek/credentials", payload: { apiKey: "sk-norma-test" } });
  const saved = await app.inject({ method: "PUT", url: "/api/assistant/config", payload: { model: { providerId: "deepseek", modelId: "deepseek-flash" } } });
  expect(saved.statusCode, saved.body).toBe(200);
  if (o.allowed) await updateAppConfig(root, { permissions: { norma: o.allowed } });
  expect(registered).toBeDefined();
  return { app, root, adapter, modelClient, reload, ask: registered! };
}

describe("/norma: who may ask (§36)", () => {
  it("answers only a listed Discord user, whatever their server roles; nobody is listed by default", async () => {
    const w = await setup([() => textTurn("hi, I'm Norma")]);
    expect((await loadAppConfig(w.root)).permissions.norma).toEqual([]);
    expect(await w.ask({ userId: ALLOWED, text: "hello" })).toMatch(/can't use \/norma/u);
    expect(w.adapter.calls).toHaveLength(0);

    await updateAppConfig(w.root, { permissions: { norma: [ALLOWED] } });
    expect(await w.ask({ userId: ALLOWED, text: "hello" })).toBe("hi, I'm Norma");
    expect(await w.ask({ userId: OTHER, text: "hello" })).toMatch(/can't use \/norma/u);
    expect(w.adapter.calls).toHaveLength(1);
    // She knows where she is answering, and the user's words follow.
    const sent = lastUserText(w.adapter.calls[0]!.request);
    expect(sent).toContain(`/norma in Discord from user ${ALLOWED}`);
    expect(sent.endsWith("hello")).toBe(true);
  });

  it("stops a user removed mid-turn at their next tool call", async () => {
    let root = "";
    const w = await setup(
      [
        async function* () {
          // The owner removes them while Norma is thinking.
          await updateAppConfig(root, { permissions: { norma: [] } });
          yield* toolCallTurn("list_waifus");
        },
        () => textTurn("should not be reached")
      ],
      { allowed: [ALLOWED] }
    );
    root = w.root;
    expect(await w.ask({ userId: ALLOWED, text: "list my waifus" })).toBe("You can't use /norma any more.");
    expect(w.adapter.calls).toHaveLength(1);
  });

  it("keeps one conversation per user while they keep talking, and starts over after 30 idle minutes", async () => {
    const w = await setup([() => textTurn("first"), () => textTurn("second"), () => textTurn("third")], { allowed: [ALLOWED] });
    let now = 1_000_000;
    const ask = createDiscordNorma(w.app, { dataRoot: w.root, modelClient: w.modelClient, now: () => now });
    expect(await ask({ userId: ALLOWED, text: "one" })).toBe("first");
    now += 60_000;
    expect(await ask({ userId: ALLOWED, text: "two" })).toBe("second");
    // The second call carries the first exchange.
    expect(JSON.stringify(w.adapter.calls[1]!.request.messages)).toContain("first");
    now += DISCORD_NORMA_IDLE_MS + 1;
    expect(await ask({ userId: ALLOWED, text: "three" })).toBe("third");
    expect(JSON.stringify(w.adapter.calls[2]!.request.messages)).not.toContain("first");
  });
});

describe("/norma: what she can't do from Discord (§36)", () => {
  it("refuses a change that needs a confirmation card, and never widens who may use /norma", async () => {
    const w = await setup(
      [() => toolCallTurn("update_app_config", { changes: { permissions: { norma: [ALLOWED, OTHER] } } }), () => textTurn("I can't do that from here.")],
      { allowed: [ALLOWED] }
    );
    expect(await w.ask({ userId: ALLOWED, text: "add my friend" })).toBe("I can't do that from here.");
    expect(lastUserText(w.adapter.calls[1]!.request)).toContain(DISCORD_NORMA_CARD_REFUSAL);
    expect((await loadAppConfig(w.root)).permissions.norma).toEqual([ALLOWED]);
  });

  it("PUT /api/config refuses an assistant write to permissions without a confirmed card; the owner's applies without a reload", async () => {
    const w = await setup([], { allowed: [ALLOWED] });
    const put = (delegation?: { conversationId: string; pendingActionId?: string }) =>
      dispatchInternal(w.app, LOCAL_REQUEST_PRINCIPAL, delegation, {
        method: "PUT",
        url: "/api/config",
        headers: { "idempotency-key": randomBytes(32).toString("base64url") },
        payload: { permissions: { norma: [ALLOWED, OTHER] } }
      });
    const refused = await put({ conversationId: "c1" });
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toContain("AssistantConfirmationRequired");
    expect((await loadAppConfig(w.root)).permissions.norma).toEqual([ALLOWED]);

    const owner = await w.app.inject({ method: "PUT", url: "/api/config", payload: { permissions: { norma: [OTHER] } } });
    expect(owner.statusCode, owner.body).toBe(200);
    expect((await loadAppConfig(w.root)).permissions.norma).toEqual([OTHER]);
    // Read at every /norma: no Discord runtime reload for it.
    expect(w.reload).not.toHaveBeenCalled();
  });

  it("only takes Discord user IDs", async () => {
    const w = await setup([]);
    const bad = await w.app.inject({ method: "PUT", url: "/api/config", payload: { permissions: { norma: ["@kevin"] } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe("/norma in the cast runtime (§36)", () => {
  it("answers with askNorma's text, and asks for words when there are none", async () => {
    const respond = vi.fn(async () => undefined);
    const askNorma = vi.fn(async () => "done");
    const handle = CastRuntime.prototype.handleNormaCommand;
    const self = { options: { askNorma, logger: { info: vi.fn() } } } as unknown as CastRuntime;
    await handle.call(self, { guildId: "1", channelId: "2", userId: ALLOWED, text: "hi", respond });
    expect(askNorma).toHaveBeenCalledWith({ userId: ALLOWED, text: "hi" });
    expect(respond).toHaveBeenLastCalledWith("done");
    await handle.call(self, { guildId: "1", channelId: "2", userId: ALLOWED, text: "", respond });
    expect(respond).toHaveBeenLastCalledWith("Tell Norma something: /norma <text>.");
    expect(askNorma).toHaveBeenCalledTimes(1);
  });
});

describe("Settings → Permissions: adding a Discord user ID", () => {
  it("takes a plain ID or a mention, keeps the list's order, and refuses anything else", () => {
    expect(addDiscordUserId([], ` ${ALLOWED} `)).toEqual({ list: [ALLOWED] });
    expect(addDiscordUserId([ALLOWED], `<@!${OTHER}>`)).toEqual({ list: [ALLOWED, OTHER] });
    expect(addDiscordUserId([ALLOWED], ALLOWED)).toEqual({ list: [ALLOWED] });
    expect(addDiscordUserId([ALLOWED], "kevin").error).toMatch(/17 to 20 digits/u);
  });
});
