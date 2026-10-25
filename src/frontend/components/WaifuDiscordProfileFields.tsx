import { useRef, useState } from "react";
import { api } from "../api/client";
import { useApi, useInterval } from "../api/useApi";
import type { DiscordProfileStatus, ServersResponse, WaifuConfig } from "../api/types";
import { Notice } from "./Notice";
import { imageLabel, profileStatusLine } from "../utils/discordProfile";
import { DISCORD_BIO_MAX, DISCORD_BIO_VISIBLE, DISCORD_USERNAME_MAX } from "../../shared/constants/discordProfile";

type Draft = Partial<WaifuConfig>;
type Patch = (patch: Draft) => void;

const IMAGE_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/**
 * Her own bot's Discord profile (Living cast §17): username, bio, per-server nicknames, avatar and
 * banner, with the sync status. The text fields are part of her config (saved with Save); images
 * upload at once. The app sets all of them on her bot.
 */
export function WaifuDiscordProfileFields({
  waifuId,
  revision,
  draft,
  onChange
}: {
  waifuId: string;
  revision: number | undefined;
  draft: Draft;
  onChange: Patch;
}) {
  const status = useApi<DiscordProfileStatus>((s) => api.discordProfile(waifuId, s), [waifuId, revision]);
  const servers = useApi<ServersResponse>((s) => api.servers(s), []);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | undefined>(undefined);
  // A sync started by a save runs in the background: look again while something is in flight.
  useInterval(() => status.reload(), 5_000, status.data?.state === "pending");
  useInterval(() => status.reload(), 60_000, status.data?.state === "rate_limited");

  const nicknames = Object.entries(draft.nicknames ?? {});
  const knownServers = servers.data?.servers ?? [];
  const setNicknames = (entries: Array<[string, string]>) =>
    onChange({ nicknames: entries.length ? Object.fromEntries(entries) : undefined });
  const fallbackName = (draft.displayName || draft.name || "").trim();
  const bioLength = (draft.bio ?? "").length;

  const upload = async (kind: "pfp" | "banner", file: File | undefined) => {
    if (!file) return;
    setBusy(kind);
    setMessage(undefined);
    try {
      await api.uploadWaifuImage(waifuId, kind, file);
      setMessage({ tone: "ok", text: kind === "pfp" ? "Avatar uploaded." : "Banner uploaded." });
      status.reload();
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const syncNow = async () => {
    setBusy("sync");
    setMessage(undefined);
    try {
      status.setData(await api.syncDiscordProfile(waifuId));
    } catch (err) {
      setMessage({ tone: "err", text: (err as Error).message });
    } finally {
      setBusy(undefined);
    }
  };

  const line = status.data ? profileStatusLine(status.data, Date.now()) : undefined;

  return (
    <>
      <div className="cell" style={{ padding: "14px 16px", flex: "none", display: "flex", alignItems: "center", gap: 12 }}>
        <span className="field-label" style={{ margin: 0 }}>Discord profile</span>
        <span className="t-small t-mute" style={{ flex: 1 }}>The app sets these on her own bot when it connects and after every change.</span>
        <button className="btn sm" onClick={syncNow} disabled={busy !== undefined || !status.data || status.data.state === "no_bot" || status.data.state === "shared_bot"}>
          {busy === "sync" ? "Syncing…" : "Sync now"}
        </button>
      </div>
      {(line || message || status.error) && (
        <div className="cell" style={{ padding: 16, flex: "none" }}>
          {line && <Notice tone={line.tone}>{line.text}</Notice>}
          {status.data?.warnings.map((warning) => (
            <Notice key={`${warning.code}:${warning.guildId ?? ""}`} tone="warn">
              {warning.guildId ? `${serverName(knownServers, warning.guildId)}: ` : ""}
              {warning.message}
            </Notice>
          ))}
          {status.error && <Notice tone="warn">The profile status could not be loaded: {status.error.message}</Notice>}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </div>
      )}
      <div className="fgrid" style={{ flex: "none", gridTemplateColumns: "1fr 1fr" }}>
        <div className="fcell">
          <label className="field-label" htmlFor="waifu-discord-username">Discord username</label>
          <input
            id="waifu-discord-username"
            className="input"
            maxLength={DISCORD_USERNAME_MAX}
            value={draft.username ?? ""}
            placeholder={fallbackName || "her display name"}
            onChange={(e) => onChange({ username: e.target.value === "" ? undefined : e.target.value })}
          />
          <span className="field-hint">
            Her bot's account name. Empty = her display name. Discord allows about two changes an hour. Her name above stays what she is called in chat.
            {status.data?.current ? ` Now: ${status.data.current.username}.` : ""}
          </span>
        </div>
        <div className="fcell">
          <label className="field-label">Avatar and banner</label>
          <ImagePicker
            label="Avatar"
            detail={imageLabel(status.data?.images.avatar ?? null)}
            busy={busy === "pfp"}
            disabled={busy !== undefined}
            onPick={(file) => upload("pfp", file)}
          />
          <ImagePicker
            label="Banner"
            detail={imageLabel(status.data?.images.banner ?? null)}
            busy={busy === "banner"}
            disabled={busy !== undefined}
            onPick={(file) => upload("banner", file)}
          />
          <span className="field-hint">PNG, JPEG, WebP or GIF, at most 8 MB. Uploaded right away and set on her bot.</span>
        </div>
      </div>
      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label" htmlFor="waifu-discord-bio">Bio (About Me)</label>
        <textarea
          id="waifu-discord-bio"
          className="textarea"
          rows={3}
          value={draft.bio ?? ""}
          onChange={(e) => onChange({ bio: e.target.value === "" ? undefined : e.target.value })}
          placeholder="Shown on her bot's profile (optional)…"
          aria-invalid={bioLength > DISCORD_BIO_MAX}
        />
        <span className="field-hint" style={bioLength > DISCORD_BIO_MAX ? { color: "var(--danger)" } : undefined}>
          {bioLength} / {DISCORD_BIO_MAX}
          {bioLength > DISCORD_BIO_MAX
            ? " — too long, shorten it to save"
            : bioLength > DISCORD_BIO_VISIBLE
              ? ` — some Discord views show only the first ${DISCORD_BIO_VISIBLE} characters`
              : " — empty leaves her bot's description as it is"}
        </span>
      </div>
      <div className="cell fcell" style={{ flex: "none" }}>
        <label className="field-label">Server nicknames</label>
        {nicknames.length === 0 && <span className="field-hint">None. She shows her username everywhere. A nickname needs the Change Nickname permission in that server.</span>}
        {nicknames.map(([guildId, nick], index) => (
          <div key={index} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 8, marginTop: 6 }}>
            <select
              className="select"
              value={guildId}
              onChange={(e) => setNicknames(nicknames.map((entry, i) => (i === index ? [e.target.value, entry[1]] : entry)))}
            >
              {!knownServers.some((server) => server.guildId === guildId) && <option value={guildId}>{guildId || "— pick a server —"}</option>}
              {knownServers.map((server) => (
                <option key={server.guildId} value={server.guildId} disabled={server.guildId !== guildId && nicknames.some(([id]) => id === server.guildId)}>
                  {server.name ?? server.guildId}
                </option>
              ))}
            </select>
            <input
              className="input"
              maxLength={32}
              placeholder="nickname"
              value={nick}
              onChange={(e) => setNicknames(nicknames.map((entry, i) => (i === index ? [entry[0], e.target.value] : entry)))}
            />
            <button className="btn ghost sm" onClick={() => setNicknames(nicknames.filter((_, i) => i !== index))}>remove</button>
          </div>
        ))}
        <div style={{ marginTop: 8 }}>
          <button
            className="btn sm"
            disabled={!knownServers.some((server) => !nicknames.some(([id]) => id === server.guildId))}
            onClick={() => {
              const next = knownServers.find((server) => !nicknames.some(([id]) => id === server.guildId));
              if (next) setNicknames([...nicknames, [next.guildId, draft.displayName || draft.name || ""]]);
            }}
          >
            + server nickname
          </button>
        </div>
      </div>
    </>
  );
}

function serverName(servers: ServersResponse["servers"], guildId: string): string {
  return servers.find((server) => server.guildId === guildId)?.name ?? guildId;
}

function ImagePicker({
  label,
  detail,
  busy,
  disabled,
  onPick
}: {
  label: string;
  detail: string;
  busy: boolean;
  disabled: boolean;
  onPick: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
      <span className="t-small" style={{ width: 60 }}>{label}</span>
      <span className="t-small t-mute" style={{ flex: 1 }}>{detail}</span>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES}
        style={{ display: "none" }}
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button className="btn sm" disabled={disabled} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : "Choose…"}
      </button>
    </div>
  );
}
