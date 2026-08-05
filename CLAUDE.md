# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run build` — backend (`tsc -p tsconfig.json` → `dist/`) + frontend (`vite build` → `dist-frontend/`).
- `npm run build:backend` — backend only. Run this when you change `src/**/*.ts` and want the shipped CLI to pick the change up, since `bin/waifus.mjs` prefers `dist/cli/main.js` over the `tsx` fallback.
- `npm run typecheck` — type-checks backend and frontend configs separately, no emit.
- `npm run test` / `npm run test:watch` — Vitest, Node environment, `tests/**/*.test.ts`. Run one file with `npx vitest run tests/<name>.test.ts`; one test with `npx vitest run -t "<name pattern>"`.
- `npm run waifus -- <cmd>` — invoke the CLI through the local bin (`start`, `dev`, `stop`, `restart`, `status`, `doctor`, `clean`, `update`).
- `npm run dev:frontend` — Vite dashboard on `:5173`, proxies `/api` to `127.0.0.1:3888`. Pair with `npm run waifus -- dev` for end-to-end iteration.
- `npm run release:beta -- <version> --yes --message "..."` — full release from a clean `main`: validates (tests, build, `check-no-file-deps`), packs, pushes the `v<version>` tag, and the GitHub workflow publishes the tarball to npm (`npm publish <tarball>` runs no lifecycle scripts, so `prepublishOnly` never fires on that path). Deploying to a machine is a separate manual `npm install -g @waifucave/discord-waifus@<version>` + `waifus restart`.

`DC_WAIFUS_HOME=PATH` overrides the default `~/.dc-waifus` data root. Tests should use isolated roots via helpers in `tests/testUtils.ts` and clean up in `afterEach`.

## Architecture

Single-process local app. The CLI boots a Fastify backend that also serves the prebuilt React SPA. There is no separate server-side process.

**Startup pipeline** (`src/backend/server.ts:startBackend`): `runMigrations` → `loadAppConfig` → instantiate `StorageService` (per-resource locking JSON store rooted at the data root) → optional Discord connect (`maybeConnectDiscord`, gated by `runtime.autoConnectDiscord`) → build `RuntimeOrchestrator` → mount API via `createApiServer`. Runtime state is persisted to `~/.dc-waifus/runtime.json` so `waifus status`/`stop` can find the live process.

**Per-channel orchestration loop** (`src/orchestration/runtime.ts`): a Discord message event drives one async run per channel, gated by `AbortController`s in `activeRuns`. The flow per turn is: build context (`discord/contextBuilder.ts` + `orchestration/context.ts`) → orchestrator decision returns one of `{ waifus | stage_manager | reviewer | no_reply }` → for each selected waifu, the model pipeline generates the reply → `messageSplit.ts` chunks it with `typingDelayMs` to simulate typing → optional reviewer pass can delete a flagged message. `stage_manager` and `no_reply` schedule an idle trigger via `idleTriggerTimers`. Two per-server switches on `ServerConfig` gate this: `orchestratorMode` (`"model"` uses the orchestrator model; `"deterministic"` — also forced when no orchestrator model is configured — uses `deterministicOrchestrator.ts`, structural speaker selection with zero API spend) and `stageManagerEnabled` (false short-circuits stage-manager and dream passes).

**Restart resume** (`src/orchestration/restartResume.ts`): at boot, a planner inspects each channel's persisted decisions and timers and schedules catch-up wakes. A human message that arrived while the process was down outranks any restored timer (the executor fetches fresh context best-effort to detect this), so deploy-window messages get a prompt reply instead of waiting out an old idle schedule.

**Model pipeline** (`src/orchestration/pipeline/`): every model call goes through `gatewayPipeline.ts`, which builds and sends requests via `@waifucave/gateway` (see below). `resolveTarget.ts` resolves `(providerId?, modelId)` pairs, `params.ts` leniently conforms stored params to the target model, `messages.ts`/`timeline.ts` shape the chat timeline. `src/providers/` holds only shared request/role types (`types.ts`) — the old in-app catalog/pipelines are gone.

**Storage** (`src/storage/storageService.ts`, `src/shared/schemas/domain.ts`): everything user-owned is a revisioned JSON file under `~/.dc-waifus/user/` (providers, discord-bots, waifus, servers, memories, histories). Writes use atomic temp-file swap with per-resource locks. Zod schemas in `src/shared/schemas/` are the authority for both on-disk format and API I/O — change them and the migrations together. `resolveDataPath` has no traversal guard of its own — any route that builds a path from a request id must call `assertSafeId` first.

