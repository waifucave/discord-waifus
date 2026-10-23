// Context compaction (spec 6.6, 8.9): each context compacts ITSELF with its own model, reusing
// its cached prefix. The summarize request is the exact BuiltPrompt through breakpoint C (same
// system, tools, tool choice and params as the reply call) with the ephemeral tail replaced by
// the compaction instruction, so it is billed mostly as cache reads. The orchestrator is the
// documented exception: its reply call forces `orchestrator_decision`, so its summarize call uses
// tool choice `none` (where supported, else `auto`) and pays mostly fresh input.
//
// An `overflow` compaction (and any summarize call that itself overflows) cannot reuse the prefix:
// the prompt that just overflowed is too big to send again. It summarizes a REDUCED prompt — the
// transcript up to the keep boundary, trimmed from the front until it fits the budget.
//
// On success one revisioned write starts the next epoch: epoch+1, the new summary, the cursor at
// the entry before the kept window, `headerText: null` (the next prepare re-freezes the time zone,
// memory snapshot and header), notes before the cursor dropped (edit notes included), memory-note
// / inline-image counters reset, image modes pruned, `lastBreakpoint: null` and `lastCompaction`.
// The write is discarded when the epoch changed meanwhile. A summary cut off by the output cap
// (`finishReason: "length"`) is never stored.
//
// Concurrency: single-flight per (conversation, agent) in memory; no storage lock is held during
// the LLM call. A caller's abort signal only stops that caller waiting.

import type { ChatMessage, ResolvedModel, TextBlock, ToolChoice } from "@waifucave/gateway";
import type { Logger } from "../../backend/logger.js";
import type { ModelPipeline, SummarizeContextRequest } from "../../providers/types.js";
import type { ContextState, LedgerEntry } from "../../shared/schemas/context.js";
import type { ContextEngineStore } from "./contextStore.js";
import { contextAgentId, conversationKey, type ContextAgent, type ConversationKey, type ConversationRef } from "./keys.js";
import { isGapEntry, orderedEntries } from "./ledger.js";
import type { CalibrationHook } from "./runtime.js";
import { estimateTokens } from "./tokens.js";
import type {
  BuiltPrompt,
  CompactInput,
  CompactionOutcome,
  CompactionService,
  CompactionSettings,
  CompactionTrigger,
  SummaryResult,
  TokenBudget
} from "./types.js";

const IMAGE_TOKENS = 1_000;

/** True for a gateway `context_overflow` error (also when wrapped as a cause). */
export function isContextOverflowError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 4) return false;
  if ((error as { kind?: unknown }).kind === "context_overflow") return true;
  return isContextOverflowError((error as { cause?: unknown }).cause, depth + 1);
}

/** Spec 8.9: `keepRecent` is clamped to floor(maxMessages × 0.6). */
export function effectiveKeepRecent(s: Pick<CompactionSettings, "keepRecent" | "maxMessages">): number {
  return Math.max(1, Math.min(s.keepRecent, Math.floor(s.maxMessages * 0.6)));
}

// ---------------------------------------------------------------------------------------------
// Calibration (spec 8.9): EMA α = 0.3 of usage.inputTokens / estimate, clamped [0.5, 2.5].

export const CALIBRATION_ALPHA = 0.3;
export const CALIBRATION_MIN = 0.5;
export const CALIBRATION_MAX = 2.5;

const clampRatio = (r: number) => Math.min(CALIBRATION_MAX, Math.max(CALIBRATION_MIN, r));

function imageCount(messages: readonly ChatMessage[] | undefined): number {
  let count = 0;
  for (const message of messages ?? []) {
    if (Array.isArray(message.content)) for (const block of message.content) if (block.type === "image") count += 1;
  }
  return count;
}

/**
 * The per-model token calibration hook for ContextRuntime. The ratio scales the TEXT estimate
 * only (estimateTokens adds a flat 1,000 per image), so it is fitted on text only: the image
 * estimate is subtracted from both the observed input and the raw estimate. The first sample
 * seeds the ratio with the (clamped) observation; later samples move it by α. Calls without
 * usable numbers are skipped.
 */
