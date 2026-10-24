// A Node fake of winter's ProviderAdapter for ModelClient tests (not a test file itself). It wraps
// the shipped adapter of the same id (capabilities, effort mapping and identity stay real) and
// replaces `streamTurn` with a script: no HTTP, no credentials leave the process.
// winter 0.0.56 ships a stable, Node-safe `createFakeProviderAdapter` in
// `@yanlinglabs/winter-provider-runtime/testing`; `fakeAdapter` switches to it with the pin bump.

import { createShippedAdapters, type ProviderAdapter, type ProviderContext, type ProviderEvent, type TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { installedCatalog } from "../src/models/catalog.js";
import { createWinterRuntime, type WinterRuntime } from "../src/models/winter.js";

export type ScriptedTurn = (request: TurnRequest, context: ProviderContext) => AsyncIterable<ProviderEvent> | ProviderEvent[];

export type FakeAdapter = ProviderAdapter & {
  calls: Array<{ request: TurnRequest; context: ProviderContext }>;
  /** Scripts for the next calls, in order; the last one repeats. */
  scripts: ScriptedTurn[];
};

export function fakeAdapter(adapterId: string, scripts: ScriptedTurn[] = []): FakeAdapter {
  const real = createShippedAdapters(installedCatalog()).find((adapter) => adapter.id === adapterId);
  if (!real) throw new Error(`No shipped winter adapter ${adapterId}`);
  const calls: FakeAdapter["calls"] = [];
  const fake: FakeAdapter = {
    id: real.id,
    version: "test",
    family: real.family,
    protocol: real.protocol,
    validateCredential: (ref, ctx) => real.validateCredential(ref, ctx),
    listModels: (ctx) => real.listModels(ctx),
    mapEffort: (effort, model) => real.mapEffort(effort, model),
    capabilities: (model) => real.capabilities(model),
    calls,
    scripts,
    streamTurn(request, context) {
      calls.push({ request, context });
      const script = fake.scripts.length > 1 ? fake.scripts.shift()! : fake.scripts[0];
      if (!script) throw new Error("FakeAdapter: no script");
      const produced = script(request, context);
      if (Array.isArray(produced)) {
        return (async function* () {
          for (const event of produced) yield event;
        })();
      }
      return produced;
    }
  };
  return fake;
}

/** The adapter ids the curated routes use in the installed catalog. */
export const CHAT_COMPLETIONS = "winter.openai-chat-completions";
export const ANTHROPIC_MESSAGES = "winter.anthropic-messages";
export const OPENAI_RESPONSES = "winter.openai-responses";

/** A winter runtime over the installed catalog whose adapters are fakes. */
export function fakeWinter(...adapters: FakeAdapter[]): WinterRuntime {
  return createWinterRuntime({ adapters });
}

export const textTurn = (text: string, usage: { inputTokens: number; outputTokens: number } = { inputTokens: 100, outputTokens: 20 }): ProviderEvent[] => [
  { type: "message_start", id: "resp-1" },
  { type: "text_delta", text },
  { type: "usage", ...usage },
  { type: "done", stopReason: "end_turn" }
];

export const errorTurn = (error: Extract<ProviderEvent, { type: "error" }>["error"], before: ProviderEvent[] = []): ProviderEvent[] => [
  ...before,
  { type: "error", error }
];

/** A stream that yields `start`, then waits until the request's signal aborts and ends `aborted`. */
export function hangingTurn(start: ProviderEvent[] = [{ type: "message_start" }]): ScriptedTurn {
  return (request) =>
    (async function* () {
      for (const event of start) yield event;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) return resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "done", stopReason: "aborted" } as ProviderEvent;
    })();
}
