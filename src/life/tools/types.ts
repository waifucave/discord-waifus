// Life tools (Living cast spec §16.3): shared types and helpers. Tool names are PascalCase like
// Claude Code's (`ReadMessages`, `Bash`), parameters snake_case (`file_path`); results are short
// text; errors start with `error:` and are sent with `is_error`.

import type { ContentBlockLike } from "@yanlinglabs/winter-provider-runtime";
import type { z } from "zod";
import type { CuratedModel } from "../../models/catalog.js";
import type { AppConfig } from "../../shared/schemas/config.js";
import type { WaifuConfig } from "../../shared/schemas/domain.js";
import type { LifeImageBlock } from "../../shared/schemas/life.js";
import type { LifeDeps } from "../deps.js";

export type LifeResultBlock = Extract<ContentBlockLike, { type: "text" }> | LifeImageBlock;

export type ToolOutput = {
  content: string | LifeResultBlock[];
  isError?: boolean;
  /** Discord message ids the result shows (§5.6: kept turns omit results of deleted messages). */
  messageIds?: string[];
  /** What a side effect produced (SendMessage: the Discord message id), for the intent's done line. */
  resultRef?: string;
};

/** Per-turn bookkeeping the tools share (§5.2, §6.3, §6.9). */
export type TurnScratch = {
  id: string;
  /** Places she sent to this turn (`life.maxSendPlacesPerTurn`). */
  sentPlaces: Set<string>;
  /** Messages she sent this turn (`life.maxSendsPerTurn`). */
  sends?: number;
  /** DM users she already sent to this turn: they may keep getting messages past the rate limit. */
  dmUsersSent: Set<string>;
  /** Pages her Web scripts opened this turn (`life.webFetch.maxPerTurn`). */
  fetches: number;
  /**
   * A DM turn (D14, spec §14.4): its wakes include a DM, or a call resolved to a DM place. Its web
   * searches and fetches are recorded as private (`dm: true`) on the dashboard's list.
   */
  dm?: boolean;
  /** Searches and fetches recorded on the dashboard's list this turn (marked private if the turn becomes a DM turn). */
  webEntries?: number;
  /**
   * Her special files (the ones in ~/life/) as she last read them this turn: path key → content
   * hash. A whole-file Write needs a current Read (a reminder fires or a watch times out on its own
   * in between).
   */
  readHashes?: Map<string, string>;
  /**
   * Private chats' transcript days she was shown this turn (Read, Bash), by content hash: a file she
   * then writes with exactly that text keeps its DM origin (§18.3, D14).
   */
  transcriptTexts?: Map<string, { sha256: string; size: number; placeKey: string }>;
  /** Files whose system-prompt copy she was told is stale this turn (§21.2: once per file per turn). */
  promptCopyNoted?: Set<string>;
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
  /** A side-effect tool's intent (§5.7): the tool may add lines to it (send: the content digest). */
  intent?: { turnId: string; toolCallId: string; tool: string; argsDigest: string };
  /**
   * `life` (default): a turn of her life. `session`: nightly maintenance or a forget's notes scrub,
   * outside her life: Read never shows an image inline and never touches her life's image state.
   */
  mode?: "life" | "session";
  /** Which session (mode `session`): a dream leaves `~/life/` alone (§21.6). */
  session?: "maintenance" | "scrub" | "dream";
};

export type LifeTool = {
  name: string;
  description: string;
  /** The description under the current configuration (Bash with or without python3). */
  describe?: (config: AppConfig) => string;
  inputSchema: Record<string, unknown>;
  /** Its input schema under the current config (limits it states), when they depend on it. */
  schemaFor?: (config: AppConfig) => Record<string, unknown>;
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

export const UNKNOWN_PLACE = "error: unknown place; see ~/life/places.md";
export const MESSAGE_TOO_OLD = "error: message too old";
export const CANNOT_POST = "error: you can't post there";
