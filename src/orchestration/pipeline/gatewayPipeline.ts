import { sanitizeChatMessages } from "../../shared/text.js";
import { createGateway, GatewayError, Gateway, type ChatMessage, type ResolvedModel, type ChatResponse, type TextBlock, type ToolCallBlock, type ToolDef } from "@waifucave/gateway";
import { z } from "zod";
import { createProviderCredentialsLookup } from "../../api/llmGatewayCredentials.js";
import { QueryRole, recordProviderQuery, recordProviderReply } from "../../shared/queryLog.js";
import type { AssistantTurnRequest, AssistantTurnResult, ModelPipeline, ProviderRequest, WaifuGenerationRequest, WaifuGenerationResult, StageManagerObserveRequest, DreamRequest, PersonaDigestRequest, PersonaDigest, SummarizeContextRequest } from "../../providers/types.js";
import { ORCHESTRATOR_TOOL_NAME, PICK_NEXT_WAIFU_TOOL_NAME, REVIEWER_TOOL_NAME, SHORT_TERM_MEMORY_TOOL_NAME, OBSERVER_TOOL_NAME, DREAM_TOOL_NAME, PERSONA_DIGEST_TOOL_NAME, dreamSystemPrompt, PERSONA_DIGEST_PROMPT, ReviewerDecision, ReviewerDecisionSchema, pickNextWaifuToolParameters, reviewerMessages, reviewerToolParameters, shortTermMemoryToolParameters, observerSystemPrompt, observerToolParameters, dreamToolParameters, flatDreamToolParameters, personaDigestToolParameters, dreamMessages, normalizeDreamOps, normalizeOrchestratorDecision, parseRawObserverOps } from "../tools.js";
import { GatewayPipelineError, TruncatedOutputError, buildUnifiedParams, preconformRequest } from "./params.js";
import { estimateTokens } from "../context/tokens.js";
import type { ModelCallAttribution, SummaryResult, UsagePurpose } from "../context/types.js";
import { compactionMaxOutputTokens, compactionMessages, compactionToolChoice } from "../context/compaction.js";
import type { Logger } from "../../backend/logger.js";
import { NoopUsageLedger, sharedUsageLedger, usageFields, type UsageLedger } from "../usageLedger.js";
import { sharedProviderAlerts, type ProviderAlerts } from "../providerAlerts.js";
import { buildWaifuMessages } from "./messages.js";
import { OrchestratorDecision } from "../decisions.js";
import { DreamOp, ObserverOp } from "../stageManager.js";

const PersonaDigestResultSchema = z.object({ voice: z.string().min(1), role: z.string().min(1) });

const REQUEST_TIMEOUT_MS = 180_000;

export type GatewayPipelineOptions = {
  providerId: string;
  modelId: string;
  queryRole: QueryRole;
  dataRoot?: string;        // production: live credentials from user/providers.json
  gateway?: Gateway;        // tests: inject directly
  /** One line per model call (spec 8.10). Defaults to the shared ledger for `dataRoot`, else none. */
  usageLedger?: UsageLedger;
  /** Quota/billing cooldowns. Defaults to the shared instance for `dataRoot`, else none. */
  providerAlerts?: ProviderAlerts;
  logger?: Pick<Logger, "warn">;
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

// content_dropped / cache_ignored warnings repeat on every call of an affected model; log each
// (provider, model, code) once per process.
const loggedWarnings = new Set<string>();

type CallMeta = {
  purpose: UsagePurpose;
  attribution?: ModelCallAttribution;
  promptCacheKey?: string;
  /** Set for structured decisions: a `length` finish throws TruncatedOutputError with this label. */
  structuredLabel?: string;
};

function callMeta(request: ProviderRequest, purpose: UsagePurpose, structuredLabel?: string): CallMeta {
  return {
    purpose: request.attribution?.purpose ?? purpose,
    attribution: request.attribution,
    promptCacheKey: request.prompt?.promptCacheKey,
    structuredLabel
  };
}

/**
 * Spec 8.0: only messages[0] may be role "system" (Anthropic/Google codecs hoist every system
 * message into the top-level system prompt, which would move mid-conversation notes out of place).
 * Any later system message becomes a user-role `<system_note>`.
 */
function demoteLateSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => {
    if (index === 0 || message.role !== "system") return message;
    const text = typeof message.content === "string" ? message.content : message.content.map((block) => block.text).join("\n\n");
    return { role: "user", content: `<system_note>\n${text}\n</system_note>`, ...(message.cacheControl ? { cacheControl: message.cacheControl } : {}) };
  });
}

