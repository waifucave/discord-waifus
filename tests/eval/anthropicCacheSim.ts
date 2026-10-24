// Offline model of Anthropic's prompt cache (Living cast spec §12), applied to the REAL wire body
// winter's anthropic-messages adapter sends (captured by tests/eval/fakeAnthropic.ts). Not a test file.
//
// Rules modelled (docs.anthropic.com "Prompt caching"):
// - The prompt is the sequence tools -> system -> messages, one cacheable position per content block
//   (all tools count as one position).
// - At most 4 `cache_control` breakpoints per request (a fifth is a 400 in production; here it throws).
// - A breakpoint at block b looks for a cache entry written by an earlier request at b itself or at
//   one of the LOOKBACK_BLOCKS - 1 blocks before it; the longest hit across breakpoints is read.
// - Every breakpoint writes an entry for its prefix, with that breakpoint's own TTL (`ttl: "1h"` is
//   one hour, otherwise five minutes). An entry lives its TTL after its last write or hit.
// - The prefix hash of message blocks also covers `tool_choice` and `thinking` (changing either
//   invalidates cached message content; tools and system stay cached). `max_tokens` is not part of it.
//
// Tokens are estimated from the JSON of each block (~4 characters per token); reads and writes are
// in that unit.

import { createHash } from "node:crypto";

export const FIVE_MINUTES_MS = 5 * 60_000;
export const ONE_HOUR_MS = 60 * 60_000;
export const LOOKBACK_BLOCKS = 20;
export const MAX_BREAKPOINTS = 4;

export type WireBlock = { type: string; cache_control?: { type: string; ttl?: string }; [key: string]: unknown };
export type WireBody = {
  model?: string;
  system?: string | WireBlock[];
  messages: Array<{ role: string; content: string | WireBlock[] }>;
  tools?: Array<{ name: string; cache_control?: { type: string; ttl?: string }; [key: string]: unknown }>;
  tool_choice?: unknown;
  thinking?: unknown;
  [key: string]: unknown;
};

type FlatBlock = { section: "tools" | "system" | "messages"; role: string; json: string; tokens: number; ttlMs?: number };

/** How many tokens a block costs: its JSON or the block itself (default: JSON characters / 4). */
export type BlockTokenizer = (json: string, block: unknown) => number;
const charsOver4: BlockTokenizer = (json) => Math.max(1, Math.ceil(json.length / 4));
const ttlOf = (mark: { ttl?: string } | undefined) => (mark ? (mark.ttl === "1h" ? ONE_HOUR_MS : FIVE_MINUTES_MS) : undefined);

function withoutMark<T extends { cache_control?: unknown }>(block: T): Omit<T, "cache_control"> {
  const { cache_control: _drop, ...rest } = block;
  return rest;
}

function flatten(body: WireBody, tokensOf: BlockTokenizer): FlatBlock[] {
  const out: FlatBlock[] = [];
  if (body.tools?.length) {
    const json = JSON.stringify(body.tools.map(withoutMark));
    const mark = body.tools.find((tool) => tool.cache_control)?.cache_control;
    out.push({ section: "tools", role: "tools", json, tokens: tokensOf(json, body.tools), ...(mark ? { ttlMs: ttlOf(mark)! } : {}) });
  }
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system } as WireBlock] : (body.system ?? []);
  for (const block of system) {
    const json = JSON.stringify(withoutMark(block));
    out.push({ section: "system", role: "system", json, tokens: tokensOf(json, block), ...(block.cache_control ? { ttlMs: ttlOf(block.cache_control)! } : {}) });
  }
  for (const message of body.messages) {
    const blocks: WireBlock[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    for (const block of blocks) {
      const json = JSON.stringify(withoutMark(block));
      out.push({ section: "messages", role: message.role, json, tokens: tokensOf(json, block), ...(block.cache_control ? { ttlMs: ttlOf(block.cache_control)! } : {}) });
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
  breakpoints: number[];
  hitIndex?: number;
};

export class AnthropicCacheSim {
  /** Tests may swap in a script-aware count (tests/eval/tokenModel.ts). */
  tokenizer: BlockTokenizer = charsOver4;
  private readonly entries = new Map<string, { expires: number; ttlMs: number }>();

  constructor(private readonly o: { now: () => number; minCacheableTokens?: number; lookback?: number }) {}

  process(body: WireBody): CacheUsage {
    const now = this.o.now();
    for (const [hash, entry] of this.entries) if (entry.expires <= now) this.entries.delete(hash);
    const flat = flatten(body, this.tokenizer);
    const breakpoints = flat.flatMap((block, index) => (block.ttlMs !== undefined ? [index] : []));
    if (breakpoints.length > MAX_BREAKPOINTS) throw new Error(`Anthropic rejects more than ${MAX_BREAKPOINTS} cache breakpoints; the request carries ${breakpoints.length}.`);
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
    for (const bp of breakpoints) {
      for (let q = bp; q >= Math.max(0, bp - lookback + 1); q -= 1) {
        if (this.entries.has(hashes[q]!) && (hitIndex === undefined || q > hitIndex)) {
          hitIndex = q;
          break;
        }
      }
    }
    const read = hitIndex === undefined ? 0 : cumulative[hitIndex]!;
    const last = breakpoints.length ? breakpoints[breakpoints.length - 1]! : undefined;
    const write = last !== undefined && cumulative[last]! >= min ? Math.max(0, cumulative[last]! - read) : 0;
    for (const bp of breakpoints) if (cumulative[bp]! >= min) this.entries.set(hashes[bp]!, { expires: now + flat[bp]!.ttlMs!, ttlMs: flat[bp]!.ttlMs! });
    if (hitIndex !== undefined) {
      const hit = this.entries.get(hashes[hitIndex]!)!;
      this.entries.set(hashes[hitIndex]!, { ...hit, expires: now + hit.ttlMs });
    }
    return { total: tokens, read, write, uncached: tokens - read - write, blocks: flat.length, breakpoints, ...(hitIndex !== undefined ? { hitIndex } : {}) };
  }
}

export type Tally = { calls: number; total: number; read: number; write: number };

export function tally(usages: readonly CacheUsage[]): Tally {
  return usages.reduce<Tally>((acc, u) => ({ calls: acc.calls + 1, total: acc.total + u.total, read: acc.read + u.read, write: acc.write + u.write }), { calls: 0, total: 0, read: 0, write: 0 });
}

export function readRatio(t: Tally): number {
  return t.total === 0 ? 0 : t.read / t.total;
}
