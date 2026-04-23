# @starlight-ai/discord-waifus

`@starlight-ai/discord-waifus` provides the global `waifus` command for the local Discord Waifus stack.

## Install

After publication:

```bash
npm install -g @starlight-ai/discord-waifus
```

From a clone:

```bash
pnpm --filter @starlight-ai/discord-waifus build
pnpm --filter @starlight-ai/discord-waifus link --global
```

## Typical Flow

### Existing clone

```bash
waifus use /path/to/Discord-Waifus
waifus init-config
waifus build
waifus start
waifus open
```

### First run with no existing project

```bash
waifus
waifus open
```

On first run, `waifus` downloads the latest GitHub Release bundle into `~/Discord-Waifus`, saves that directory as the default project root, runs `pnpm install --prod --frozen-lockfile`, initializes local runtime files, and starts the local stack.

### Refresh an existing release-bundle install

```bash
waifus update
```

`waifus update` downloads the latest GitHub Release bundle into the existing project root, preserves local runtime data such as `.waifus/`, reinstalls runtime dependencies, and restarts the stack if it was already running.

### Download from GitHub into a custom directory

```bash
waifus init ~/Discord-Waifus --repo https://github.com/HeavenllyDemon/Discord-Waifus
waifus start
waifus open
```

You can also pin a specific GitHub Release:

```bash
waifus init ~/Discord-Waifus --release app-v0.3.0
```

## Runtime Model

- committed defaults live in `defaults/`
- local runtime state lives in `.waifus/`

This CLI is for local-machine usage. The dashboard runs on `http://localhost:3000` and the backend API runs on `http://127.0.0.1:4000`.
