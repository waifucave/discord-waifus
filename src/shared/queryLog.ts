import { redactSecrets } from "../backend/redaction.js";

/**
 * Keys that carry provider-opaque or reasoning state on a message or block: winter's `nativeState`
 * (encrypted reasoning items, exposed DeepSeek reasoning), Anthropic thinking `signature`s, OpenAI
 * `encrypted_content`, OpenRouter `reasoning_details` and their camel-case twins.
 */
const OPAQUE_KEYS = new Set([
  "nativeState",
  "signature",
  "encrypted_content",
  "encryptedContent",
  "reasoning_content",
  "reasoningContent",
  "reasoning_details",
  "reasoningDetails",
  "exposed_reasoning",
  "exposedReasoning",
  "thought_signature",
  "thoughtSignature"
]);
/** Content blocks that are reasoning (readable or redacted): logged as a bare marker. */
const REASONING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking", "reasoning"]);
const MAX_DEPTH = 32;

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The query/reply log copy of a payload without reasoning: opaque keys dropped, reasoning blocks
 * replaced by `{type, omitted: true}`. The captured traffic is visible in Activity, the events
 * stream and diagnostics; the model's reasoning and its replay state never are. The request sent
 * to the provider is untouched (this only shapes the log copy).
 */
export function withoutReasoningPayloads(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[omitted]";
  if (Array.isArray(value)) return value.map((entry) => withoutReasoningPayloads(entry, depth + 1));
  if (value !== null && typeof value === "object" && isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.type === "string" && REASONING_BLOCK_TYPES.has(record.type)) return { type: record.type, omitted: true };
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (OPAQUE_KEYS.has(key)) continue;
      out[key] = withoutReasoningPayloads(entry, depth + 1);
    }
    return out;
  }
  return value;
}

/** Which caller made a model call (the usage purposes, spec §9.3). */
export type QueryRole = "life" | "maintenance" | "detector" | "compaction" | "assistant" | "web";

export type CapturedQuery = {
  id: number;
  time: string;
  role: QueryRole;
  payload: {
    system?: unknown;
    instructions?: unknown;
    systemInstruction?: unknown;
    messages?: unknown;
    input?: unknown;
    contents?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    toolConfig?: unknown;
    generationConfig?: unknown;
    safetySettings?: unknown;
    stop?: unknown;
    stop_sequences?: unknown;
  };
};

export type CapturedReply = {
  id: number;
  time: string;
  role: QueryRole;
  queryId: number;
  status: number;
  ok: boolean;
  payload: unknown;
};

type QueryListener = (entry: CapturedQuery) => void;
type ReplyListener = (entry: CapturedReply) => void;

const MAX_RECENT = 100;
const recentQueryEntries: CapturedQuery[] = [];
const recentReplyEntries: CapturedReply[] = [];
const queryListeners = new Set<QueryListener>();
const replyListeners = new Set<ReplyListener>();
let nextQueryId = 1;
let nextReplyId = 1;

export function recordProviderQuery(role: QueryRole, body: Record<string, unknown>): CapturedQuery {
  const payload: CapturedQuery["payload"] = {};
  if (body.system !== undefined) payload.system = body.system;
  if (body.instructions !== undefined) payload.instructions = body.instructions;
  if (body.systemInstruction !== undefined) payload.systemInstruction = body.systemInstruction;
  if (body.messages !== undefined) payload.messages = body.messages;
  if (body.input !== undefined) payload.input = body.input;
  if (body.contents !== undefined) payload.contents = body.contents;
  if (body.tools !== undefined) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  if (body.toolConfig !== undefined) payload.toolConfig = body.toolConfig;
  if (body.generationConfig !== undefined) payload.generationConfig = body.generationConfig;
  if (body.safetySettings !== undefined) payload.safetySettings = body.safetySettings;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.stop_sequences !== undefined) payload.stop_sequences = body.stop_sequences;
  const entry: CapturedQuery = {
    id: nextQueryId++,
    time: new Date().toISOString(),
    role,
    payload: redactSecrets(withoutReasoningPayloads(payload) as CapturedQuery["payload"])
  };
  recentQueryEntries.push(entry);
  if (recentQueryEntries.length > MAX_RECENT) recentQueryEntries.shift();
  for (const listener of queryListeners) listener(entry);
  return entry;
}

export function recordProviderReply(
  role: QueryRole,
  queryId: number,
  status: number,
  ok: boolean,
  payload: unknown
): CapturedReply {
  const entry: CapturedReply = {
    id: nextReplyId++,
    time: new Date().toISOString(),
    role,
    queryId,
    status,
    ok,
    payload: redactSecrets(withoutReasoningPayloads(payload))
  };
  recentReplyEntries.push(entry);
  if (recentReplyEntries.length > MAX_RECENT) recentReplyEntries.shift();
  for (const listener of replyListeners) listener(entry);
  return entry;
}

export function recentQueries(): CapturedQuery[] {
  return [...recentQueryEntries];
}

export function recentReplies(): CapturedReply[] {
  return [...recentReplyEntries];
}

export function subscribeQueries(listener: QueryListener): () => void {
  queryListeners.add(listener);
  return () => queryListeners.delete(listener);
}

export function subscribeReplies(listener: ReplyListener): () => void {
  replyListeners.add(listener);
  return () => replyListeners.delete(listener);
}

const clearListeners = new Set<() => void>();

/**
 * Forget (Living cast §7.5): the in-memory traffic buffers go — the captured queries and replies
 * and, through the listeners, the `/api/events` replay — so nothing a forgotten person said is
 * replayed to a reconnecting dashboard.
 */
export function clearCapturedTraffic(): void {
  recentQueryEntries.length = 0;
  recentReplyEntries.length = 0;
  for (const listener of clearListeners) {
    try {
      listener();
    } catch {
      // a listener never stops the others
    }
  }
}

export function onCapturedTrafficCleared(listener: () => void): () => void {
  clearListeners.add(listener);
  return () => clearListeners.delete(listener);
}
