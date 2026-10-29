// The benchmark's model layer: the app's real ModelClient (winter, real providers) with a capture
// around every call, or, under `--dry-run`, the same client over winter's fake adapters playing a
// scripted policy. Provider keys come from the caller's lookup and are never stored or printed.

import { AsyncLocalStorage } from "node:async_hooks";
import { createShippedAdapters, type ProviderAdapter, type ProviderEvent, type ProviderMessageLike, type TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createFakeProviderAdapter, fakeTextTurn, fakeToolCallTurn } from "@yanlinglabs/winter-provider-runtime/testing";
import { installedCatalog } from "../../src/models/catalog.js";
import { ModelClient, type ModelCallRequest, type ModelCallResult, type ModelClientOptions, type ModelStreamSink } from "../../src/models/client.js";
import { createWinterRuntime, type WinterRuntime } from "../../src/models/winter.js";
import { isRestNotice, selfSummaryOf } from "../../src/life/rest.js";
import type { UsageLedger, UsageLedgerLine } from "../../src/orchestration/usageLedger.js";
import type { Scenario } from "./scenario.js";

/** One model call as the benchmark saw it (content kept only where a summary needs its input). */
export type CallRecord = {
  seq: number;
  /** Simulated time the call started. */
  at: string;
  purpose: string;
  turnId?: string;
  route: string;
  effort?: string;
  /** The new input of a life call (its last message, as text); every message for summary calls. */
  input: { lastMessage: string; system?: string[]; messages?: unknown[]; tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> };
  toolNames: string[];
  restNotice: boolean;
  result?: { text: string; toolCalls: Array<{ name: string; input: unknown }>; finishReason: string; durationMs: number; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number };
  error?: { kind: string; message: string; status?: number; providerCode?: string };
  realMs: number;
};

/** Long token-like runs (keys, ids) in an error message become `[masked]`. */
export function maskKeyLike(text: string): string {
  return text.replace(/[A-Za-z0-9_\-]{24,}/g, "[masked]");
}

