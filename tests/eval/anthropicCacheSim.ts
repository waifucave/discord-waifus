// Offline model of Anthropic's prompt cache (spec 6.7 / 8.11), applied to the REAL wire body the
// gateway's anthropic-messages codec produces. Not a test file.
//
// Rules modelled (docs.anthropic.com "Prompt caching"):
// - The prompt is the sequence tools -> system -> messages, one cacheable position per content
//   block (tools count as one position). Consecutive same-role turns are already merged by the
//   codec, so the sim sees what Anthropic sees.
// - At most 4 `cache_control` breakpoints per request (a fifth is a 400 in production; here it
//   throws).
// - A breakpoint at block b looks for a cache entry written by an earlier request at b itself or
//   at one of the LOOKBACK_BLOCKS - 1 blocks before it; the longest hit across breakpoints is read.
// - Every breakpoint writes an entry for its prefix. An entry lives CACHE_TTL_MS after its last
//   write or hit.
// - The prefix hash of message blocks also covers `tool_choice` and `thinking` (changing either
//   invalidates cached message content; tools and system stay cached). `max_tokens`, sampling and
//   stop sequences are not part of the key.
// - Optionally `minCacheableTokens` (1,024 for Sonnet): a prefix shorter than that is never cached.
//
// Tokens are counted with the app's own estimator (context/tokens.ts) per block, so reads/writes
// are in the same unit the engine budgets with.

import { createHash } from "node:crypto";
import type { ChatMessage, ToolDef } from "@waifucave/gateway";
import { estimateTokens } from "../../src/orchestration/context/tokens.js";

export const CACHE_TTL_MS = 5 * 60_000;
export const LOOKBACK_BLOCKS = 20;
export const MAX_BREAKPOINTS = 4;

export type WireBlock = { type: string; cache_control?: unknown; [key: string]: unknown };
export type WireBody = {
  system?: string | WireBlock[];
  messages: Array<{ role: string; content: string | WireBlock[] }>;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown }>;
  tool_choice?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
};

type FlatBlock = { section: "tools" | "system" | "messages"; role: string; json: string; tokens: number; breakpoint: boolean };

function wireBlockTokens(role: string, block: WireBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens([{ role: "user", content: [{ type: "text", text: String(block.text ?? "") }] }]);
    case "image":
      return estimateTokens([{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "" }] }]);
    case "tool_use":
      return estimateTokens([
        { role: "assistant", content: [{ type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}) }] }
      ]);
    case "tool_result":
      return estimateTokens([{ role: "tool", toolCallId: String(block.tool_use_id ?? ""), content: String(block.content ?? "") }] as ChatMessage[]);
    default:
      return estimateTokens([{ role: "assistant", content: [{ type: "reasoning", text: String(block.thinking ?? block.text ?? "") }] }] as ChatMessage[]);
  }
}

function stripMark(block: WireBlock): WireBlock {
  const { cache_control: _drop, ...rest } = block;
  return rest;
}

function flatten(body: WireBody): FlatBlock[] {
  const out: FlatBlock[] = [];
  if (body.tools?.length) {
    const defs: ToolDef[] = body.tools.map((tool) => ({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters: (tool.input_schema ?? {}) as Record<string, unknown> }));
    out.push({ section: "tools", role: "tools", json: JSON.stringify(body.tools), tokens: estimateTokens([], defs), breakpoint: false });
  }
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? []);
  for (const block of system) {
    out.push({ section: "system", role: "system", json: JSON.stringify(stripMark(block)), tokens: wireBlockTokens("system", block), breakpoint: block.cache_control !== undefined });
  }
  for (const message of body.messages) {
    const blocks: WireBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      out.push({ section: "messages", role: message.role, json: JSON.stringify(stripMark(block)), tokens: wireBlockTokens(message.role, block), breakpoint: block.cache_control !== undefined });
    }
  }
  return out;
}

export type CacheUsage = {
  total: number;
  read: number;
  write: number;
  uncached: number;
  blocks: number;
  /** Block index of each explicit breakpoint. */
  breakpoints: number[];
  /** Block index the longest hit ended at (undefined: full miss), and which breakpoint found it. */
  hitIndex?: number;
  hitBreakpoint?: number;
  /** First block whose prefix differs from the previous request with the same label (diagnostic). */
  divergedAt?: number;
  divergedText?: string;
};

