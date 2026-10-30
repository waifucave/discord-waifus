import { useId, useMemo, useState } from "react";
import { Check, Copy, ExternalLink as ExternalLinkIcon, ShieldAlert } from "lucide-react";
import {
  DISCORD_INTENTS_DOC,
  DISCORD_OAUTH_DOC,
  DISCORD_PERMISSIONS_DOC,
  DISCORD_PORTAL_URL,
  buildInviteUrl,
  intentListFor,
  isLikelyApplicationId,
  permissionListFor,
  type BotKind
} from "../utils/discord";
import {
  changeSummary,
  checkApplicationId,
  checkToken,
  connectionLabel,
  connectionFor,
  effectiveApplicationId,
  setupBadge,
  summarizeTarget,
  type BotTarget
} from "../utils/discordBots";
import type { DiscordBotSetup } from "./useDiscordBotSetup";
import { Pill } from "./Pill";
import { Notice } from "./Notice";
import { ContextExternalLink } from "./ContextExternalLink";

/**
 * Interactive Discord developer-portal walkthrough: pick a bot, then paste each value into the
 * step that produces it. The Application ID (step 3) and bot token (step 4) are typed right
 * here; the intents (step 5) and the invite link (step 7) follow what is typed, and Save sits in a
 * sticky bar. All state lives in `useDiscordBotSetup`, so a host (Settings, onboarding) can also
 * react to a save.
 *
 * - `pickerStyle="chips"`: a compact "Which bot?" row. `"list"`: one row per bot with its app id,
 *   token and connection status (Settings).
 * - With a single bot (House-only mode) the picker is replaced by a one-line heading.
 * - `guildId` makes the invite target that server; `onOpenRooms` adds the Rooms button to step 8.
 */
