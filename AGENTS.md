# Repository Guidelines

## Project Structure & Module Organization

This is a Node 20+ TypeScript ESM project for a local host of Discord waifus, each an autonomous agent with her own life. Runtime source lives in `src/`: `api/` exposes Fastify endpoints, `backend/` manages runtime and migrations, `cli/` powers `bin/waifus.mjs`, `discord/` handles Discord integration, `models/` is the winter model layer (`ModelClient`, curated catalog, credentials, errors), `life/` is the Living cast (intake, wake router and queue, life loop, tools, her home folder in `life/home/`, the simulated Bash in `life/bash/`, scheduler, web search/fetch), `orchestration/` keeps the runtime facade (`CastRuntime`) and the helpers the Living cast reuses, `storage/` contains persistence helpers, and `shared/schemas/` holds Zod contracts. The React/Vite dashboard is in `src/frontend/`. Dev-only remote contract vector tooling lives in `scripts/remote-contracts/` (never imported by `src/`). Tests live in `tests/**/*.test.ts`; generated outputs are `dist/` and `dist-frontend/` and should not be edited directly. Docs belong in `docs/`.

Remote management lives in `src/remote/` (local gateway, helper verification, transport, sessions), `src/backend/remoteAccess/` (host lifecycle), `src/api/remoteAccess.ts` (host endpoints), and `src/frontend/remote-shell/` (connection window). Read `CLAUDE.md` for detailed architecture and security invariants, and the README's Remote management section for the user-facing setup flow. Keep these files synchronized when behavior changes; verify the current source and package pins rather than treating old plans as current implementation.

## Build, Test, and Development Commands

- `npm run dev`: start the local CLI development flow via `waifus dev`.
- `npm run dev:frontend`: run the Vite dashboard on port 5173, proxying `/api` to `127.0.0.1:3888`.
- `npm run build`: compile backend TypeScript and build the frontend.
- `npm run build:backend`: compile only `src/**/*.ts` to `dist/`.
- `npm run test`: run the Vitest suite once.
- `npm run test:watch`: run Vitest in watch mode.
- `npm run typecheck`: type-check backend and frontend configs without emitting files.
- `npm run benchmark:decisions`: preview the isolated decision benchmark; `-- --live` makes inference calls using saved provider keys. See `docs/decision-api-benchmark.md` for targets, costs, local Laya setup, and measurement limits.
- `npm run waifus -- remote`: start the separate local remote gateway and open its connection window. `remote status` and `remote stop` affect only that gateway.
- `npm run waifus -- start` / `restart`: launch or restart the ordinary local Discord host. It can coexist with `waifus remote`.
- `npm run waifus -- help [topic]`, `get|set|unset|list`, `wake`, `life`, `files`, `schedule`, `watches`, `forget`, `usage`: every setting and each waifu's life and files from the terminal (over the running host's loopback API; `app` settings and `usage` also work with it stopped).
- `npm run docs:settings:generate` / `docs:settings:check`: regenerate or verify `docs/assistant-kb/settings.md` and the endpoint table in `docs/assistant-kb/api.md` from the settings registry and route help (a test fails when they are stale).

`DC_WAIFUS_HOME=PATH` selects an isolated data root. Pairings and installation identities belong to that root; use isolated roots for tests and preserve normal user data.

## Remote Management

