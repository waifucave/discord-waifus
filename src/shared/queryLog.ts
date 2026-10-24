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

/**
 * Callers whose captured traffic keeps metadata only (Living cast; review M14): a life's requests
 * carry her whole private log, her notes, DMs and the people she talks to, and so do her
 * maintenance, compaction and web digest calls. Activity, `/api/events` and the diagnostics bundle
 * see the route, sizes, stop reason, usage, cost and timing, never the content. The private view
 * of a life is L3's Life timeline.
 */
export const METADATA_ONLY_ROLES: ReadonlySet<QueryRole> = new Set<QueryRole>(["life", "maintenance", "compaction", "web"]);

/** The reply fields a metadata-only entry keeps. */
const REPLY_METADATA_KEYS = ["finishReason", "usage", "costUsd", "durationMs"] as const;

export type CapturedQuery = {
  id: number;
  time: string;
  role: QueryRole;
  providerId?: string;
  modelId?: string;
  /** Content left out (METADATA_ONLY_ROLES): `payload` holds counts only. */
  metadataOnly?: true;
  payload: {
    messageCount?: number;
    toolCount?: number;
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
  /** Content left out (METADATA_ONLY_ROLES). */
  metadataOnly?: true;
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

export function recordProviderQuery(role: QueryRole, body: Record<string, unknown>, route: { providerId?: string; modelId?: string } = {}): CapturedQuery {
  const routeFields = {
    ...(route.providerId !== undefined ? { providerId: route.providerId } : {}),
    ...(route.modelId !== undefined ? { modelId: route.modelId } : {})
  };
  if (METADATA_ONLY_ROLES.has(role)) {
    const count = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
    const messageCount = count(body.messages) ?? count(body.input) ?? count(body.contents);
    const toolCount = count(body.tools);
    return keepQuery({
      id: nextQueryId++,
      time: new Date().toISOString(),
      role,
      ...routeFields,
      metadataOnly: true,
      payload: { ...(messageCount !== undefined ? { messageCount } : {}), ...(toolCount !== undefined ? { toolCount } : {}) }
    });
  }
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
  return keepQuery({
    id: nextQueryId++,
    time: new Date().toISOString(),
    role,
    ...routeFields,
    payload: redactSecrets(withoutReasoningPayloads(payload) as CapturedQuery["payload"])
  });
}

function keepQuery(entry: CapturedQuery): CapturedQuery {
  recentQueryEntries.push(entry);
  if (recentQueryEntries.length > MAX_RECENT) recentQueryEntries.shift();
  for (const listener of queryListeners) listener(entry);
  return entry;
}

/** A metadata-only reply: the stop reason, usage, cost and timing; an error's kind and code. */
function replyMetadata(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of REPLY_METADATA_KEYS) if (record[key] !== undefined) out[key] = record[key];
  const error = record.error;
  if (error !== null && typeof error === "object") {
    const { kind, code } = error as Record<string, unknown>;
    out.error = { ...(kind !== undefined ? { kind } : {}), ...(code !== undefined ? { code } : {}) };
  }
  return out;
}

export function recordProviderReply(
  role: QueryRole,
  queryId: number,
  status: number,
  ok: boolean,
  payload: unknown
): CapturedReply {
  const metadataOnly = METADATA_ONLY_ROLES.has(role);
  const entry: CapturedReply = {
    id: nextReplyId++,
    time: new Date().toISOString(),
    role,
    queryId,
    status,
    ok,
    ...(metadataOnly ? { metadataOnly: true as const } : {}),
    payload: metadataOnly ? replyMetadata(payload) : redactSecrets(withoutReasoningPayloads(payload))
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

/** Whether an entry (walked as a value, never as JSON) carries the person: their id or a name only they have. */
export type TrafficMatch = (entry: unknown) => boolean;

const forgetListeners = new Set<(matches: TrafficMatch) => void>();

function dropMatching<T>(entries: T[], matches: TrafficMatch): number {
  const kept = entries.filter((entry) => !matches(entry));
  const removed = entries.length - kept.length;
  if (removed > 0) entries.splice(0, entries.length, ...kept);
  return removed;
}

/**
 * Forget (Living cast §7.5, F12): the in-memory captured queries and replies that carry the person
 * go, and through the listeners so do the matching `/api/events` replay records, so nothing they
 * said is replayed to a reconnecting dashboard. Everyone else's entries stay.
 */
export function forgetCapturedTraffic(matches: TrafficMatch): number {
  const removed = dropMatching(recentQueryEntries, matches) + dropMatching(recentReplyEntries, matches);
  for (const listener of forgetListeners) {
    try {
      listener(matches);
    } catch {
      // a listener never stops the others
    }
  }
  return removed;
}

export function onCapturedTrafficForgotten(listener: (matches: TrafficMatch) => void): () => void {
  forgetListeners.add(listener);
  return () => forgetListeners.delete(listener);
}
