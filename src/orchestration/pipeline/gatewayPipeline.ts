import { createGateway, Gateway, type ChatResponse, type ToolDef } from "@waifucave/gateway";
import { createProviderCredentialsLookup } from "../../api/llmGatewayCredentials.js";
import { QueryRole, recordProviderQuery, recordProviderReply } from "../../shared/queryLog.js";
import type { ModelPipeline, ProviderRequest, WaifuGenerationRequest, WaifuGenerationResult } from "../../providers/types.js";
import { ORCHESTRATOR_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME, REVIEWER_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_NAME, orchestratorToolParameters, pickNextWaifuToolParameters, reviewerSystemPrompt, reviewerToolParameters, shortTermMemoryToolParameters } from "../tools.js";
import { GatewayPipelineError, buildUnifiedParams, preconformRequest } from "./params.js";
import { buildWaifuMessages } from "./messages.js";
import { buildOrchestratorChatMessages } from "./timeline.js";
import { OrchestratorDecision, OrchestratorDecisionSchema } from "../decisions.js";
import { ReviewerDecision, ReviewerDecisionSchema } from "../reviewer.js";

const REQUEST_TIMEOUT_MS = 180_000;

export type GatewayPipelineOptions = {
  providerId: string;
  modelId: string;
  queryRole: QueryRole;
  dataRoot?: string;        // production: live credentials from user/providers.json
  gateway?: Gateway;        // tests: inject directly
};

const gatewayCache = new Map<string, Gateway>();

function resolveGateway(options: GatewayPipelineOptions): Gateway {
  if (options.gateway) return options.gateway;
  if (!options.dataRoot) throw new GatewayPipelineError("dataRoot or gateway required");
  const key = `${options.dataRoot}:${options.queryRole}`;
  let cached = gatewayCache.get(key);
  if (!cached) {
    const role = options.queryRole;
    const fetchImpl: typeof fetch = async (input, init) => {
      // Pass the wire body through at top level so queryLog's field allowlist
      // captures messages/tools/... exactly as the legacy pipeline path does.
      const captured = recordProviderQuery(role, init?.body ? JSON.parse(String(init.body)) : {});
      const response = await fetch(input, init);
      // Clone before the gateway consumes the single-use body; log the reply
      // fire-and-forget so the call is never blocked or failed by logging.
      response
        .clone()
        .json()
        .then((payload) => recordProviderReply(role, captured.id, response.status, response.ok, payload))
        .catch(() => recordProviderReply(role, captured.id, response.status, response.ok, undefined));
      return response;
    };
    cached = createGateway({ credentials: createProviderCredentialsLookup(options.dataRoot), fetchImpl });
    gatewayCache.set(key, cached);
  }
  return cached;
}

function combinedSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function flatUsage(response: ChatResponse): Record<string, number> | undefined {
  const { inputTokens, outputTokens, reasoningTokens, cachedInputTokens } = response.usage;
  const entries: [string, number][] = [];
  if (typeof inputTokens === "number") entries.push(["inputTokens", inputTokens]);
  if (typeof outputTokens === "number") entries.push(["outputTokens", outputTokens]);
  if (typeof reasoningTokens === "number") entries.push(["reasoningTokens", reasoningTokens]);
  if (typeof cachedInputTokens === "number") entries.push(["cachedInputTokens", cachedInputTokens]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function textContent(response: ChatResponse): string {
  return response.content
    .filter((b): b is Extract<ChatResponse["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function toolCalls(response: ChatResponse, name: string) {
  return response.content.filter(
    (b): b is Extract<ChatResponse["content"][number], { type: "toolCall" }> =>
      b.type === "toolCall" && b.name === name
  );
}

function parseForcedCall<T>(response: ChatResponse, toolName: string, parse: (raw: unknown) => T, label: string): T {
  const call = toolCalls(response, toolName)[0];
  if (!call) throw new GatewayPipelineError(`${label}: model did not call ${toolName}`);
  let raw: unknown;
  try { raw = JSON.parse(call.arguments); } catch { throw new GatewayPipelineError(`${label}: malformed ${toolName} arguments`); }
  try {
    return parse(raw);
  } catch (error) {
    throw new GatewayPipelineError(`${label}: invalid ${toolName} arguments — ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class GatewayModelPipeline implements ModelPipeline {
  constructor(private readonly options: GatewayPipelineOptions, private readonly gateway: Gateway) {}

  protected async chat(request: {
    messages: Parameters<Gateway["chat"]>[0]["messages"];
    tools?: ToolDef[];
    toolChoice?: Parameters<Gateway["chat"]>[0]["toolChoice"];
    sampling: Parameters<typeof buildUnifiedParams>[0];
    signal?: AbortSignal;
  }): Promise<ChatResponse> {
    const { providerId, modelId } = this.options;
    const conformed = preconformRequest(this.gateway, providerId, modelId, {
      params: buildUnifiedParams(request.sampling),
      toolChoice: request.toolChoice
    });
    return this.gateway.chat({
      provider: providerId,
      model: modelId,
      messages: request.messages,
      tools: request.tools,
      toolChoice: conformed.toolChoice,
      params: conformed.params,
      signal: combinedSignal(request.signal)
    });
  }

  protected get model() {
    const resolved = this.gateway.getCapabilities(this.options.providerId, this.options.modelId);
    if (!resolved) throw new GatewayPipelineError(`Unknown model ${this.options.providerId}:${this.options.modelId}`);
    return resolved;
  }

  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const response = await this.chat({
      messages: buildOrchestratorChatMessages({
        systemPrompt: request.systemPrompt,
        trailingPrompt: request.trailingPrompt,
        messages: request.messages,
        pastDecisions: request.pastDecisions,
        decisionMarkers: request.decisionMarkers
      }),
      tools: [{ name: ORCHESTRATOR_TOOL_NAME, parameters: orchestratorToolParameters(request.availableWaifuIds, request.replyRequired, request.directiveBudgetOpen ?? true) as Record<string, unknown> }],
      toolChoice: { name: ORCHESTRATOR_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxOutputTokens, reasoning: request.reasoning },
      signal: request.signal
    });
    const decision = parseForcedCall(response, ORCHESTRATOR_TOOL_NAME, (raw) => OrchestratorDecisionSchema.parse(raw), "decideOrchestrator");
    // Parity with the legacy pipeline: a /run (replyRequired) must produce a reply.
    if (request.replyRequired && decision.action !== "reply") {
      throw new GatewayPipelineError("decideOrchestrator: replyRequired was set but the model returned no_reply");
    }
    return decision;
  }

  async decideReviewer(request: ProviderRequest & { message: string }): Promise<ReviewerDecision> {
    const response = await this.chat({
      messages: [
        { role: "system", content: reviewerSystemPrompt(request.systemPrompt) },
        { role: "user", content: request.message }
      ],
      tools: [{ name: REVIEWER_TOOL_NAME, parameters: reviewerToolParameters() as Record<string, unknown> }],
      toolChoice: { name: REVIEWER_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0, maxOutputTokens: request.maxOutputTokens ?? 64, reasoning: request.reasoning },
      signal: request.signal
    });
    return parseForcedCall(response, REVIEWER_TOOL_NAME, (raw) => ReviewerDecisionSchema.parse(raw), "decideReviewer");
  }

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    const tools: ToolDef[] = [];
    if (request.shortTermMemoryToolEnabled) {
      tools.push({ name: SHORT_TERM_MEMORY_TOOL_NAME, parameters: shortTermMemoryToolParameters() as Record<string, unknown> });
    }
    if (request.pickNextWaifuToolEnabled && request.availableWaifuIds?.length) {
      tools.push({ name: PICK_NEXT_WAIFU_TOOL_NAME, parameters: pickNextWaifuToolParameters(request.availableWaifuIds) as Record<string, unknown> });
    }
    const response = await this.chat({
      messages: await buildWaifuMessages(this.model, request),
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : undefined,
      sampling: {
        temperature: request.temperature, topP: request.topP, maxOutputTokens: request.maxOutputTokens,
        reasoning: request.reasoning, stopSequences: request.stopSequences
      },
      signal: request.signal
    });

    const content = textContent(response);
    if (!content) throw new GatewayPipelineError("empty waifu response");

    const result: WaifuGenerationResult = { content };
    const usage = flatUsage(response);
    if (usage) result.usage = usage;

    const memoryEntries = toolCalls(response, SHORT_TERM_MEMORY_TOOL_NAME)
      .map((call) => { try { return JSON.parse(call.arguments) as { content?: unknown }; } catch { return undefined; } })
      .map((parsed) => (typeof parsed?.content === "string" && parsed.content.trim() ? parsed.content.trim() : undefined))
      .filter((entry): entry is string => entry !== undefined);
    if (memoryEntries.length) result.shortTermMemoryEntries = memoryEntries;

    const pick = toolCalls(response, PICK_NEXT_WAIFU_TOOL_NAME)[0];
    if (pick) {
      let waifuId: string | undefined;
      try { waifuId = (JSON.parse(pick.arguments) as { waifuId?: unknown }).waifuId as string | undefined; } catch { /* malformed */ }
      if (typeof waifuId !== "string" || !waifuId) {
        result.rejectedPickNextWaifu = { reason: "malformed" };
      } else if (!request.availableWaifuIds?.includes(waifuId)) {
        result.rejectedPickNextWaifu = { reason: "unavailable_waifu", waifuId };
      } else {
        result.pickedNextWaifuId = waifuId;
      }
    }
    return result;
  }
}

export function createGatewayModelPipeline(options: GatewayPipelineOptions): GatewayModelPipeline {
  return new GatewayModelPipeline(options, resolveGateway(options));
}
