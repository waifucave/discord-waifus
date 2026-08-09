import { redactSecrets } from "../backend/redaction.js";

export type QueryRole =
  | "orchestrator"
  | "waifu"
  | "stage_manager_observer"
  | "stage_manager_librarian"
  | "dream"
  | "reviewer"
  | "assistant";

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
    payload: redactSecrets(payload)
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
    payload: redactSecrets(payload)
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
