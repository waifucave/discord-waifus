# Getting Started

What Discord Waifus is and how to get from a fresh install to characters chatting in your server.

## What this app is

Discord Waifus runs a cast of AI characters ("waifus") in your Discord server. A single local
process hosts everything: a director model (the orchestrator) decides who speaks and when,
each waifu generates her own messages with her own model and persona, a stage-manager watches
conversations and records memories, and an optional reviewer can delete rule-breaking messages.

Everything is stored locally under the data root (default `~/.dc-waifus`, override with
`DC_WAIFUS_HOME`). Ordinary operation sends data only to the model providers you configure and to
Discord. If Remote Access is enabled, `pair.waifucave.com` also receives bounded coordination
metadata; dashboard and API traffic remains direct between the paired devices and is never relayed.

## The pieces you need before anything works

1. **A model provider API key** — at least one (DeepSeek, Anthropic, OpenAI, Google AI Studio,
   and others). Set it in Settings → Providers or via `PUT /api/providers/:id/credentials`.
2. **A model for the orchestrator** — the director that decides who replies. Configure in
   Direction → Orchestrator.
3. **At least one waifu** — a character with a persona and a model.
4. **Discord bot applications** — one for the orchestrator plus one per waifu (each waifu is
   its own Discord bot account, so they have separate names and avatars). See the Discord
   setup doc.
5. **An enabled channel** — in Rooms, enable the waifus you want in a specific channel.

## Running it

- `waifus start` / `waifus stop` / `waifus restart` — manage the background process.
- `waifus status` — where it runs and whether Discord is connected.
- `waifus doctor` — quick health diagnostics.
- Dashboard: http://127.0.0.1:3888 (local only).

## Optional remote management

On the host, activate and enable Settings → Remote Access, then create a short-lived invitation.
On the other device, run `waifus remote`. Its protected loopback connection window accepts either
the full token/QR flow or the manual short code. Compare the displayed safety phrase on both
devices before approving the pending request on the host.

The remote gateway fetches and verifies the host's exact dashboard build. Compatible app versions
can therefore connect without requiring identical installations. Management traffic is direct
peer to peer and has no relay fallback; hard NAT or blocked UDP can leave the host offline.
`waifus remote status` and `waifus remote stop` manage only the remote gateway. Remote V1 does not
stop or restart the host OS process. Intel macOS is not supported in V1.

## How a conversation works

When someone posts in an enabled channel, the orchestrator reads recent context and either
picks one or more waifus to reply (sometimes with a steering directive), or stays silent and
schedules a later check-in. Each chosen waifu writes a reply in character; long replies are
split into natural chat-sized messages. The stage-manager periodically records observations
as memories that waifus recall in later conversations, and a nightly "dream" pass consolidates
them.
