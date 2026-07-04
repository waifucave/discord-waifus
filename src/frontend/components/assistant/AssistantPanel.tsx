import { useEffect, useRef, useState } from "react";
import { useApi } from "../../api/useApi";
import { api } from "../../api/client";
import type { AgentConfig } from "../../api/types";
import { useAssistantChat, type ChatItem } from "../../state/assistantChat";
import type { ViewId } from "../../nav";

type SecretArgs = { purpose: "provider_key" | "bot_token"; providerId?: string; botId?: string };

function parseSecretArgs(raw: string | undefined): SecretArgs | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as SecretArgs;
    if (parsed.purpose !== "provider_key" && parsed.purpose !== "bot_token") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Secure secret entry: the value goes browser → storage endpoint directly.
 * It never enters the conversation, so Norma's model never sees it.
 */
function SecretForm({ args, onDone }: { args: SecretArgs; onDone: (outcome: string) => void }) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const target = args.purpose === "provider_key" ? args.providerId : args.botId;

  const submit = async () => {
    if (!value.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      if (args.purpose === "provider_key") {
        await api.putProviderCredentials(String(args.providerId), { apiKey: value.trim() });
      } else {
        const bots = await api.discordBots();
        const isOrchestrator = !args.botId || args.botId === "orchestrator";
        const entry = isOrchestrator ? bots.orchestrator : bots.waifus.find((bot) => bot.id === args.botId);
        const patched = {
          id: entry?.id ?? (isOrchestrator ? "orchestrator" : String(args.botId)),
          displayName: entry?.displayName ?? String(args.botId ?? "orchestrator"),
          enabled: true,
          ...(entry ?? {}),
          token: value.trim()
        };
        await api.putDiscordBots(
          isOrchestrator
            ? { ...bots, orchestrator: patched }
            : { ...bots, waifus: [...bots.waifus.filter((bot) => bot.id !== patched.id), patched] }
        );
        await api.reload();
      }
      setValue("");
      onDone(`[secure-form] the ${args.purpose === "provider_key" ? `API key for ${target}` : `bot token for ${target}`} was saved — it never entered this chat. Continue.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ border: "1px solid var(--ink)", padding: 14, margin: "0 0 16px" }}>
      <div className="m-label" style={{ marginBottom: 8 }}>
        Secure input · {args.purpose === "provider_key" ? `${target} API key` : `${target} bot token`} · bypasses the chat
      </div>
      <input
        className="input"
        type="password"
        autoFocus
        placeholder="paste the secret…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {error && <div className="m-err" style={{ marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button className="btn sm primary" onClick={submit} disabled={saving || !value.trim()}>
          {saving ? "Saving…" : "Save secret"}
        </button>
        <button className="btn sm ghost" onClick={() => onDone("[secure-form] the user dismissed the form without saving a secret.")}>
          Cancel
        </button>
      </div>
    </div>
  );
}

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
  const [handledSecrets, setHandledSecrets] = useState<Set<number>>(new Set());
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
          if (item.kind === "user") {
            if (item.content.startsWith("[secure-form]")) {
              return (
                <div key={index} className="m-tool">
                  <span className="chip pink">secure form</span>
                  {item.content.replace("[secure-form]", "").trim()}
                </div>
              );
            }
            return (
              <div key={index} className="m-user">
                <div className="m-label">You</div>
                {item.content}
              </div>
            );
          }
          if (item.kind === "assistant") return <div key={index} className="m-asst">{item.content}</div>;
          if (item.kind === "tool") {
            const secretArgs = item.name === "request_secret" ? parseSecretArgs(item.args) : undefined;
            if (secretArgs && !handledSecrets.has(index)) {
              return (
                <div key={index}>
                  <ToolRow item={item} />
                  <SecretForm
                    args={secretArgs}
                    onDone={(outcome) => {
                      setHandledSecrets((prev) => new Set(prev).add(index));
                      void chat.send(outcome);
                    }}
                  />
                </div>
              );
            }
            return <ToolRow key={index} item={item} />;
          }
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