export function DiscordBotGuide({
  setup,
  pickerStyle = "chips",
  guildId,
  onOpenRooms
}: {
  setup: DiscordBotSetup;
  pickerStyle?: "chips" | "list";
  guildId?: string;
  onOpenRooms?: () => void;
}) {
  const { selected } = setup;
  const kind: BotKind = selected.kind;
  const ids = useId();
  const appIdField = `${ids}-app-id`;
  const tokenField = `${ids}-token`;
  const intents = intentListFor(kind);
  const permissions = permissionListFor(kind);
  const typedAppId = effectiveApplicationId(selected, setup.draft);
  const appIdCheck = checkApplicationId(setup.draft.applicationId ?? "");
  const tokenCheck = checkToken(setup.draft.token);
  const summary = summarizeTarget(selected);
  const inviteUrl = useMemo(
    () => (isLikelyApplicationId(typedAppId) ? buildInviteUrl(typedAppId, kind, guildId) : undefined),
    [typedAppId, kind, guildId]
  );
  const portalIntents = intents.filter((intent) => intent.portalToggle);
  const autoIntents = intents.filter((intent) => !intent.portalToggle);
  const willChange = changeSummary(selected, setup.draft);
  const connection = connectionLabel(setup.status);
  const isWaifu = kind === "waifu";
  const nameForSteps = selected.label;

  if (setup.loading) return <p className="t-mute t-small" role="status">Loading bots…</p>;
  if (setup.error && !setup.bots.data) return <Notice tone="err">{setup.error.message}</Notice>;

  return (
    <div className="bot-guide">
      <BotPicker setup={setup} style={pickerStyle} />

      <div className="bot-guide-steps">
        <Step
          num={1}
          title="Create a Discord application"
          body={
            <>
              Open the{" "}
              <ContextExternalLink href={DISCORD_PORTAL_URL}>
                Discord Developer Portal <ExternalLinkIcon className="icon" style={iconSm} />
              </ContextExternalLink>{" "}
              and click <strong>New Application</strong>. Name it <code>{selected.suggestedName}</code>
              {isWaifu ? ", her display name (the app keeps the bot's username in line with her profile)" : ""}.
              <div className="field-hint" style={{ marginTop: 4 }}>
                The name can be anything you like. For a test copy of the bot, add a suffix such as{" "}
                <code>{selected.suggestedName} Test</code>.
              </div>
            </>
          }
        />

        <Step
          num={2}
          title={isWaifu ? "Name, avatar, banner and bio (optional)" : "Set name and avatar (optional)"}
          body={
            isWaifu ? (
              <>
                Nothing to do here: <strong>the app sets these for you from her profile</strong>. Once her bot
                connects, it gets her username (or her display name), the avatar and banner you upload in
                Cast → her page → Discord profile, her bio as the bot's description, and any per-server
                nicknames. Changes there are applied again automatically.
                <div className="field-hint" style={{ marginTop: 4 }}>
                  Discord allows only about two username changes an hour; the app waits and retries on its
                  own. You can still set them in the Developer Portal, but the app replaces them with her
                  profile the next time it syncs.
                </div>
              </>
            ) : (
              <>
                On the <strong>General Information</strong> page you can set a <strong>NAME</strong>,{" "}
                <strong>APP ICON</strong> (the bot's avatar) and <strong>DESCRIPTION</strong>. The House bot
                never posts, so this is only how it looks in the member list.
              </>
            )
          }
        />

        <Step
          num={3}
          title="Copy the Application ID"
          body={
            <>
              Still on <strong>General Information</strong>, click <strong>Copy</strong> under{" "}
              <code>APPLICATION ID</code> and paste it here. It's a 17–20 digit number; the invite link
              below is built from it.
              <div className="fgrid cols-1 bot-field">
                <div className="fcell">
                  <label className="field-label" htmlFor={appIdField}>Application ID{selected.bot?.applicationId ? " · saved" : ""}</label>
                  <input
                    id={appIdField}
                    className="input mono"
                    inputMode="numeric"
                    autoComplete="off"
                    spellCheck={false}
                    value={setup.draft.applicationId ?? selected.bot?.applicationId ?? ""}
                    onChange={(event) => setup.setApplicationId(event.target.value)}
                    aria-invalid={appIdCheck.state === "invalid"}
                    aria-describedby={`${appIdField}-msg`}
                    placeholder="e.g. 123456789012345678"
                  />
                  <span id={`${appIdField}-msg`} className={appIdCheck.state === "invalid" ? "field-error" : "field-hint"} aria-live="polite">
                    {appIdCheck.state === "invalid"
                      ? appIdCheck.message
                      : appIdCheck.state === "valid"
                        ? "Looks like a valid Application ID."
                        : "Not a secret: it only identifies the application."}
                  </span>
                </div>
              </div>
            </>
          }
        />

        <Step
          num={4}
          title="Reset and copy the bot token"
          body={
            <>
              Open the <strong>Bot</strong> tab → click <strong>Reset Token</strong> →{" "}
              <strong>Yes, do it!</strong> → <strong>Copy</strong>, then paste it here.
              <div className="fgrid cols-1 bot-field">
                <div className="fcell">
                  <label className="field-label" htmlFor={tokenField}>Bot token · write-only</label>
                  <input
                    id={tokenField}
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    data-1p-ignore
                    data-lpignore="true"
                    value={setup.draft.token}
                    onChange={(event) => setup.setToken(event.target.value)}
                    aria-invalid={tokenCheck.state === "invalid"}
                    aria-describedby={`${tokenField}-msg`}
                    placeholder={summary.tokenConfigured ? "Leave empty to keep the stored token" : "Paste the token"}
                  />
                  <span
                    id={`${tokenField}-msg`}
                    className={tokenCheck.state === "invalid" ? "field-error" : "field-hint"}
                    aria-live="polite"
                  >
                    {tokenCheck.message ?? (summary.tokenConfigured
                      ? `A token is already stored${summary.tokenHint ? ` (${summary.tokenHint})` : ""}. It is never shown again; paste a new one only to replace it.`
                      : "No token stored yet for this bot.")}
                  </span>
                </div>
              </div>
              <div style={{ marginTop: 6 }}>
                <Notice tone="warn">
                  <ShieldAlert className="icon" style={iconSm} /> The token is shown <strong>once</strong>.
                  Treat it like a password — anyone with it can act as the bot. Our backend redacts it
                  from logs and never returns it via the API.
                </Notice>
              </div>
            </>
          }
        />

        <Step
          num={5}
          title="Enable Privileged Gateway Intents"
          body={
            <>
              On the <strong>Bot</strong> tab, scroll to <strong>Privileged Gateway Intents</strong>.
              {portalIntents.length === 0 ? (
                <p style={{ margin: "4px 0" }}>
                  {nameForSteps} needs <strong>no privileged intents</strong>: leave all three off. The
                  House bot is the one that reads the rooms; she only posts, reacts and attaches files.
                </p>
              ) : (
                <ul style={ul}>
                  {portalIntents.map((intent) => (
                    <li key={intent.name}>
                      <code>{intent.name}</code> {intent.privileged && <Pill tone="warn">privileged</Pill>}{" "}
                      {intent.required ? <Pill tone="ok">turn on</Pill> : <Pill tone="neutral">optional</Pill>}
                      {intent.note && <div className="field-hint">{intent.note}</div>}
                    </li>
                  ))}
                </ul>
              )}
              Leave <code>PRESENCE INTENT</code> off — we don't use it.
              <details style={{ marginTop: 6 }}>
                <summary className="t-small">Requested automatically (no toggle)</summary>
                <ul style={ul}>
                  {autoIntents.map((intent) => (
                    <li key={intent.name}>
                      <code>{intent.name}</code>
                      {intent.note && <span className="field-hint"> {intent.note}</span>}
                    </li>
                  ))}
                </ul>
              </details>
              <ContextExternalLink href={DISCORD_INTENTS_DOC}>
                Discord intent docs <ExternalLinkIcon className="icon" style={iconSm} />
              </ContextExternalLink>
            </>
          }
        />

        <Step
          num={6}
          title="Set bot-tab toggles"
          body={
            <>
              Still on the <strong>Bot</strong> tab:
              <ul style={ul}>
                <li>
                  <strong>PUBLIC BOT</strong> — turn <em>off</em> if you don't want anyone else inviting
                  your bot.
                </li>
                <li>
                  <strong>REQUIRES OAUTH2 CODE GRANT</strong> — leave <em>off</em>.
                </li>
              </ul>
            </>
          }
        />

        <Step
          num={7}
          title="Generate an invite link and add the bot to a server"
          body={
            <>
              Use the link below (it follows the Application ID you typed, with the right scopes and
              permissions) or build one yourself via <strong>OAuth2 → URL Generator</strong>:
              <ul style={ul}>
                <li>
                  <strong>SCOPES:</strong> <code>bot</code>
                  {kind === "house" && (
                    <>
                      {" "}+ <code>applications.commands</code>
                    </>
                  )}
                </li>
                <li>
                  <strong>BOT PERMISSIONS:</strong>
                  <ul style={ul}>
                    {permissions.map((permission) => (
                      <li key={permission}>{permission}</li>
                    ))}
                  </ul>
                </li>
              </ul>
              Open the generated URL, pick the server, click <strong>Authorize</strong>. You need{" "}
              <em>Manage Server</em> on the target guild.
              <InviteBlock url={inviteUrl} applicationId={typedAppId} guildId={guildId} kind={kind} />
              <div style={{ marginTop: 6 }}>
                <ContextExternalLink href={DISCORD_OAUTH_DOC}>
                  OAuth2 bot-authorization docs <ExternalLinkIcon className="icon" style={iconSm} />
                </ContextExternalLink>{" "}
                ·{" "}
                <ContextExternalLink href={DISCORD_PERMISSIONS_DOC}>
                  Permission reference <ExternalLinkIcon className="icon" style={iconSm} />
                </ContextExternalLink>
              </div>
            </>
          }
        />

        <Step
          num={8}
          title="Verify in Discord"
          body={
            <>
              {isWaifu ? (
                <>
                  Give her role access to the channel(s) she should talk in (right-click the channel →{" "}
                  <strong>Edit Channel → Permissions</strong>, or via a role): <em>View Channel, Send
                  Messages, Send Messages in Threads, Add Reactions, Attach Files</em>. The House bot
                  must be in the same server and see those channels too, since it reads them for her.
                  Then enable her for each channel on the <strong>Rooms</strong> page.
                </>
              ) : (
                <>
                  The House bot reads the rooms for every waifu, and runs <code>/wake</code> and{" "}
                  <code>/print</code>. Its invite asks for <em>Administrator</em>, so it sees every
                  channel; if you untick that, give its role <em>View Channel</em> and{" "}
                  <em>Read Message History</em> in each channel your cast should be in (right-click the
                  channel → <strong>Edit Channel → Permissions</strong>, or via a role). Then choose
                  which waifus talk in each channel on the <strong>Rooms</strong> page.
                </>
              )}
              <div className="bot-status" aria-live="polite">
                <span className="field-label">Status</span>
                <Pill tone={connection.tone}>{connection.text}</Pill>
                {setup.watching && <span className="field-hint">checking…</span>}
                {setup.status?.state === "error" && setup.status.error && (
                  <span className="field-hint">{setup.status.error}</span>
                )}
              </div>
              {onOpenRooms && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn" onClick={onOpenRooms}>
                    Open Rooms
                  </button>
                </div>
              )}
            </>
          }
        />
      </div>

      <div className="bot-save-bar">
        <div className="bot-save-text">
          {setup.result ? (
            <Notice tone={setup.result.ok ? "ok" : "err"}>{setup.result.text}</Notice>
          ) : willChange.length > 0 ? (
            <span className="t-small">Unsaved for {nameForSteps}: {willChange.join(", ")}.</span>
          ) : (
            <span className="t-small t-mute">Type the Application ID and token above, then save.</span>
          )}
        </div>
        <button type="button" className="btn primary" onClick={() => void setup.save()} disabled={!setup.saveable || setup.saving}>
          {setup.saving ? "Saving…" : `Save ${isWaifu ? "her bot" : "House bot"}`}
        </button>
      </div>
    </div>
  );
}

