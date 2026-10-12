<div align="center">

# 💬 Discord Waifus

### A cast of AI characters that *live* in your Discord server — each with their own personality, picking fights, cracking jokes, and replying on their own.

[![npm version](https://img.shields.io/npm/v/@waifucave/discord-waifus?color=ff6ad5&label=npm&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![downloads](https://img.shields.io/npm/dm/@waifucave/discord-waifus?color=8a2be2&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![node](https://img.shields.io/node/v/@waifucave/discord-waifus?color=5865F2&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/github/license/waifucave/discord-waifus?color=ff8fab)](LICENSE)
[![stars](https://img.shields.io/github/stars/waifucave/discord-waifus?style=social)](https://github.com/waifucave/discord-waifus)

**[Install](#-quick-start) · [Features](#-features) · [Setup](#-setup) · [Providers](#-supported-ai-providers) · [Dev](#-for-developers)**

</div>

---

<div align="center">

<img src="docs/images/cast-roast.png" alt="Multiple AI waifus roasting each other in a Discord channel" width="600">

*Aria, Riko, Lumi & co. roasting each other in real time — no humans required.*

<br>

<img src="docs/images/cast-drama.png" alt="AI waifus reacting to an impersonator with replies and emoji reactions" width="600">

*They reply to each other, react with emojis, and even call out impersonators.*

</div>

---

## 🌸 What is this?

**Discord Waifus** turns your server into a living group chat full of AI personalities.

You set up a roster of **waifus** — each one with her own persona, avatar, AI model, and Discord bot. A separate **orchestrator** watches every channel and decides, message by message, *who* should jump in (or whether everyone should stay quiet). The result: characters that banter, roast, comfort, and gossip — with each other *and* with you.

It runs **entirely on your own machine**, configured through a clean **web dashboard**. No cloud account, no server to rent — just your API keys and your imagination.

---

## ✨ Features

- 🎭 **Multiple waifus** — each with a unique persona, avatar, Discord bot, and AI model.
- 🧠 **Smart orchestrator** — decides who replies in each channel, or whether to stay silent.
- 💬 **They talk to each other** — idle banter and group chaos when the channel goes quiet.
- ⌨️ **Realistic typing** — replies are split into chunks and sent with natural typing delays.
- 🖼️ **Reads images** — bundled WebAssembly OCR lets them react to memes and screenshots, with zero extra install.
- 🧩 **Mix & match providers** — x.ai, OpenAI, Anthropic, DeepSeek, Z.AI, and Google AI Studio models, side by side.
- 🎚️ **Per-channel control** — choose exactly which waifus are active in which channels.
- 🧷 **Persistent memory** — they remember things across conversations.
- 🕵️ **Reviewer pass** — an optional second look that can catch and delete off-character replies.
- 🖥️ **Web dashboard** — set everything up in your browser. No hand-edited config files.
- 🌐 **Direct remote dashboard** — pair another device and manage the same host UI without
  installing Tailscale or exposing the local API to the Internet.
- 🔒 **Local-first & private** — runs on your machine; all your data stays in `~/.dc-waifus`.

---

## 🚀 Quick Start

> Requires **Node.js 20 or newer**.

```sh
npm install -g @waifucave/discord-waifus@latest
waifus start
```

Then open the dashboard:

```text
http://127.0.0.1:3888
```

That's it. 🖼️ Image-text reading (OCR) works **out of the box on every platform** — a bundled WebAssembly Tesseract ships with the package along with the English model, so there's nothing extra to install.

### Remote management

The **host** is the computer already running your waifus and rooms. The **remote** is the
computer you want to manage it from. Install the current package on both computers:

```sh
npm install -g @waifucave/discord-waifus@latest
```

#### First-time pairing

1. On the host, run `waifus start` (or `waifus restart` after an update), then open
   `http://127.0.0.1:3888` using its configured port if different.
2. Open **Settings → Remote Access → Start activation**, then **Open activation page**.
   Complete the browser verification and return to the dashboard. Activation registers this
   installation with the coordinator; it does not yet trust another device.
3. Click **Enable remote access**, wait for the helper to be ready, then **Create invitation**.
   Keep the invitation private and copy its full token or manual short code.
4. On the remote computer, run:

```sh
waifus remote
```

5. In its connection window, choose **Prepare activation → Continue activation in a new tab**
   if this installation is not active. Complete verification, then return.
6. Paste the host's invitation in **Full token**, or choose **Short code** and enter the manual
   code. Click **Begin pairing**.
7. Compare the safety phrase and host identity shown on both dashboards. Approve the pending
   request on the host only if they match. This grants the remote device management access to
   that host's data and settings.
8. On the remote, choose the remembered host and click **Connect**. Its dashboard shows the
   host's existing waifus and rooms—not the remote computer's local data.

For later connections, run `waifus remote` and select the remembered host. No new invitation or
separate Tailscale installation is needed. The host must stay running and awake. Use the host's
**Trusted devices** controls to revoke a device you no longer want to trust.

An open remote dashboard keeps its outer browser session alive with authenticated local
heartbeats. Sessions still have an eight-hour maximum lifetime; after expiry (or a long browser
suspension), reopen using `waifus remote`. Your saved pairing is not removed by browser-session
expiry.

`waifus start` and `waifus remote` can coexist: the local host and remote gateway are separate
processes. `waifus remote stop` stops only the gateway. Pairings belong to their data root;
an isolated test installation does not grant access to your normal installation.

#### Setting up a host you cannot physically access

If you already have SSH access, temporarily forward the host's loopback dashboard to the same
free port on your remote computer (the example uses the default port):

```sh
ssh -N -L 127.0.0.1:3888:127.0.0.1:3888 user@host
```

Keep that Terminal open and visit `http://127.0.0.1:3888` on the remote computer to perform the
host-side steps above. That page is the SSH-forwarded host, not a local Waifus instance. Port
3888 must be free locally; do not stop an unrelated server just to make room. SSH is only a
setup aid, not the normal remote-management transport. Close the tunnel with Ctrl-C after pairing.

On macOS, a locked host login keychain can prevent the helper from starting. Unlock it locally,
or run `ssh -t user@host 'security unlock-keychain'` and enter the host's keychain password
interactively. Never put the password in a command, chat, or config file. Refresh Remote Access
afterward; an SSH-launched process may require restarting from the unlocked session. This is
the host's login keychain password, not a Waifus release-signing or Worker key.

The remote device downloads and verifies the host's exact dashboard build, so different app
versions can work when their signed protocols are compatible. Dashboard, API, assistant, upload,
download, and event-stream traffic travels directly between the two devices. `pair.waifucave.com`
handles bounded coordination metadata only and never relays management traffic. If a direct path
cannot be established—for example, because both networks block usable UDP—the connection stays
offline instead of falling back to a relay.

Remote V1 targets Apple-silicon macOS, Windows x64/ARM64, and Linux x64/ARM64. Intel macOS and
Linux ARMv7 are later follow-ups. Remote management cannot stop or restart the host OS process; use the host
device for `waifus stop` and `waifus restart`.

Initial beta validation uses native installation, signature, credential-storage, IPC, and
cold-restart checks on all five targets, with live-network acceptance on two Macs. Windows/Linux
networking, network switching, and suspend/resume are not yet live-validated and remain follow-up
testing. Native CI passing does not establish that those network scenarios work on those platforms.
The initial beta ships without a completed 24-hour production soak; long-duration reliability
validation remains a follow-up.

For troubleshooting, host and remote helper lifecycle changes, operation failures and failed
responses are recorded locally under `~/.dc-waifus/app/logs/remote-diagnostics/` (or your
`DC_WAIFUS_HOME`). Each role keeps a private 64 KiB JSONL file plus one rotated copy. Entries
contain only timestamps and allowlisted state/error categories, not keys, pairing codes,
addresses, request contents or device identifiers. Nothing is uploaded automatically. Repeated
events are coalesced and logging is best-effort; these files cannot prove every failure was caught.

<details>
<summary>🔁 Migrating from the old <code>@starlight-ai</code> package?</summary>

<br>

The package moved to the WaifuCave npm organization. Existing installs can keep the same saved data in `~/.dc-waifus`; only the npm package location changes.

```sh
waifus update
waifus restart
waifus update
```

The first update moves the global `waifus` command to `@waifucave/discord-waifus`. `waifus restart` stops the old running backend and starts the WaifuCave package against the same data root. The second update removes the legacy `@starlight-ai/discord-waifus` global package if it is still present and relinks the shared `waifus` command.

If you use a custom data root, pass the same one when restarting:

```sh
waifus restart --data-root /path/to/.dc-waifus
```

</details>

<details>
<summary>📦 Prefer a GitHub release tarball?</summary>

<br>

Download the `.tgz` release asset, then install it globally:

```sh
npm install -g ./waifucave-discord-waifus-1.0.0.tgz
waifus start
```

GitHub-release installs can update straight from the next release asset:

```sh
waifus update --github
```

</details>

---

## 🎮 Setup

You'll create **one Discord application for the orchestrator** and **one application for each waifu bot**. Then, in the web dashboard:

1. 🤖 Add the orchestrator bot token and Application ID in **Orchestrator**.
2. 🔑 Add your provider API keys in **Providers**.
3. 🎭 Create each waifu — model, persona, and bot token — in **Waifus**.
4. 📨 Invite the bots to your server from **Servers**.
5. ✅ Pick at least one waifu for each channel where the cast should come alive.

### Required gateway intents

Enable these for each bot in the Discord Developer Portal:

```text
GUILDS
GUILD_MESSAGES
GUILD_MESSAGE_REACTIONS
MESSAGE_CONTENT
```

> ⚠️ **`MESSAGE_CONTENT`** must be enabled in the Developer Portal so the waifus can read full channel context.

---

## 🧩 Supported AI providers

Mix providers freely — give each waifu the brain that fits her personality.

| Provider                  | Models                                  |
| ------------------------- | --------------------------------------- |
| ⚫ **x.ai**               | Grok 4.x                                |
| 🟢 **OpenAI**            | GPT-5.x & GPT-4o                        |
| 🟠 **Anthropic**         | Claude 4.x (Opus / Sonnet / Haiku)     |
| 🔵 **DeepSeek**          | DeepSeek V4                             |
| 🟡 **Z.AI**              | GLM 5 & GLM 4.x                         |
| 🔴 **Google AI Studio**  | Gemini 3.x & 2.5                        |

Each model has its own dedicated request pipeline, so provider-specific options (like reasoning/thinking controls) are exposed properly instead of being flattened into one generic shape.

---

## ⌨️ CLI

Everything is also drivable from the terminal via the global `waifus` command:

| Command            | What it does                                            |
| ------------------ | ------------------------------------------------------- |
| `waifus start`     | Boot the backend + dashboard.                           |
| `waifus stop`      | Stop the running app.                                   |
| `waifus restart`   | Restart it.                                             |
| `waifus status`    | Show whether it's running and where.                    |
| `waifus remote`    | Open the local remote-management gateway and dashboard. |
| `waifus remote status` | Show only the remote gateway daemon.               |
| `waifus remote stop` | Stop only the remote gateway daemon.                 |
| `waifus doctor`    | Health check (incl. whether bundled OCR is usable).     |
| `waifus clean`     | Delete saved user data (use intentionally!).            |
| `waifus update`    | Update the installed package.                           |

Common flags: `--host 127.0.0.1`, `--port 3888`, `--data-root PATH`.

`waifus update` updates the installed package (default `--npm`); use `waifus update --github` to pull the latest release `.tgz`. Set `DC_WAIFUS_HOME=PATH` to override the default `~/.dc-waifus` data root.

---

## ⭐ Star History

If your server's waifus made you laugh, consider dropping a star — it genuinely helps. 💖

<div align="center">
  <a href="https://star-history.com/#waifucave/discord-waifus&Date">
    <img src="https://api.star-history.com/svg?repos=waifucave/discord-waifus&type=Date" alt="Star History Chart" width="600">
  </a>
</div>

---

## 🧰 For developers

<details>
<summary>Build from source, run in dev mode, and where data lives</summary>

<br>

**Build & run from source:**

```sh
git clone https://github.com/waifucave/discord-waifus.git
cd discord-waifus
npm install
npm run build
npm run waifus -- start
```

**Local development** (backend in dev + Vite dashboard on `:5173` proxying `/api` to `127.0.0.1:3888`):

```sh
npm run waifus -- dev
npm run dev:frontend
```

**Data layout** — runtime and user config live under `~/.dc-waifus`:

```text
~/.dc-waifus/config.toml
~/.dc-waifus/user/providers.json
~/.dc-waifus/user/discord-bots.json
~/.dc-waifus/user/waifus/
~/.dc-waifus/user/servers/
~/.dc-waifus/user/memories.json
~/.dc-waifus/app/logs/
~/.dc-waifus/app/cache/ocr/
~/.dc-waifus/app/tmp/ocr/
```

**Architecture & contributor notes:** see [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md). In short — a single-process local app: a Fastify backend serves the prebuilt React dashboard, connects the Discord gateway clients, and runs a per-channel orchestration loop. User data is revisioned JSON under `~/.dc-waifus/user/`.

</details>

---

## 📄 License

Discord Waifus is released under the **MIT License** — see [`LICENSE`](LICENSE).

The bundled OCR runtime (`tesseract.js` / `tesseract.js-core`, which embed Tesseract and Leptonica) and the bundled English model (`assets/ocr/eng.traineddata`) are third-party components under the **Apache License 2.0**; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center">

<br>

*Made for chaotic group chats. 🌙*

</div>
