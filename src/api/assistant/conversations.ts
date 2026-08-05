import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@waifucave/gateway";

export type AssistantEvent =
  | { type: "turn_started" }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "turn_completed" }
  | { type: "error"; message: string };

export type StoredMessage =
  | { role: "user" | "assistant"; content: string; at: string }
  | { role: "event"; event: AssistantEvent; seq?: number; at: string };

type Conversation = {
  id: string;
  createdAt: string;
  messages: StoredMessage[];
  chat: ChatMessage[];
  busy: boolean;
  eventSeq: number;
  listeners: Set<(event: AssistantEvent, seq: number) => void>;
};

const MAX_CONVERSATIONS = 20;
const MAX_STORED_MESSAGES = 200;

/**
 * In-memory conversation state for the dashboard assistant. `messages` is the display
 * transcript (user/assistant text plus tool events); `chat` is the model-facing gateway
 * transcript. Both live only for the process lifetime — v1 has no persistence by design.
 */
export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  create(): { id: string } {
    const id = randomUUID();
    this.conversations.set(id, {
      id,
      createdAt: new Date().toISOString(),
      messages: [],
      chat: [],
      busy: false,
      eventSeq: 0,
      listeners: new Set()
    });
    // Map preserves insertion order; get() re-inserts, so iteration order is true LRU.
    // Never evict a conversation mid-turn (its output would silently vanish).
    while (this.conversations.size > MAX_CONVERSATIONS) {
      const victim = [...this.conversations.values()].find((candidate) => !candidate.busy && candidate.id !== id);
      if (!victim) break;
      this.conversations.delete(victim.id);
    }
    return { id };
  }

  get(id: string): { id: string; messages: StoredMessage[]; chat: ChatMessage[]; busy: boolean } | undefined {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    // LRU touch: re-insert so create() evicts genuinely idle conversations first
    this.conversations.delete(id);
    this.conversations.set(id, conversation);
    const { listeners: _listeners, ...visible } = conversation;
    return visible;
  }

  appendChat(id: string, messages: ChatMessage[]): void {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    // trim the model transcript from the front (never the system prompt) past a byte budget —
    // tool results are up to 6000 chars each and were resent wholesale forever (audit finding 12)
    const budget = 120_000;
    let size = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
    const trimmed = [...messages];
    while (size > budget && trimmed.length > 2) {
      const index = trimmed.findIndex((message) => message.role !== "system");
      if (index === -1) break;
      size -= JSON.stringify(trimmed[index]).length;
      trimmed.splice(index, 1);
    }
    conversation.chat = trimmed;
  }

  appendStored(id: string, message: StoredMessage): void {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    conversation.messages.push(message);
    if (conversation.messages.length > MAX_STORED_MESSAGES) {
      conversation.messages.splice(0, conversation.messages.length - MAX_STORED_MESSAGES);
    }
  }

  setBusy(id: string, busy: boolean): void {
    const conversation = this.conversations.get(id);
    if (conversation) conversation.busy = busy;
  }

  subscribe(id: string, listener: (event: AssistantEvent, seq: number) => void): () => void {
    const conversation = this.conversations.get(id);
    if (!conversation) return () => undefined;
    conversation.listeners.add(listener);
    return () => conversation.listeners.delete(listener);
  }

  list(): Array<{ id: string; createdAt: string; messageCount: number; preview?: string }> {
    return [...this.conversations.values()]
      .map((conversation) => {
        const firstUser = conversation.messages.find((message) => message.role === "user");
        const preview = firstUser && "content" in firstUser ? firstUser.content.slice(0, 80) : undefined;
        return {
          id: conversation.id,
          createdAt: conversation.createdAt,
          messageCount: conversation.messages.filter((message) => message.role !== "event").length,
          ...(preview ? { preview } : {})
        };
      })
      .reverse();
  }

  delete(id: string): boolean {
    return this.conversations.delete(id);
  }

  emit(id: string, event: AssistantEvent): void {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    // monotone sequence: the SSE layer sends it as the event id so clients can drop
    // duplicates when the browser reconnects and history is replayed (audit finding 10)
    const seq = ++conversation.eventSeq;
    this.appendStored(id, { role: "event", event, seq, at: new Date().toISOString() });
    for (const listener of conversation.listeners) listener(event, seq);
  }
}
