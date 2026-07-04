import { useEffect, useRef, useState } from "react";
import { useApi } from "../../api/useApi";
import { api } from "../../api/client";
import type { AgentConfig } from "../../api/types";
import { useAssistantChat, type ChatItem } from "../../state/assistantChat";
import type { ViewId } from "../../nav";

function ToolRow({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="m-tool">
      <button className="clickable" style={{ background: "transparent", padding: 0, font: "inherit", color: "inherit" }} onClick={() => setExpanded((v) => !v)}>
        <span className="chip pink">{item.name}</span>
        {item.result === undefined ? "running…" : "done"}
      </button>
      {expanded && item.result !== undefined && <span className="result">{item.result}</span>}
    </div>
  );
}

export function AssistantLauncher({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  if (open) return null;
  return (
    <button
      className="clickable"
      style={{
        position: "fixed",
        right: 0,
        bottom: 0,
        width: 52,
        height: 52,
        background: "var(--ink)",
        color: "#fff",
        border: "none",
        fontSize: 18,
        zIndex: 29
      }}
      onClick={onToggle}
      aria-label="Assistant"
    >
      ▣
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
  const assistantConfig = useApi<AgentConfig | undefined>(async (s) => (open ? api.assistantConfig(s) : undefined), [open]);
  const orchestratorConfig = useApi<AgentConfig | undefined>(async (s) => (open ? api.orchestratorConfig(s) : undefined), [open]);

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
  const model = assistantConfig.data?.modelId ?? orchestratorConfig.data?.modelId;

  return (
    <aside className="norma">
      <div className="nhead">
        <div className="ttl">
          <span className="t-title">Norma</span>
          <span className="t-micro">assistant{model ? ` · ${model}` : ""}</span>
        </div>
        <button className="cell clickable hbtn" data-hue style={{ ["--hover-hue" as string]: "var(--sky)" }} onClick={chat.reset} title="New conversation">
          +
        </button>
        <button className="cell clickable hbtn" data-hue style={{ ["--hover-hue" as string]: "var(--peach)" }} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="cell nbody" ref={scrollRef}>
        {chat.items.length === 0 && !chat.error && (
          <div className="hint">
            Ask about your setup, or tell me to change it — "create a character named Momo", "which channels is Riko
            in?", "set the orchestrator temperature to 0.3". Changes apply immediately.
          </div>
        )}
        {chat.items.map((item, index) => {
          if (item.kind === "user")
            return (
              <div key={index} className="m-user">
                <div className="m-label">You</div>
                {item.content}
              </div>
            );
          if (item.kind === "assistant") return <div key={index} className="m-asst">{item.content}</div>;
          if (item.kind === "tool") return <ToolRow key={index} item={item} />;
          return <div key={index} className="m-err">{item.message}</div>;
        })}
        {chat.busy && <div className="m-busy">working…</div>}
        {chat.error && (
          <div className="m-err">
            {chat.error}
            {modelMissing && (
              <div>
                <button className="btn sm" style={{ marginTop: 8 }} onClick={() => onNavigate("direction", "assistant")}>
                  Configure the assistant model
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="ninput">
        <textarea
          placeholder="Message Norma…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="send" onClick={submit} disabled={chat.busy || !draft.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
