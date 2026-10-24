import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ContentBlockLike, ProviderMessageLike } from "@yanlinglabs/winter-provider-runtime";
import type { ModelChoice } from "../../shared/schemas/domain.js";
import { routeKey } from "../../models/catalog.js";
import { createProviderCredentialsLookup } from "../../models/credentials.js";
import type { ModelCallRequest, ModelCallResult, ModelClient, ModelStreamSink } from "../../models/client.js";
import { executeAssistantTool, toolDefs } from "./tools.js";
import {
  AssistantEvent,
  ConversationStore,
  type ConversationOwner
} from "./conversations.js";
import {
  AssistantActionStore,
  retargetAssistantBrowserPrincipal
} from "./actions.js";
import { dispatchInternal } from "../internalDispatch.js";
import type {
  AssistantDelegation,
  RequestPrincipal
} from "../requestPrincipal.js";

/** The slice of ModelClient the assistant uses (tests pass a scripted stand-in). */
export type AssistantModelClient = Pick<ModelClient, "stream">;

export type AssistantTarget =
  | { ok: true; route: ModelChoice }
  | { ok: false; reason: string };

/** Hard cap on executed tool calls per turn. */
export const ASSISTANT_MAX_TOOL_CALLS = 12;
/** Tool results longer than this are cut before they reach the model. */
export const ASSISTANT_TOOL_RESULT_MAX_CHARS = 6000;
const TEXT_DELTA_FLUSH_MS = 80;

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

function modelChoiceOf(value: unknown): ModelChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { providerId, modelId, effort } = value as Record<string, unknown>;
  if (typeof providerId !== "string" || typeof modelId !== "string" || !providerId || !modelId) return undefined;
  return { providerId, modelId, ...(typeof effort === "string" && effort ? { effort } : {}) };
}

/**
 * The assistant runs on its own configured model (`user/assistant/config.json`) when set. Otherwise
 * it borrows a waifu's model (enabled waifus first), but only one that is offered, whose provider
 * has a key, and that is not a contributor (training) variant: training is never chosen silently.
 * With no such model it does not run and says why. Living cast spec §9.3.
 */
export async function resolveAssistantTarget(
  app: FastifyInstance,
  dataRoot: string,
  principal: RequestPrincipal,
  delegation?: AssistantDelegation
): Promise<AssistantTarget> {
  const [assistant, models] = await Promise.all([
    getJson(app, principal, delegation, "/api/assistant/config"),
    getJson(app, principal, delegation, "/api/models")
  ]);
  const offered = new Map(
    ((models?.models as Array<Record<string, unknown>> | undefined) ?? []).map((model) => [String(model.id), model])
  );
  const hasKey = createProviderCredentialsLookup(dataRoot);
  const configured = modelChoiceOf(assistant?.model);
  if (configured) {
    if (!offered.has(routeKey(configured))) {
      return { ok: false, reason: `The assistant's model ${routeKey(configured)} is not offered any more. Pick another in Settings → Assistant.` };
    }
    if (!hasKey(configured.providerId)) {
      return { ok: false, reason: `Provider ${configured.providerId} has no API key configured (assistant model ${routeKey(configured)}).` };
    }
    return { ok: true, route: configured };
  }
  const waifus = await getJson(app, principal, delegation, "/api/waifus");
  const list = (waifus?.waifus as Array<Record<string, unknown>> | undefined) ?? [];
  const ordered = [...list.filter((waifu) => waifu.enabled === true), ...list.filter((waifu) => waifu.enabled !== true)];
  for (const waifu of ordered) {
    const route = modelChoiceOf(waifu.model);
    if (!route) continue;
    const model = offered.get(routeKey(route));
    if (!model || model.contributor === true || !hasKey(route.providerId)) continue;
    return { ok: true, route };
  }
  return {
    ok: false,
    reason:
      "No model is set for the assistant. Pick one in Settings → Assistant. (Without one it borrows a waifu's model, " +
      "but only an offered, non-contributor model whose provider has a key.)"
  };
}

