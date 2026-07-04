import { useEffect, useRef, useState } from "react";
import { MessageSquare, Plus, X } from "lucide-react";
import { useAssistantChat, type ChatItem } from "../../state/assistantChat";
import type { ViewId } from "../../nav";

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-tool">
      <button className="chat-tool-line" onClick={() => setExpanded((v) => !v)}>
        <span className="chat-tool-mark">{item.result === undefined ? "…" : "▸"}</span>
        <span className="chat-tool-name">{item.name}</span>
        <span className="chat-tool-state">{item.result === undefined ? "running" : "done"}</span>
      </button>
      {expanded && item.result !== undefined && <pre className="chat-tool-result">{item.result}</pre>}
    </div>
  );
}

export function AssistantLauncher({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className={"assistant-launcher" + (open ? " open" : "")} onClick={onToggle} aria-label="Assistant">
      {open ? <X className="icon" /> : <MessageSquare className="icon" />}
    </button>
  );
}

export function AssistantPanel({
  open,
  onClose,
  onNavigate
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId, tab?: string) => void;
}) {
  const chat = useAssistantChat(open);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [chat.items, chat.busy, open]);

  if (!open) return null;

  const submit = () => {
    const content = draft.trim();
    if (!content || chat.busy) return;
    setDraft("");
    void chat.send(content);
  };

  const modelMissing = chat.error && /model|provider/i.test(chat.error);

  return (
    <aside className="assistant-panel">
      <div className="assistant-panel-header">
        <span className="assistant-panel-title">Assistant</span>
        <button className="btn ghost sm" onClick={chat.reset} title="New conversation">
          <Plus className="icon" />
        </button>
        <button className="btn ghost sm" onClick={onClose} aria-label="Close">
          <X className="icon" />
        </button>
      </div>
      <div className="assistant-panel-body" ref={scrollRef}>
        {chat.items.length === 0 && !chat.error && (
          <div className="chat-hint">
            Ask about your setup, or tell me to change it — “create a waifu named Momo”, “which channels is Riko
            in?”, “set the orchestrator temperature to 0.3”. Changes apply immediately.
          </div>
        )}
        {chat.items.map((item, index) => {
          if (item.kind === "user") return <div key={index} className="chat-msg user">{item.content}</div>;
          if (item.kind === "assistant") return <div key={index} className="chat-msg assistant">{item.content}</div>;
          if (item.kind === "tool") return <ToolRow key={index} item={item} />;
          return <div key={index} className="chat-msg error">{item.message}</div>;
        })}
        {chat.busy && <div className="chat-busy">working…</div>}
        {chat.error && (
          <div className="chat-msg error">
            {chat.error}
            {modelMissing && (
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => onNavigate("direction", "assistant")}>
                Configure the assistant model
              </button>
            )}
          </div>
        )}
      </div>
      <div className="assistant-panel-input">
        <textarea
          className="textarea"
          rows={2}
          placeholder="Message the assistant…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="btn primary" onClick={submit} disabled={chat.busy || !draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
