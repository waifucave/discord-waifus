<div align="center">

# 💬 Discord Waifus

### A cast of AI characters that *live* in your Discord server — each with her own personality and her own life, picking fights, cracking jokes, and deciding for herself when to talk.

[![npm version](https://img.shields.io/npm/v/@waifucave/discord-waifus?color=ff6ad5&label=npm&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![downloads](https://img.shields.io/npm/dm/@waifucave/discord-waifus?color=8a2be2&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![node](https://img.shields.io/node/v/@waifucave/discord-waifus?color=5865F2&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/github/license/waifucave/discord-waifus?color=ff8fab)](LICENSE)
[![stars](https://img.shields.io/github/stars/waifucave/discord-waifus?style=social)](https://github.com/waifucave/discord-waifus)

**[Install](#-quick-start) · [Features](#-features) · [Setup](#-setup) · [Models](#-models-and-keys) · [CLI](#%EF%B8%8F-cli) · [Dev](#-for-developers)**

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

You set up a cast of **waifus** — each one with her own persona, AI model and (optionally) her own
Discord bot. Since **3.0.0, the Living cast**, every waifu is an autonomous agent with **one
continuous life**: a mention, a reply, her name, a DM, one of her own reminders or watches wakes
her; she reads the room, decides whether to answer (or to stay quiet), keeps notes as her memory in
her own folder and tidies them every night. There is no director picking speakers: each waifu decides for herself.

It runs **entirely on your own machine**, configured through a **web dashboard** or the `waifus`
command. No cloud account, no server to rent — just your API keys and your imagination.

---

## ✨ Features

- 🎭 **A cast that lives** — every waifu has her own persona, model, life log and folder (notes, reminders,
  watches, files people sent her), and acts on her own.
- 🔔 **Woken by what concerns her** — mentions, replies, her name, DMs, her reminders and watches, and an
  addressee detector for messages nobody addressed.
- 😴 **Sleep, schedules and budgets** — a nightly sleep window with a morning summary, busy blocks, and an
  optional daily budget per waifu.
- 💌 **DMs** — each waifu can answer DMs to her own bot, with a per-person rate limit.
- 🔎 **Web search** — Exa search and page reading, capped per day (works without a key).
- 🖼️ **Reads images** — bundled WebAssembly OCR for memes and screenshots, with zero extra install.
- 🧩 **Curated models** — Anthropic, OpenAI, DeepSeek, Meta and OpenRouter routes, each with its reasoning
  efforts and price, at most $10 per million output tokens.
- 🖥️ **Web dashboard** — a live Life timeline per waifu, usage and cost, and every setting.
- ⌨️ **CLI and help** — every setting is readable and writable with `waifus get|set`, and documented by
  `waifus help`.
- 🧽 **Forget a person** — remove someone from DMs and every waifu's life and files (best effort, see below).
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

### The addressee detector

A message that mentions, replies to or names a waifu wakes her directly. A message nobody addressed
goes to the **addressee detector**, a native-choice decision model that picks who it is for (or
nobody). Choose it in **Settings → Detector** (or `waifus set app detector.target …`); a server can
override it in **Rooms**. With the detector off, a first message after 10 minutes of quiet, or a
question, wakes one waifu at random.

The OpenRouter decision catalog and direct OpenAI Decisions need that provider's key in
**Settings → Providers**. These models are only ever used for this choice, never as a character's
model.

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
remote settings. The first local call downloads public weights at a pinned revision. The benchmark
found substantial Laya false positives; don't mistake local/free operation for reliable routing.

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

For later connections, run `waifus remote`: it connects to the last selected host (or the only
remembered host) and opens its dashboard without showing a connection screen or connection banner.
Running it again reopens a browser window without stopping the gateway.
Use `waifus remote --setup` for activation, pairing, or choosing another host.
No new invitation or separate Tailscale installation is needed. The host must stay running and awake. Use the host's
**Trusted devices** controls to revoke a device you no longer want to trust.

Remote browser sessions have no idle timeout or eight-hour cutoff; when many accumulate, the
least recently used one is retired first and simply reconnects. A non-exportable browser key
in the trusted local page's IndexedDB proves ownership after restart; owner-only gateway files
store only its public key, scoped to the paired host, trust epoch and exact isolated origin.
Cookies remain HttpOnly and SameSite=Strict. Old cookies are invalid after restart. An open
dashboard tab retries locally and obtains a fresh session through a short-lived, single-use
challenge, using fresh helper launch authority. This needs browser WebCrypto/IndexedDB support.
These polls never go to the coordinator; bootstrap links remain single-use and are not saved.
An invisible isolation frame still prevents host pages from navigating your tab or accessing
the local setup UI. Clearing browser site data, disconnecting/forgetting a host, trust/origin changes,
or conflicting local ports can require reopening with `waifus remote`. Device pairing is separate;
revocation and origin/CSRF checks still apply. This does not bypass a locked macOS Keychain.

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

You'll create **one Discord application for the House bot** (it reads the rooms and hosts the owner's
`/wake` and `/print` commands) and, if you like, **one application per waifu** so each has her own
name and avatar. A waifu needs her own bot to post: the House bot only reads and never speaks for her. Then, in the dashboard:

1. 🔑 **Settings → Providers**: add at least one model provider key.
2. 🤖 **Settings → App → Discord bots**: pick a bot and follow the interactive guide, pasting its Application ID and token right into the step that produces them (the House bot first, then each waifu's).
3. 🎭 **Cast**: create each waifu — persona, model and effort, her bot, schedule, budget and DMs.
4. 📨 Invite the bots to your server, then in **Rooms** pick the waifus for each channel.
5. 👀 **Life** shows what each waifu is doing; **Home** shows who is awake and anything that needs you.

The setup wizard walks you through the first steps; the dashboard assistant (Norma) can do any of
this for you.

### Required gateway intents

Only the **House bot** reads the rooms, so only its application needs privileged intents in the Developer Portal:

```text
MESSAGE CONTENT INTENT   (required)
SERVER MEMBERS INTENT    (only if you turn on discord.guildMembersIntent)
```

The non-privileged intents (Guilds, Guild Messages, Guild Message Reactions, Guild Message Typing, Guild Expressions) are requested
automatically. A **waifu bot** only posts, reacts and attaches files, so it needs no privileged intent. DMs need
none either: turn on **Cast → Direct messages** for a waifu with her own bot.

---

## 🧩 Models and keys

Models come from a **curated list** on top of the installed model catalog: each route lists its
reasoning efforts and its price, and nothing above **$10 per million output tokens** is offered
(**Settings → Models** or `waifus set app models.allowed …`). Pick a model and an effort per waifu in
**Cast**.

| Provider        | Curated models (by default)                     |
| --------------- | ----------------------------------------------- |
| 🟠 **Anthropic** | Claude Haiku 5.5, Claude Sonnet 5.5            |
| 🟢 **OpenAI**    | GPT-6 Luna, GPT-6.1 Sol                         |
| 🔵 **DeepSeek**  | DeepSeek V4.1 Flash                             |
| 🟣 **Meta**      | Muse Spark 1.3 (contributor variant)            |
| ⚪ **OpenRouter** | the same models through one OpenRouter key    |

Contributor variants share your prompts for model training and are only ever an explicit choice.
Keys are stored locally in `~/.dc-waifus/user/providers.json`, sent only to their provider, and never
shown again (`waifus set provider:anthropic apiKey --from-env ANTHROPIC_API_KEY`, never on the
command line itself).

**Web search (Exa):** waifus search the web through Exa's hosted service, which works without a key;
an `exa` key (**Settings → Search**) is used when the keyless service is busy or limited. Searches
and page reads are capped per day (`search.*`, `life.webFetch.*`).

---

## 🧽 Forgetting someone

**Life → Forget a person**, `waifus forget <userId>`, or `POST /api/people/:userId/forget` removes a
Discord user from every DM, the member lists and the archive, and scrubs every waifu's life log,
summary, queue and files. A DM user can also use `/forget` in their DM with a waifu. Forget is a
**best-effort scrub**:

- Discord history itself is not deleted, and whatever a waifu already said in rooms stays there.
- Usage-ledger lines and app logs stay (they hold ids only, never text).
- Cached guild images, and any DM image no image index recorded, stay until the disk cache expires
  them (`discord.images.diskCacheTtlHours`, 168 hours by default).
- Anything outside this host, and the web page cache (`life.webFetch.cacheMinutes`, 15 minutes by default), are not touched.
- Name matching is best effort: a name someone else also has is only listed for review
  (**Life → Needs review**).

---

## 🖥️ Dashboard

- **Home** — who is awake, asleep or mid-turn, recent sends and wakes, today's cost, and anything
  that needs you (owner notices, unfinished forgets, upgrade steps waiting).
- **Cast** — persona, style, model and effort, her bot, wake-on-name, schedule, daily budget, DMs.
- **Life** — each waifu's live timeline (tool calls with their arguments; private chats hidden unless
  you reveal them on the host itself), Wake / Compact / Reset, review lines, today's web searches,
  her reminders and watches (with delete buttons), a browser and text editor for her files (her home
  and `/tmp`; files from private chats stay unnamed unless revealed on the host), and the forget form.
- **Rooms** — servers and channels, who may speak where, threads, and the detector override.
- **Activity** — logs, model calls (a life's calls show metadata only) and usage by day, waifu,
  purpose or model.
- **Settings** — providers, models, search, the detector, life limits, the assistant, app settings
  and Remote Access.

---

## ⌨️ CLI

Everything is also drivable from the terminal via the global `waifus` command (`waifus help` lists
it all, offline):

| Command | What it does |
| --- | --- |
| `waifus start` / `stop` / `restart` | Run the host (backend, dashboard and Discord) in the background. |
| `waifus status` | Whether it runs, plus the Living cast's state that needs attention. |
| `waifus doctor` | Health check (bundled OCR, the data root, unfinished upgrades and forgets). |
| `waifus help [topic]` | Help for a command, a settings group, a key or a topic. |
| `waifus list [group]` | The settings groups, or one group's keys with type, default and help. |
| `waifus get TARGET [KEY]` | Read settings (`app`, `waifu:aria`, `server:<id>`, `channel:<g>/<c>`, `bot:house`, `provider:<id>`, `assistant`, `remote-access`). |
| `waifus set TARGET KEY VALUE` | Change a setting (several `KEY=VALUE` pairs in one write); secrets only via `--from-env` or stdin. |
| `waifus unset TARGET KEY` | Clear a key or restore its default. |
| `waifus wake WAIFU [note]` | Wake a waifu now, with a note she sees. |
| `waifus life WAIFU [--log]` | Her status, queue and today's cost; `--log` adds her recent life (`--private` on the host shows DMs). |
| `waifus files WAIFU [PATH] [--root tmp]` | List a folder of her home (or `/tmp`), or print one of her text files (`--private` on the host shows files from DMs). |
| `waifus schedule WAIFU` / `waifus watches WAIFU` | Her reminders and her watches. |
| `waifus forget USER_ID` | Forget a person (asks for confirmation; `--yes` for scripts). |
| `waifus usage [--by waifu]` | Model calls and cost by local day, waifu, purpose or model. |
| `waifus remote` / `remote status` / `remote stop` | The remote-management gateway on another device. |
| `waifus clean` | Delete saved user data (use intentionally!). |
| `waifus update` | Update the installed package. |

Examples:

```sh
waifus set app life.maxSendsPerTurn 6
waifus set waifu:aria life.dailyBudgetUsd=2.5 wakeOnName=false
waifus get app.search
waifus help app.life
```

Common flags: `--data-root PATH`, `--json`, and for the host `--host 127.0.0.1`, `--port 3888`.
Exit codes: 0 ok, 1 failure, 2 usage, 3 host not running, 4 rejected, 5 conflict.

`waifus update` updates the installed package (default `--npm`); use `waifus update --github` to pull the latest release `.tgz`. Set `DC_WAIFUS_HOME=PATH` to override the default `~/.dc-waifus` data root.

### Upgrading to 3.0.0

3.0.0 is a major release: idle updates never install it. Install it by hand
(`npm install -g @waifucave/discord-waifus@3.0.0`, then `waifus restart`). The first start migrates
each waifu's memories to notes in her home folder, maps old model settings to the curated list (anything without an
equivalent shows as a notice to pick again) and archives the director's data under
`~/.dc-waifus/user/.archive/living-cast/`. Downgrading is not supported. `waifus doctor` reports any
step that left unreadable data alone.

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

On macOS, remote-enabled hosts/gateways postpone restart while the login keychain is locked. The status probe is read-only and never shows a password prompt. An open dashboard tab recovers after a gateway restart using its browser-key proof, without another connection window or pairing. Remote users may read update status but cannot enable/schedule host process restarts.

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
~/.dc-waifus/user/waifus/<id>/life/    # her life: state, log, wakes, plans
~/.dc-waifus/user/waifus/<id>/home/    # her home: notes, MEMORY.md (the index), schedule.json, watches.json
~/.dc-waifus/user/waifus/<id>/tmp/     # her /tmp: files people sent, deleted after 7 days
~/.dc-waifus/user/servers/
~/.dc-waifus/user/dms/
~/.dc-waifus/user/usage/               # the usage ledger, one file per UTC day
~/.dc-waifus/app/logs/
~/.dc-waifus/app/cache/ocr/
~/.dc-waifus/app/tmp/ocr/
```

**Architecture & contributor notes:** see [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md). In short — a single-process local app: a Fastify backend serves the prebuilt React dashboard, connects the Discord gateway clients, and runs one life per waifu (spec `docs/specs/2026-10-24-living-cast-design.md`). User data is revisioned JSON under `~/.dc-waifus/user/`. The HTTP API is documented in [`docs/api.md`](docs/api.md) and by `GET /api/help`.

</details>

---

## 📄 License

Discord Waifus is released under the **MIT License** — see [`LICENSE`](LICENSE).

The bundled OCR runtime (`tesseract.js` / `tesseract.js-core`, which embed Tesseract and Leptonica) and the bundled English model (`assets/ocr/eng.traineddata`) are third-party components under the **Apache License 2.0**; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center">

<br>

*Made for chaotic group chats. 🌙*

</div>