export const emaTokenCalibration: CalibrationHook = ({ state, prompt, rawEstimate, usage, modelKey, now }) => {
  const images = imageCount(prompt?.messages) * IMAGE_TOKENS;
  const input = usage.inputTokens - images;
  const text = rawEstimate - images;
  if (!Number.isFinite(input) || input <= 0 || !Number.isFinite(text) || text <= 0) return undefined;
  const observed = clampRatio(input / text);
  const previous = state.tokenCalibration[modelKey];
  const ratio = previous ? clampRatio(previous.ratio + CALIBRATION_ALPHA * (observed - previous.ratio)) : observed;
  return {
    ...state.tokenCalibration,
    [modelKey]: { ratio, samples: (previous?.samples ?? 0) + 1, updatedAt: now.toISOString() }
  };
};

// ---------------------------------------------------------------------------------------------
// Request shape

function stripTail(messages: ChatMessage[], tail: string): void {
  const last = messages[messages.length - 1];
  if (!tail || !last || last.role !== "user" || !Array.isArray(last.content)) return;
  const final = last.content[last.content.length - 1];
  if (final && final.type === "text" && final.text === tail && !final.cacheControl) {
    last.content.pop();
    if (last.content.length === 0) messages.pop();
  }
}

/**
 * The compaction request's messages: the BuiltPrompt's messages through C, unchanged (cache
 * markers included), with the ephemeral tail block removed and the instruction appended as the
 * new tail (same user turn when the prefix ends with a user turn, otherwise a new user turn —
 * the builder's own tail rule).
 */
export function compactionMessages(prompt: Pick<BuiltPrompt, "messages" | "debug">, instruction: string): ChatMessage[] {
  const messages = structuredClone(prompt.messages);
  stripTail(messages, prompt.debug.tail);
  const block: TextBlock = { type: "text", text: instruction };
  const end = messages[messages.length - 1];
  if (end && end.role === "user" && Array.isArray(end.content)) end.content.push(block);
  else messages.push({ role: "user", content: [block] });
  return messages;
}

type CapModel = Pick<ResolvedModel, "limits"> & Partial<Pick<ResolvedModel, "features" | "params">>;

/**
 * Whether the summarize call may spend output on thinking: any model with reasoning params or a
 * thinking style (effort / adaptive / budget / always-on, incl. provider defaults), unless the
 * reply params explicitly turn it off. Without model info only the params decide.
 */
export function thinkingMayRun(params: Record<string, unknown> | undefined, model?: CapModel): boolean {
  if (model?.features?.thinkingStyle === "always-on") return true;
  if (params?.["reasoning.enabled"] === false || params?.["reasoning.effort"] === "none") return false;
  if (params && Object.keys(params).some((key) => key.startsWith("reasoning.") && key !== "reasoning.exclude")) return true;
  if (model?.features?.thinkingStyle) return true;
  return Object.keys(model?.params ?? {}).some((key) => key === "reasoning.enabled" || key === "reasoning.effort" || key === "reasoning.budgetTokens");
}

const DEFAULT_OUTPUT_CAP = 8_192;

/**
 * Summary output cap. max_tokens is not part of the cache key (Anthropic / OpenAI), so it is free
 * to differ from the reply call:
 * - no thinking: max(1500, reply cap);
 * - thinking may run (effort, adaptive, always-on, enabled): max(reply cap or the model default,
 *   thinking budget + 1500, 4000) — a 1500 cap would be eaten by thinking;
 * always clamped to the model's output limit.
 */
export function compactionMaxOutputTokens(
  params: Record<string, unknown> | undefined,
  model?: CapModel,
  replyMaxOutputTokens?: number
): number {
  const fromParams = params?.maxOutputTokens;
  const reply =
    typeof replyMaxOutputTokens === "number" && replyMaxOutputTokens > 0
      ? replyMaxOutputTokens
      : typeof fromParams === "number" && fromParams > 0
        ? fromParams
        : undefined;
  let cap: number;
  if (thinkingMayRun(params, model)) {
    const budget = params?.["reasoning.budgetTokens"];
    const thinking = typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : 0;
    const modelDefault = model ? Math.min(model.limits.maxOutputTokens, DEFAULT_OUTPUT_CAP) : DEFAULT_OUTPUT_CAP;
    cap = Math.max(reply ?? modelDefault, thinking + 1500, 4000);
  } else {
    cap = Math.max(1500, reply ?? 0);
  }
  return model ? Math.min(cap, model.limits.maxOutputTokens) : cap;
}

/**
 * Tool choice for a summarize call. Waifus keep their reply call's choice (`auto`); a reply call
 * that forces a tool (the orchestrator) uses `none` where the model supports it, else `auto`.
 */