function assistantSystemPrompt(snapshot: {
  waifuCount: number;
  serverCount: number;
  providerIds: string[];
  discordConnected: boolean;
}): string {
  return [
    "You are Norma, the Discord Waifus dashboard assistant. You operate a locally-hosted multi-character Discord bot app on the user's behalf. Users may address you by name.",
    "Never ask the user to paste API keys or bot tokens into this chat: call request_secret so they can enter the secret in a secure form that bypasses the conversation entirely.",
    "You have tools that read AND directly modify live configuration (waifus, servers, providers, models), manage direct-only Remote Access, and search a docs knowledge base (docs_search/docs_read).",
    "Each waifu is an autonomous agent with one continuous life: mentions, her name, replies, DMs and her reminders wake her, and she decides for herself what to say and where. get_life shows how she is doing (content from private chats is never shown to you); wake_waifu wakes her with a note. Use get_setting_help to look up any setting before changing it.",
    "Rules:",
    "- Apply ordinary changes directly — the user chose an agent that writes without asking. Only DELETIONS (delete_waifu, clear_provider_key) need a confirmation in chat first. forget_person and forget_dm always raise their own secure dashboard card. Config updates, model changes, bot wiring, and token forms never do.",
    "- Models are chosen from the curated list (list_models): a model is { providerId, modelId, effort? } and effort must be one the model lists. Contributor variants share data for training: only pick one when the user explicitly asks for it.",
    "- Remote Access is direct-only: pair.waifucave.com coordinates handshakes but never carries dashboard/API traffic. Never claim a relay or proxy fallback exists.",
    "- Remote Access enable/disable, pairing approval, device revocation, and another actor's invitation cancellation create secure dashboard cards. You cannot confirm those cards yourself or replace their stored target. Invitation tokens, QR data, safety words, fingerprints, transcript bindings, and identity bundles must never be requested, quoted, or placed in chat.",
    "- Always answer the user's NEWEST message. Messages starting with [secure-form] are automated receipts from the dashboard (not the user speaking); acknowledge them briefly and continue the task. Secure-action receipts stay outside the model transcript.",
    "- To connect a character to Discord: link_waifu_bot(waifuId, applicationId) first, then request_secret(purpose bot_token, botId = waifuId) for the token, then runtime_reload once saved. Open at most one secret form per reply.",
    "- runtime_pause pauses the bots; nothing you can call stops or restarts the host operating-system process.",
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
  actions: AssistantActionStore;
  dataRoot: string;
  actor: ConversationOwner;
  principal: RequestPrincipal;
  authorizationPrincipal: RequestPrincipal;
  delegation?: AssistantDelegation;
  authorizePrincipal: (principal: RequestPrincipal) => boolean | Promise<boolean>;
  modelClient: AssistantModelClient;
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

/** The JSON text a tool receives; winter's unparsed-arguments marker is passed through raw so the tool reports it. */
function toolArgumentsJson(input: unknown): string {
  if (input && typeof input === "object" && "__winter_unparsed_arguments" in input) {
    const raw = (input as Record<string, unknown>).__winter_unparsed_arguments;
    if (typeof raw === "string") return raw;
  }
  return JSON.stringify(input ?? {});
}

/** Coalesces streamed text into `text_delta` events (at most one per flush window). */
function textDeltaPublisher(publish: (content: string) => void) {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending) return;
    const content = pending;
    pending = "";
    publish(content);
  };
  return {
    push(text: string): void {
      pending += text;
      timer ??= setTimeout(flush, TEXT_DELTA_FLUSH_MS);
    },
    flush
  };
}

/**
 * The assistant's tool loop over ModelClient.stream: up to ASSISTANT_MAX_TOOL_CALLS executed calls,
 * each round's assistant message appended exactly as assembled, tool results returned in one user
 * message of `tool_result` blocks.
 */
