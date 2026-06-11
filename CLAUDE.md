# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — backend (`tsc -p tsconfig.json` → `dist/`) + frontend (`vite build` → `dist-frontend/`).
- `npm run build:backend` — backend only. Run this when you change `src/**/*.ts` and want the shipped CLI to pick the change up, since `bin/waifus.mjs` prefers `dist/cli/main.js` over the `tsx` fallback.
- `npm run typecheck` — type-checks backend and frontend configs separately, no emit.
- `npm run test` / `npm run test:watch` — Vitest, Node environment, `tests/**/*.test.ts`. Run one file with `npx vitest run tests/<name>.test.ts`; one test with `npx vitest run -t "<name pattern>"`.
- `npm run waifus -- <cmd>` — invoke the CLI through the local bin (`start`, `dev`, `stop`, `restart`, `status`, `doctor`, `clean`, `update`).
- `npm run dev:frontend` — Vite dashboard on `:5173`, proxies `/api` to `127.0.0.1:3888`. Pair with `npm run waifus -- dev` for end-to-end iteration.

`DC_WAIFUS_HOME=PATH` overrides the default `~/.dc-waifus` data root. Tests should use isolated roots via helpers in `tests/testUtils.ts` and clean up in `afterEach`.

## Architecture

Single-process local app. The CLI boots a Fastify backend that also serves the prebuilt React SPA. There is no separate server-side process.

**Startup pipeline** (`src/backend/server.ts:startBackend`): `runMigrations` → `loadAppConfig` → instantiate `StorageService` (per-resource locking JSON store rooted at the data root) → optional Discord connect (`maybeConnectDiscord`, gated by `runtime.autoConnectDiscord`) → build `RuntimeOrchestrator` → mount API via `createApiServer`. Runtime state is persisted to `~/.dc-waifus/runtime.json` so `waifus status`/`stop` can find the live process.

**Per-channel orchestration loop** (`src/orchestration/runtime.ts`): a Discord message event drives one async run per channel, gated by `AbortController`s in `activeRuns`. The flow per turn is: build context (`discord/contextBuilder.ts` + `orchestration/context.ts`) → orchestrator model returns one of `{ waifus | stage_manager | reviewer | no_reply }` → for each selected waifu, the model pipeline generates the reply → `messageSplit.ts` chunks it with `typingDelayMs` to simulate typing → optional reviewer pass can delete a flagged message. `stage_manager` and `no_reply` schedule an idle trigger via `idleTriggerTimers`.

**Provider abstraction** (`src/providers/`):
- `catalog.ts` is the single source of truth for which `(providerId, modelId)` pairs are exposed, plus capability flags (`supportsTools`, `reasoningControls`, `defaultTemperature`, etc.). Don't add models elsewhere.
- `pipelines.ts` builds three request shapes — `openai-compatible-chat`, `openai-responses`, `anthropic-messages` — each with provider-specific quirks: Anthropic thinking modes (`anthropicThinkingPayload`, plus sampling constraints when thinking is `enabled`/`adaptive`), DeepSeek thinking dropping `temperature`/`top_p` (`openAiChatSamplingOverrides`), and OpenAI gpt-5.x reasoning models rejecting `temperature`/`top_p` (`openAiResponsesSamplingOverrides`). When adding a model or touching request bodies, check whether a per-provider override helper already exists and extend it rather than branching inline.
- `stripUndefined` is applied to every request body, so the override helpers return `{ field: undefined }` to remove a key.

**Storage** (`src/storage/storageService.ts`, `src/shared/schemas/domain.ts`): everything user-owned is a revisioned JSON file under `~/.dc-waifus/user/` (providers, discord-bots, waifus, servers, memories, histories). Writes use atomic temp-file swap with per-resource locks. API mutations require `expectedRevision`; mismatch returns 412 (`StorageConflictError` → `conflict()` in `src/api/errors.ts`). Zod schemas in `src/shared/schemas/` are the authority for both on-disk format and API I/O — change them and the migrations together.

**Frontend** (`src/frontend/`): React 19 SPA. `views/` mirrors top-level navigation; shared client state lives in `state/runtimeStore.ts`. API types are mirrored in `src/frontend/api/types.ts` — these must stay in sync with `src/shared/schemas/domain.ts` manually (no codegen).

## Conventions

- ESM with `moduleResolution: NodeNext`. Local imports in `.ts` files must use `.js` extensions (e.g., `import { foo } from "./bar.js"`). This is enforced by the compiler.
- `dist/` and `dist-frontend/` are generated artifacts; never edit them. After backend changes, rerun `npm run build:backend` if you need the shipped CLI to use new code (otherwise `bin/waifus.mjs` falls back to `tsx` against `src/`).
- Backend tsconfig excludes `tests/` and `src/frontend/`; frontend has its own `src/frontend/tsconfig.json`.
- Tests prefer real on-disk behavior with temp roots over mocks (especially for storage/config concurrency).

## Gateway dependency (migration window, P2–P5)

- `@waifucave/gateway` is consumed as `file:../waifucave-gateway` (npm symlink). The sibling repo must be cloned **and built** — the package resolves from its `dist/`, so a missing/stale build breaks `src/api/server.ts` imports and every test that touches the API server.
- After changing gateway source: run `npm run build` in `../waifucave-gateway`. Nothing to re-run here (symlink); restart `waifus`/vitest to pick it up.
- The gateway HTTP API is mounted at `/api/llm/*` (`src/api/server.ts`); provider keys are read live per request from `user/providers.json` by `src/api/llmGatewayCredentials.ts` — the gateway never stores keys. `/api/models` and `/api/providers` carry the gateway registry as additive `gatewayModels`/`gatewayProviders` fields; the legacy fields still come from `src/providers/catalog.ts` and all chat traffic still goes through `src/providers/pipelines.ts` (until P3).
- Publishing is blocked while the `file:` dep exists: `scripts/check-no-file-deps.mjs` runs at the top of `release:beta`'s validate-and-pack step (the real release path — the workflow publishes a pre-packed tarball, which skips `prepublishOnly`) and in `prepublishOnly` as a backstop for manual `npm publish`. P6 swaps to a pinned registry version.
