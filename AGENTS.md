# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20+ TypeScript ESM project for a local Discord waifu orchestrator. Runtime source lives in `src/`: `api/` exposes Fastify endpoints, `backend/` manages runtime and migrations, `cli/` powers `bin/waifus.mjs`, `discord/` handles Discord integration, `orchestration/` coordinates sessions, `storage/` contains persistence helpers, and `shared/schemas/` holds Zod contracts. The React/Vite dashboard is in `src/frontend/`. Tests live in `tests/**/*.test.ts`; generated outputs are `dist/` and `dist-frontend/` and should not be edited directly. Docs belong in `docs/`.

## Build, Test, and Development Commands

- `npm run dev`: start the local CLI development flow via `waifus dev`.
- `npm run dev:frontend`: run the Vite dashboard on port 5173, proxying `/api` to `127.0.0.1:3888`.
- `npm run build`: compile backend TypeScript and build the frontend.
- `npm run build:backend`: compile only `src/**/*.ts` to `dist/`.
- `npm run test`: run the Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run typecheck`: type-check backend and frontend configs without emitting files.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Follow the existing style: two-space indentation, double quotes, semicolons, named exports, and explicit `.js` extensions in local imports compiled by `NodeNext`. Use `camelCase` for functions and variables, `PascalCase` for React components and classes, and descriptive file names such as `messageSplit.ts` or `ReasoningControls.tsx`. Keep shared validation in `src/shared/schemas/`.

## Testing Guidelines

Vitest runs in the Node environment and includes `tests/**/*.test.ts`. Name tests after the behavior or module under test, for example `storage.test.ts` or `messageSplit.test.ts`. Prefer isolated temp data roots using helpers from `tests/testUtils.ts`, and clean them up in `afterEach`. Add tests for API behavior, storage concurrency, orchestration decisions, CLI parsing, and regression-prone fixes.

## Commit & Pull Request Guidelines

Recent history mixes imperative summaries (`Fix channel creation flow`) with Conventional Commit prefixes (`docs: add publishing details`, `chore: empty repository`). Prefer short, imperative messages; use `fix:`, `feat:`, `docs:`, or `chore:` when it clarifies scope. Pull requests should describe the user-visible change, list verification commands, link issues, and include screenshots for dashboard UI changes.

## Security & Configuration Tips

Do not commit local runtime data, logs, provider keys, or `.dc-waifus/`. Configuration files containing credentials should be written with restricted permissions, matching the existing `config.toml` handling. Redact secrets in logs, tests, screenshots, and issue reports.
