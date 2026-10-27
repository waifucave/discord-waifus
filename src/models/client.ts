// ModelClient (Living cast spec §9.1): every model call in the app goes through here.
//
// One call = winter route resolution → winter's history renderer → `adapter.streamTurn` (winter's
// retry runs inside the adapter, strictly before the first byte) → the stream assembler
// (./assemble.ts) → one usage-ledger line. The system prompt is passed the way spec §5.4 requires:
// `system` = the blocks joined by a blank line, `systemBlocks` = the same blocks with cache scope
// `org`, `cacheTtl: "1h"` and (winter W3) `messageCacheTtl: { rolling: "1h" }`. `messages` may never
// carry a `role: "system"` entry.

import { createMemoryCredentialStore, shouldRequestSummary } from "@yanlinglabs/winter-provider-runtime";
import type {
  ConnectionProfile,
  ContentBlockLike,
  MessageOrigin,
  ProviderContext,
  ProviderEvent,
  ProviderMessageLike,
  ResolvedModel,
  TurnRequest
} from "@yanlinglabs/winter-provider-runtime";
import type { Logger } from "../backend/logger.js";
import { recordProviderQuery, recordProviderReply, type QueryRole } from "../shared/queryLog.js";
import { joinAdjacentUserMessages } from "./messageShape.js";
import type { UsagePurpose } from "../shared/schemas/usage.js";
import { NoopUsageLedger, sharedUsageLedger, usageFields, type ModelUsage, type UsageLedger } from "../orchestration/usageLedger.js";
import { sharedProviderAlerts, type ProviderAlerts } from "../orchestration/providerAlerts.js";
import {
  assembleTurn,
  messageText,
  newStreamObservation,
  messageToolCalls,
  ProviderStreamError,
  type AssembledMessage,
  type AssemblySink,
  type StreamObservation,
  type WinterStopReason,
  type WinterUsage
} from "./assemble.js";
import { listPricedEstimate, PROMPT_CACHE_TTL, routeKey, type ModelRoute } from "./catalog.js";
import { createProviderCredentialsLookup, inlineAuthRef, type ProviderKeyLookup } from "./credentials.js";
import { fromProviderError, ModelCallError, toModelCallError } from "./errors.js";
import { sharedWinterRuntime, type WinterRuntime } from "./winter.js";

export type { ModelUsage };

/** A tool the model may call. `inputSchema` is a JSON schema object. */
export type ModelTool = { name: string; description: string; inputSchema: Record<string, unknown> };

/** Who a call is billed to in the usage ledger. */
export type ModelCallAttribution = {
  purpose: UsagePurpose;
  agentId?: string;
  waifuId?: string;
  guildId?: string;
  channelId?: string;
  conversationKey?: string;
  turnId?: string;
};

export type ModelCallRequest = {
  route: ModelRoute;
  /** System blocks: [A] or [A, B] (spec §5.4). Never also a `role: "system"` message. */
  system: readonly string[];
  messages: readonly ProviderMessageLike[];
  tools?: readonly ModelTool[];
  toolChoice?: TurnRequest["toolChoice"];
  effort?: string;
  maxOutputTokens?: number;
  /** Groups one conversation's requests for the provider's cache routing (`life:<waifuId>`). */
  cacheKey?: string;
  signal?: AbortSignal;
  /** Wall-clock cap for the whole call, retries included. Default 180 s. */
  timeoutMs?: number;
  /**
   * Thinking blocks the caller already stripped from this request's history (a new epoch's kept
   * turns, §5.6); added to what winter's renderer drops and recorded as `thinkingBlocksDropped`.
   */
  thinkingBlocksStripped?: number;
  attribution: ModelCallAttribution;
};

/** `stop` (ended normally), `tool_use`, `length` (output cap), `refusal`, `context_window`, `paused`. */
export type ModelFinishReason = "stop" | "tool_use" | "length" | "refusal" | "context_window" | "paused";

export type ModelCallResult = {
  /** The assistant message exactly as assembled: append it to the log unchanged. */
  message: AssembledMessage;
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  finishReason: ModelFinishReason;
  usage?: ModelUsage;
  /** Absent for an unpriced route. */
  costUsd?: number;
  responseId?: string;
  reasoningSummary?: string;
  /** Thinking blocks dropped from the replayed history (renderer + caller-stripped). */
  thinkingBlocksDropped: number;
  durationMs: number;
};

/** Live events of a streaming call (the dashboard assistant's SSE). */
export type ModelStreamSink = AssemblySink;

