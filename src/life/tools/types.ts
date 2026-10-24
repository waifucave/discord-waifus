// Life tools (Living cast spec §6): shared types and helpers. Tool names are snake_case; results
// are short text; errors start with `error:` and are sent with `is_error`.

import type { ContentBlockLike } from "@yanlinglabs/winter-provider-runtime";
import type { z } from "zod";
import type { CuratedModel } from "../../models/catalog.js";
import type { WaifuConfig } from "../../shared/schemas/domain.js";
import type { LifeImageBlock } from "../../shared/schemas/life.js";
import type { LifeDeps } from "../deps.js";

export type LifeResultBlock = Extract<ContentBlockLike, { type: "text" }> | LifeImageBlock;

export type ToolOutput = {
  content: string | LifeResultBlock[];
  isError?: boolean;
  /** Discord message ids the result shows (§5.6: kept turns omit results of deleted messages). */
  messageIds?: string[];
  /** What a side effect produced (send_message: the Discord message id), for the intent's done line. */
  resultRef?: string;
};

/** Per-turn bookkeeping the tools share (§5.2, §6.3, §6.9). */
export type TurnScratch = {
  id: string;
  /** Places she sent to this turn (`life.maxSendPlacesPerTurn`). */
  sentPlaces: Set<string>;
  /** DM users she already sent to this turn: they may keep getting messages past the rate limit. */
  dmUsersSent: Set<string>;
  /** web_fetch calls this turn (`life.webFetch.maxPerTurn`). */
  fetches: number;
};

export type ToolHooks = {
  /** Her schedule or watches changed (the scheduler re-arms its timers). */
  scheduleChanged?(waifuId: string): void;
};

export type ToolContext = {
  deps: LifeDeps;
  waifu: WaifuConfig;
  route: CuratedModel;
  turn: TurnScratch;
  signal: AbortSignal;
  toolCallId: string;
  /** Her own Discord author ids (her bot's id and application id). */
  selfAuthorIds: readonly string[];
  /** Every tool name offered this epoch (the outbound tool-call-syntax check). */
  toolNames: readonly string[];
  hooks?: ToolHooks;
};

export type LifeTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Writes an intent before it runs and a done line after (§5.7). */
  sideEffect: boolean;
  run(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
};

export function toolError(message: string): ToolOutput {
  return { content: message.startsWith("error:") ? message : `error: ${message}`, isError: true };
}

/** Validates tool input with a zod schema; the first issue becomes a short error. */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown): { ok: true; value: T } | { ok: false; output: ToolOutput } {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, output: toolError(`${where}${issue?.message ?? "invalid input"}`) };
}

export const UNKNOWN_PLACE = "error: unknown place; use list_places";
export const MESSAGE_TOO_OLD = "error: message too old";
export const CANNOT_POST = "error: you can't post there";
