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
  | { role: "event"; event: AssistantEvent; at: string };

type Conversation = {
  id: string;
  messages: StoredMessage[];
  chat: ChatMessage[];
  busy: boolean;
  listeners: Set<(event: AssistantEvent) => void>;
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
    this.conversations.set(id, { id, messages: [], chat: [], busy: false, listeners: new Set() });
    // Map preserves insertion order — evict the oldest past the cap.
    while (this.conversations.size > MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value as string;
      this.conversations.delete(oldest);
    }
    return { id };
  }

  get(id: string): { id: string; messages: StoredMessage[]; chat: ChatMessage[]; busy: boolean } | undefined {
    const conversation = this.conversations.get(id);
    if (!conversation) return undefined;
    const { listeners: _listeners, ...visible } = conversation;
    return visible;
  }

  appendChat(id: string, messages: ChatMessage[]): void {
    const conversation = this.conversations.get(id);
    if (conversation) conversation.chat = messages;
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

  subscribe(id: string, listener: (event: AssistantEvent) => void): () => void {
    const conversation = this.conversations.get(id);
    if (!conversation) return () => undefined;
    conversation.listeners.add(listener);
    return () => conversation.listeners.delete(listener);
  }

  emit(id: string, event: AssistantEvent): void {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    this.appendStored(id, { role: "event", event, at: new Date().toISOString() });
    for (const listener of conversation.listeners) listener(event);
  }
}