export class AnthropicCacheSim {
  private readonly entries = new Map<string, number>(); // prefix hash -> expiry
  private readonly lastFlat = new Map<string, { hashes: string[]; flat: FlatBlock[] }>();

  constructor(
    private readonly o: { now: () => number; minCacheableTokens?: number; ttlMs?: number; lookback?: number; maxBreakpoints?: number }
  ) {}

  private get ttl(): number {
    return this.o.ttlMs ?? CACHE_TTL_MS;
  }

  /** Processes one request body at the clock's current time. `label` groups requests for divergence diagnostics. */
  process(body: WireBody, label = ""): CacheUsage {
    const now = this.o.now();
    for (const [hash, expires] of this.entries) if (expires <= now) this.entries.delete(hash);
    const flat = flatten(body);
    const breakpoints = flat.flatMap((block, index) => (block.breakpoint ? [index] : []));
    const maxBreakpoints = this.o.maxBreakpoints ?? MAX_BREAKPOINTS;
    if (breakpoints.length > maxBreakpoints) {
      throw new Error(`Anthropic rejects more than ${maxBreakpoints} cache breakpoints; the request carries ${breakpoints.length}.`);
    }
    // Message blocks are only reusable under the same tool_choice / thinking configuration.
    const messageSeed = JSON.stringify([body.tool_choice ?? null, body.thinking ?? null]);
    const hashes: string[] = [];
    const cumulative: number[] = [];
    let previous = "";
    let tokens = 0;
    for (const block of flat) {
      previous = createHash("sha256").update(previous).update("\n").update(block.section === "messages" ? messageSeed : "").update("\n").update(block.role).update("\n").update(block.json).digest("hex");
      tokens += block.tokens;
      hashes.push(previous);
      cumulative.push(tokens);
    }
    const lookback = this.o.lookback ?? LOOKBACK_BLOCKS;
    const min = this.o.minCacheableTokens ?? 0;
    let hitIndex: number | undefined;
    let hitBreakpoint: number | undefined;
    for (const bp of breakpoints) {
      for (let q = bp; q >= Math.max(0, bp - lookback + 1); q -= 1) {
        if (this.entries.has(hashes[q]!) && (hitIndex === undefined || q > hitIndex)) {
          hitIndex = q;
          hitBreakpoint = bp;
          break;
        }
      }
    }
    const read = hitIndex === undefined ? 0 : cumulative[hitIndex]!;
    const lastBreakpoint = breakpoints.length ? breakpoints[breakpoints.length - 1]! : undefined;
    const cacheable = lastBreakpoint !== undefined && cumulative[lastBreakpoint]! >= min;
    const write = cacheable ? Math.max(0, cumulative[lastBreakpoint!]! - read) : 0;
    for (const bp of breakpoints) if (cumulative[bp]! >= min) this.entries.set(hashes[bp]!, now + this.ttl);
    if (hitIndex !== undefined) this.entries.set(hashes[hitIndex]!, now + this.ttl);

    const result: CacheUsage = { total: tokens, read, write, uncached: tokens - read - write, blocks: flat.length, breakpoints, ...(hitIndex !== undefined ? { hitIndex, hitBreakpoint } : {}) };
    const before = this.lastFlat.get(label);
    if (before) {
      let i = 0;
      while (i < hashes.length && i < before.hashes.length && hashes[i] === before.hashes[i]) i += 1;
      if (i < before.hashes.length) {
        result.divergedAt = i;
        result.divergedText = `was ${before.flat[i]?.json.slice(0, 160) ?? "(end)"} / now ${flat[i]?.json.slice(0, 160) ?? "(end)"}`;
      }
    }
    this.lastFlat.set(label, { hashes, flat });
    return result;
  }
}

/** The Anthropic `usage` object for a processed request. */
export function wireUsage(u: CacheUsage, outputTokens: number): Record<string, number> {
  return { input_tokens: u.uncached, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: outputTokens };
}

export type Tally = { calls: number; total: number; read: number; write: number };

export function tally(usages: readonly CacheUsage[]): Tally {
  return usages.reduce<Tally>((acc, u) => ({ calls: acc.calls + 1, total: acc.total + u.total, read: acc.read + u.read, write: acc.write + u.write }), { calls: 0, total: 0, read: 0, write: 0 });
}

export function readRatio(t: Tally): number {
  return t.total === 0 ? 0 : t.read / t.total;
}