- The host serves its dashboard and API on loopback and supervises a signed `ts-connect` helper. The remote gateway has its own helper and no Discord runtime. No separate Tailscale installation is required.
- First-time setup activates each installation, creates an invitation on the host, compares the safety phrase/identity on both devices, and requires host approval. Later connections reuse the saved pairing. Never put invitation tokens or bootstrap URLs in commands, logs, screenshots, or public docs.
- `pair.waifucave.com` handles bounded coordination metadata. Dashboard, API, assistant, file transfers, and event streams use the authenticated direct peer path. Keep direct-only enforcement: no DERP, TURN, peer relay, arbitrary proxy, or coordinator-origin fallback.
- The gateway downloads, verifies, and serves the host's exact dashboard bundle. Different app versions may interoperate only within their signed protocol compatibility window. Preserve gateway/host route policy, browser origin checks, session cookies, and CSRF checks.
- Normal launches open the remembered host's dashboard without the connection UI/banner. `waifus remote --setup` keeps activation/pairing and host selection separate. Re-running the CLI reopens the browser through an owner-private CLI-only launch capability; browser-origin requests cannot mint setup sessions. Keep the invisible frame isolation that prevents host-controlled top-level navigation.
- Browser sessions have no idle timeout or eight-hour cutoff; at the in-memory cap the least-recently-used session is evicted rather than refusing new ones. Owner-only browser-session files store public reconnect keys scoped to the exact host/trust/origin binding, never cookies, CSRF or private keys. The trusted frame stores a non-exportable WebCrypto key in IndexedDB and answers bounded one-use challenges to obtain fresh cookies/CSRF/helper authority after restart. Old cookies and bootstrap links remain invalid. Disconnect/forget clears recovery authority; trust/origin rotation never migrates it. Missing browser keys need a fresh CLI bootstrap, not new pairing. Recovery polling is local-only and passive for idle updates. Keep the stable trusted frame endpoint separate from the host's child origin.
- Host lifecycle/status endpoints are under `/api/remote-access`; reconnect is `POST /api/remote-access/reconnect`, and sanitized diagnostics are `GET /api/remote-access/diagnostics`. Assistant tools use the same API and authorization rules. Identity reset is local-only; remote management cannot stop/restart the host OS process. Reconnect failures do not authorize deleting trust or re-pairing.
- Supported remote targets are macOS ARM64, Windows x64/ARM64, and Linux x64/ARM64. Intel macOS and Linux ARMv7 are deferred; never substitute an incompatible helper. Initial beta coverage is five-platform native CI plus two-Mac live testing. Windows/Linux roaming and long-duration reliability remain follow-ups; do not claim a completed 24-hour soak.
- Helper installation/pair keys use native OS credential storage, with the existing protected-file fallback where applicable. A locked macOS login keychain can block launch; unlock interactively, never embed its password. Local failure diagnostics are bounded, private, allowlisted files under `app/logs/remote-diagnostics/`; they upload nothing and are best-effort.

## Idle-only updates

`src/backend/updates/` owns opt-in global-npm patch updates, private local control capabilities,
shared installation/worker locks, staging/signature checks, crash journal and bounded diagnostics.
`UpdateActivity` is a synchronous admission gate shared by API requests and runtime background work.
Passively open streams/status polls are not active conversations; finite calls/transfers, assistant
turns, reloads and live pairing/activation operations block preparation. Host and remote registrations
must coordinate all roles/data roots before replacement; never infer an unregistered sibling is idle.
Only local config changes may toggle `updates`; `GET /api/updates` is sanitized and remote-readable.
Development/test/source runtimes must not auto-update. macOS native-keychain status is probed without
unlocking or reading secrets; locked credentials postpone restart. An automatic gateway restart ends
old browser/helper authority; browser-key proof acquires fresh authority while preserving pairing.
Keep manual updater transaction locking and document rollback
limits. Test the race/failure paths without updating live global packages or using real credentials.

## Model Layer

`@yanlinglabs/winter-provider-runtime` and `@yanlinglabs/winter-provider-catalog` are pinned exactly and are the source of model/provider facts; every model call goes through `ModelClient` (`src/models/client.ts`). Keep model facts in winter's catalog rather than duplicating them in this app: `src/models/catalog.ts` only curates the installed catalog (allow list, price cap, feature checks). Provider credentials are read per call from `user/providers.json` and passed inline; never log them. Meta Muse Spark contributor variants enable training and must remain an explicit user choice. Never send a `role: "system"` message: system prompts go in `system`/`systemBlocks`. The `@waifucave/gateway` dependency was removed in Living cast L1.

The addressee detector's native decision APIs live in `src/life/detector/` (decision-only discovery at `GET /api/detector/models`, strict choice protocol, optional supervised local Laya worker), separate from the curated chat model list; do not insert decision-only models into the model picker. Candidates must support native choices; yes/no-only models are excluded without ranking workarounds. Private captures/reports remain ignored and historical decisions are not ground truth. Read `docs/decision-api-benchmark.md` for limitations and evidence.

