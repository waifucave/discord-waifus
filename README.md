## Install Now

```bash
npm install -g @starlight-ai/discord-waifus
waifus
```

# Waifu Orchestrator

Local-first Discord bot orchestration for multi-character AI group chats.

README test marker: update verification note.

This repo uses a split runtime layout:

- committed defaults and catalogs live in `defaults/`
- local runtime state lives in `.waifus/`

## Packages

- `packages/backend`: Express + Socket.IO + discord.js runtime
- `packages/dashboard`: Next.js control panel
- `packages/cli`: the global `waifus` command

## Prerequisites

- Node.js 20+
- `pnpm` 10+
- 1 or more Discord bot applications

## Local URLs

The current network model is fixed to local-machine defaults:

- dashboard: `http://localhost:3000`
- backend API: `http://127.0.0.1:4000`
- socket URL defaults to `ws://<current-host>:4000`

Use `waifus open` instead of manually typing the dashboard URL.

## Quick Start

### New clone

```bash
pnpm install
pnpm --filter @starlight-ai/discord-waifus build
pnpm --filter @starlight-ai/discord-waifus link --global
waifus use "$(pwd)"
waifus init-config
waifus build
waifus start
waifus open
```

### Global CLI + no manual clone

Install the global command and let it bootstrap everything on first run:

```bash
npm install -g @starlight-ai/discord-waifus
waifus
waifus open
```

On first run, `waifus` will:
- download the repo into `~/Discord-Waifus`
- install dependencies
- build the app if needed
- initialize the local `.waifus/` runtime
- start the backend and dashboard

After that, starting the local stack again is just:

```bash
waifus
```

To refresh that downloaded copy later without losing `.waifus/`, run:

```bash
waifus update
```

You can still use `waifus init ~/Discord-Waifus --repo https://github.com/<owner>/<repo>` if you want to choose the target directory manually.

## Runtime Layout

### Committed to GitHub

```text
defaults/
  config.toml
  channels.toml
  orchestrator.toml
  stage-manager.toml
  providers.catalog.json
  waifus/
    default-waifu.json
```

### Local-only runtime state

```text
.waifus/
  config.toml
  providers.toml
  keys.toml
  channels.toml
  orchestrator.toml
  stage-manager.toml
  waifus/
  stage-manager-data/
  assets/
  state/
```

Key rules:

- `.waifus/` is user-local and should never be committed
- provider API keys live in `.waifus/keys.toml`
- bot tokens live in `.waifus/waifus/*.json`
- stage-manager relationship and memory state lives in `.waifus/stage-manager-data/*.json`
- stage-manager checkpoints live in `.waifus/state/stage-manager-checkpoints.json`

## Dashboard-First Configuration

Normal setup should happen through the dashboard after first start:

1. `npm install -g @starlight-ai/discord-waifus`
2. `waifus`
3. `waifus open`
4. configure providers, waifus, channels, orchestrator, and stage manager in the UI

Immediate dashboard/API writes still apply without requiring a restart. If you edit `.waifus/` files manually on disk, apply them with:

```bash
waifus restart
```

## CLI Commands

```bash
waifus use <project-path>
waifus init <target-dir> [--repo <github-repo>] [--ref <git-ref>]
waifus doctor
waifus init-config
waifus update
waifus build
waifus start
waifus stop
waifus restart
waifus status
waifus logs
waifus open
waifus run backend
waifus run dashboard
```

Important behavior:

- `waifus doctor` validates the `defaults/` + `.waifus/` layout, build artifacts, and unresolved `env:` / `${...}` placeholders
- `waifus init` downloads the project from GitHub into a fresh directory and registers it with the global CLI
- `waifus init-config` bootstraps `.waifus/` from `defaults/`
- `waifus update` first checks npm for a newer global CLI, updates it when available, then refreshes an archive-bootstrapped install from GitHub, preserves local runtime data, reinstalls dependencies, and rebuilds
- `waifus start/stop/restart/status/logs` manage local PM2-backed services
- `waifus run backend` and `waifus run dashboard` run foreground services with the same fixed local env defaults used by PM2

## Secrets and Environment References

The preferred path is entering secrets in the dashboard so they stay in `.waifus/` on that machine only.

Advanced users can still reference environment variables in local runtime files:

```json
{
  "botToken": "env:YUKI_BOT_TOKEN"
}
```

```toml
[[provider_keys]]
id = "openai"
api_key = "${OPENAI_API_KEY}"
```

`waifus doctor` reports unresolved environment placeholders before start.

## Discord Bot Setup

Do this once per waifu:

1. Open <https://discord.com/developers/applications>.
2. Create a new application.
3. Create the bot user under the **Bot** tab.
4. Copy the bot token into the waifu editor.
5. Enable **MESSAGE CONTENT INTENT** and **SERVER MEMBERS INTENT**.
6. Use **OAuth2 > URL Generator** with the `bot` scope.
7. Grant the required bot permissions and invite the bot to your server.
8. Copy the application ID into the waifu editor when available.

## Notes

- draft waifus can exist locally in `.waifus/waifus/*.json` without being runtime-ready
- the repo-shipped defaults are bootable and contain no live secrets
