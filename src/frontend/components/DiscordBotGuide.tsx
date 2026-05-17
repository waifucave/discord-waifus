import { useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Info,
  ShieldAlert
} from "lucide-react";
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
import { Pill } from "./Pill";
import { Notice } from "./Notice";

/**
 * Step-by-step Discord developer-portal walkthrough.
 *
 * Used in: Setup view, Orchestrator view, Waifu editor
 * (waifu bot section), and Servers view (invite-into-guild helper).
 *
 * `applicationId` and `guildId` are optional. When provided, the invite block
 * builds a ready-to-click URL targeting that exact guild.
 */
export function DiscordBotGuide({
  kind,
  applicationId,
  guildId,
  collapsedByDefault = true,
  botDisplayName
}: {
  kind: BotKind;
  applicationId?: string;
  guildId?: string;
  collapsedByDefault?: boolean;
  botDisplayName?: string;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const intents = intentListFor(kind);
  const permissions = permissionListFor(kind);
  const inviteUrl = useMemo(() => {
    if (!applicationId || !isLikelyApplicationId(applicationId)) return undefined;
    return buildInviteUrl(applicationId, kind, guildId);
  }, [applicationId, kind, guildId]);
  const niceKind = kind === "orchestrator" ? "orchestrator" : "waifu";
  const botLabel = botDisplayName ? `"${botDisplayName}"` : `this ${niceKind} bot`;

  return (
    <div className="panel" style={{ marginTop: 8 }}>
      <button
        className="btn ghost"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          justifyContent: "space-between",
          height: 36,
          padding: "0 4px"
        }}
        aria-expanded={open}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          {open ? <ChevronDown className="icon" /> : <ChevronRight className="icon" />}
          <Info className="icon" style={{ color: "var(--info)" }} />
          <strong style={{ fontWeight: 600 }}>
            How to set up the {niceKind} bot in Discord
          </strong>
        </span>
        <Pill tone="info">portal walkthrough</Pill>
      </button>

      {open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 12 }}>
          <Step
            num={1}
            title="Create a Discord application"
            body={
              <>
                Open the{" "}
                <a href={DISCORD_PORTAL_URL} target="_blank" rel="noreferrer">
                  Discord Developer Portal <ExternalLink className="icon" style={iconSm} />
                </a>{" "}
                and click <strong>New Application</strong>. Use the name you want to appear in
                Discord for {botLabel} — e.g.{" "}
                <em>{kind === "orchestrator" ? "Orchestrator" : botDisplayName || "Aria"}</em>.
              </>
            }
          />

          <Step
            num={2}
            title="Set name, avatar, and (optional) banner"
            body={
              <>
                On the <strong>General Information</strong> page set:
                <ul style={ul}>
                  <li><strong>NAME</strong> — what Discord shows next to the bot's messages.</li>
                  <li><strong>APP ICON</strong> — square image. Becomes the bot's avatar.</li>
                  <li><strong>DESCRIPTION</strong> — shown on the bot's profile.</li>
                </ul>
                Discord stores avatars and banners on its side. Uploading via this UI is reserved
                for our local cache.
              </>
            }
          />

          <Step
            num={3}
            title="Copy the Application ID"
            body={
              <>
                Still on <strong>General Information</strong>, click{" "}
                <strong>Copy</strong> under <code>APPLICATION ID</code> and paste it into the{" "}
                <em>Application ID</em> field {kind === "orchestrator" ? "on the Orchestrator page" : "on this waifu"}.
                It's a 17–20 digit number used to build the invite URL and to register slash
                commands.
                {applicationId && !isLikelyApplicationId(applicationId) && (
                  <div style={{ marginTop: 6 }}>
                    <Notice tone="warn">
                      The current value <code>{applicationId}</code> doesn't look like a valid
                      Discord application ID (expect 17–20 digits).
                    </Notice>
                  </div>
                )}
              </>
            }
          />

          <Step
            num={4}
            title="Reset and copy the bot token"
            body={
              <>
                Open the <strong>Bot</strong> tab → click <strong>Reset Token</strong> →{" "}
                <strong>Yes, do it!</strong> → <strong>Copy</strong>. Paste that token into the{" "}
                <em>Bot token</em> field below.
                <div style={{ marginTop: 6 }}>
                  <Notice tone="warn">
                    <ShieldAlert className="icon" style={iconSm} /> The token is shown{" "}
                    <strong>once</strong>. Treat it like a password — anyone with it can act as the
                    bot. Our backend redacts it from logs and never returns it via the API.
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
                On the <strong>Bot</strong> tab, scroll to{" "}
                <strong>Privileged Gateway Intents</strong> and toggle:
                <ul style={ul}>
                  {intents.map((i) => (
                    <li key={i.name}>
                      <code>{i.name}</code>{" "}
                      {i.privileged && <Pill tone="warn">privileged</Pill>}{" "}
                      {i.required ? (
                        <Pill tone="ok">required</Pill>
                      ) : (
                        <Pill tone="neutral">optional</Pill>
                      )}
                      {i.note && (
                        <div style={{ color: "var(--text-muted)", fontSize: "var(--fs-xs)" }}>
                          {i.note}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                Leave <code>PRESENCE INTENT</code> off — we don't use it.{" "}
                <a href={DISCORD_INTENTS_DOC} target="_blank" rel="noreferrer">
                  Discord intent docs <ExternalLink className="icon" style={iconSm} />
                </a>
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
                    <strong>PUBLIC BOT</strong> — turn <em>off</em> if you don't want anyone else
                    inviting your bot.
                  </li>
                  <li>
                    <strong>REQUIRES OAUTH2 CODE GRANT</strong> — leave <em>off</em>.
                  </li>
                  {kind === "orchestrator" && (
                    <li>
                      <strong>SERVER MEMBERS INTENT</strong> only matters if you also want full
                      member fetches; otherwise the orchestrator falls back to opportunistic
                      caching.
                    </li>
                  )}
                </ul>
              </>
            }
          />

          <Step
            num={7}
            title="Generate an invite link and add the bot to a server"
            body={
              <>
                Either use the link below (already filled in with the right scopes and
                permissions) or build one yourself via{" "}
                <strong>OAuth2 → URL Generator</strong>:
                <ul style={ul}>
                  <li>
                    <strong>SCOPES:</strong> <code>bot</code>
                    {kind === "orchestrator" && (
                      <>
                        {" "}+ <code>applications.commands</code>
                      </>
                    )}
                  </li>
                  <li>
                    <strong>BOT PERMISSIONS:</strong>
                    <ul style={ul}>
                      {permissions.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </li>
                </ul>
                Open the generated URL, pick the server, click <strong>Authorize</strong>. You need
                <em> Manage Server</em> on the target guild.
                <InviteBlock url={inviteUrl} applicationId={applicationId} guildId={guildId} kind={kind} />
                <div style={{ marginTop: 6 }}>
                  <a href={DISCORD_OAUTH_DOC} target="_blank" rel="noreferrer">
                    OAuth2 bot-authorization docs <ExternalLink className="icon" style={iconSm} />
                  </a>{" "}
                  ·{" "}
                  <a href={DISCORD_PERMISSIONS_DOC} target="_blank" rel="noreferrer">
                    Permission reference <ExternalLink className="icon" style={iconSm} />
                  </a>
                </div>
              </>
            }
          />

          <Step
            num={8}
            title="Verify in Discord"
            body={
              <>
                In the target server, give the bot's role access to the channel(s) you want it to
                operate in (right-click the channel → <strong>Edit Channel → Permissions</strong>
                {" "}or via a role). Confirm{" "}
                <em>View Channel, Send Messages, Read Message History, Add Reactions</em> are
                allowed. Then come back here and choose at least one waifu for that channel on the{" "}
                <strong>Servers</strong> page.
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

function Step({ num, title, body }: { num: number; title: string; body: React.ReactNode }) {
  return (
    <div className="step">
      <span className="num">{num}</span>
      <div className="body">
        <div className="step-title">{title}</div>
        <div className="step-desc" style={{ color: "var(--text-secondary)" }}>
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
  applicationId: string | undefined;
  guildId: string | undefined;
  kind: BotKind;
}) {
  const [copied, setCopied] = useState(false);
  if (!applicationId) {
    return (
      <Notice tone="info">
        Paste the Application ID above and an invite link will be generated here automatically.
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
    <div className="row" style={{ marginTop: 8, gap: 8 }}>
      <input className="input code" readOnly value={url} style={{ flex: 1, minWidth: 0 }} />
      <button
        className="btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            // ignore; user can copy manually
          }
        }}
      >
        {copied ? <Check className="icon" /> : <Copy className="icon" />}
        {copied ? "Copied" : "Copy URL"}
      </button>
      <a className="btn primary" href={url} target="_blank" rel="noreferrer">
        Open invite <ExternalLink className="icon" />
      </a>
      {guildId && (
        <Pill tone="info">
          targets guild <code>{guildId}</code>
        </Pill>
      )}
      {kind === "orchestrator" && <Pill tone="info">includes slash commands</Pill>}
    </div>
  );
}

const iconSm: React.CSSProperties = { width: 12, height: 12, verticalAlign: "-2px" };
const ul: React.CSSProperties = { margin: "4px 0 4px 18px", padding: 0 };