**API conventions** (`src/api/server.ts`, `src/api/errors.ts`): errors carry a machine-readable `code` (`BadRequest`/`NotFound`/`Conflict`/`PreconditionRequired`) via `ApiError`. Revision enforcement is deliberately split: waifu and memory writes require `expectedRevision` (missing → 428, mismatch → 409); other resources accept it optionally and are last-writer-wins otherwise. `params` on waifu/agent-config PUTs merge server-side — an explicit `null` value unsets a key, omission keeps it — so dashboard editors must send `null` for keys the user removed (see `mergeParamsPatch`). `waifu.botId` uses the same null-to-unset pattern.

**Frontend** (`src/frontend/`): React 19 SPA. `screens/` mirrors top-level navigation (`nav.ts`); shared client state lives in `state/runtimeStore.ts`. API types are mirrored in `src/frontend/api/types.ts` — these must stay in sync with `src/shared/schemas/domain.ts` manually (no codegen).

**Dashboard assistant** (`src/api/assistant/`): a built-in agent reachable from the dashboard chat. `routes.ts` exposes conversations under `/api/assistant/*` with SSE streaming; `service.ts` runs the gateway-pipeline tool loop; `tools.ts` defines self-REST tools that mutate app state by dispatching to the app's own HTTP routes via `app.inject` (with revision-conflict retry). Its knowledge base is `docs/assistant-kb/*.md`, served read-only at `/api/docs` — update those docs when endpoint semantics change.

## Conventions

- ESM with `moduleResolution: NodeNext`. Local imports in `.ts` files must use `.js` extensions (e.g., `import { foo } from "./bar.js"`). This is enforced by the compiler.
- `dist/` and `dist-frontend/` are generated artifacts; never edit them. After backend changes, rerun `npm run build:backend` if you need the shipped CLI to use new code (otherwise `bin/waifus.mjs` falls back to `tsx` against `src/`).
- Backend tsconfig excludes `tests/` and `src/frontend/`; frontend has its own `src/frontend/tsconfig.json`.
- Tests prefer real on-disk behavior with temp roots over mocks (especially for storage/config concurrency).

## Gateway dependency

- `@waifucave/gateway` is a pinned registry dependency (see `package.json`) installed normally from npm — the migration-era `file:` symlink to the sibling repo is gone. All chat traffic, capability data, and write-side param validation go through it.
- The gateway is the single source of truth for models/providers/param capabilities (declarative registry + constraint rules). There is no in-app model catalog. `resolveModelTarget` (`src/orchestration/pipeline/resolveTarget.ts`) resolves `(providerId?, modelId)` pairs incl. legacy-id remaps; writes normalize legacy ids to the resolved pair.
- The gateway HTTP API is mounted at `/api/llm/*` (`src/api/server.ts`); the SPA reads models/capability docs/validation from it (`src/frontend/api/llm.ts` — TYPE-ONLY imports from the package in frontend code; value imports are forbidden client-side because the Registry touches `node:fs`). Provider keys are read live per request from `user/providers.json` by `src/api/llmGatewayCredentials.ts` — the gateway never stores keys. `/api/providers` serves credentials-status (redacted key hints) over the full registry plus `gatewayProviders`; there is no `/api/models`.
- Configs store gateway-native dotted `params` (`temperature`, `reasoning.enabled`, …). Write endpoints validate resolved stored state via `gateway.validate()` → 400 `unsupported_parameter` naming the violated rule; the chat path pre-conforms leniently (`src/orchestration/pipeline/params.ts`). PATCH bodies must never let zod manufacture `.default()` values into merges — defaulted fields are re-declared truly-optional in the body schemas (see the comments in `src/api/server.ts`).
- To develop against a local gateway checkout: `npm link ../waifucave-gateway` (build it first: `npm run build` there), and unlink/`npm ci` before committing lock changes. `scripts/check-no-file-deps.mjs` blocks `file:` deps from ever reaching a release (runs in `release:beta`'s validate-and-pack and `prepublishOnly`).
- The gateway repo has CI (test + live drift check + publish-freshness guard): if you change gateway `data/`/`src/` without bumping its version while that version is already published, CI fails — bump and republish.