export function compactionToolChoice(
  reply: ToolChoice | undefined,
  supported: ReadonlyArray<"auto" | "none" | "required" | "named"> | undefined
): ToolChoice | undefined {
  if (reply === undefined || reply === "auto" || reply === "none") return reply === "none" && supported && !supported.includes("none") ? "auto" : reply;
  return supported?.includes("none") ? "none" : "auto";
}

export type CompactionInstructionInput = {
  agent: ContextAgent;
  /** Ref of the first message that stays verbatim ("messages from #k9 on stay verbatim"). */
  keepFromRef?: string;
  keepCount: number;
  /** Refs of summarized messages their authors deleted (spec 9.5): the summary leaves them out. */
  deletedRefs: string[];
  hasPreviousSummary: boolean;
};

export function compactionInstruction(i: CompactionInstructionInput): string {
  const keep = i.keepFromRef
    ? `Messages from #${i.keepFromRef} on stay verbatim after your summary, so summarize everything before #${i.keepFromRef}.`
    : `The newest ${i.keepCount} messages stay verbatim after your summary, so summarize everything before them.`;
  const previous = i.hasPreviousSummary
    ? " Your summary replaces the earlier <conversation_summary>, so carry forward whatever in it still matters."
    : "";
  const focus =
    i.agent.kind === "orchestrator"
      ? "Write it as the director's notes: the state of the room, open threads, who has spoken and who has been quiet, and the pacing so far."
      : "Write it from your own perspective, in first person, as notes for your future self: the people here and how you feel about each of them, ongoing threads and plans, promises made, running jokes, and unresolved questions. Keep names and concrete details; skip small talk.";
  const lines = [
    "<compaction_request>",
    `This conversation is getting long and is being compacted. ${keep}${previous}`,
    focus
  ];
  if (i.deletedRefs.length > 0) {
    const refs = i.deletedRefs.map((ref) => `#${ref}`).join(", ");
    lines.push(`Leave out messages ${refs} — their authors deleted them.`);
  }
  lines.push("Reply with the summary text only: no preamble, no chat message, no tool calls.", "</compaction_request>");
  return lines.join("\n");
}

const EMPTY_RETRY_PREFIX = "Your previous reply contained no summary text.";

/**
 * The overflow-safe summarize prompt: system and header unchanged, transcript messages up to the
 * keep boundary (the block of `#keepFromRef`), trimmed from the FRONT (whole messages, then blocks
 * of the first message) until the estimate fits `targetTokens`. No prefix reuse is possible here.
 */
export function reducedCompactionPrompt(prompt: BuiltPrompt, o: { keepFromRef?: string; targetTokens: number }): BuiltPrompt {
  const messages = structuredClone(prompt.messages);
  stripTail(messages, prompt.debug.tail);
  const start = 1 + (prompt.debug.header ? 1 : 0);
  const head = messages.slice(0, start);
  let body = messages.slice(start);

  if (o.keepFromRef) {
    const pattern = new RegExp(`^\\[[^\\]]*#${o.keepFromRef}[ \\]]`);
    outer: for (const [mi, message] of body.entries()) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const [bi, block] of message.content.entries()) {
        if (block.type === "text" && pattern.test(block.text)) {
          const kept = body.slice(0, mi);
          if (bi > 0) kept.push({ ...message, content: message.content.slice(0, bi) });
          body = kept;
          break outer;
        }
      }
    }
  }

  const raw = estimateTokens(prompt.messages, prompt.tools);
  const ratio = raw > 0 ? prompt.estimatedTokens / raw : 1;
  const estimate = (b: ChatMessage[]) => Math.ceil(estimateTokens([...head, ...b], prompt.tools) * ratio);
  const cleanFront = () => {
    // A tool result without its call, or (with no header) a leading assistant turn, is invalid.
    while (body.length > 0 && (body[0]!.role === "tool" || (start === 1 && body[0]!.role === "assistant"))) body.shift();
  };
  cleanFront();
  while (body.length > 1 && estimate(body) > o.targetTokens) {
    body.shift();
    cleanFront();
  }
  const first = body[0];
  if (first && Array.isArray(first.content)) {
    let blocks = first.content as Array<TextBlock>;
    while (blocks.length > 1 && estimate(body) > o.targetTokens) {
      blocks = blocks.slice(1);
      body[0] = { ...first, content: blocks } as ChatMessage;
    }
  }
  const out = [...head, ...body];
  return { ...prompt, messages: out, estimatedTokens: estimate(body), debug: { ...prompt.debug, tail: "" } };
}

