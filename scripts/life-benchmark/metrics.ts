// Automatic metrics of a run (spec §33.3), all generic: tool use from her life log's tool calls and
// results (a result marked `is_error` is a failed call), whatever the tools are called; chat from
// what reached the fake server; dollars and tokens from the run's usage lines.

import { promptTokensOf, type UsageLedgerLine } from "../../src/orchestration/usageLedger.js";
import { UNANSWERED_SEND_GAP_MS } from "../../src/life/unanswered.js";
import type { Fact } from "./scenario.js";
import type { ProbeResult, RunMetrics, SummaryCapture, TranscriptEvent } from "./types.js";

/** Lowercase words of a text (letters and digits; apostrophes dropped). */
export function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/gu, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Whether `text` says `phrase`: every word of the phrase starts a word of the text ("climb" finds
 * "climbing"), in any order.
 */
export function mentions(text: string, phrase: string): boolean {
  const words = wordsOf(text);
  return wordsOf(phrase).every((wanted) => words.some((word) => word.startsWith(wanted)));
}

/** Any of the phrases. */
export function mentionsAny(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find((phrase) => mentions(text, phrase));
}

/** Which facts a summary kept (any alternative of the fact found) and which it lost. */
export function factsFound(facts: readonly Fact[], text: string): { kept: string[]; missing: string[] } {
  const kept: string[] = [];
  const missing: string[] = [];
  for (const fact of facts) (mentionsAny(text, fact.match) !== undefined ? kept : missing).push(fact.id);
  return { kept, missing };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Lines of her messages (blank lines left out). */
export function messageLines(events: readonly TranscriptEvent[]): string[] {
  return events.flatMap((event) => (event.type === "sent" ? event.text.split("\n").map((line) => line.trim()).filter(Boolean) : []));
}

/** The most messages she sent in a row in one place, nobody else writing there in between. */
export function longestBurst(events: readonly TranscriptEvent[]): number {
  const run = new Map<string, number>();
  let longest = 0;
  for (const event of events) {
    if (event.type === "people") run.set(event.place, 0);
    else if (event.type === "sent") {
      const count = (run.get(event.place) ?? 0) + 1;
      run.set(event.place, count);
      longest = Math.max(longest, count);
    }
  }
  return longest;
}

/** Her messages this close together with no turn id to tell them apart are one send (the app's own rule, spec §34). */
export const SEND_GAP_MS = UNANSWERED_SEND_GAP_MS;

/**
 * The most separate sends she made in a row in one place, nobody else writing there in between
 * (spec §34): nagging. A send is a turn's go at writing, not a message: a `sent` event starts a new
 * send when its turn id differs from her previous one there, or, when either has no turn id, when
 * `SEND_GAP_MS` or more passed since it.
 */
export function maxUnansweredSends(events: readonly TranscriptEvent[]): number {
  const run = new Map<string, { sends: number; turnId?: string | undefined; at: number }>();
  let longest = 0;
  for (const event of events) {
    if (event.type === "people") run.delete(event.place);
    else if (event.type === "sent") {
      const at = Date.parse(event.at);
      const previous = run.get(event.place);
      const sameSend =
        previous !== undefined &&
        (previous.turnId !== undefined && event.turnId !== undefined ? previous.turnId === event.turnId : Number.isFinite(at) && Number.isFinite(previous.at) && at - previous.at < SEND_GAP_MS);
      const sends = (previous?.sends ?? 0) + (sameSend ? 0 : 1);
      run.set(event.place, { sends, turnId: event.turnId, at });
      longest = Math.max(longest, sends);
    }
  }
  return longest;
}

export function computeMetrics(o: { events: readonly TranscriptEvent[]; summaries: readonly SummaryCapture[]; ledger: readonly UsageLedgerLine[]; probes: readonly ProbeResult[] }): RunMetrics {
  const { events } = o;
  const results = new Map<string, boolean>();
  for (const event of events) if (event.type === "tool_result") results.set(event.id, event.isError);
  const toolCalls = events.filter((event): event is Extract<TranscriptEvent, { type: "tool_call" }> => event.type === "tool_call");
  const byName: Record<string, { calls: number; failed: number }> = {};
  let failed = 0;
  let retries = 0;
  let loops = 0;
  let uses = 0;
  let firstOk = 0;
  const failing = new Set<string>();
  let previous: { turn: string | undefined; name: string; failed: boolean } | undefined;
  for (const call of toolCalls) {
    const isError = results.get(call.id) === true;
    const entry = (byName[call.name] ??= { calls: 0, failed: 0 });
    entry.calls += 1;
    if (isError) {
      failed += 1;
      entry.failed += 1;
      const signature = `${call.name}\u0000${JSON.stringify(call.input)}`;
      if (failing.has(signature)) loops += 1;
      failing.add(signature);
    }
    const sameUse = previous !== undefined && previous.turn === call.turnId && previous.name === call.name;
    if (sameUse && previous!.failed) retries += 1;
    if (!sameUse) {
      uses += 1;
      if (!isError) firstOk += 1;
    }
    previous = { turn: call.turnId, name: call.name, failed: isError };
  }
  const sent = events.filter((event): event is Extract<TranscriptEvent, { type: "sent" }> => event.type === "sent");
  const lines = messageLines(events).map((line) => [...line].length);
  const lifeCalls = events.filter((event): event is Extract<TranscriptEvent, { type: "call" }> => event.type === "call" && event.purpose === "life");
  const turns = new Set(lifeCalls.flatMap((call) => (call.turnId ? [call.turnId] : [])));
  const sendsPerTurn = new Map<string, number>();
  for (const message of sent) if (message.turnId) sendsPerTurn.set(message.turnId, (sendsPerTurn.get(message.turnId) ?? 0) + 1);
  const turnMs = lifeCalls.reduce((sum, call) => sum + call.realMs, 0);
  const usdByPurpose: Record<string, number> = {};
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  for (const line of o.ledger) {
    const cost = line.costUsd ?? 0;
    usd += cost;
    usdByPurpose[line.purpose] = (usdByPurpose[line.purpose] ?? 0) + cost;
    tokensIn += promptTokensOf(line);
    tokensOut += line.outputTokens;
    cacheRead += line.cacheReadTokens ?? 0;
  }
  const scored = o.probes.filter((probe) => probe.passed !== null);
  // Her memory: her summaries and her notes after a dream.
  const herSummaries = o.summaries.filter((summary) => summary.facts);
  const kept = herSummaries.reduce((sum, summary) => sum + summary.facts!.kept.length, 0);
  const due = herSummaries.reduce((sum, summary) => sum + summary.facts!.kept.length + summary.facts!.missing.length, 0);
  return {
    turns: turns.size,
    toolCalls: toolCalls.length,
    failedCalls: failed,
    firstTrySuccess: uses > 0 ? firstOk / uses : null,
    retries,
    loops,
    toolCallsByName: byName,
    messages: sent.length,
    reactions: events.filter((event) => event.type === "reaction").length,
    medianLineChars: median(lines),
    longestLineChars: lines.length > 0 ? Math.max(...lines) : null,
    messagesPerSendingTurn: sendsPerTurn.size > 0 ? [...sendsPerTurn.values()].reduce((a, b) => a + b, 0) / sendsPerTurn.size : null,
    longestBurst: longestBurst(events),
    maxUnansweredSends: maxUnansweredSends(events),
    probesPassed: scored.filter((probe) => probe.passed).length,
    probesScored: scored.length,
    usd: Math.round(usd * 1_000_000) / 1_000_000,
    tokensIn,
    tokensOut,
    cacheReadShare: tokensIn > 0 ? cacheRead / tokensIn : null,
    secondsPerTurn: turns.size > 0 ? Math.round(turnMs / turns.size / 100) / 10 : null,
    modelCalls: events.filter((event) => event.type === "call").length,
    failedModelCalls: events.filter((event) => event.type === "call" && event.error !== undefined).length,
    usdByPurpose,
    compactions: events.filter((event) => event.type === "compaction").length,
    summaries: o.summaries.length,
    factCoverage: due > 0 ? kept / due : null
  };
}