export type ModelClientOptions = {
  /** Production: provider keys come from `<dataRoot>/user/providers.json`; ledger and alerts default to the shared instances. */
  dataRoot?: string;
  credentials?: ProviderKeyLookup;
  winter?: WinterRuntime;
  usageLedger?: UsageLedger;
  providerAlerts?: ProviderAlerts;
  logger?: Pick<Logger, "warn" | "debug">;
  /** Per-provider connection overrides (tests: a loopback `baseUrl` with `local: true`). */
  connection?: (providerId: string) => Partial<Omit<ConnectionProfile, "providerId">> | undefined;
  /** winter's no-bytes stall timeout. Default 120 s. */
  stallTimeoutMs?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
};

export const DEFAULT_MODEL_CALL_TIMEOUT_MS = 180_000;
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;
/**
 * Our own output cap for a route whose catalog row names none (winter W2: the Muse Spark
 * contributor rows carry no `maxOutputTokens`), used when the caller sets no cap either.
 */
export const DEFAULT_OUTPUT_CAP_TOKENS = 8_192;

/**
 * winter W3: the message-level cache TTLs. `lookback` defaults to `rolling`, and a request whose TTLs
 * increase from system to lookback to rolling is refused, so with `cacheTtl: "1h"` the rolling TTL is
 * 1h too.
 */
export const MESSAGE_CACHE_TTL = Object.freeze({ rolling: PROMPT_CACHE_TTL });

/**
 * The call's cost: the provider's own reported figure when there is one (winter W5: OpenRouter's
 * `reportedCostUsd`, where 0 is a real value), else winter's list-price estimate. Undefined for an
 * unpriced route (`listPricedEstimate` decides priced-ness the same way `/api/models` does).
 */
export function callCostUsd(usage: (ModelUsage & { reportedCostUsd?: number }) | undefined, estimate: { costUsd: number; costBasis: string } | undefined): number | undefined {
  const reported = usage?.reportedCostUsd;
  if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) return reported;
  return estimate && estimate.costBasis === "list" ? estimate.costUsd : undefined;
}

/** The adapter ended the stream with `done: aborted`: keeps the usage the fold had counted. */
class TurnAbortedError extends Error {
  override name = "TurnAbortedError";
  constructor(readonly usage: WinterUsage | undefined) {
    super("The model call was aborted.");
  }
}

const QUERY_ROLE: Record<UsagePurpose, QueryRole> = {
  life: "life",
  maintenance: "maintenance",
  detector: "detector",
  compaction: "compaction",
  assistant: "assistant",
  web: "web"
};

function finishReasonOf(stop: WinterStopReason | undefined, toolCalls: number): ModelFinishReason {
  switch (stop) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    case "model_context_window_exceeded":
      return "context_window";
    case "pause_turn":
      return "paused";
    case "end_turn":
      return toolCalls > 0 ? "tool_use" : "stop";
    default:
      return toolCalls > 0 ? "tool_use" : "stop";
  }
}

function assertNoSystemMessages(messages: readonly ProviderMessageLike[]): void {
  if (messages.some((message) => message.role === "system")) {
    throw new TypeError("ModelClient: messages may not contain a role \"system\" entry; pass system blocks instead.");
  }
}

/** Rough pre-flight size of a request (characters / 3.5 + a flat 1,000 per image), for the ledger. */
function estimateInputTokens(system: readonly string[], messages: readonly ProviderMessageLike[], tools: readonly ModelTool[] | undefined): number {
  let chars = system.reduce((sum, block) => sum + block.length, 0);
  let images = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      chars += message.content.length;
      continue;
    }
    for (const block of message.content) {
      if (block.type === "image") images += 1;
      else if (block.type === "text") chars += block.text.length;
      else if (block.type === "tool_use") chars += block.name.length + JSON.stringify(block.input ?? {}).length;
      else if (block.type === "tool_result") chars += typeof block.content === "string" ? block.content.length : JSON.stringify(block.content).length;
      else if (block.type === "thinking") chars += block.thinking.length;
    }
  }
  for (const tool of tools ?? []) chars += JSON.stringify(tool).length;
  return Math.ceil(chars / 3.5) + images * 1_000;
}

