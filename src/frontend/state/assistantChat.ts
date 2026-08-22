import { useCallback, useEffect, useRef, useState } from "react";
import { api, openAssistantEventStream } from "../api/client";
import { latestEventCursor } from "../api/eventCursor";
import type { ResumableEventFeed } from "../api/resumableEventFeed";
import type { AssistantEvent, AssistantStoredMessage } from "../api/types";

const STORAGE_KEY = "assistant-conversation";

export type ChatItem =
  | { kind: "user"; content: string }
  | { kind: "assistant"; content: string }
  | { kind: "tool"; name: string; args?: string; result?: string }
  | { kind: "error"; message: string };

/**
 * Chat state for the corner assistant panel. The conversation id survives view changes via
 * sessionStorage; the SSE stream renders tool activity live while a turn runs. A stale id
 * (backend restarted — conversations are in-memory) transparently gets a fresh conversation.
 */
export function useAssistantChat(open: boolean) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const conversationRef = useRef<string | undefined>(sessionStorage.getItem(STORAGE_KEY) ?? undefined);
  const sourceRef = useRef<ResumableEventFeed | undefined>(undefined);

  const foldEvent = useCallback((event: AssistantEvent) => {
    if (event.type === "tool_call") {
      setItems((prev) => [...prev, { kind: "tool", name: event.name, args: event.arguments }]);
    } else if (event.type === "tool_result") {
      setItems((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const item = next[i];
          if (item.kind === "tool" && item.name === event.name && item.result === undefined) {
            next[i] = { ...item, result: event.result };
            break;
          }
        }
        return next;
      });
    } else if (event.type === "error") {
      setItems((prev) => [...prev, { kind: "error", message: event.message }]);
    }
  }, []);

  const attachStream = useCallback(
    (
      conversationId: string,
      options?: { initialCursor?: string; preserveItemsOnEmptySnapshot?: boolean }
    ) => {
      sourceRef.current?.close();
      const source = openAssistantEventStream(conversationId, {
        ...(options?.initialCursor ? { initialCursor: options.initialCursor } : {}),
        onReset: () => {
          if (!options?.preserveItemsOnEmptySnapshot) setItems([]);
        },
        onEvent: (message) => {
          try {
            if (message.event === "snapshot") {
              const snapshot = JSON.parse(message.data) as {
                busy?: unknown;
                messages?: AssistantStoredMessage[];
              };
              const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
              if (!(options?.preserveItemsOnEmptySnapshot && messages.length === 0)) {
                setItems(restoreItems(messages));
              }
              setBusy(Boolean(snapshot.busy));
            } else if (message.event === "assistant") {
              const event = JSON.parse(message.data) as AssistantEvent;
              foldEvent(event);
              if (event.type === "turn_started") setBusy(true);
              else if (event.type === "turn_completed" || event.type === "error") setBusy(false);
            }
          } catch {
            // Malformed frames never replace the canonical transcript or POST result.
          }
        }
      });
      sourceRef.current = source;
    },
    [foldEvent]
  );

  const ensureConversation = useCallback(async (): Promise<string> => {
    const existing = conversationRef.current;
    if (existing) {
      try {
        const found = await api.assistantConversation(existing);
        return found.id;
      } catch {
        // Stale id after a backend restart — fall through and create anew.
      }
    }
    const created = await api.createAssistantConversation();
    conversationRef.current = created.conversationId;
    sessionStorage.setItem(STORAGE_KEY, created.conversationId);
    attachStream(created.conversationId, { preserveItemsOnEmptySnapshot: true });
    return created.conversationId;
  }, [attachStream]);

  // On first open, restore the prior transcript (if the conversation still exists).
  useEffect(() => {
    if (!open) return;
    const existing = conversationRef.current;
    if (!existing || items.length > 0) return;
    let cancelled = false;
    api
      .assistantConversation(existing)
      .then((conversation) => {
        if (cancelled) return;
        const messages = conversation.messages as AssistantStoredMessage[];
        setItems(restoreItems(messages));
        const initialCursor = storedLatestCursor(messages);
        attachStream(existing, initialCursor ? { initialCursor } : undefined);
      })
      .catch(() => {
        conversationRef.current = undefined;
        sessionStorage.removeItem(STORAGE_KEY);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => () => sourceRef.current?.close(), []);

  const send = useCallback(
    async (content: string) => {
      setError(undefined);
      setBusy(true);
      setItems((prev) => [...prev, { kind: "user", content }]);
      try {
        const conversationId = await ensureConversation();
        const result = await api.sendAssistantMessage(conversationId, content);
        setItems((prev) => [...prev, { kind: "assistant", content: result.reply }]);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [ensureConversation]
  );

  const reset = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = undefined;
    conversationRef.current = undefined;
    sessionStorage.removeItem(STORAGE_KEY);
    setItems([]);
    setBusy(false);
    setError(undefined);
  }, []);

  return { items, busy, error, send, reset };
}

function restoreItems(messages: readonly AssistantStoredMessage[]): ChatItem[] {
  const restored: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      restored.push({ kind: "user", content: message.content });
    } else if (message.role === "assistant") {
      restored.push({ kind: "assistant", content: message.content });
    } else if (message.role === "event") {
      if (message.event.type === "tool_call") {
        restored.push({
          kind: "tool",
          name: message.event.name,
          args: message.event.arguments
        });
      } else if (message.event.type === "tool_result") {
        for (let index = restored.length - 1; index >= 0; index -= 1) {
          const item = restored[index];
          if (item.kind === "tool" && item.name === message.event.name && item.result === undefined) {
            restored[index] = { ...item, result: message.event.result };
            break;
          }
        }
      } else if (message.event.type === "error") {
        restored.push({ kind: "error", message: message.event.message });
      }
    }
  }
  return restored;
}

function storedLatestCursor(messages: readonly AssistantStoredMessage[]): string | undefined {
  try {
    return latestEventCursor(
      messages.flatMap((message) => message.role === "event" ? [message.cursor] : [])
    );
  } catch {
    return undefined;
  }
}
