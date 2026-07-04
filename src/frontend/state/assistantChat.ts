import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
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
  const sourceRef = useRef<EventSource | undefined>(undefined);

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
    (conversationId: string) => {
      sourceRef.current?.close();
      const source = new EventSource(`/api/assistant/conversations/${encodeURIComponent(conversationId)}/stream`);
      source.addEventListener("assistant", (raw) => {
        try {
          foldEvent(JSON.parse((raw as MessageEvent).data) as AssistantEvent);
        } catch {
          // Malformed frame — ignore; the POST response still carries the final reply.
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
    attachStream(created.conversationId);
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
        const restored: ChatItem[] = [];
        for (const message of conversation.messages as AssistantStoredMessage[]) {
          if (message.role === "user") restored.push({ kind: "user", content: message.content });
          else if (message.role === "assistant") restored.push({ kind: "assistant", content: message.content });
        }
        setItems(restored);
        attachStream(existing);
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
    setError(undefined);
  }, []);

  return { items, busy, error, send, reset };
}