// ---------------------------------------------------------------------------------------------
// Summarizer factory (call sites: T3 waifu reply path, T5 orchestrator)

/** The reply-call shape a summarizer mirrors. `toolChoice` is required: the orchestrator passes its forced tool. */
export type SummarizerReplyShape = Omit<SummarizeContextRequest, "prompt" | "instruction" | "signal" | "toolChoice"> & {
  toolChoice: ToolChoice;
};

/**
 * The `summarize` function ContextRuntime.prepare needs, over a pipeline's summarizeContext and
 * the agent's reply-call shape (tool choice, params, sampling, attribution). The returned
 * function deliberately takes no abort signal: a compaction outlives the reply that started it.
 */
export function contextSummarizer(
  pipeline: Pick<ModelPipeline, "summarizeContext">,
  reply: SummarizerReplyShape
): (prompt: BuiltPrompt, instruction: string) => Promise<SummaryResult> {
  return async (prompt, instruction) => {
    if (!pipeline.summarizeContext) throw new Error("This model pipeline cannot summarize a context.");
    return pipeline.summarizeContext({ ...reply, prompt, instruction });
  };
}

// ---------------------------------------------------------------------------------------------
// Service

export type CompactionServiceDeps = {
  store: ContextEngineStore;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
  /** Observer handoff (spec 8.9 / 8.8 `requestObserveThrough`): fire-and-forget. */
  observeThrough?: (conversation: ConversationRef, seq: number) => void;
  /** After a failed compaction, check() stays quiet this long (default 5 min). */
  failureBackoffMs?: number;
};

export const COMPACTION_FAILURE_BACKOFF_MS = 5 * 60_000;

type Plan = {
  cursorSeq: number;
  cursorMessageId: string | null;
  keepFromRef?: string;
  instruction: string;
};

export class CompactionSummaryError extends Error {
  override name = "CompactionSummaryError";
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Compaction wait aborted.");
  error.name = "AbortError";
  return error;
}