/** Text of a message's content (tool results and images summarised; no image bytes). */
export function messageText(message: Pick<ProviderMessageLike, "content"> | undefined): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_result") return typeof block.content === "string" ? block.content : messageText({ content: block.content });
      if (block.type === "tool_use") return `[call ${block.name}] ${JSON.stringify(block.input)}`;
      if (block.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Messages with image bytes dropped (summary inputs are saved as JSON). */
export function withoutImages(messages: readonly ProviderMessageLike[]): unknown[] {
  return messages.map((message) => {
    if (typeof message.content === "string") return { role: message.role, content: message.content };
    return {
      role: message.role,
      content: message.content.map((block) => {
        if (block.type === "image") return { type: "text", text: "[image]" };
        if (block.type === "tool_result" && Array.isArray(block.content)) return { ...block, content: block.content.map((inner) => (inner.type === "image" ? { type: "text", text: "[image]" } : inner)) };
        if (block.type === "thinking" || block.type === "redacted_thinking") return { type: "text", text: "[thinking]" };
        return block;
      })
    };
  });
}

const callPurpose = new AsyncLocalStorage<string>();

/** The purpose (`life`, `compaction`, `maintenance`, `web`) of the model call running in this async context. */
export function currentCallPurpose(): string | undefined {
  return callPurpose.getStore();
}

/** The real client with a record of every call. `beforeCall` runs first and may throw to refuse a call (the run's budget). */
export class CapturingModelClient extends ModelClient {
  private seq = 0;
  private beforeCall: (() => void | Promise<void>) | undefined;
  constructor(
    options: ModelClientOptions,
    private readonly hooks: { simNow: () => Date; record: (call: CallRecord) => void }
  ) {
    super(options);
  }

  setBeforeCall(hook: (() => void | Promise<void>) | undefined): void {
    this.beforeCall = hook;
  }

  override call(request: ModelCallRequest): Promise<ModelCallResult> {
    return this.capture(request, () => super.call(request));
  }

  override stream(request: ModelCallRequest, sink: ModelStreamSink): Promise<ModelCallResult> {
    return this.capture(request, () => super.stream(request, sink));
  }

  private async capture(request: ModelCallRequest, run: () => Promise<ModelCallResult>): Promise<ModelCallResult> {
    await this.beforeCall?.();
    const last = request.messages[request.messages.length - 1];
    const lastMessage = messageText(last);
    const purpose = request.attribution.purpose;
    const restNotice = purpose === "life" && isRestNotice(lastMessage);
    const keepAll = purpose !== "life" || restNotice;
    const record: CallRecord = {
      seq: (this.seq += 1),
      at: this.hooks.simNow().toISOString(),
      purpose,
      ...(request.attribution.turnId ? { turnId: request.attribution.turnId } : {}),
      route: `${request.route.providerId}/${request.route.modelId}`,
      ...(request.effort ? { effort: request.effort } : {}),
      input: { lastMessage, ...(keepAll ? { system: [...request.system], messages: withoutImages(request.messages), tools: [...(request.tools ?? [])] } : {}) },
      toolNames: (request.tools ?? []).map((tool) => tool.name),
      restNotice,
      realMs: 0
    };
    const started = performance.now();
    try {
      const result = await callPurpose.run(purpose, run);
      // Her own `<summary>` reset (§21.6b) is a summary too: keep what it summarised.
      if (!keepAll && selfSummaryOf(result.text) !== undefined) {
        record.input.system = [...request.system];
        record.input.messages = withoutImages(request.messages);
        record.input.tools = [...(request.tools ?? [])];
      }
      record.result = {
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({ name: call.name, input: call.input })),
        finishReason: result.finishReason,
        durationMs: result.durationMs,
        ...(result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, cacheReadTokens: result.usage.cacheReadTokens ?? 0 } : {}),
        ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {})
      };
      return result;
    } catch (error) {
      const { kind, status, providerCode } = (error ?? {}) as { kind?: unknown; status?: unknown; providerCode?: unknown };
      // The app's error kind, the HTTP status, the provider's code and a short message with anything
      // key-like masked: never a provider body or a key.
      record.error = {
        kind: typeof kind === "string" ? kind : "other",
        message: error instanceof Error ? maskKeyLike(error.message.slice(0, 200)) : "failed",
        ...(typeof status === "number" ? { status } : {}),
        ...(typeof providerCode === "string" ? { providerCode: maskKeyLike(providerCode.slice(0, 80)) } : {})
      };
      throw error;
    } finally {
      record.realMs = Math.round(performance.now() - started);
      this.hooks.record(record);
    }
  }
}

/** Ledger lines in memory: the run's dollars and tokens (failed and aborted calls included). */
export class MemoryLedger implements UsageLedger {
  readonly lines: UsageLedgerLine[] = [];
  async record(entry: UsageLedgerLine): Promise<void> {
    this.lines.push(entry);
  }
  async flush(): Promise<void> {}
}

// ---- dry run ---------------------------------------------------------------------------------------

type DryAction = { send?: { place: string; text: string }; note?: { path: string; text: string }; wakeup?: { when: string; note: string } };

function requestText(request: TurnRequest): string {
  return request.messages.map((message) => messageText(message)).join("\n");
}