export class ModelClient {
  private readonly credentials: ProviderKeyLookup;
  private readonly ledger: UsageLedger;
  private readonly alerts: ProviderAlerts | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ModelClientOptions = {}) {
    const dataRoot = options.dataRoot;
    this.credentials = options.credentials ?? (dataRoot ? createProviderCredentialsLookup(dataRoot) : () => undefined);
    this.ledger = options.usageLedger ?? (dataRoot ? sharedUsageLedger(dataRoot) : NoopUsageLedger);
    this.alerts = options.providerAlerts ?? (dataRoot ? sharedProviderAlerts(dataRoot) : undefined);
    this.now = options.now ?? Date.now;
  }

  private get winter(): WinterRuntime {
    return this.options.winter ?? sharedWinterRuntime();
  }

  /** The winter resolution of a route, or a ModelCallError (`unknown_model`). */
  resolve(route: ModelRoute): ResolvedModel {
    const resolved = this.winter.registry.resolve({ model: route.modelId, provider: { providerId: route.providerId } });
    if (resolved instanceof Error) {
      throw new ModelCallError("other", `Model ${routeKey(route)} is not available: ${resolved.message}`, { code: "unknown_model" });
    }
    return resolved;
  }

  /** How long a provider still cools down after a quota/billing error (ms), or undefined when available. */
  cooldownRemainingMs(providerId: string): number | undefined {
    return this.alerts?.remainingMs(providerId);
  }

  /** One model call; returns the assembled assistant message. */
  call(request: ModelCallRequest): Promise<ModelCallResult> {
    return this.run(request, undefined);
  }

  /** The streaming variant: the same call, with text/tool/reasoning deltas reported as they arrive. */
  stream(request: ModelCallRequest, sink: ModelStreamSink): Promise<ModelCallResult> {
    return this.run(request, sink);
  }

  private async run(request: ModelCallRequest, sink: ModelStreamSink | undefined): Promise<ModelCallResult> {
    assertNoSystemMessages(request.messages);
    const { route, attribution } = request;
    // Fail fast (no network, no ledger line) while a quota/billing cooldown is open.
    this.alerts?.assertAvailable(route.providerId);

    const startedMs = this.now();
    const entryBase = {
      at: new Date(startedMs).toISOString(),
      ...attribution,
      providerId: route.providerId,
      modelId: route.modelId,
      estimatedInputTokens: estimateInputTokens(request.system, request.messages, request.tools)
    };
    const timeout = AbortSignal.timeout(request.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_MODEL_CALL_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    let queryId: number | undefined;
    const role = QUERY_ROLE[attribution.purpose];
    let descriptor: ResolvedModel["descriptor"];
    const observation: StreamObservation = newStreamObservation();

    try {
      const resolved = this.resolve(route);
      const apiKey = this.credentials(resolved.providerId);
      if (!apiKey) {
        throw new ModelCallError("auth", `Provider ${resolved.providerId} has no API key configured.`, { code: "missing_credentials" });
      }
      const adapter = resolved.adapter;
      descriptor = resolved.descriptor;
      const capabilities = descriptor ? adapter.capabilities(descriptor) : undefined;
      const { messages: rendered, report } = this.winter.renderer.renderWithReport([...request.messages], new Map(), {
        family: adapter.family,
        ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {}),
        readableState: capabilities?.readableState ?? "none",
        providerId: resolved.providerId,
        modelKey: resolved.modelKey,
        ...(descriptor ? { readsImages: descriptor.inputModalities.value.includes("image") } : {})
      });
      const system = request.system.filter((block) => block.length > 0);
      const maxOutputTokens = request.maxOutputTokens ?? (descriptor?.maxOutputTokens ? undefined : DEFAULT_OUTPUT_CAP_TOKENS);
      const turn: TurnRequest = {
        model: resolved.providerModelId,
        ...(system.length > 0
          ? { system: system.join("\n\n"), systemBlocks: system.map((text) => ({ text, cacheScope: "org" as const })) }
          : {}),
        messages: joinAdjacentUserMessages(rendered),
        ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map((tool) => ({ ...tool })) } : {}),
        ...(request.toolChoice ? { toolChoice: request.toolChoice } : {}),
        ...(request.effort !== undefined ? { effort: request.effort as TurnRequest["effort"] } : {}),
        ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
        cacheTtl: PROMPT_CACHE_TTL,
        messageCacheTtl: { ...MESSAGE_CACHE_TTL },
        ...(request.cacheKey !== undefined ? { cacheKey: request.cacheKey } : {}),
        ...(shouldRequestSummary(descriptor) ? { requestSummary: true } : {}),
        signal
      };
      queryId = recordProviderQuery(role, {
        system: turn.system,
        messages: turn.messages,
        ...(turn.tools ? { tools: turn.tools } : {}),
        ...(turn.toolChoice ? { tool_choice: turn.toolChoice } : {})
      }, { providerId: route.providerId, modelId: route.modelId }).id;
      const connection: ConnectionProfile = { ...(this.options.connection?.(resolved.providerId) ?? {}), providerId: resolved.providerId };
      const context: ProviderContext = {
        connection,
        credentials: createMemoryCredentialStore(),
        authRef: inlineAuthRef(apiKey),
        stallTimeoutMs: this.options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
        log: () => undefined
      };
      const origin: MessageOrigin = {
        providerId: resolved.providerId,
        modelKey: resolved.modelKey,
        family: adapter.family,
        ...(resolved.continuationDomain !== undefined ? { continuationDomain: resolved.continuationDomain } : {})
      };
      let stream: AsyncIterable<ProviderEvent>;
      try {
        stream = adapter.streamTurn(turn, context);
      } catch (error) {
        throw toModelCallError(error);
      }
      const assembled = await assembleTurn(stream, { origin, signal, observation, ...(sink ? { sink } : {}) });
      // Only the stream decides: a call whose stream completed is a completed call, even when the
      // caller aborts right after.
      if (assembled.stopReason === "aborted") throw new TurnAbortedError(assembled.usage);
      const usage = assembled.usage;
      const priced = callCostUsd(usage, listPricedEstimate(usage, descriptor));
      const toolCalls = messageToolCalls(assembled.message);
      const finishReason = finishReasonOf(assembled.stopReason, toolCalls.length);
      const durationMs = this.now() - startedMs;
      // The provider's own count (winter's usage event), what winter's renderer stripped, and what the
      // caller stripped before the call (a new epoch's kept turns).
      const thinkingBlocksDropped = (usage?.thinkingBlocksDropped ?? 0) + report.strippedInDialectBlocks + (request.thinkingBlocksStripped ?? 0);
      void this.ledger.record({
        ...entryBase,
        status: "ok",
        ...usageFields(usage, priced),
        ...(thinkingBlocksDropped > 0 ? { thinkingBlocksDropped } : {}),
        finishReason,
        durationMs
      });
      recordProviderReply(role, queryId, 200, true, { content: assembled.message.content, finishReason, usage, ...(priced !== undefined ? { costUsd: priced } : {}), durationMs });
      return {
        message: assembled.message,
        text: messageText(assembled.message),
        toolCalls,
        finishReason,
        ...(usage ? { usage } : {}),
        ...(priced !== undefined ? { costUsd: priced } : {}),
        ...(assembled.responseId !== undefined ? { responseId: assembled.responseId } : {}),
        ...(assembled.reasoningSummary !== undefined ? { reasoningSummary: assembled.reasoningSummary } : {}),
        thinkingBlocksDropped,
        durationMs
      };
    } catch (raw) {
      let error: ModelCallError;
      // One meaning of "committed" on every path: part of the answer (text, a tool call or
      // reasoning) arrived, as the observation tap saw it. winter's own first-byte flag also counts
      // a bare `message_start` or role-only chunk, after which a retry is still safe.
      const committed = observation.contentArrived;
      if (raw instanceof ProviderStreamError) {
        error = fromProviderError(raw.error, { subscriptionQuota: observation.subscriptionQuota, committed });
      } else if (raw instanceof TurnAbortedError) {
        error = new ModelCallError("aborted", raw.message, { code: "aborted", committed });
      } else {
        error = toModelCallError(raw, { committed });
      }
      if (request.signal?.aborted && error.kind !== "aborted") {
        error = new ModelCallError("aborted", "The model call was aborted.", { code: "aborted", committed });
      } else if (!request.signal?.aborted && timeout.aborted && error.kind === "aborted") {
        // A timeout is retryable only when nothing of the answer had arrived.
        error = new ModelCallError("other", "The model call timed out.", { code: "timeout", retryable: true, committed });
      }
      this.alerts?.report(route.providerId, error);
      // winter's failure carries no usage: the stream observation keeps the last usage event.
      const partialUsage = raw instanceof TurnAbortedError ? raw.usage : raw instanceof ProviderStreamError ? observation.usage : undefined;
      const partialCost = callCostUsd(partialUsage, listPricedEstimate(partialUsage, descriptor));
      void this.ledger.record({
        ...entryBase,
        status: error.kind === "aborted" ? "aborted" : "failed",
        ...usageFields(partialUsage, partialCost),
        errorKind: error.kind,
        durationMs: this.now() - startedMs
      });
      if (queryId !== undefined) recordProviderReply(role, queryId, error.status ?? 0, false, { error: { kind: error.kind, code: error.code, message: error.message }, durationMs: this.now() - startedMs });
      throw error;
    }
  }
}

const sharedClients = new Map<string, ModelClient>();

/** The process-wide client for a data root (credentials, ledger and alerts of that root). */
export function sharedModelClient(dataRoot: string): ModelClient {
  let client = sharedClients.get(dataRoot);
  if (!client) {
    client = new ModelClient({ dataRoot });
    sharedClients.set(dataRoot, client);
  }
  return client;
}