The `--suite=loops` benchmark measures blind semantic repetition and scene/topic stagnation against healthy progression. Preserve real-chat message ages and exclude runtime loop hints and previous model decisions. Its compatible wire names are not production speaker/timer semantics; do not equate synthetic detection with real-room reliability or successful loop breaking.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules. Follow the existing style: two-space indentation, double quotes, semicolons, named exports, and explicit `.js` extensions in local imports compiled by `NodeNext`. Use `camelCase` for functions and variables, `PascalCase` for React components and classes, and descriptive file names such as `outputValidator.ts` or `ReasoningControls.tsx`. Keep shared validation in `src/shared/schemas/`.

## Testing Guidelines

Vitest runs in the Node environment and includes `tests/**/*.test.ts`. Name tests after the behavior or module under test, for example `storage.test.ts` or `outputValidator.test.ts`. Prefer isolated temp data roots using helpers from `tests/testUtils.ts`, and clean them up in `afterEach`. Add tests for API behavior, storage concurrency, life behavior, CLI parsing, and regression-prone fixes.

Tests never make live model, Exa or Discord calls: `tests/setup/noNetwork.ts` lets `fetch` reach only loopback, model calls go through winter fakes (`tests/modelFakes.ts`, `tests/lifeFixtures.ts`) or loopback servers, and lives run against the in-memory fake Discord. The live life evaluation (`tests/eval/lifeLive.eval.test.ts`) is skipped unless `WAIFUS_EVAL_LIVE=1` and costs money on the owner's keys: run it only with the owner's approval, with `WAIFUS_EVAL_KEYS_ROOT` pointing at a data root with keys, never the real `~/.dc-waifus` as the run's data root. Goldens in `tests/golden/__snapshots__/` are reviewed by the owner; update them deliberately (`npx vitest run tests/golden -u`) and say so.

For remote changes, cover the relevant lifecycle, revocation/re-pairing, direct readiness, route authorization, session/origin/CSRF, and helper verification regressions. Tests under `tests/e2e/` cover the connection shell, remote settings/dashboard, and assistant actions. Distinguish fixture tests, native installed-helper CI, and actual two-device network tests in reported results.

## Commit & Pull Request Guidelines

Recent history mixes imperative summaries (`Fix channel creation flow`) with Conventional Commit prefixes (`docs: add publishing details`, `chore: empty repository`). Prefer short, imperative messages; use `fix:`, `feat:`, `docs:`, or `chore:` when it clarifies scope. Pull requests should describe the user-visible change, list verification commands, link issues, and include screenshots for dashboard UI changes.

## Release & Publishing Workflow

Use the beta release script for normal version cuts. Starting with `2.111.1`, the app uses **major.feature.bugfix** numbering (`#.###.#`): increment the third segment for bugfixes, increment the middle segment and reset bugfix to zero for new feature releases, and increment the first segment for major releases. A short user request such as `next` or `next version` means the next bugfix version unless the user specifies otherwise. Keep canonical numeric SemVer in `package.json` and `package-lock.json`; the three-digit feature notation is not permission to add leading zeroes. GitHub tags/releases are `v<version>` (for example `v2.111.1`). The `1.5.x` series is historical. The `2.111.1` transition requires a one-time manual install on existing 1.x installations; idle updates remain limited to bugfixes within the same major/feature series. Do not weaken that boundary to migrate versions automatically.

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

Keep release tarballs under `release-artifacts/`; do not leave `.tgz` files in the repo root or commit them. The GitHub `Root npm Package` workflow publishes through npm trusted publishing (no stored token); verify its result, since the npm package's trusted publisher must match this repo and workflow file. If authenticated manual publication is needed, publish the reviewed archive through:

```bash
node scripts/publish-archive.mjs <archive> <sha256> <package-name> <version> <latest|next> --yes
```

The wrapper checks archive bytes and identity and publishes from a private neutral path so npm metadata cannot disclose a personally named checkout. Use it for manual fallbacks as well; independently verify registry bytes, tags, and metadata afterward. Publication is separate from deploying: install the intended version on each machine, restart the host or remote gateway as appropriate, and check live state while preserving pairings and user data.

The GitHub repository is `waifucave/discord-waifus`, and the current npm package is `@waifucave/discord-waifus`. The `@starlight-ai` scope is historical migration context. Let the script derive tarball names from the current package name.

## Security & Configuration Tips

Do not commit local runtime data, logs, provider keys, or `.dc-waifus/`. Configuration files containing credentials should be written with restricted permissions, matching the existing `config.toml` handling. Redact secrets in logs, tests, screenshots, and issue reports.
