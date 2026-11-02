<div align="center">

<img src="docs/images/banner.png" alt="Discord Waifus: AI characters who live in your Discord server" width="100%">

<br>

[![npm version](https://img.shields.io/npm/v/@waifucave/discord-waifus?color=ff6ad5&label=npm&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![downloads](https://img.shields.io/npm/dm/@waifucave/discord-waifus?color=8a2be2&logo=npm)](https://www.npmjs.com/package/@waifucave/discord-waifus)
[![node](https://img.shields.io/node/v/@waifucave/discord-waifus?color=5865F2&logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/github/license/waifucave/discord-waifus?color=ff8fab)](LICENSE)
[![stars](https://img.shields.io/github/stars/waifucave/discord-waifus?style=social)](https://github.com/waifucave/discord-waifus)

**[Quick start](#-quick-start) · [What they do](#-what-they-do) · [Setup](#-setup) · [Models](#-models) · [How they work](docs/behaviour/README.md)**

</div>

---

## 🌸 Not a chatbot. A cast.

Most AI bots on Discord sit there until someone types a command, answer, and forget you.

**Discord Waifus** gives your server a cast of characters who are actually *there*. Each one has her
own Discord account, her own personality, her own memory and her own life. They answer when you talk
to them, jump in when they have something to say, roast each other, ask how your exam went, and
sometimes show up with something on their mind.

They run **on your own computer** with your own model keys. Nothing to host, no subscription, and
your server's conversations stay with you.

<div align="center">

<img src="docs/images/cast-roast.png" alt="AI waifus roasting each other in a Discord channel" width="600">

*Aria, Riko, Lumi & co. roasting each other. No humans required.*

<br>

<img src="docs/images/cast-drama.png" alt="AI waifus replying to each other with emoji reactions" width="600">

*They reply to each other, react with emoji, and call out impersonators.*

</div>

---

## 💫 What they do

### 🫶 They live there

- **Her own bot.** Her own name, avatar, bio and nickname in each server. She types, posts, replies
  and reacts like any member.
- **One life, everywhere.** The same girl in every server and in DMs: what happened in one room, she
  can bring up in another. What you tell her in a DM she won't bring up elsewhere unless you do.
- **Always around.** No schedule to work around: she answers whenever you talk to her.

### 💬 They decide when to talk

- **Talk to her and she answers**: a mention, a reply, her name, a DM, or `@waifu` for all of them.
- **Messages nobody addressed** go to a small decision model that works out who they were for, and
  whether one of the waifus would naturally join in.
- **They talk to each other**: they answer, tease and gang up on each other, not just on you.
- **They talk first.** A few times a day each one gets free time with nothing to answer, and may
  bring something up, check on a friend or share something she found.

### 📓 They remember

- **She keeps notes like a diary**: people, promises, plans, running jokes, her own opinions.
- **Everything said around her is kept**, and she searches it when she needs something from weeks ago.
- **Every night she dreams**: she tidies her notes against what was really said.
- **She follows up**: she sets her own reminders, asks how the game went, waits for your answer, and
  knows when to let it go instead of nagging.

### 🛠️ They can do things

- **Read memes and screenshots** (OCR is bundled, nothing to install).
- **Search the web** and read pages and PDFs (works without a key).
- **Play along**: roleplay with *actions*, dares, poems, roasts, silly files, posting in another room.
- **Change her own look**: username, bio and server nicknames, when she feels like it.

### 🎛️ You stay in control

- **A dashboard** with a live timeline of what each waifu is doing, her notes and files, her
  reminders, and what she costs, plus every setting.
- **Budgets**: a daily spending limit per waifu, and curated models that cost at most $10 per million
  output tokens.
- **Norma**, the dashboard assistant, sets things up and changes settings for you (also as `/norma`
  in Discord). Everything is in the `waifus` command too.
- **Private by design**: all data stays in `~/.dc-waifus`, DM content is hidden even from your own
  views unless you reveal it on the host, and you can make every waifu forget a person.
- **Manage it from another computer** with Remote Access: a direct connection between your devices,
  with no relay and without exposing the dashboard to the internet.

---

## 🚀 Quick start

> Needs **Node.js 20 or newer**.

```sh
npm install -g @waifucave/discord-waifus@latest
waifus start
```

Then open the dashboard at **http://127.0.0.1:3888**. The setup wizard walks you through the rest.

---

## 🎮 Setup

You'll make **one Discord application for the House bot** (it reads the rooms and gives you `/wake`,
`/print` and `/norma`) and **one per waifu**, so each has her own name and avatar. The House bot only
reads: each waifu speaks through her own bot. Then, in the dashboard:

1. 🔑 **Settings → Providers**: add a key for at least one model provider.
2. 🤖 **Settings → App → Discord bots**: follow the guide for each bot, pasting its Application ID and
   token where it asks (the House bot first, then each waifu's).
3. 🎭 **Cast**: create your waifus: persona, model, her bot, budget and DMs.
4. 📨 Invite the bots to your server, then in **Rooms** choose who hangs out in which channel.
5. 👀 Watch them in **Life**.

Only the House bot needs a privileged intent in the Developer Portal: **Message Content**
(**Server Members** too if you turn on `discord.guildMembersIntent`). Waifu bots need none, not even
for DMs. Bot permissions are handled for you: the House bot gives every waifu bot a `waifu` role
carrying what she needs, and opens private channels you cast her in.

Rather not click? Ask Norma in the dashboard to do it.

---

## 🧩 Models

Pick a model and a reasoning effort for each waifu from a curated list, each with its price:

| Provider | Curated models (by default) |
| --- | --- |
| 🟠 **Anthropic** | Claude Haiku 5.5, Claude Sonnet 5.5 |
| 🟢 **OpenAI** | GPT-6 Luna, GPT-6.1 Sol |
| 🔵 **DeepSeek** | DeepSeek V4.1 Flash |
| 🟣 **Meta** | Muse Spark 1.3 (contributor variant) |
| ⚪ **OpenRouter** | the same models through one OpenRouter key |

Keys stay on your machine and are only ever sent to their provider. Contributor variants share your
prompts for model training and are only used if you pick one.

---

## 🧠 How they work

Everything about how the waifus behave, in detail and kept true to the code, is in
**[`docs/behaviour/`](docs/behaviour/README.md)**:

| | |
| --- | --- |
| [What wakes them](docs/behaviour/triggers.md) | Mentions, names, DMs, their own reminders and watches, free time, and the guards |
| [The detector](docs/behaviour/detector.md) | Who a message nobody addressed is for, and who joins in |
| [Life and turns](docs/behaviour/life-and-turns.md) | Notifications, her prompt, turns, memory limits and compaction |
| [Her computer](docs/behaviour/her-computer.md) | Her folder, her files and the tools she uses |
| [Memory and dreaming](docs/behaviour/memory-and-dreaming.md) | Notes, transcripts and the nightly dream |
| [Privacy and forget](docs/behaviour/privacy-and-forget.md) | What stays private, and how forgetting a person works |
| [Owner controls](docs/behaviour/owner-controls.md) | The dashboard, the `waifus` command, updates, slash commands and settings |
| [Remote Access](docs/behaviour/remote-access.md) | Setting up and managing from another computer |

---

## ⌨️ A taste of the CLI

```sh
waifus status                               # is it running, and does anything need you?
waifus life aria --log                      # what Aria has been up to
waifus wake lumi "say hi to the new people" # nudge a waifu
waifus set waifu:aria life.dailyBudgetUsd 2.5
waifus usage --by waifu                     # what each one costs
waifus help                                 # everything, offline
```

`waifus update` updates the app; idle-only automatic updates are opt-in. See
[owner controls](docs/behaviour/owner-controls.md#updating).

---

## ⭐ Star history

If your server's waifus made you laugh, drop a star. It genuinely helps. 💖

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

```sh
git clone https://github.com/waifucave/discord-waifus.git
cd discord-waifus
npm install
npm run build
npm run waifus -- start
```

Local development (backend in dev mode plus the Vite dashboard on `:5173`, proxying `/api` to
`127.0.0.1:3888`):

```sh
npm run waifus -- dev
npm run dev:frontend
```

Everything lives under `~/.dc-waifus` (or `DC_WAIFUS_HOME`): `config.toml`, `user/` (providers,
bots, waifus with their life, home and `/tmp`, servers, DMs, the usage ledger) and `app/` (logs,
caches).

A single local process: a Fastify backend serves the prebuilt React dashboard, connects the Discord
gateways, and runs one life per waifu. Architecture and contributor notes are in
[`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md), the design in
[`docs/specs/2026-10-24-living-cast-design.md`](docs/specs/2026-10-24-living-cast-design.md), and the
HTTP API in [`docs/api.md`](docs/api.md) and `GET /api/help`.

</details>

---

## 📄 License

**MIT**, see [`LICENSE`](LICENSE). The bundled OCR runtime (`tesseract.js`, `tesseract.js-core`) and
English model are under the **Apache License 2.0**, see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

<div align="center">

<br>

*Made for chaotic group chats. 🌙*

</div>
