export type QueryRole = "orchestrator" | "waifu" | "stage_manager" | "reviewer";

export type CapturedQuery = {
  id: number;
  time: string;
  role: QueryRole;
  payload: {
    system?: unknown;
    instructions?: unknown;
    messages?: unknown;
    input?: unknown;
    tools?: unknown;
    tool_choice?: unknown;
    stop?: unknown;
    stop_sequences?: unknown;
  };
};

type Listener = (entry: CapturedQuery) => void;

const MAX_RECENT = 100;
const recentEntries: CapturedQuery[] = [];
const listeners = new Set<Listener>();
let nextId = 1;

export function recordProviderQuery(role: QueryRole, body: Record<string, unknown>): void {
  const payload: CapturedQuery["payload"] = {};
  if (body.system !== undefined) payload.system = body.system;
  if (body.instructions !== undefined) payload.instructions = body.instructions;
  if (body.messages !== undefined) payload.messages = body.messages;
  if (body.input !== undefined) payload.input = body.input;
  if (body.tools !== undefined) payload.tools = body.tools;
  if (body.tool_choice !== undefined) payload.tool_choice = body.tool_choice;
  if (body.stop !== undefined) payload.stop = body.stop;
  if (body.stop_sequences !== undefined) payload.stop_sequences = body.stop_sequences;
  const entry: CapturedQuery = {
    id: nextId++,
    time: new Date().toISOString(),
    role,
    payload
  };
  recentEntries.push(entry);
  if (recentEntries.length > MAX_RECENT) recentEntries.shift();
  for (const listener of listeners) listener(entry);
}

export function recentQueries(): CapturedQuery[] {
  return [...recentEntries];
}

export function subscribeQueries(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
