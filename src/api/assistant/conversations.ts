import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@waifucave/gateway";
import type { EventCursor } from "../../shared/schemas/adminOperations.js";
import { EventStream } from "../eventStream.js";

export type AssistantEvent =
  | { type: "turn_started" }
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; arguments: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "confirmation_required"; actionId: string; category: string; summary: string }
  | { type: "turn_completed" }
  | { type: "error"; message: string };

export type StoredMessage =
  | { role: "user" | "assistant"; content: string; at: string }
  | { role: "event"; event: AssistantEvent; cursor: EventCursor; at: string };

type Conversation = {
  id: string;
  createdAt: string;
  messages: StoredMessage[];
  chat: ChatMessage[];
  busy: boolean;
  eventStream: EventStream<AssistantEvent>;
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

  constructor(
    private readonly createEventStream: () => EventStream<AssistantEvent> = () => new EventStream()
  ) {}

  create(): { id: string } {
    const id = randomUUID();
    this.conversations.set(id, {
      id,
      createdAt: new Date().toISOString(),
      messages: [],
      chat: [],
      busy: false,
      eventStream: this.createEventStream()
    });
    // Map preserves insertion order; get() re-inserts, so iteration order is true LRU.
    // Never evict a conversation mid-turn (its output would silently vanish).
    while (this.conversations.size > MAX_CONVERSATIONS) {
      const victim = [...this.conversations.values()].find((candidate) => !candidate.busy && candidate.id !== id);
      if (!victim) break;
      victim.eventStream.close();
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
    const { eventStream: _eventStream, ...visible } = conversation;
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

  subscribe(id: string, listener: (event: AssistantEvent, cursor: EventCursor) => void): () => void {
    const conversation = this.conversations.get(id);
    if (!conversation) return () => undefined;
    const subscription = conversation.eventStream.subscribeAuthorized({
      principal: "internal",
      lastEventId: conversation.eventStream.latestCursor(),
      authorize: () => true,
      project: (_principal, _event, data) => data,
      snapshot: () => null,
      projectSnapshot: () => null,
      onReset: () => undefined,
      onSnapshot: () => undefined,
      onEvent: (_event, data, cursor) => listener(data, cursor),
      onUnauthorized: () => undefined
    });
    return subscription.close;
  }

  eventStream(id: string): EventStream<AssistantEvent> | undefined {
    return this.conversations.get(id)?.eventStream;
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
    const conversation = this.conversations.get(id);
    if (!conversation) return false;
    conversation.eventStream.close();
    return this.conversations.delete(id);
  }

  emit(id: string, event: AssistantEvent): void {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    const cursor = conversation.eventStream.publish("assistant", event);
    this.appendStored(id, { role: "event", event, cursor, at: new Date().toISOString() });
  }
}
