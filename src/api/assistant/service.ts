import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ModelPipeline } from "../../providers/types.js";
import { createGatewayModelPipeline } from "../../orchestration/pipeline/gatewayPipeline.js";
import { resolveModelTarget } from "../../orchestration/pipeline/resolveTarget.js";
import { createProviderCredentialsLookup } from "../llmGatewayCredentials.js";
import { executeAssistantTool, toolDefs } from "./tools.js";
import {
  AssistantEvent,
  ConversationStore,
  type ConversationOwner
} from "./conversations.js";
import { dispatchInternal } from "../internalDispatch.js";
import type {
  AssistantDelegation,
  RequestPrincipal
} from "../requestPrincipal.js";

export type AssistantTarget =
  | { ok: true; providerId: string; modelId: string; params: Record<string, unknown> }
  | { ok: false; reason: string };

async function getJson(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation: AssistantDelegation | undefined,
  url: string
): Promise<Record<string, unknown> | undefined> {
  const response = await dispatchInternal(app, principal, delegation, { method: "GET", url });
  if (response.statusCode !== 200) return undefined;
  return JSON.parse(response.body) as Record<string, unknown>;
}

/**
 * The assistant runs on its own configured model when set, otherwise it borrows the
 * orchestrator's. Params always come from the config that supplied the model.
 */
export async function resolveAssistantTarget(
  app: FastifyInstance,
  dataRoot: string,
  principal: RequestPrincipal,
  delegation?: AssistantDelegation
): Promise<AssistantTarget> {
  const assistant = await getJson(app, principal, delegation, "/api/assistant/config");
  const orchestrator = await getJson(app, principal, delegation, "/api/orchestrator/config");
  const source = assistant?.modelId ? assistant : orchestrator?.modelId ? orchestrator : undefined;
  if (!source) {
    return { ok: false, reason: "No model is configured for the assistant. Set one under Direction \u2192 Assistant (do not repurpose the orchestrator\u2019s setting \u2014 an empty orchestrator model can be a deliberate free deterministic mode)." };
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
    "You are Norma, the Discord Waifus dashboard assistant. You operate a locally-hosted multi-character Discord bot app on the user's behalf. Users may address you by name.",
    "Never ask the user to paste API keys or bot tokens into this chat: call request_secret so they can enter the secret in a secure form that bypasses the conversation entirely.",
    "You have tools that read AND directly modify live configuration (waifus, servers, providers, agent configs, memories) plus a docs knowledge base (docs_search/docs_read).",
    "Rules:",
    "- Apply changes directly — the user chose an agent that writes without asking. Only DELETIONS (delete_waifu, delete_memory, clear_provider_key) need a confirmation in chat first. Config updates, model changes, bot wiring, and token forms never do.",
    "- Always answer the user's NEWEST message. Messages starting with [secure-form] are automated receipts from the dashboard (not the user speaking); acknowledge them briefly and continue the task.",
    "- To connect a character to Discord: link_waifu_bot(waifuId, applicationId) first, then request_secret(purpose bot_token, botId = waifuId) for the token, then runtime_reload once saved. Open at most one secret form per reply.",
    "- Never echo API keys or bot tokens back to the user, even if they appear in tool output.",
    "- Prefer docs_search before answering how-to questions you are not certain about.",
    "- Be concise. Report what you changed with the field values that matter.",
    `Current state: ${snapshot.waifuCount} waifus, ${snapshot.serverCount} servers, providers configured: ${snapshot.providerIds.join(", ") || "none"}, discord ${snapshot.discordConnected ? "connected" : "disconnected"}.`
  ].join("\n");
}

