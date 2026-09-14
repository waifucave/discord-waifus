import { useEffect, useRef, useState } from "react";
import { useApi } from "../../api/useApi";
import { api } from "../../api/client";
import type { AgentConfig, AssistantActionDetail } from "../../api/types";
import { useAssistantChat, type ChatItem } from "../../state/assistantChat";
import type { ViewId } from "../../nav";
import { InvitationCard } from "../remoteAccess/InvitationCard";
import { formatHelperTarget, formatUnixSeconds } from "../remoteAccess/presentation";

type SecretArgs = { purpose: "provider_key" | "bot_token"; providerId?: string; botId?: string };

function parseSecretArgs(raw: string | undefined): SecretArgs | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as SecretArgs;
    if (parsed.purpose !== "provider_key" && parsed.purpose !== "bot_token") return undefined;
    // a form without a target would PUT to /providers/undefined — refuse to render it
    if (parsed.purpose === "provider_key" && !parsed.providerId) return undefined;
    if (parsed.purpose === "bot_token" && !parsed.botId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** A secret form is live only while its request is the newest thing in the transcript —
 * replayed/answered requests (a [secure-form] receipt or any later user turn follows) are history. */
function secretFormIsLive(items: ChatItem[], index: number): boolean {
  for (let i = index + 1; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "user") return false; // receipt or a newer user message supersedes it
    if (item.kind === "assistant") continue; // Norma's "paste it into the form" reply is expected
  }
  return true;
}

export function secureActionIsLive(items: ChatItem[], index: number): boolean {
  return !items.slice(index + 1).some((item) => item.kind === "user");
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
    <div style={{ margin: "0 0 16px" }}>
      <div className="m-label" style={{ marginBottom: 6 }}>
        Secure input · {args.purpose === "provider_key" ? `${target} API key` : `${target} bot token`} · bypasses the chat
      </div>
      <div className="fgrid" style={{ gridTemplateColumns: "1fr 90px 32px", margin: "0 -20px", borderTop: "var(--line) solid var(--ink)", borderBottom: "var(--line) solid var(--ink)" }}>
        <div className="fcell" style={{ padding: "10px 12px" }}>
          <input
            className="input"
            type="password"
            autoFocus
            placeholder="paste the secret…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <button className="cell clickable btn" onClick={submit} disabled={saving || !value.trim()}>
          {saving ? "…" : "Save"}
        </button>
        <button className="cell clickable btn ghost" onClick={() => onDone("[secure-form] the user dismissed the form without saving a secret.")}>
          ✕
        </button>
      </div>
      {error && <div className="m-err" style={{ marginTop: 8 }}>{error}</div>}
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

export function AssistantActionCard({
  item,
  onDone
}: {
  item: Extract<ChatItem, { kind: "action" }>;
  onDone: (outcome: string) => void;
}) {
  const [detail, setDetail] = useState<AssistantActionDetail | undefined>();
  const [invitation, setInvitation] = useState<Awaited<ReturnType<typeof api.confirmAssistantAction>>["invitation"]>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    api.assistantAction(item.actionId, controller.signal)
      .then(setDetail)
      .catch((reason) => {
        if ((reason as DOMException)?.name !== "AbortError") setError((reason as Error).message);
      });
    return () => controller.abort();
  }, [item.actionId]);

  const cancel = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.cancelAssistantAction(item.actionId);
      onDone(`The ${item.category.replaceAll("_", " ")} request was cancelled without making a change.`);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await api.confirmAssistantAction(item.actionId);
      if (result.invitation) {
        setInvitation(result.invitation);
      } else {
        onDone(`${result.message}${result.resourceId ? ` Resource ${result.resourceId}.` : ""}`);
      }
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (invitation) {
    return (
      <div className="assistant-secure-action" data-assistant-action={item.actionId}>
        {notice && <div className="m-tool"><span className="chip pink">secure action</span>{notice}</div>}
        <InvitationCard
          invitation={invitation}
          onCancel={async () => {
            setError(undefined);
            try {
              await api.cancelRemoteAccessInvitation(invitation.invitationId);
              onDone(`Pairing invitation ${invitation.invitationId} was cancelled. Its token and code never entered the chat transcript.`);
            } catch (reason) {
              setError((reason as Error).message);
            }
          }}
          onMessage={(message, failed) => failed ? setError(message) : setNotice(message)}
        />
        {error && <div className="m-err">{error}</div>}
      </div>
    );
  }

  const pairing = detail?.secure?.kind === "pairing_request" ? detail.secure : undefined;
  const invitationRequest = item.category === "remote_pairing_invitation";
  return (
    <article className="cell pairing-request-card assistant-secure-action" data-assistant-action={item.actionId}>
      <div className="remote-section-head">
        <div>
          <span className="t-micro">Secure assistant action</span>
          <div className="t-title">{pairing?.claimedDisplayName ?? "Confirmation required"}</div>
        </div>
        <span className="chip butter">{detail ? "pending" : "loading"}</span>
      </div>
      <p className="t-small">{detail?.summary ?? item.summary}</p>
      {pairing && (
        <>
          <p className="t-small t-mute">
            Claimed device: {formatHelperTarget(pairing.claimedPlatform)} · expires {formatUnixSeconds(pairing.expiresAt)}
          </p>
          <div className="sas-phrase" aria-label="Safety phrase">{pairing.sasWords.join(" ")}</div>
          <div className="sas-fingerprint">
            <span className="field-label">Safety fingerprint</span>
            <code>{pairing.sasFingerprint}</code>
          </div>
        </>
      )}
      {!invitationRequest && (
        <label className="checkbox-chip pairing-confirmation">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          {pairing
            ? "I compared both the words and fingerprint on the requesting device"
            : "I reviewed this exact action and want to apply it"}
        </label>
      )}
      <div className="remote-actions">
        <button
          className="btn primary"
          disabled={busy || !detail || (!invitationRequest && !acknowledged)}
          onClick={confirm}
        >
          {busy ? "Working…" : invitationRequest ? "Create private invitation" : pairing ? "Approve device" : "Confirm action"}
        </button>
        <button className="btn" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
      {error && <div className="m-err">{error}</div>}
    </article>
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
  const [actionReceipts, setActionReceipts] = useState<Map<string, string>>(new Map());
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
        <button
          className="cell clickable hbtn"
          data-hue
          style={{ ["--hover-hue" as string]: "var(--sky)" }}
          onClick={() => {
            chat.reset();
            setHandledSecrets(new Set());
            setActionReceipts(new Map());
          }}
          title="New conversation"
        >
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
            if (item.content.startsWith("[secure-form]") || item.content.startsWith("[secure-action]")) {
              const marker = item.content.startsWith("[secure-form]") ? "[secure-form]" : "[secure-action]";
              return (
                <div key={index} className="m-tool">
                  <span className="chip pink">{marker === "[secure-form]" ? "secure form" : "secure action"}</span>
                  {item.content.replace(marker, "").trim()}
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
            if (secretArgs && !handledSecrets.has(index) && secretFormIsLive(chat.items, index)) {
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
          if (item.kind === "action") {
            const receipt = actionReceipts.get(item.actionId);
            if (receipt || !secureActionIsLive(chat.items, index)) {
              return (
                <div key={index} className="m-tool">
                  <span className="chip pink">secure action</span>
                  {receipt ?? item.summary}
                </div>
              );
            }
            return (
              <AssistantActionCard
                key={index}
                item={item}
                onDone={(outcome) => {
                  setActionReceipts((previous) => new Map(previous).set(item.actionId, outcome));
                }}
              />
            );
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
