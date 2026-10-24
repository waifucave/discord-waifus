// Fake winter adapters for ModelClient tests (not a test file itself), over winter's own Node-safe
// `createFakeProviderAdapter` (`@yanlinglabs/winter-provider-runtime/testing`, 0.0.56).
//
// The thin app wrapper adds what these tests need on top of winter's fake: the shipped adapter's
// id, family, protocol, capabilities and effort mapping (so the history renderer and capability
// checks behave as in production), per-call scripts computed from the request and context, a
// "last script repeats" rule, and async-generator scripts for streams that wait on the caller's
// signal (`hangingTurn`). Array scripts are played by winter's fake, abort handling included.

import { createShippedAdapters, type ProviderAdapter, type ProviderContext, type ProviderEvent, type TurnRequest } from "@yanlinglabs/winter-provider-runtime";
import { createFakeProviderAdapter, fakeErrorTurn, fakeTextTurn } from "@yanlinglabs/winter-provider-runtime/testing";
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
      if (!Array.isArray(produced)) return produced;
      // A scripted turn is played by winter's own fake adapter.
      const played = createFakeProviderAdapter({ id: real.id, family: real.family, protocol: real.protocol, turns: [produced] });
      return played.streamTurn(request, context);
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

/** winter's `fakeTextTurn` with this suite's defaults (response id `resp-1`, 100 in / 20 out). */
export const textTurn = (text: string, usage: { inputTokens: number; outputTokens: number; reportedCostUsd?: number } = { inputTokens: 100, outputTokens: 20 }): ProviderEvent[] =>
  fakeTextTurn(text, { usage, id: "resp-1" });

/** `before`, then winter's `fakeErrorTurn`. */
export const errorTurn = (error: Extract<ProviderEvent, { type: "error" }>["error"], before: ProviderEvent[] = []): ProviderEvent[] => [
  ...before,
  ...fakeErrorTurn(error)
];

/** A stream that yields `start`, then waits until the request's signal aborts and ends `done: aborted`. */
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