async function buildSnapshot(
  app: FastifyInstance,
  principal: RequestPrincipal,
  delegation?: AssistantDelegation
) {
  const [status, waifus, servers, providers] = await Promise.all([
    getJson(app, principal, delegation, "/api/status"),
    getJson(app, principal, delegation, "/api/waifus"),
    getJson(app, principal, delegation, "/api/servers"),
    getJson(app, principal, delegation, "/api/providers")
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
  actor: ConversationOwner;
  principal: RequestPrincipal;
  authorizationPrincipal: RequestPrincipal;
  delegation?: AssistantDelegation;
  authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  createPipeline?: (target: { providerId: string; modelId: string }) => ModelPipeline;
};

export class AssistantTurnError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

async function assertConversationOwnerAuthorized(
  deps: AssistantServiceDeps,
  conversationId: string
): Promise<void> {
  if (!deps.store.isOwner(conversationId, deps.actor)) {
    throw new AssistantTurnError(403, "The conversation owner is no longer authorized.");
  }
  const authorized = await deps.authorizePrincipal(deps.authorizationPrincipal);
  if (!authorized || !deps.store.isOwner(conversationId, deps.actor)) {
    throw new AssistantTurnError(403, "The conversation owner is no longer authorized.");
  }
}

export async function runAssistantTurn(deps: AssistantServiceDeps, conversationId: string, userContent: string): Promise<string> {
  const { app, store, dataRoot, actor, principal, delegation } = deps;
  const conversation = store.get(conversationId, actor);
  if (!conversation) throw new AssistantTurnError(404, "Unknown conversation.");
  if (conversation.busy) throw new AssistantTurnError(409, "A turn is already running in this conversation.");
  // claim the conversation BEFORE the first await — two concurrent POSTs both passed the
  // check above and interleaved, last-writer-winning the model transcript (audit finding 6)
  store.setBusy(conversationId, actor, true);
  let turnStarted = false;
  try {
    await assertConversationOwnerAuthorized(deps, conversationId);
    const target = await resolveAssistantTarget(app, dataRoot, principal, delegation);
    await assertConversationOwnerAuthorized(deps, conversationId);
    if (!target.ok) throw new AssistantTurnError(503, target.reason);
    const pipeline = deps.createPipeline
      ? deps.createPipeline({ providerId: target.providerId, modelId: target.modelId })
      : createGatewayModelPipeline({
          providerId: target.providerId,
          modelId: target.modelId,
          queryRole: "assistant",
          dataRoot
        });
    if (!pipeline.generateAssistantTurn) {
      throw new AssistantTurnError(503, "The resolved pipeline cannot run assistant turns.");
    }

    const transcript =
      conversation.chat.length > 0
        ? [...conversation.chat]
        : [{
            role: "system" as const,
            content: assistantSystemPrompt(await buildSnapshot(app, principal, delegation))
          }];
    await assertConversationOwnerAuthorized(deps, conversationId);
    transcript.push({ role: "user", content: userContent });

    // Persist the accepted user turn before invoking the provider. If the provider fails, the
    // next turn still has the user's message, but an owner revoked during setup stores nothing.
    store.appendChat(conversationId, actor, transcript);
    store.appendStored(conversationId, actor, { role: "user", content: userContent, at: new Date().toISOString() });
    store.emit(conversationId, actor, { type: "turn_started" });
    turnStarted = true;
    let toolCallSequence = 0;
    const result = await pipeline.generateAssistantTurn({
      modelId: target.modelId,
      messages: transcript,
      tools: toolDefs({ actor, principal }),
      params: target.params,
      executeTool: async (name, argsJson) => {
        await assertConversationOwnerAuthorized(deps, conversationId);
        toolCallSequence += 1;
        const result = await executeAssistantTool(
          {
            app,
            actor,
            principal,
            delegation: {
              conversationId,
              toolCallId: `tool-${toolCallSequence}-${randomUUID()}`,
              ...(delegation?.pendingActionId
                ? { pendingActionId: delegation.pendingActionId }
                : {})
            }
          },
          name,
          argsJson
        );
        await assertConversationOwnerAuthorized(deps, conversationId);
        return result;
      },
      onEvent: (event) => store.emit(
        conversationId,
        actor,
        scrubSecretsFromEvent(event as AssistantEvent)
      )
    });
    await assertConversationOwnerAuthorized(deps, conversationId);
    store.appendChat(conversationId, actor, result.messages);
    store.appendStored(conversationId, actor, { role: "assistant", content: result.content, at: new Date().toISOString() });
    store.emit(conversationId, actor, { type: "text", content: result.content });
    store.emit(conversationId, actor, { type: "turn_completed" });
    return result.content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (turnStarted) store.emit(conversationId, actor, { type: "error", message });
    if (error instanceof AssistantTurnError) throw error;
    throw new AssistantTurnError(500, message);
  } finally {
    store.setBusy(conversationId, actor, false);
  }
}

/** Keys/tokens must never persist in the display transcript or SSE replay, even when the
 * user pasted one into chat and the model called set_provider_key with it. */
function scrubSecretsFromEvent(event: AssistantEvent): AssistantEvent {
  if (event.type !== "tool_call") return event;
  const scrubbed = event.arguments.replace(/("(?:apiKey|token)"\s*:\s*")([^"]+)(")/g, "$1[redacted]$3");
  return scrubbed === event.arguments ? event : { ...event, arguments: scrubbed };
}
