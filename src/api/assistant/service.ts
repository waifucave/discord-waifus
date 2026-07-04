import type { FastifyInstance } from "fastify";
import type { ModelPipeline } from "../../providers/types.js";
import { createGatewayModelPipeline } from "../../orchestration/pipeline/gatewayPipeline.js";
import { resolveModelTarget } from "../../orchestration/pipeline/resolveTarget.js";
import { createProviderCredentialsLookup } from "../llmGatewayCredentials.js";
import { executeAssistantTool, toolDefs } from "./tools.js";
import { AssistantEvent, ConversationStore } from "./conversations.js";

export type AssistantTarget =
  | { ok: true; providerId: string; modelId: string; params: Record<string, unknown> }
  | { ok: false; reason: string };

async function getJson(app: FastifyInstance, url: string): Promise<Record<string, unknown> | undefined> {
  const response = await app.inject({ method: "GET", url });
  if (response.statusCode !== 200) return undefined;
  return JSON.parse(response.body) as Record<string, unknown>;
}

/**
 * The assistant runs on its own configured model when set, otherwise it borrows the
 * orchestrator's. Params always come from the config that supplied the model.
 */
export async function resolveAssistantTarget(app: FastifyInstance, dataRoot: string): Promise<AssistantTarget> {
  const assistant = await getJson(app, "/api/assistant/config");
  const orchestrator = await getJson(app, "/api/orchestrator/config");
  const source = assistant?.modelId ? assistant : orchestrator?.modelId ? orchestrator : undefined;
  if (!source) {
    return { ok: false, reason: "No model configured — set one on the assistant or the orchestrator." };
  }
  let target: { providerId: string; modelId: string };
  try {
    target = resolveModelTarget({
      providerId: source.providerId as string | undefined,
      modelId: source.modelId as string
    });
  } catch {
    return { ok: false, reason: `Model ${String(source.modelId)} is not recognized.` };
  }
  if (!createProviderCredentialsLookup(dataRoot)(target.providerId)) {
    return { ok: false, reason: `Provider ${target.providerId} has no API key configured.` };
  }
  return { ok: true, ...target, params: (source.params as Record<string, unknown>) ?? {} };
}

export function assistantSystemPrompt(snapshot: {
  waifuCount: number;
  serverCount: number;
  providerIds: string[];
  discordConnected: boolean;
}): string {
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

async function buildSnapshot(app: FastifyInstance) {
  const [status, waifus, servers, providers] = await Promise.all([
    getJson(app, "/api/status"),
    getJson(app, "/api/waifus"),
    getJson(app, "/api/servers"),
    getJson(app, "/api/providers")
  ]);
  const providerList = (providers?.providers as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    waifuCount: ((waifus?.waifus as unknown[]) ?? []).length,
    serverCount: ((servers?.servers as unknown[]) ?? []).length,
    providerIds: providerList
      .filter((provider) => (provider.credentials as Record<string, unknown> | undefined)?.configured)
      .map((provider) => String(provider.providerId ?? provider.id)),
    discordConnected: Boolean((status?.discord as Record<string, unknown> | undefined)?.connected)
  };
}

export type AssistantServiceDeps = {
  app: FastifyInstance;
  store: ConversationStore;
  dataRoot: string;
  createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline;
};

export class AssistantTurnError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

export async function runAssistantTurn(deps: AssistantServiceDeps, conversationId: string, userContent: string): Promise<string> {
  const { app, store, dataRoot } = deps;
  const conversation = store.get(conversationId);
  if (!conversation) throw new AssistantTurnError(404, "Unknown conversation.");
  if (conversation.busy) throw new AssistantTurnError(409, "A turn is already running in this conversation.");

  const target = await resolveAssistantTarget(app, dataRoot);
  if (!target.ok) throw new AssistantTurnError(503, target.reason);

  const pipeline = deps.createPipeline
    ? deps.createPipeline({ providerId: target.providerId, modelId: target.modelId })
    : createGatewayModelPipeline({
        providerId: target.providerId,
        modelId: target.modelId,
        queryRole: "assistant",
        dataRoot
      });
  if (!pipeline.generateAssistantTurn) throw new AssistantTurnError(503, "The resolved pipeline cannot run assistant turns.");

  const transcript =
    conversation.chat.length > 0
      ? [...conversation.chat]
      : [{ role: "system" as const, content: assistantSystemPrompt(await buildSnapshot(app)) }];
  transcript.push({ role: "user", content: userContent });

  store.setBusy(conversationId, true);
  store.appendStored(conversationId, { role: "user", content: userContent, at: new Date().toISOString() });
  store.emit(conversationId, { type: "turn_started" });
  try {
    const result = await pipeline.generateAssistantTurn({
      modelId: target.modelId,
      messages: transcript,
      tools: toolDefs(),
      params: target.params,
      executeTool: (name, argsJson) => executeAssistantTool({ app }, name, argsJson),
      onEvent: (event) => store.emit(conversationId, event as AssistantEvent)
    });
    store.appendChat(conversationId, result.messages);
    store.appendStored(conversationId, { role: "assistant", content: result.content, at: new Date().toISOString() });
    store.emit(conversationId, { type: "text", content: result.content });
    store.emit(conversationId, { type: "turn_completed" });
    return result.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.emit(conversationId, { type: "error", message });
    throw new AssistantTurnError(500, message);
  } finally {
    store.setBusy(conversationId, false);
  }
}