async function runToolLoop(input: {
  client: AssistantModelClient;
  request: Omit<ModelCallRequest, "messages">;
  transcript: ProviderMessageLike[];
  sink: ModelStreamSink;
  executeTool: (name: string, argsJson: string) => Promise<string>;
  onEvent: (event: AssistantEvent) => void;
}): Promise<string> {
  const { client, request, transcript, sink, executeTool, onEvent } = input;
  let executedCalls = 0;
  for (let round = 0; round <= ASSISTANT_MAX_TOOL_CALLS; round++) {
    const result: ModelCallResult = await client.stream({ ...request, messages: [...transcript] }, sink);
    transcript.push(result.message);
    if (result.toolCalls.length === 0) return result.text;
    const results: ContentBlockLike[] = [];
    for (const call of result.toolCalls) {
      if (executedCalls >= ASSISTANT_MAX_TOOL_CALLS) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Tool call limit reached for this turn." });
        continue;
      }
      executedCalls += 1;
      const argsJson = toolArgumentsJson(call.input);
      onEvent({ type: "tool_call", name: call.name, arguments: argsJson });
      let output: string;
      try {
        output = await executeTool(call.name, argsJson);
      } catch (error) {
        if (error instanceof AssistantTurnError) throw error;
        output = `Tool failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (output.length > ASSISTANT_TOOL_RESULT_MAX_CHARS) output = `${output.slice(0, ASSISTANT_TOOL_RESULT_MAX_CHARS)}\n[truncated]`;
      onEvent({ type: "tool_result", name: call.name, result: output });
      results.push({ type: "tool_result", tool_use_id: call.id, content: output });
    }
    transcript.push({ role: "user", content: results });
    if (executedCalls >= ASSISTANT_MAX_TOOL_CALLS) break;
  }
  const summary = "I hit the tool call limit for this turn — here's where I got to.";
  transcript.push({ role: "assistant", content: [{ type: "text", text: summary }] });
  return summary;
}

export async function runAssistantTurn(deps: AssistantServiceDeps, conversationId: string, userContent: string): Promise<string> {
  const { app, store, actions, dataRoot, actor, principal, authorizationPrincipal, delegation } = deps;
  const conversation = store.get(conversationId, actor);
  if (!conversation) throw new AssistantTurnError(404, "Unknown conversation.");
  if (conversation.busy) throw new AssistantTurnError(409, "A turn is already running in this conversation.");
  // claim the conversation BEFORE the first await — two concurrent POSTs both passed the
  // check above and interleaved, last-writer-winning the model transcript (audit finding 6)
  store.setBusy(conversationId, actor, true);
  let turnStarted = false;
  const deltas = textDeltaPublisher((content) => store.publish(conversationId, actor, { type: "text_delta", content }));
  try {
    await assertConversationOwnerAuthorized(deps, conversationId);
    const target = await resolveAssistantTarget(app, dataRoot, principal, delegation);
    await assertConversationOwnerAuthorized(deps, conversationId);
    if (!target.ok) throw new AssistantTurnError(503, target.reason);

    // The system prompt is frozen at the first turn so every later call reuses the cached prefix.
    const system = conversation.system ?? assistantSystemPrompt(await buildSnapshot(app, principal, delegation));
    await assertConversationOwnerAuthorized(deps, conversationId);
    const transcript: ProviderMessageLike[] = [...conversation.chat, { role: "user", content: userContent }];

    // Persist the accepted user turn before invoking the provider. If the provider fails, the
    // next turn still has the user's message, but an owner revoked during setup stores nothing.
    store.setTranscript(conversationId, actor, { system, chat: transcript });
    store.appendStored(conversationId, actor, { role: "user", content: userContent, at: new Date().toISOString() });
    store.emit(conversationId, actor, { type: "turn_started" });
    turnStarted = true;
    let toolCallSequence = 0;
    const content = await runToolLoop({
      client: deps.modelClient,
      request: {
        route: target.route,
        system: [system],
        tools: toolDefs({ actor, principal }),
        ...(target.route.effort ? { effort: target.route.effort } : {}),
        cacheKey: `assistant:${conversationId}`,
        attribution: { purpose: "assistant", conversationKey: `assistant:${conversationId}` }
      },
      transcript,
      sink: {
        onTextDelta: (text) => deltas.push(text),
        onToolCallStart: () => deltas.flush()
      },
      executeTool: async (name, argsJson) => {
        deltas.flush();
        await assertConversationOwnerAuthorized(deps, conversationId);
        toolCallSequence += 1;
        const toolDelegation = {
          conversationId,
          toolCallId: `tool-${toolCallSequence}-${randomUUID()}`,
          ...(delegation?.pendingActionId
            ? { pendingActionId: delegation.pendingActionId }
            : {})
        };
        const result = await executeAssistantTool(
          {
            app,
            actor,
            principal,
            delegation: toolDelegation,
            actions: {
              propose: async (proposal) => {
                await assertConversationOwnerAuthorized(deps, conversationId);
                const action = actions.create({
                  principal: authorizationPrincipal,
                  delegation: toolDelegation,
                  proposal
                });
                try {
                  store.emit(conversationId, actor, {
                    type: "confirmation_required",
                    actionId: action.actionId,
                    category: action.category,
                    summary: action.summary
                  });
                } catch (error) {
                  actions.discard(action.actionId);
                  throw error;
                }
                return action;
              },
              cancelOwnedInvitation: async (invitationId) => {
                await assertConversationOwnerAuthorized(deps, conversationId);
                if (!actions.ownsInvitation(invitationId, authorizationPrincipal)) return undefined;
                const target = `/api/remote-access/invitations/${encodeURIComponent(invitationId)}`;
                const response = await dispatchInternal(
                  app,
                  retargetAssistantBrowserPrincipal(authorizationPrincipal, "DELETE", target),
                  toolDelegation,
                  {
                    method: "DELETE",
                    url: target,
                    headers: { "idempotency-key": randomBytes(32).toString("base64url") }
                  }
                );
                await assertConversationOwnerAuthorized(deps, conversationId);
                if (response.statusCode !== 202) return response.body;
                actions.forgetInvitation(invitationId);
                return `Pairing invitation ${invitationId} was cancelled.`;
              }
            }
          },
          name,
          argsJson
        );
        await assertConversationOwnerAuthorized(deps, conversationId);
        return result;
      },
      onEvent: (event) => store.emit(conversationId, actor, scrubSecretsFromEvent(event))
    });
    deltas.flush();
    await assertConversationOwnerAuthorized(deps, conversationId);
    store.setTranscript(conversationId, actor, { system, chat: transcript });
    store.appendStored(conversationId, actor, { role: "assistant", content, at: new Date().toISOString() });
    store.emit(conversationId, actor, { type: "text", content });
    store.emit(conversationId, actor, { type: "turn_completed" });
    return content;
  } catch (error) {
    deltas.flush();
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