/**
 * True when a forced decision on this model goes out as JSON-schema structured output with NO
 * tools (it lacks named tool choice but supports JSON schema). The orchestrator renders its past
 * decisions as text lines on this path (spec 8.3), since there are no tool turns to replay.
 */
export function usesJsonSchemaDecisions(model: Pick<ResolvedModel, "features">): boolean {
  return !model.features.tools.toolChoice?.includes("named") && Boolean(model.features.structuredOutput.jsonSchema);
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function errorKindOf(error: unknown): string {
  if (error instanceof GatewayError) return error.kind;
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  return "error";
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
  const calls = toolCalls(response, toolName);
  const call = calls[0];
  if (!call) throw new GatewayPipelineError(`${label}: model did not call ${toolName}`, { text: calls[0]?.arguments });
  let raw: unknown;
  try {
    raw = JSON.parse(call.arguments);
  } catch (error) {
    throw new GatewayPipelineError(`${label}: malformed ${toolName} arguments`, {
      text: call.arguments,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  try {
    return parse(raw);
  } catch (error) {
    throw new GatewayPipelineError(`${label}: invalid ${toolName} arguments — ${error instanceof Error ? error.message : String(error)}`, {
      text: call.arguments,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

class GatewayModelPipeline implements ModelPipeline {
  private readonly ledger: UsageLedger;
  private readonly alerts: ProviderAlerts | undefined;

  constructor(private readonly options: GatewayPipelineOptions, private readonly gateway: Gateway) {
    const dataRoot = options.dataRoot;
    this.ledger = options.usageLedger ?? (dataRoot ? sharedUsageLedger(dataRoot) : NoopUsageLedger);
    this.alerts = options.providerAlerts ?? (dataRoot ? sharedProviderAlerts(dataRoot) : undefined);
  }

  private logCallWarnings(response: ChatResponse): void {
    const { providerId, modelId } = this.options;
    for (const warning of response.warnings) {
      if (warning.code !== "content_dropped" && warning.code !== "cache_ignored") continue;
      const key = `${providerId}:${modelId}:${warning.code}`;
      if (loggedWarnings.has(key)) continue;
      loggedWarnings.add(key);
      const message = `Gateway warning ${warning.code} for ${providerId}:${modelId}`;
      const context = { param: warning.param, message: warning.message };
      if (this.options.logger) this.options.logger.warn(message, context);
      else console.warn(message, context);
    }
  }

  protected async chat(request: {
    messages: Parameters<Gateway["chat"]>[0]["messages"];
    tools?: ToolDef[];
    toolChoice?: Parameters<Gateway["chat"]>[0]["toolChoice"];
    sampling: Parameters<typeof buildUnifiedParams>[0];
    signal?: AbortSignal;
    meta: CallMeta;
  }): Promise<ChatResponse> {
    const { providerId, modelId } = this.options;
    // Fail fast (no network, no ledger line) while a quota/billing cooldown is open.
    this.alerts?.assertAvailable(providerId);
    // Some models (including Muse Spark) allow automatic tools but not named
    // tool choice. Decisions can use the SAME schema as structured output;
    // never silently downgrade a required decision to optional tool calling.
    const choice = request.toolChoice;
    const schemaTool = typeof choice === "object" && usesJsonSchemaDecisions(this.model)
      ? request.tools?.find((tool) => tool.name === choice.name)
      : undefined;
    const conformed = preconformRequest(this.gateway, providerId, modelId, {
      params: buildUnifiedParams(request.sampling),
      toolChoice: schemaTool ? undefined : request.toolChoice
    });
    // Only messages[0] may be a system message (spec 8.0): the JSON nudge is a final user turn.
    const messages = demoteLateSystemMessages(sanitizeChatMessages(schemaTool ? [
      ...request.messages,
      { role: "user" as const, content: `Return the arguments for ${schemaTool.name} as JSON matching the provided response schema. Do not call a tool.` }
    ] : request.messages));
    const { meta } = request;
    const startedMs = Date.now();
    const entryBase = {
      at: new Date(startedMs).toISOString(),
      ...(meta.attribution ?? {}),
      purpose: meta.purpose,
      providerId,
      modelId,
      estimatedInputTokens: estimateTokens(messages, schemaTool ? undefined : request.tools)
    };
    let response: ChatResponse;
    try {
      response = await this.gateway.chat({
        provider: providerId,
        model: modelId,
        messages,
        tools: schemaTool ? undefined : request.tools,
        toolChoice: conformed.toolChoice,
        responseFormat: schemaTool ? { type: "json_schema", name: schemaTool.name, schema: schemaTool.parameters } : undefined,
        params: conformed.params,
        promptCacheKey: meta.promptCacheKey,
        signal: combinedSignal(request.signal)
      });
    } catch (error) {
      this.alerts?.report(providerId, error);
      void this.ledger.record({
        ...entryBase,
        status: isAbort(error, request.signal) ? "aborted" : "failed",
        ...usageFields(undefined),
        errorKind: errorKindOf(error),
        durationMs: Date.now() - startedMs
      });
      throw error;
    }
    void this.ledger.record({
      ...entryBase,
      status: "ok",
      ...usageFields(response.usage),
      finishReason: response.finishReason,
      durationMs: Date.now() - startedMs
    });
    this.logCallWarnings(response);
    if (meta.structuredLabel && response.finishReason === "length") throw new TruncatedOutputError(meta.structuredLabel);
    if (!schemaTool) return response;
    if (response.finishReason !== "stop") {
      throw new GatewayPipelineError(`Structured decision did not complete: ${response.finishReason}`);
    }
    // Existing decision parsers still validate both JSON syntax and semantics.
    return { ...response, content: [{ type: "toolCall", id: `structured-${response.id}`,
      name: schemaTool.name, arguments: response.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text).join("") }] };
  }

  protected get model() {
    const resolved = this.gateway.getCapabilities(this.options.providerId, this.options.modelId);
    if (!resolved) throw new GatewayPipelineError(`Unknown model ${this.options.providerId}:${this.options.modelId}`);
    return resolved;
  }

  // The director's prompt is built by the context engine (spec 8.7): messages, tools and
  // promptCacheKey are sent unchanged. Reply-required is enforced by the caller in code (the tool
  // schema is stable per channel config), so the decision is parsed without that gate.
  async decideOrchestrator(request: ProviderRequest): Promise<OrchestratorDecision> {
    const prompt = request.prompt;
    if (!prompt) throw new GatewayPipelineError("decideOrchestrator: a context-engine prompt is required");
    const response = await this.chat({
      messages: prompt.messages,
      tools: prompt.tools,
      toolChoice: { name: ORCHESTRATOR_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, topP: request.topP, maxOutputTokens: request.maxOutputTokens, params: request.params },
      signal: request.signal,
      meta: callMeta(request, "orchestrator", "decideOrchestrator")
    });
    if (response.usage) request.onUsage?.(response.usage);
    return parseForcedCall(response, ORCHESTRATOR_TOOL_NAME, (raw) => normalizeOrchestratorDecision(raw), "decideOrchestrator");
  }

  async decideReviewer(request: ProviderRequest & { message: string; authorName?: string }): Promise<ReviewerDecision> {
    const response = await this.chat({
      messages: reviewerMessages({ customPrompt: request.systemPrompt, authorName: request.authorName, message: request.message }),
      tools: [{ name: REVIEWER_TOOL_NAME, parameters: reviewerToolParameters() as Record<string, unknown> }],
      toolChoice: { name: REVIEWER_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0, maxOutputTokens: request.maxOutputTokens ?? 64, params: request.params },
      signal: request.signal,
      meta: callMeta(request, "reviewer", "decideReviewer")
    });
    return parseForcedCall(response, REVIEWER_TOOL_NAME, (raw) => ReviewerDecisionSchema.parse(raw), "decideReviewer");
  }

  async generateAssistantTurn(request: AssistantTurnRequest): Promise<AssistantTurnResult> {
    const transcript = [...request.messages];
    const limit = request.maxToolCalls ?? 12;
    let executedCalls = 0;
    for (let round = 0; round < limit + 1; round++) {
      const response = await this.chat({
        messages: transcript,
        tools: request.tools,
        sampling: { params: request.params },
        signal: request.signal,
        meta: { purpose: "assistant" }
      });
      const toolCalls = response.content.filter((block): block is ToolCallBlock => block.type === "toolCall");
      const text = response.content
        .filter((block): block is TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (toolCalls.length === 0) {
        transcript.push({ role: "assistant", content: text });
        return { content: text, messages: transcript };
      }
      // Reasoning blocks go back unchanged (signatures / redacted data / `replay` must round-trip
      // byte-exact on the next round); they are never displayed, only `text` blocks are.
      transcript.push({ role: "assistant", content: response.content });
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

  async generateWaifu(request: WaifuGenerationRequest): Promise<WaifuGenerationResult> {
    const tools: ToolDef[] = [];
    if (request.shortTermMemoryToolEnabled) {
      tools.push({ name: SHORT_TERM_MEMORY_TOOL_NAME, parameters: shortTermMemoryToolParameters() as Record<string, unknown> });
    }
    if (request.pickNextWaifuToolEnabled && request.availableWaifuIds?.length) {
      tools.push({ name: PICK_NEXT_WAIFU_TOOL_NAME, parameters: pickNextWaifuToolParameters(request.availableWaifuIds) as Record<string, unknown> });
    }
    const response = await this.chat({
      messages: await buildWaifuMessages(this.model, { ...request, systemPrompt: request.systemPrompt ?? "" }),
      tools: tools.length ? tools : undefined,
      toolChoice: tools.length ? "auto" : undefined,
      sampling: {
        temperature: request.temperature, topP: request.topP, maxOutputTokens: request.maxOutputTokens,
        params: request.params, stopSequences: request.stopSequences
      },
      signal: request.signal,
      meta: callMeta(request, request.retryUserMessage ? "waifu_retry" : "waifu_reply")
    });

    // Legacy parity (postJsonAndExtractText, legacy pipelines.ts:837-840): a record extract
    // with a `content` field is returned as-is even when trimmed content is "" — tool calls
    // (add_memory / PickNextWaifu) still need to be surfaced for a tool-only reply. Do not
    // throw here; runtime.ts's usedToolWithoutVisibleMessage / tool-only note-recording path
    // depends on receiving `content: ""` alongside extracted tool results.
    const content = textContent(response);

    const result: WaifuGenerationResult = { content };
    result.usage = response.usage;
    result.finishReason = response.finishReason;

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

  async decideStageManagerObservations(request: StageManagerObserveRequest): Promise<ObserverOp[]> {
    // The observer reads its rendered per-conversation input (T6: participants, memories, the
    // transcript since its cursor); the legacy window formatter is gone.
    const observerInput = request.observerInput;
    if (!observerInput) throw new GatewayPipelineError("decideStageManagerObservations: observerInput is required");
    const response = await this.chat({
      messages: [
        { role: "system", content: observerSystemPrompt(request.systemPrompt, request.availableWaifuIds) },
        { role: "user", content: observerInput }
      ],
      tools: [{ name: OBSERVER_TOOL_NAME, parameters: observerToolParameters(request.availableWaifuIds) as Record<string, unknown> }],
      toolChoice: { name: OBSERVER_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxOutputTokens, params: request.params },
      signal: request.signal,
      meta: callMeta(request, "observer", "decideStageManagerObservations")
    });
    return parseForcedCall(response, OBSERVER_TOOL_NAME, (raw) => {
      const obj = raw as { ops?: unknown[]; observations?: unknown[] };
      const arr = Array.isArray(obj) ? obj : (obj.ops ?? obj.observations ?? []);
      return parseRawObserverOps(arr as unknown[]);
    }, "decideStageManagerObservations");
  }

  async decideDream(request: DreamRequest): Promise<DreamOp[]> {
    const isFlat = this.model.wire === "google-generative-language";
    const response = await this.chat({
      messages: [
        { role: "system", content: dreamSystemPrompt(request.systemPrompt) },
        ...dreamMessages(request)
      ],
      tools: [{ name: DREAM_TOOL_NAME, parameters: (isFlat ? flatDreamToolParameters(request.availableWaifuIds) : dreamToolParameters(request.availableWaifuIds)) as Record<string, unknown> }],
      toolChoice: { name: DREAM_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxOutputTokens, params: request.params },
      signal: request.signal,
      meta: callMeta(request, "dream", "decideDream")
    });
    return parseForcedCall(response, DREAM_TOOL_NAME, (raw) => {
      const obj = raw as { ops?: unknown[] };
      const rawOps = Array.isArray(obj) ? obj : (obj.ops ?? []);
      if (!Array.isArray(rawOps) || rawOps.length === 0) {
        throw new Error("dream response did not contain an ops array.");
      }
      // Per-op tolerance (parity with legacy parseDreamOps, legacy pipelines.ts:1416-1432):
      // skip individually invalid ops instead of failing the whole chunk on the first bad one.
      return normalizeDreamOps(rawOps as unknown[]);
    }, "decideDream");
  }

  async generatePersonaDigest(request: PersonaDigestRequest): Promise<PersonaDigest> {
    const response = await this.chat({
      messages: [
        { role: "system", content: PERSONA_DIGEST_PROMPT },
        { role: "user", content: request.personaText }
      ],
      tools: [{ name: PERSONA_DIGEST_TOOL_NAME, parameters: personaDigestToolParameters() as Record<string, unknown> }],
      toolChoice: { name: PERSONA_DIGEST_TOOL_NAME },
      sampling: { temperature: request.temperature ?? 0.2, maxOutputTokens: request.maxOutputTokens, params: request.params },
      signal: request.signal,
      meta: callMeta(request, "persona_digest", "generatePersonaDigest")
    });
    return parseForcedCall(response, PERSONA_DIGEST_TOOL_NAME, (raw) => PersonaDigestResultSchema.parse(raw), "generatePersonaDigest");
  }

  /**
   * Spec 8.9: the context's own model summarizes it, reusing the cached prefix. Messages through
   * C, tools, tool choice and params are the reply call's; only the tail (the instruction), the
   * output cap and the absence of stop sequences differ. Tool calls in the output are ignored.
   * A `length` finish (summary cut off) is retried once with a doubled cap; the finish reason is
   * returned so compaction never stores a truncated summary.
   */
  async summarizeContext(request: SummarizeContextRequest): Promise<SummaryResult> {
    const { prompt } = request;
    const model = this.model;
    const tools = prompt.tools.length > 0 ? prompt.tools : undefined;
    const { stopSequences: _stop, ...params } = request.params ?? {};
    const messages = compactionMessages(prompt, request.instruction);
    const toolChoice = tools ? compactionToolChoice(request.toolChoice ?? "auto", model.features.tools.toolChoice) : undefined;
    const send = (maxOutputTokens: number) =>
      this.chat({
        messages,
        tools,
        toolChoice,
        sampling: { temperature: request.temperature, topP: request.topP, params: { ...params, maxOutputTokens } },
        signal: request.signal,
        meta: {
          purpose: "compaction",
          attribution: { ...(request.attribution ?? {}), purpose: "compaction" },
          promptCacheKey: prompt.promptCacheKey
        }
      });
    const cap = compactionMaxOutputTokens(request.params, model, request.maxOutputTokens);
    let response = await send(cap);
    if (response.finishReason === "length" && cap < model.limits.maxOutputTokens) {
      response = await send(Math.min(model.limits.maxOutputTokens, cap * 2));
    }
    return { text: textContent(response), finishReason: response.finishReason };
  }
}

export function createGatewayModelPipeline(options: GatewayPipelineOptions): ModelPipeline {
  return new GatewayModelPipeline(options, resolveGateway(options));
}