/** "Which bot?": a radio group, so the arrow keys move between bots and Tab leaves the group. */
function BotPicker({ setup, style }: { setup: DiscordBotSetup; style: "chips" | "list" }) {
  const group = useId();
  if (setup.targets.length <= 1) {
    const only = setup.targets[0]!;
    return (
      <div className="bot-picker-single">
        <span className="field-label">Setting up</span> <strong>{only.label}</strong>{" "}
        <span className="field-hint">runs /wake, /print and reads the rooms for the whole cast</span>
      </div>
    );
  }
  return (
    <fieldset className={"bot-picker " + style}>
      <legend className="field-label">Which bot?</legend>
      {setup.targets.map((target) => (
        <PickerOption key={target.key} group={group} target={target} setup={setup} style={style} />
      ))}
    </fieldset>
  );
}

function PickerOption({ group, target, setup, style }: { group: string; target: BotTarget; setup: DiscordBotSetup; style: "chips" | "list" }) {
  const checked = setup.selected.key === target.key;
  const badge = setupBadge(target);
  const connection = connectionLabel(connectionFor(target, setup.runtime.data));
  const summary = summarizeTarget(target);
  return (
    <label className={"bot-pick" + (checked ? " on" : "")}>
      <input type="radio" name={group} value={target.key} checked={checked} onChange={() => setup.select(target.key)} />
      <span className="bot-pick-name">{target.label}</span>
      {style === "list" ? (
        <>
          <span className="bot-pick-detail t-micro">{summary.text}</span>
          <Pill tone={connection.tone}>{connection.text}</Pill>
        </>
      ) : (
        <Pill tone={badge.tone}>{badge.text}</Pill>
      )}
    </label>
  );
}

