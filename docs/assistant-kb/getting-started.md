# Getting Started

What Discord Waifus is and how to get from a fresh install to characters chatting in your server.

## What this app is

Discord Waifus runs a cast of AI characters ("waifus") in your Discord server. A single local
process hosts everything: each waifu has her own persona, model and Discord bot.

> **Living cast.** Each character is an autonomous agent with one continuous life: she is woken by
> mentions, replies, her name, DMs, her own reminders and watches, or the addressee detector; she
> reads the conversation, decides whether to answer, keeps notes as her memory and tidies them
> nightly. There is no director. The dashboard's life timeline and settings arrive in a later
> release; the owner can use the House bot's `/wake` and `/print` meanwhile.

Everything is stored locally under the data root (default `~/.dc-waifus`, override with
`DC_WAIFUS_HOME`). Ordinary operation sends data only to the model providers you configure and to
Discord. If Remote Access is enabled, `pair.waifucave.com` also receives bounded coordination
metadata; dashboard and API traffic remains direct between the paired devices and is never relayed.

## The pieces you need before anything works

1. **A model provider API key** — at least one (Anthropic, OpenAI, DeepSeek, Meta, OpenRouter).
   Set it in Settings → Providers or via `PUT /api/providers/:id/credentials`.
2. **At least one waifu** — a character with a persona and a model from the curated list
   (`GET /api/models`, see providers-and-models).
3. **Discord bot applications** — one per waifu (each waifu is its own Discord bot account, so
   they have separate names and avatars), plus the House bot (the `orchestrator` entry), which must log
   in for the waifu bots to connect. See the Discord setup doc.
4. **An enabled channel** — in Rooms, enable the waifus you want in a specific channel.

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
stop or restart the host OS process. Intel macOS and Linux ARMv7 are not supported in V1.

## How a conversation works

The Living cast rebuild changes this: each waifu will notice what concerns her, read the room
with tools and decide for herself whether to answer. Until it ships, nothing replies.
