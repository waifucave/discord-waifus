# Discord Waifus

Local Discord waifu orchestrator with a backend, web UI, Discord gateway clients, provider-specific AI model pipelines, and a global `waifus` CLI.

The app runs on your machine, stores its user data under `~/.dc-waifus`, and lets one orchestrator bot decide which configured waifu bot should answer in each Discord channel.

## Install From npm

Requires Node.js 20 or newer.

```sh
npm install -g @starlight-ai/discord-waifus@latest
waifus start
```

Open the web UI:

```text
http://127.0.0.1:3888
```

## Install From a GitHub Release

Download the `.tgz` release asset, then install it globally:

```sh
npm install -g ./starlight-ai-discord-waifus-1.0.0.tgz
waifus start
```

## Build From Source

```sh
git clone https://github.com/HeavenllyDemon/Discord-Waifus.git
cd Discord-Waifus
npm install
npm run build
npm run waifus -- start
```

For local development:

```sh
npm run waifus -- dev
npm run dev:frontend
```

## CLI

```text
waifus help
waifus start [--host 127.0.0.1] [--port 3888] [--data-root PATH]
waifus stop [--data-root PATH]
waifus restart [--host 127.0.0.1] [--port 3888] [--data-root PATH]
waifus status [--data-root PATH]
waifus doctor [--data-root PATH]
waifus clean [--force] [--include-logs] [--data-root PATH]
waifus update
```

`DC_WAIFUS_HOME=PATH` overrides the default `~/.dc-waifus` data root.

## Discord Setup

Create one Discord application for the orchestrator and one application for each waifu bot. In the web UI:

1. Configure the orchestrator bot token and Application ID in **Orchestrator**.
2. Configure provider API keys in **Providers**.
3. Configure each waifu model, persona, and bot token in **Waifus**.
4. Invite the bots to your Discord server from **Servers**.
5. Select at least one waifu for each channel where the system should run.

Required gateway intents:

```text
GUILDS
GUILD_MESSAGES
GUILD_MESSAGE_REACTIONS
MESSAGE_CONTENT
```

`MESSAGE_CONTENT` must be enabled in the Discord Developer Portal for complete channel context.

## AI Providers

The app groups supported models under:

- x.ai
- DeepSeek
- Anthropic
- OpenAI
- Z.AI

Each model has its own backend pipeline so provider-specific options can be exposed without flattening everything into one generic request shape.

## Data Layout

By default, runtime and user configuration lives in:

```text
~/.dc-waifus
```

Important folders:

```text
~/.dc-waifus/config.toml
~/.dc-waifus/user/providers.json
~/.dc-waifus/user/discord-bots.json
~/.dc-waifus/user/waifus/
~/.dc-waifus/user/servers/
~/.dc-waifus/user/memories.json
~/.dc-waifus/app/logs/
```

Use `waifus clean` only when you intentionally want to delete saved user data.

## Release Notes

Version `1.0.0` is the first stable release for the local backend, web UI, Discord runtime, npm CLI, and prebuilt waifu configuration flow.