function waitFor<T>(job: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return job;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    job.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

const normalize = (r: string | SummaryResult): SummaryResult => (typeof r === "string" ? { text: r } : r);

/** Rough token size of one ledger entry as rendered (header + body, images at the flat rate). */
function entryTokens(entry: LedgerEntry, ratio: number): number {
  return Math.ceil(((entry.body.length + entry.authorName.length + 24) / 3.5) * ratio) + entry.images.length * IMAGE_TOKENS;
}

/**
 * Production factory: plugged into ContextRuntime as `compaction`, alongside
 * `calibrate: emaTokenCalibration`.
 */
export function createCompactionService(deps: CompactionServiceDeps): ContextCompactionService {
  return new ContextCompactionService(deps);
}

export class ContextCompactionService implements CompactionService {
  private readonly running = new Map<string, Promise<CompactionOutcome>>();
  private readonly now: () => Date;
  private readonly backoffMs: number;

  constructor(private readonly d: CompactionServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.backoffMs = d.failureBackoffMs ?? COMPACTION_FAILURE_BACKOFF_MS;
  }

  check(i: { state: ContextState; prompt: BuiltPrompt; budget: TokenBudget; settings: CompactionSettings }): CompactionTrigger | undefined {
    if (!i.settings.enabled) return undefined;
    // Nothing to summarize: a compaction could not shrink the prompt.
    if (i.prompt.transcriptCount < 2) return undefined;
    const last = i.state.lastCompaction;
    if (last && !last.ok && this.now().getTime() - Date.parse(last.at) < this.backoffMs) return undefined;
    if (i.prompt.estimatedTokens > i.budget.budgetTokens) return "tokens";
    if (i.prompt.transcriptCount > i.settings.maxMessages) return "messages";
    return undefined;
  }

  inFlight(k: ConversationKey, a: ContextAgent): Promise<CompactionOutcome> | undefined {
    return this.running.get(`${k}|${contextAgentId(a)}`);
  }

  compact(i: CompactInput): Promise<CompactionOutcome> {
    const key = conversationKey(i.conversation);
    const id = `${key}|${contextAgentId(i.agent)}`;
    let job = this.running.get(id);
    if (!job) {
      job = this.run(key, i).finally(() => {
        if (this.running.get(id) === job) this.running.delete(id);
      });
      job.catch(() => undefined); // joiners observe the rejection; the shared promise never goes unhandled
      this.running.set(id, job);
    }
    return waitFor(job, i.signal);
  }

  private async run(key: ConversationKey, i: CompactInput): Promise<CompactionOutcome> {
    const startedAt = this.now();
    const base = i.basedOn ?? (await this.d.store.load(key, i.agent));
    const ledger = await this.d.store.loadLedger(key);
    const refs = await this.d.store.loadRefs(key);
    const plan = this.plan(i, base, orderedEntries(ledger), refs.refs);
    if ("skip" in plan) {
      this.d.logger.info("Nothing to compact", { conversationKey: key, trigger: i.trigger, reason: plan.skip });
      return { status: "skipped", reason: plan.skip };
    }

    let summary: string;
    try {
      summary = await this.summarize(i, plan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.recordFailure(key, i, base, startedAt, message);
      throw error;
    }

    const at = this.now();
    const result = await this.d.store.commitPrepare(key, i.agent, {
      sealIds: [],
      update: (current) => {
        const source = current.revision === base.revision ? base : current.epoch === base.epoch ? current : undefined;
        if (!source) return undefined; // the epoch changed meanwhile: discard
        if (source.cursorSeq !== null && plan.cursorSeq <= source.cursorSeq) return undefined;
        return this.nextEpoch(source, plan, summary, i.trigger, at, orderedEntries(ledger));
      }
    });
    if (!result.ok) {
      this.d.logger.info("Compaction discarded: the context changed epoch meanwhile", { conversationKey: key, conflict: result.conflict });
      return { status: "discarded", reason: "the context changed epoch meanwhile" };
    }
    this.d.logger.info("Context compacted", {
      conversationKey: key,
      agentId: contextAgentId(i.agent),
      trigger: i.trigger,
      epoch: result.state.epoch,
      cursorSeq: plan.cursorSeq
    });
    try {
      this.d.observeThrough?.(i.conversation, plan.cursorSeq);
    } catch {
      // fire-and-forget
    }
    return { status: "compacted", trigger: i.trigger, epoch: result.state.epoch, cursorSeq: plan.cursorSeq };
  }

  /**
   * One summary: the full prefix-reusing prompt, except for an overflow (or a summarize call that
   * overflows) which uses the reduced prompt. An empty result gets one retry with the instruction
   * repeated; a truncated (`length`) result is never accepted.
   */
  private async summarize(i: CompactInput, plan: Plan): Promise<string> {
    const target = i.budget ? i.budget.budgetTokens : Math.floor(i.prompt.estimatedTokens / 2);
    const reduced = () => reducedCompactionPrompt(i.prompt, { keepFromRef: plan.keepFromRef, targetTokens: target });
    let prompt = i.trigger === "overflow" ? reduced() : i.prompt;
    const once = async (instruction: string): Promise<SummaryResult> => {
      try {
        return normalize(await i.summarize(prompt, instruction));
      } catch (error) {
        if (prompt === i.prompt && isContextOverflowError(error)) {
          prompt = reduced();
          return normalize(await i.summarize(prompt, instruction));
        }
        throw error;
      }
    };
    let result = await once(plan.instruction);
    if (!result.text.trim() && result.finishReason !== "length") {
      result = await once(`${EMPTY_RETRY_PREFIX}\n${plan.instruction}`);
    }
    if (result.finishReason === "length") throw new CompactionSummaryError("The summary was cut off by the output limit.");
    const text = result.text.trim();
    if (!text) throw new CompactionSummaryError("The model returned no summary text.");
    return text;
  }

  /** The summarized range and new cursor, from the entries the prompt actually rendered. */
  private plan(i: CompactInput, base: ContextState, all: LedgerEntry[], refs: Record<string, string>): Plan | { skip: string } {
    const cursor = i.prompt.cursorSeq;
    const after = all.filter((entry) => cursor === null || entry.seq > cursor);
    // The prompt rendered the first `transcriptCount` entries after its cursor (the ledger only
    // appends). A hard-truncated prompt (timeout path) does not start at its cursor: its ids do
    // not match, and it is never a basis for a compaction.
    const rendered = after.slice(0, i.prompt.transcriptCount);
    const renderedIds = rendered.filter((e) => !isGapEntry(e)).map((e) => e.id);
    if (renderedIds.some((id) => !i.prompt.messageIdToRef.has(id))) {
      this.d.logger.warn("Compaction skipped: the prompt is not a full transcript", { conversationKey: base.conversationKey });
      return { skip: "the prompt is not a full transcript" };
    }
    const count = rendered.length;
    if (count < 2) return { skip: "fewer than two messages since the cursor" };

    // Kept window: `keepRecent` (clamped) for message-count / manual compactions; at most half the
    // transcript for token / overflow ones (the kept part alone may be what is too big). With a
    // budget, it shrinks until it fits in about half of it, so the next prompt is under budget.
    const settingsKeep = effectiveKeepRecent(i.settings);
    let keep =
      i.trigger === "tokens" || i.trigger === "overflow"
        ? Math.max(1, Math.min(settingsKeep, Math.floor(count / 2)))
        : count > settingsKeep
          ? settingsKeep
          : Math.max(1, Math.floor(count / 2));
    if (i.budget) {
      const raw = estimateTokens(i.prompt.messages, i.prompt.tools);
      const ratio = raw > 0 ? Math.max(1, i.prompt.estimatedTokens / raw) : 1;
      const half = i.budget.budgetTokens / 2;
      const keptTokens = (k: number) => rendered.slice(count - k).reduce((sum, e) => sum + entryTokens(e, ratio), 0);
      while (keep > 1 && keptTokens(keep) > half) keep -= 1;
    }

    const self = new Set(i.selfAuthorIds ?? []);
    const visibleRef = (e: LedgerEntry) => (!isGapEntry(e) && !self.has(e.authorId) ? refs[e.id] : undefined);
    const cursorEntry = rendered[count - keep - 1]!;
    const kept = rendered.slice(count - keep);
    const keepFrom = kept.find((e) => visibleRef(e) !== undefined);
    const deletedRefs = rendered
      .slice(0, count - keep)
      .filter((e) => e.state === "deleted")
      .map(visibleRef)
      .filter((ref): ref is string => ref !== undefined);
    const keepFromRef = keepFrom ? visibleRef(keepFrom) : undefined;
    return {
      cursorSeq: cursorEntry.seq,
      cursorMessageId: isGapEntry(cursorEntry) ? null : cursorEntry.id,
      ...(keepFromRef ? { keepFromRef } : {}),
      instruction: compactionInstruction({
        agent: i.agent,
        keepFromRef,
        keepCount: keep,
        deletedRefs,
        hasPreviousSummary: Boolean(base.summary)
      })
    };
  }

  private nextEpoch(
    s: ContextState,
    plan: Plan,
    summary: string,
    trigger: CompactionTrigger,
    at: Date,
    all: LedgerEntry[]
  ): ContextState {
    const keptImageKeys = new Set(all.filter((e) => e.seq > plan.cursorSeq).flatMap((e) => e.images.map((image) => image.key)));
    const iso = at.toISOString();
    return {
      ...s,
      epoch: s.epoch + 1,
      epochStartedAt: iso,
      lastUsedAt: iso,
      summary,
      cursorSeq: plan.cursorSeq,
      cursorMessageId: plan.cursorMessageId,
      headerText: null,
      memorySnapshotIds: [],
      memoryNoteCount: 0,
      inlineImageCount: 0,
      imageModes: Object.fromEntries(Object.entries(s.imageModes).filter(([imageKey]) => keptImageKeys.has(imageKey))),
      notes: s.notes.filter((note) => note.anchorSeq > plan.cursorSeq),
      lastBreakpoint: null,
      lastCompaction: { at: iso, trigger, ok: true }
    };
  }

  private async recordFailure(key: ConversationKey, i: CompactInput, base: ContextState, startedAt: Date, message: string): Promise<void> {
    this.d.logger.warn("Context compaction failed", { conversationKey: key, trigger: i.trigger, message });
    try {
      await this.d.store.commitPrepare(key, i.agent, {
        sealIds: [],
        update: (current) =>
          // A never-persisted (fresh) context stays unpersisted; prepare writes it.
          current.epoch === base.epoch && current.revision > 0
            ? { ...current, lastCompaction: { at: startedAt.toISOString(), trigger: i.trigger, ok: false, error: message.slice(0, 500) } }
            : undefined
      });
    } catch {
      // best effort
    }
  }
}
