import type { ServerConfig } from "../shared/schemas/domain.js";

export type ContextCapKind = "orchestrator" | "waifu" | "stageManager";

/**
 * B29: the backfill cap for one agent in one conversation. Precedence: an explicit
 * `ServerConfig.contextWindows.<kind>` override wins, otherwise the agent/waifu's own
 * `contextWindow`. DMs have no server, so they pass `undefined` and always use the waifu's value.
 * `contextWindow` is only the backfill cap (spec 8.9); compaction is token/maxMessages driven.
 */
export function resolveContextCap(
  kind: ContextCapKind,
  server: Pick<ServerConfig, "contextWindows"> | undefined,
  own: { contextWindow: number }
): number {
  return server?.contextWindows?.[kind] ?? own.contextWindow;
}

/** Pre-B29 server defaults: what a server file without an explicit key used to be filled with. */
export const LEGACY_SERVER_CONTEXT_WINDOWS: Readonly<Record<ContextCapKind, number>> = {
  orchestrator: 20,
  waifu: 50,
  stageManager: 80
};

/**
 * Effective server-level window exactly as it behaved before B29 made the keys optional overrides
 * (explicit value, else the old default). Existing read sites use this until T5 moves them to
 * `resolveContextCap`; it keeps Phase 4 contracts landing with zero behaviour change.
 */
export function legacyServerContextWindow(
  kind: ContextCapKind,
  server: Pick<ServerConfig, "contextWindows">
): number {
  return server.contextWindows[kind] ?? LEGACY_SERVER_CONTEXT_WINDOWS[kind];
}