function Step({ num, title, body }: { num: number; title: string; body: React.ReactNode }) {
  return (
    <div className="step">
      <span className="num">{num}</span>
      <div className="body">
        <div className="step-title">{title}</div>
        <div className="step-desc">
          {body}
        </div>
      </div>
    </div>
  );
}

function InviteBlock({
  url,
  applicationId,
  guildId,
  kind
}: {
  url: string | undefined;
  applicationId: string;
  guildId: string | undefined;
  kind: BotKind;
}) {
  const [copied, setCopied] = useState(false);
  if (!applicationId) {
    return (
      <Notice tone="info">
        Paste the Application ID in step 3 and an invite link will appear here.
      </Notice>
    );
  }
  if (!url) {
    return (
      <Notice tone="warn">
        That Application ID doesn't look valid yet — Discord IDs are 17–20 digits.
      </Notice>
    );
  }
  return (
    <div className="bot-invite">
      <input className="input code" readOnly value={url} aria-label="Invite link" onFocus={(event) => event.currentTarget.select()} />
      <div className="bot-invite-actions">
        <button
          type="button"
          className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // ignore; the user can copy the selected text by hand
            }
          }}
        >
          {copied ? <Check className="icon" /> : <Copy className="icon" />}
          {copied ? "Copied" : "Copy URL"}
        </button>
        <ContextExternalLink className="btn primary" href={url}>
          Open invite <ExternalLinkIcon className="icon" />
        </ContextExternalLink>
        {guildId && (
          <Pill tone="info">
            targets guild <code>{guildId}</code>
          </Pill>
        )}
        {kind === "house" && <Pill tone="info">includes slash commands</Pill>}
      </div>
    </div>
  );
}

const iconSm: React.CSSProperties = { width: 12, height: 12, verticalAlign: "-2px" };
const ul: React.CSSProperties = { margin: "4px 0 4px 18px", padding: 0 };
