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

## Release & Publishing Workflow

Use the beta release script for normal version cuts. A short user request such as `next` or `next version` in the release flow means cut the next patch version unless the user names a specific valid SemVer version. Version names must be plain SemVer in `package.json` and `package-lock.json` such as `1.5.153`; GitHub tags and releases must be named `v<version>` such as `v1.5.153`. Do not use npm-invalid leading zero segments such as `1.5.001`.

Before releasing, inspect the current state:

```bash
git status --short
git log --oneline --decorate -8
npm pkg get version dependencies optionalDependencies files --json
PACKAGE_NAME="$(node -p "require('./package.json').name")"
NPM_CONFIG_CACHE=/tmp/codex-npm-cache npm view "$PACKAGE_NAME" version dist-tags --json
gh release view v<VERSION> --repo waifucave/discord-waifus --json tagName,url,assets 2>/dev/null
```

Run a non-mutating preflight first:

```bash
NPM_CONFIG_CACHE=/tmp/codex-npm-cache npm run release:beta -- <VERSION> --dry-run --message "<subject>" --details-file /tmp/waifus-release-notes-<VERSION>.md
```

Run the full release only when the user explicitly asks to publish:

```bash
NPM_CONFIG_CACHE=/tmp/codex-npm-cache npm run release:beta -- <VERSION> --yes --message "<subject>" --details-file /tmp/waifus-release-notes-<VERSION>.md
```

Use a descriptive single-line commit subject instead of `Release <VERSION>` when the diff has a clear purpose. Prefer Conventional Commit style when it fits, for example `fix: retry Discord auto-connect`, `feat: add prompt layout editor`, `docs: clarify setup flow`, or `chore: update release workflow`. Keep it imperative and specific to the shipped change.

Put release details in a temporary notes file and pass it with `--details-file`. The notes should be user-facing and concise:

```md
One-sentence summary of what changed.

- Concrete user-visible fix or feature.
- Backend, frontend, CLI, packaging, or docs impact.
- Migration, compatibility, or behavior notes if relevant.
- Verification or risk note only when useful.
```

The script reads the root npm package name from `package.json`, bumps `package.json` and `package-lock.json`, runs validation, packs into the ignored `release-artifacts/` directory, smoke-tests the tarball, commits, pushes `main`, creates the GitHub release, runs the `Root npm Package` workflow, verifies npm, verifies GitHub assets, and performs a fresh npm install smoke test. Treat the script as beta: watch its output and fall back to the manual checklist if it stops or reports an unexpected condition. Untracked files are ignored by default; commit them separately before the release if they must ship.

After publishing, independently verify:

```bash
PACKAGE_NAME="$(node -p "require('./package.json').name")"
NPM_CONFIG_CACHE=/tmp/codex-npm-cache npm view "$PACKAGE_NAME" version dist-tags license --json
gh release view v<VERSION> --repo waifucave/discord-waifus --json tagName,targetCommitish,url,assets
git status -sb
```

For OCR-sensitive releases, also confirm the npm-installed package reports bundled OCR through `tesseract.js` with `available: true`:

```bash
SMOKE_DIR="$(mktemp -d /tmp/waifus-npm-smoke-<VERSION>.XXXXXX)"
PACKAGE_NAME="$(node -p "require('./package.json').name")"
NPM_CONFIG_CACHE=/tmp/codex-npm-cache npm install --prefix "$SMOKE_DIR" -g "$PACKAGE_NAME@<VERSION>"
DC_WAIFUS_HOME="$SMOKE_DIR/home" "$SMOKE_DIR/bin/waifus" doctor
```

Keep release tarballs under `release-artifacts/`; do not leave `.tgz` files in the repo root or commit them. If npm auth fails locally, prefer the GitHub `Root npm Package` workflow because it uses the repository `NPM_TOKEN`.

The GitHub repository is `waifucave/discord-waifus`. During the npm scope migration, one bridge release may still publish as `@starlight-ai/discord-waifus`; after `package.json` changes to `@waifucave/discord-waifus`, use the same workflow and let the script derive tarball names from the package name.

## Security & Configuration Tips

Do not commit local runtime data, logs, provider keys, or `.dc-waifus/`. Configuration files containing credentials should be written with restricted permissions, matching the existing `config.toml` handling. Redact secrets in logs, tests, screenshots, and issue reports.
