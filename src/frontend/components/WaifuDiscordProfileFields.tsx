import { useRef, useState, type ReactNode } from "react";
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
  onChange,
  botField
}: {
  waifuId: string;
  revision: number | undefined;
  draft: Draft;
  onChange: Patch;
  /** Her bot picker: the first cell of the section. */
  botField: ReactNode;
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

  const syncDisabled = busy !== undefined || !status.data || status.data.state === "no_bot" || status.data.state === "shared_bot";

  return (
    <>
      <div className="fgrid cols-2">
        {botField}
        <div className="fcell">
          <label className="field-label" htmlFor="waifu-discord-username">Discord username</label>
          <input
            id="waifu-discord-username"
            className="input"
            maxLength={DISCORD_USERNAME_MAX}
            value={draft.username ?? ""}
            placeholder="unchanged"
            onChange={(e) => onChange({ username: e.target.value === "" ? undefined : e.target.value })}
          />
          <span className="field-hint">
            Her bot's account name. Empty = leave her bot's current name. Discord allows about two changes an hour. Her name above stays what she is called in chat.
            {status.data?.current ? ` Now: ${status.data.current.username}.` : ""}
          </span>
        </div>
      </div>
      <div className="fgrid cols-2">
        <div className="fcell">
          <span className="field-label">Avatar and banner</span>
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
        <div className="fcell sync-cell">
          <span className="field-label">Profile sync</span>
          <div className="t-small t-mute">The app sets these on her own bot when it connects and after every change.</div>
          {line && <Notice tone={line.tone}>{line.text}</Notice>}
          {status.data?.warnings.map((warning) => (
            <Notice key={`${warning.code}:${warning.guildId ?? ""}`} tone="warn">
              {warning.guildId ? `${serverName(knownServers, warning.guildId)}: ` : ""}
              {warning.message}
            </Notice>
          ))}
          {status.error && <Notice tone="warn">The profile status could not be loaded: {status.error.message}</Notice>}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
          <div>
            <button type="button" className="btn sm" onClick={syncNow} disabled={syncDisabled}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </button>
          </div>
        </div>
      </div>
      <div className="cell fcell">
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
        <span className={"field-hint" + (bioLength > DISCORD_BIO_MAX ? " t-error" : "")}>
          {bioLength} / {DISCORD_BIO_MAX}
          {bioLength > DISCORD_BIO_MAX
            ? " — too long, shorten it to save"
            : bioLength > DISCORD_BIO_VISIBLE
              ? ` — some Discord views show only the first ${DISCORD_BIO_VISIBLE} characters`
              : " — empty leaves her bot's description as it is"}
        </span>
      </div>
      <div className="cell fcell">
        <span className="field-label">Server nicknames</span>
        {nicknames.length === 0 && <span className="field-hint">None. She shows her username everywhere. A nickname needs the Change Nickname permission in that server.</span>}
        <div className="list-rows">
          {nicknames.map(([guildId, nick], index) => (
            <div key={index} className="nick-row">
              <select
                className="select"
                aria-label={`Nickname ${index + 1} server`}
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
                aria-label={`Nickname ${index + 1}`}
                placeholder="nickname"
                value={nick}
                onChange={(e) => setNicknames(nicknames.map((entry, i) => (i === index ? [entry[0], e.target.value] : entry)))}
              />
              <button type="button" className="btn quiet sm" onClick={() => setNicknames(nicknames.filter((_, i) => i !== index))}>
                Remove
              </button>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="btn sm"
            disabled={!knownServers.some((server) => !nicknames.some(([id]) => id === server.guildId))}
            onClick={() => {
              const next = knownServers.find((server) => !nicknames.some(([id]) => id === server.guildId));
              if (next) setNicknames([...nicknames, [next.guildId, draft.displayName || draft.name || ""]]);
            }}
          >
            Add server nickname
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
    <div className="image-pick">
      <span className="t-small image-name">{label}</span>
      <span className="t-small image-detail">{detail}</span>
      <input
        ref={input}
        type="file"
        accept={IMAGE_TYPES}
        aria-label={`${label} file`}
        onChange={(e) => {
          onPick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <button type="button" className="btn sm" disabled={disabled} onClick={() => input.current?.click()}>
        {busy ? "Uploading…" : `Upload ${label.toLowerCase()}…`}
      </button>
    </div>
  );
}
