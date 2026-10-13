# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20+ TypeScript ESM project for a local Discord waifu orchestrator. Runtime source lives in `src/`: `api/` exposes Fastify endpoints, `backend/` manages runtime and migrations, `cli/` powers `bin/waifus.mjs`, `discord/` handles Discord integration, `orchestration/` coordinates sessions, `storage/` contains persistence helpers, and `shared/schemas/` holds Zod contracts. The React/Vite dashboard is in `src/frontend/`. Tests live in `tests/**/*.test.ts`; generated outputs are `dist/` and `dist-frontend/` and should not be edited directly. Docs belong in `docs/`.

Remote management lives in `src/remote/` (local gateway, helper verification, transport, sessions), `src/backend/remoteAccess/` (host lifecycle), `src/api/remoteAccess.ts` (host endpoints), and `src/frontend/remote-shell/` (connection window). Read `CLAUDE.md` for detailed architecture and security invariants, and the README's Remote management section for the user-facing setup flow. Keep these files synchronized when behavior changes; verify the current source and package pins rather than treating old plans as current implementation.

## Build, Test, and Development Commands

- `npm run dev`: start the local CLI development flow via `waifus dev`.
- `npm run dev:frontend`: run the Vite dashboard on port 5173, proxying `/api` to `127.0.0.1:3888`.
- `npm run build`: compile backend TypeScript and build the frontend.
- `npm run build:backend`: compile only `src/**/*.ts` to `dist/`.
- `npm run test`: run the Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run typecheck`: type-check backend and frontend configs without emitting files.
- `npm run benchmark:decisions`: preview the isolated orchestrator decision benchmark; `-- --live` makes inference calls using saved provider keys. See `docs/decision-api-benchmark.md` for targets, costs, local Laya setup, and measurement limits.
- `npm run waifus -- remote`: start the separate local remote gateway and open its connection window. `remote status` and `remote stop` affect only that gateway.
- `npm run waifus -- start` / `restart`: launch or restart the ordinary local Discord host. It can coexist with `waifus remote`.

`DC_WAIFUS_HOME=PATH` selects an isolated data root. Pairings and installation identities belong to that root; use isolated roots for tests and preserve normal user data.

## Remote Management

- The host serves its dashboard and API on loopback and supervises a signed `ts-connect` helper. The remote gateway has its own helper and no Discord runtime. No separate Tailscale installation is required.
- First-time setup activates each installation, creates an invitation on the host, compares the safety phrase/identity on both devices, and requires host approval. Later connections reuse the saved pairing. Never put invitation tokens or bootstrap URLs in commands, logs, screenshots, or public docs.
- `pair.waifucave.com` handles bounded coordination metadata. Dashboard, API, assistant, file transfers, and event streams use the authenticated direct peer path. Keep direct-only enforcement: no DERP, TURN, peer relay, arbitrary proxy, or coordinator-origin fallback.
- The gateway downloads, verifies, and serves the host's exact dashboard bundle. Different app versions may interoperate only within their signed protocol compatibility window. Preserve gateway/host route policy, browser origin checks, session cookies, and CSRF checks.
- Browser sessions have no idle timeout or eight-hour cutoff. Authority lasts while the gateway process is alive and the browser retains its cookie; gateway restart, explicit invalidation, or cookie loss requires a new browser session. Saved device pairing is separate and persists. Bootstrap tokens remain single-use with a five-minute lifetime. The dashboard's periodic frame health check is local to the gateway and does not renew activation through Cloudflare.
- Host lifecycle/status endpoints are under `/api/remote-access`; reconnect is `POST /api/remote-access/reconnect`, and sanitized diagnostics are `GET /api/remote-access/diagnostics`. Assistant tools use the same API and authorization rules. Identity reset is local-only; remote management cannot stop/restart the host OS process. Reconnect failures do not authorize deleting trust or re-pairing.
- Supported remote targets are macOS ARM64, Windows x64/ARM64, and Linux x64/ARM64. Intel macOS and Linux ARMv7 are deferred; never substitute an incompatible helper. Initial beta coverage is five-platform native CI plus two-Mac live testing. Windows/Linux roaming and long-duration reliability remain follow-ups; do not claim a completed 24-hour soak.
- Helper installation/pair keys use native OS credential storage, with the existing protected-file fallback where applicable. A locked macOS login keychain can block launch; unlock interactively, never embed its password. Local failure diagnostics are bounded, private, allowlisted files under `app/logs/remote-diagnostics/`; they upload nothing and are best-effort.

## Model Gateway

`@waifucave/gateway` is a pinned npm dependency and the source of model/provider capabilities and parameter validation. Keep model definitions in the gateway rather than duplicating a catalog in this app. Provider credentials are resolved per request; the gateway does not store them. Meta Muse Spark and contributor variants are supported through this gateway; contributor variants enable training and must remain an explicit user choice. For mandatory decisions on models without named tool choice, use the existing JSON-schema response path when supported; do not silently weaken a required decision to automatic tools. The current gateway remains in use; changing to another SDK is a separate migration.

The experimental `one-shot` server mode uses native decision APIs separately from the gateway's chat catalog. `src/orchestration/oneShot/` owns upstream decision-only discovery, strict choice transport, bounded planning and optional supervised local Laya workers. Shared config validation is in `src/shared/schemas/oneShot.ts`. The current gateway still owns all text-generation models/providers/parameters; do not insert decision-only models into its chat picker. Candidates must support native choices; yes/no-only models are excluded without ranking workarounds. Private captures/reports remain ignored and historical decisions are not ground truth. Read the README and `docs/decision-api-benchmark.md` for limitations and evidence, not a guarantee of loop breaking.

The `--suite=loops` benchmark measures blind semantic repetition and scene/topic stagnation against healthy progression. Preserve real-chat message ages and exclude runtime loop hints and previous model decisions. Its compatible wire names are not production speaker/timer semantics; do not equate synthetic detection with real-room reliability or successful loop breaking.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Follow the existing style: two-space indentation, double quotes, semicolons, named exports, and explicit `.js` extensions in local imports compiled by `NodeNext`. Use `camelCase` for functions and variables, `PascalCase` for React components and classes, and descriptive file names such as `messageSplit.ts` or `ReasoningControls.tsx`. Keep shared validation in `src/shared/schemas/`.

## Testing Guidelines

Vitest runs in the Node environment and includes `tests/**/*.test.ts`. Name tests after the behavior or module under test, for example `storage.test.ts` or `messageSplit.test.ts`. Prefer isolated temp data roots using helpers from `tests/testUtils.ts`, and clean them up in `afterEach`. Add tests for API behavior, storage concurrency, orchestration decisions, CLI parsing, and regression-prone fixes.

For remote changes, cover the relevant lifecycle, revocation/re-pairing, direct readiness, route authorization, session/origin/CSRF, and helper verification regressions. Tests under `tests/e2e/` cover the connection shell, remote settings/dashboard, and assistant actions. Distinguish fixture tests, native installed-helper CI, and actual two-device network tests in reported results.

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

Remote release gates also require all five exact optional helper pins, registry integrities, signed manifests/binary hashes, and `remote-compatibility.json` to agree. The root workflow checks installed-helper launch and cold restart on each native target before publishing. Never bypass those checks to resolve an authentication failure.

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

Keep release tarballs under `release-artifacts/`; do not leave `.tgz` files in the repo root or commit them. The GitHub `Root npm Package` workflow uses the repository `NPM_TOKEN`; verify its result because credentials can expire. If authenticated manual publication is needed, publish the reviewed archive through:

```bash
node scripts/publish-archive.mjs <archive> <sha256> <package-name> <version> <latest|next> --yes
```

The wrapper checks archive bytes and identity and publishes from a private neutral path so npm metadata cannot disclose a personally named checkout. Use it for manual fallbacks as well; independently verify registry bytes, tags, and metadata afterward. Publication is separate from deploying: install the intended version on each machine, restart the host or remote gateway as appropriate, and check live state while preserving pairings and user data.

The GitHub repository is `waifucave/discord-waifus`, and the current npm package is `@waifucave/discord-waifus`. The `@starlight-ai` scope is historical migration context. Let the script derive tarball names from the current package name.

## Security & Configuration Tips

Do not commit local runtime data, logs, provider keys, or `.dc-waifus/`. Configuration files containing credentials should be written with restricted permissions, matching the existing `config.toml` handling. Redact secrets in logs, tests, screenshots, and issue reports.