const HANDLE_RE = / · ((?:dm\/[a-z0-9._-]+)|(?:[a-z0-9-]+\/#[a-z0-9_-]+)) · /u;

/** The tool calls for actions, in whichever shape the offered tools take (§27/§30 today, §32's `tools.*` scripts after it). */
export function dryToolCalls(request: TurnRequest, actions: readonly DryAction[]): Array<{ name: string; input: unknown }> {
  const tools = new Map((request.tools ?? []).map((tool) => [tool.name, tool] as const));
  const scriptStyle = (name: string) => {
    const tool = tools.get(name);
    return tool !== undefined && /\btools\.[a-z_]+\(/u.test(tool.description);
  };
  const calls: Array<{ name: string; input: unknown }> = [];
  for (const action of actions) {
    if (action.send && tools.has("SendMessage")) {
      const props = (tools.get("SendMessage")!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      calls.push(
        "place" in props
          ? { name: "SendMessage", input: { place: action.send.place, script: `m: ${action.send.text}` } }
          : { name: "SendMessage", input: { script: `return await tools.send_message(${JSON.stringify({ place: action.send.place, messages: [{ text: action.send.text }] })});` } }
      );
    }
    if (action.note) {
      if (tools.has("Write")) calls.push({ name: "Write", input: { file_path: action.note.path, content: `${action.note.text}\n` } });
      else if (tools.has("Edit") && scriptStyle("Edit")) {
        const patch = ["*** Begin Patch", `*** Add File: ${action.note.path}`, `+${action.note.text}`, "*** End Patch"].join("\n");
        calls.push({ name: "Edit", input: { script: `return await tools.apply_patch(${JSON.stringify(patch)});` } });
      }
    }
    if (action.wakeup && tools.has("Wakeup")) {
      calls.push(
        scriptStyle("Wakeup")
          ? { name: "Wakeup", input: { script: `return await tools.wakeup(${JSON.stringify({ at: [{ when: action.wakeup.when, note: action.wakeup.note }] })});` } }
          : { name: "Wakeup", input: { script: `at(${JSON.stringify(action.wakeup.when)}, ${JSON.stringify(action.wakeup.note)});` } }
      );
    }
  }
  return calls;
}

/**
 * The scripted fake model of `--dry-run`: summaries get a canned summary, a rest notice gets a
 * summary long enough to be used, a turn's first round runs the scenario's dry-run rules that match
 * its input (else a short reply in the first place a notification names), every later round ends
 * the turn. Usage is a rough count of the request so the metrics are not empty.
 */
export function dryRunPolicy(scenario: Pick<Scenario, "dryRun">): (request: TurnRequest) => ProviderEvent[] {
  const fired = new Set<number>();
  return (request) => {
    const all = requestText(request);
    const last = messageText(request.messages[request.messages.length - 1]);
    const usage = { inputTokens: Math.ceil(((request.system ?? "").length + all.length) / 4), outputTokens: 40 };
    const tools = request.tools ?? [];
    const purpose = currentCallPurpose();
    const lastMessage = request.messages[request.messages.length - 1];
    const toolResults = Array.isArray(lastMessage?.content) && lastMessage.content.some((block) => block.type === "tool_result");
    if (purpose === "compaction" || tools.length === 0) return fakeTextTurn(`Summary (dry run): ${all.replace(/\s+/gu, " ").slice(0, 400)}`, { usage });
    if (isRestNotice(last)) return fakeTextTurn(`Dry-run rest summary. ${all.replace(/\s+/gu, " ").slice(-600)}`, { usage });
    if (purpose !== "life" || toolResults || !tools.some((tool) => tool.name === "SendMessage")) return fakeTextTurn("", { usage });
    const actions: DryAction[] = [];
    scenario.dryRun.forEach((rule, index) => {
      if (!last.includes(rule.when) || (rule.once && fired.has(index))) return;
      fired.add(index);
      actions.push({ ...(rule.send ? { send: rule.send } : {}), ...(rule.note ? { note: rule.note } : {}), ...(rule.wakeup ? { wakeup: rule.wakeup } : {}) });
    });
    if (actions.length === 0) {
      const handle = HANDLE_RE.exec(last)?.[1];
      if (handle && !/Good morning/u.test(last)) actions.push({ send: { place: handle, text: "haha ok" } });
    }
    const calls = dryToolCalls(request, actions);
    if (calls.length === 0) return fakeTextTurn("", { usage });
    let n = 0;
    return fakeToolCallTurn(calls.map((call) => ({ id: `dry_${(n += 1)}_${call.name}`, name: call.name, input: call.input })), { usage });
  };
}

/** A winter runtime over the installed catalog whose every adapter plays `policy`. */
export function dryRunWinter(policy: (request: TurnRequest) => ProviderEvent[]): WinterRuntime {
  const adapters: ProviderAdapter[] = createShippedAdapters(installedCatalog()).map((real) => ({
    id: real.id,
    version: "dry-run",
    family: real.family,
    protocol: real.protocol,
    validateCredential: (ref, ctx) => real.validateCredential(ref, ctx),
    listModels: (ctx) => real.listModels(ctx),
    mapEffort: (effort, model) => real.mapEffort(effort, model),
    capabilities: (model) => real.capabilities(model),
    streamTurn(request, context) {
      const played = createFakeProviderAdapter({ id: real.id, family: real.family, protocol: real.protocol, turns: [policy(request)] });
      return played.streamTurn(request, context);
    }
  }));
  return createWinterRuntime({ adapters });
}
