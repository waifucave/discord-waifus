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
- 🎯 **Three orchestrator modes** — LLM, free deterministic, or native decision APIs with One shot.
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

### Orchestrator modes

Open **Rooms → your server → Orchestration for this server**:

- **LLM** uses the global director model and prompt from Direction, with generated reasoning and goals.
- **Deterministic** picks speakers structurally without an orchestration API call.
- **One shot** uses one native-choice decision request per turn to choose one speaker or a pause,
  identify repetition/scene stagnation, and select steering. The characters still generate their
  replies with their own LLMs. The global LLM settings remain saved and unchanged.

In One shot, pick a model from the additional **One shot model** selector. Save the corresponding
OpenRouter or OpenAI key in **Settings → Providers** on the host. The live OpenRouter decision
catalog includes Jev, Clef/Flash/Omni, Mercury Decide, Perplexity Decider, Microsoft Decision,
Liquid d1, Drex, Tev, Kev, Solar Decide/Flash, and routed OpenAI Decisions, including available
aliases/free variants. Direct OpenAI Decisions is also available. Yes/no-only models are excluded;
these models are not offered as character text-generation models.

One shot is experimental: detecting a loop does not guarantee breaking it. It has fixed pause
buckets (100, 600, 3600 seconds, with timer-wake backoff), short template steering goals, and no
generated wake-plan prose. At most 17 eligible characters are offered per pass; larger casts use
addressing plus rotation to shortlist candidates. Automatic provider/validation failures use the
existing deterministic fallback and record a safe error code. Required manual passes use the
existing runtime error path instead. Existing pacing, pause, cancellation and directive guards
remain active. Switching modes does not alter your waifu, stage-manager or reviewer models.

**Optional local Laya:** English, multilingual and typed-decisions checkpoints are included as
experimental choices, but Python and weights are not bundled. On the host, create a separate
environment (Python 3.10+), then install the runtime:

```sh
python3 -m venv /absolute/path/to/waifus-laya-env
/absolute/path/to/waifus-laya-env/bin/python -m pip install "laya==0.3.20" "torch==2.14.1" "transformers==5.19.0"
DC_WAIFUS_LAYA_PYTHON=/absolute/path/to/waifus-laya-env/bin/python waifus restart
```

On Windows, use the environment's `Scripts/python.exe` and set `DC_WAIFUS_LAYA_PYTHON` before
starting Waifus. This is host-local environment configuration; it cannot be changed through
remote settings. The first local call downloads public weights at a pinned revision; subsequent
calls reuse supervised workers. A slow first download can time out and retry on a later call.
Local calls serialize per checkpoint with bounded queues; shutdown cancels them. Laya offers
at most seven candidates per pass. English/specialist contexts are short, and detected context
clipping fails safely rather than producing a decision from incomplete input. The benchmark
found substantial Laya false positives; don't mistake local/free operation for reliable routing.

The same settings and model catalog work from the paired remote dashboard and assistant. The
assistant can use `list_one_shot_models` and `update_server` without accessing provider secrets.

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

Remote browser sessions have no idle timeout or eight-hour cutoff. They remain valid while
the gateway is running and the browser retains its session cookie, including after a long
browser suspension. Stopping/restarting the gateway invalidates its browser sessions; clearing
cookies or ending the browser session may also require reopening with `waifus remote`.
Your saved pairing remains intact. Device revocation and origin/CSRF checks still apply.

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

### Version numbering

Starting with **2.111.1**, Waifus uses **major.feature.bugfix** numbering (`#.###.#`). Bugfix releases increment the last number (for example, `2.111.2`); feature releases increment the middle number and reset the bugfix counter (for example, `2.112.0`); major releases increment the first number. npm packages and GitHub tags use the same canonical numeric version, without leading zeroes (`v2.111.1` on GitHub).

The transition from the historical `1.5.x` series to `2.111.1` requires one manual `waifus update` followed by restarting your running host/remote processes. Existing data, device pairings and automatic-update preferences are retained. Automatic updates do not cross a major or feature boundary.

### Automatic updates while idle

Automatic updates are **opt-in**. On a global npm installation, enable them in **Settings → App → Idle-only updates**, or use:

```bash
waifus update --auto on
waifus update --auto status
waifus update --auto off
```

The default is an hourly npm `latest` check and five minutes without active work. Only newer plain patch versions in your current major/minor series are eligible; major/minor upgrades, prereleases and deprecated app releases require a manual update. Source checkouts and development/test runtimes are never automatically replaced. Start both ordinary and remote processes once with an updater-aware version before enabling it; an old sibling that cannot report idle blocks updating.

The updater coordinates every registered host and remote gateway using that global installation, including different data roots. All must opt in and be quiet. It waits for channel/background jobs, assistant turns, API/file transfers, runtime reloads and active pairing/activation work. Passive status polling and event subscriptions do not extend the quiet window. Packages and the current platform's signed helper are staged/verified first; it then reserves a short maintenance window, stops the idle processes, installs the exact staged release and restarts the same roles/data roots. If replacement or verification fails, it attempts to restore the previous package before restarting. Manual and automatic installs share a transaction lock. Configuration, provider credentials, characters, rooms and saved pairings are never cleared by the updater.

On macOS, remote-enabled hosts/gateways postpone restart while the login keychain is locked. The status probe is read-only and never shows a password prompt. A remote-gateway restart ends its browser sessions; reopen it with `waifus remote stop` followed by `waifus remote` (no new device pairing is needed). Remote users may read update status but cannot enable/schedule host process restarts.

`GET /api/updates` and `waifus update --auto status` show sanitized status. Bounded private history and a crash-recovery journal live under the normal data root's `app/updates/` installation-specific directory; no provider keys or child-process output are recorded or uploaded. Recovery does not roll back user-data migrations. If a crash, lost permissions or failed package restore leaves the CLI unusable, reinstall with `npm install -g @waifucave/discord-waifus` and start your roles again. An isolated native macOS replacement/restart cycle is verified; native Windows/Linux updater cycles remain untested. Fixture tests are not that proof.

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
