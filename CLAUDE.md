# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read alongside `AGENTS.md` for repository/release guidelines and the README's Remote management
section for setup instructions. Keep all three synchronized with current behavior; historical
specs and plans describe earlier checkpoints and do not establish present release readiness.

## Commands

- `npm run build` — backend (`tsc -p tsconfig.json` → `dist/`) + frontend (`vite build` → `dist-frontend/`).
- `npm run build:backend` — backend only. Run this when you change `src/**/*.ts` and want the shipped CLI to pick the change up, since `bin/waifus.mjs` prefers `dist/cli/main.js` over the `tsx` fallback.
- `npm run typecheck` — type-checks backend and frontend configs separately, no emit.
- `npm run test` / `npm run test:watch` — Vitest, Node environment, `tests/**/*.test.ts`. Run one file with `npx vitest run tests/<name>.test.ts`; one test with `npx vitest run -t "<name pattern>"`.
- `npm run benchmark:decisions` — preview bounded decision judgments without inference; `-- --live` runs the benchmark through `ModelClient` using saved provider settings. Local Laya uses a separate Python environment. See `docs/decision-api-benchmark.md`; this tooling does not enable anything in production.
- `npm run waifus -- <cmd>` — invoke the CLI through the local bin (`start`, `dev`, `stop`, `restart`, `status`, `remote`, `doctor`, `clean`, `update`). `remote status` and `remote stop` target only the remote gateway daemon.
- `npm run dev:frontend` — Vite dashboard on `:5173`, proxies `/api` to `127.0.0.1:3888`. Pair with `npm run waifus -- dev` for end-to-end iteration.
- `npm run release:beta -- <version> --yes --message "..."` — full release from a clean `main`: validates (tests, build, `check-no-file-deps`), packs, pushes the `v<version>` tag, and the GitHub workflow publishes the tarball to npm (`npm publish <tarball>` runs no lifecycle scripts, so `prepublishOnly` never fires on that path). Deploying to a machine is a separate manual `npm install -g @waifucave/discord-waifus@<version>` + `waifus restart`.

Remote releases additionally require all five exact optional helper pins and matching registry
integrities/signatures/compatibility before packing. `release:beta --dry-run` checks the proposed
version in memory without changing tracked version files. The root publish workflow requires
installed-helper launch/cold-restart checks on every native target before using `NPM_TOKEN`.
The five `@waifucave/ts-connect-*` helper packages are published: `package.json` pins them
exactly (currently 0.1.13) and `package-lock.json` resolves each from registry.npmjs.org with an
integrity hash. A helper bump must publish all five first; a missing one blocks the release.
Always publish reviewed tarballs using `scripts/publish-archive.mjs <archive> <sha256>
<package-name> <version> <latest|next> --yes` on macOS/Linux, including manual fallbacks.
It verifies immutable bytes and package identity, then uses a private neutral temporary path:
npm adds `_from`/`_resolved` hints to registry metadata, so publishing directly from a personally
named checkout can disclose the local account path even when the archive itself is clean.
The command does not waive any release gates or authenticate on the user's behalf, and an
accepted upload still requires independent registry availability/hash/privacy verification.

`DC_WAIFUS_HOME=PATH` overrides the default `~/.dc-waifus` data root. Tests should use isolated roots via helpers in `tests/testUtils.ts` and clean up in `afterEach`.

## Architecture

The ordinary host is one local Node process: the CLI boots a Fastify backend that also serves the
prebuilt React SPA and Discord runtime. When Remote Access is enabled, that host supervises one
platform-specific `ts-connect` child. `waifus remote` is a separate local Node gateway with no
Discord runtime and supervises its own remote-role helper child.

**Startup pipeline** (`src/backend/server.ts:startBackend`): acquire the exclusive host lock `app/host.lock` (`src/storage/instanceLock.ts`: pid + OS process start time + nonce; a second host on the same data root fails fast, stale locks are broken; the remote gateway role does not take it) → `runMigrations` (`src/backend/migrations.ts`; legacy shape steps run once and are recorded in the `app/migrations.json` ledger, the frozen legacy model-id remap re-runs per app version, and invariant checks such as remote-state hardening and the stored-effort check run every boot — a missing/corrupt ledger, or an `app/runtime.json` written by a different version than the ledger's, re-runs every idempotent step; new steps get a new id) → `loadAppConfig` → instantiate `StorageService` (per-resource locking JSON store rooted at the data root) → optional Discord connect (`maybeConnectDiscord`, gated by `runtime.autoConnectDiscord`) → build `CastRuntime` (which starts the `LivingCast`) → mount API via `createApiServer`. Runtime state is persisted to `~/.dc-waifus/runtime.json` so `waifus status`/`stop` can find the live process; they verify the pid against the lock's start time (or pid.json `startedAt`) before reporting or signalling it, so a pid reused after a crash is treated as stale. Start times come from `ps` on macOS/Linux; Windows falls back to pid liveness.

**Living cast (spec `docs/specs/2026-10-24-living-cast-design.md`; L1 and L2 done, L3 = API,
settings registry, CLI and dashboard)**: each waifu is an autonomous agent with one continuous
life; there is no director. `CastRuntime` (`src/orchestration/runtime.ts`) keeps the Discord
lifecycle, guild/channel sync, threads, DM eligibility, forget and pause/resume, and owns one
`LivingCast` (`src/life/livingCast.ts`): House bot → **intake** (`intake.ts`: guild bursts coalesce
2 s, DMs wait for a 30 s quiet timer capped at 180 s, mentions/replies/names/`@everyone`/shared
roles/watches map straight to wakes, everything else goes to the addressee detector in
`detector/`) → **wake router** (`wakeRouter.ts`, guards in spec order: paused, DM rate limit,
per-user wake limit, sleep, budget, room loop guard; the owner skips 3–6; `@everyone` wakes are
staggered) → the persistent **wake queue** (`wakeQueue.ts`, `wakes.json`) → the **life loop**
(`lifeLoop.ts`: one turn at a time per waifu under the `life:<id>` lock, host-wide
`life.maxConcurrentTurns`; notifications, the tool loop, the unsent-reply check, caps) →
`ModelClient`. The prompt (`lifeHarness.ts`, `request.ts`) is system blocks [A, B] snapshotted per
epoch, the epoch's log with permanent time lines, and compaction (`compaction.ts`) keeps the last
three complete turns. Tools live in `tools/` (messages, notes, planning, web), web search/fetch in
`search.ts` over `web/` (a thin adapter over `@yanlinglabs/winter-web`: Exa's hosted MCP, keyless
by default with the `exa` provider credential as fallback, and the SSRF-checked page fetcher, always
`privateAddressPolicy: "deny"`, with a digest call, purpose `web`). Per-waifu data: `user/waifus/<id>/life/` (`state.json`,
`log/<epoch>.jsonl`, `intents.jsonl`, `reads.json`, `handles.json`, `wakes.json`, `watches.json`,
`schedule.json`, `maintenance.jsonl`, `pending-scrubs.json`, `usage.json`) and her notes in
`user/waifus/<id>/notes/` (`MEMORY.md` index). Boot repairs every life (`repair.ts`), runs queued
owner forget scrubs, then catches up (`resumeWindowMinutes`); the scheduler (`scheduler.ts`, 15 s tick)
fires reminders, drops expired watches, sends the `morning` batch when sleep ends and runs nightly
maintenance with any pending scrubs (`maintenance.ts`). The House bot owns
`/wake` and `/print` (Administrator only, checked again at run time); DM bots keep `/forget`.
Tests: `tests/life*.test.ts` over `tests/lifeFixtures.ts` (fake Discord, fixed clock, scripted
winter fakes), goldens in `tests/golden/__snapshots__/` (owner review), the cache simulation in
`tests/eval/cacheHit.test.ts`, and the live eval `tests/eval/lifeLive.eval.test.ts` (skipped unless
`WAIFUS_EVAL_LIVE=1`; needs the owner's keys and approval). The whole suite runs behind a
loopback-only `fetch` (`tests/setup/noNetwork.ts`). The word "orchestrator" survives only in
migrations, the bots-file key (`discord-bots.json` `orchestrator` = the House bot), the archive
path and the legacy usage purpose.

**Model layer** (`src/models/`, spec §9): every model call goes through `ModelClient`
(`client.ts`, `call` and `stream`) on winter's provider runtime: winter route resolution → winter's
history renderer → `adapter.streamTurn` (retries happen inside the adapter, before the first byte)
→ the stream assembler (`assemble.ts`) → one usage-ledger line per call, including aborted and
failed ones. System prompts are passed as `system` (blocks joined by a blank line) plus
`systemBlocks` (cache scope `org`), `cacheTtl: "1h"` and `messageCacheTtl: { rolling: "1h" }`;
**`messages` never carry a `role: "system"` entry**. `catalog.ts` is the curated view over the
installed winter catalog (allow list in `defaults.ts`, price cap, hidden routes with reasons, the
OpenRouter reasoning-replay feature check); `credentials.ts` reads keys live from
`user/providers.json` and passes them inline per call (the gateway-era provider ids
`google-ai-studio`/`qwen` map to `google`/`alibaba`); `errors.ts` maps winter errors to app kinds
(`context_overflow`, `quota`, `billing`, `rate_limit`, `auth`, `aborted`, `other`; quota/billing
open provider cooldowns in `providerAlerts.ts`; winter's own `billing` code (0.0.57: 402s, Anthropic's
400 "credit balance is too low", OpenAI spend/billing limits) maps to `billing`, OpenAI
`insufficient_quota` and usage-window codes stay `quota`, and a small fallback list covers what winter
still leaves as `bad_request`). A `ModelCallError` carries
`committed` (part of the answer — text, a tool call or reasoning — had arrived, as the assembler's
tap saw it; a bare `message_start` or role-only chunk is not) and is `retryable` only when winter
says so and nothing was committed; `imageOverflow` marks an image refusal. `summarize.ts` is the compaction
summarize helper;
`modelWarnings.ts` persists upgrade/boot warnings (`app/model-warnings.json`). Usage purposes are
`life`, `maintenance`, `detector`, `compaction`, `assistant`, `web` (older lines keep their legacy
purposes). Without a request cap, a route the catalog gives no `maxOutputTokens` gets
`DEFAULT_OUTPUT_CAP_TOKENS`. Cost prefers winter's `reportedCostUsd` (0 is a real value) over the
list-price estimate; failed and aborted lines are priced whenever usage is known. The captured
query/reply log (Activity, `/api/events`, diagnostics) never carries reasoning: `nativeState`,
signatures, encrypted reasoning and thinking blocks are stripped from the log copy
(`withoutReasoningPayloads` in `src/shared/queryLog.ts`); the provider still gets them.

**Migrations** (`src/backend/migrations.ts`, `src/backend/migrationSteps/`): steps are `once`
(legacy shape conversions, recorded in `app/migrations.json`), `once-per-app-version` (outcome
depends on code shipped with the app, e.g. the frozen legacy model-id remap) or `every-boot` (invariants,
never recorded). Every step is idempotent: re-running all of them (lost ledger, manual upgrades)
leaves the data root byte-identical (`tests/phase4Acceptance.test.ts`). Phase 4 added the
gateway-0.4.0 param cleanup (removed in Living cast L1; its id stays in the history comment), prompt-layout removal, explicit server context windows, global
memory origin/subjects with a one-time cross-guild dedupe (its own marker file survives ledger
loss), global pending observations and dream cursor, the URL-keyed OCR cache cleanup and the
`ocr.cacheTtlHours` 24 -> 168 default move. Phase 5 added `orchestrator-history-per-guild-v1` and
`server-drop-enabled-flags-v1`. Living cast L1 added `living-cast-models-v1` (once: gateway
provider ids → winter ids, each waifu/assistant model → nested `model: {providerId, modelId,
effort?}` by family, drops `params`, `contextWindow`, `personaDigest`, `tools.toolUse`; unmapped
models are unset and reported in `GET /api/runtime` → `models.warnings` with the old model as
`previous`; each original document is archived first under `user/.archive/living-cast/models/`,
which the schema stamp never touches, and a replaced provider key under
`user/.archive/living-cast/providers.json`) and
`living-cast-model-effort-check` (every boot: drops a stored effort the installed catalog no longer
lists for that route). Living cast L2 added five once-steps (`LIVING_CAST_L2_STEP_IDS`, spec §11.2,
in `migrationSteps/livingCast*.ts`): `living-cast-memories-to-notes-v1` (the memory store becomes
each waifu's notes; forgotten and pending-scrub users are left out; a corrupt forget record stops
the step), `living-cast-archive-director-v1` (director/stage-manager/reviewer data, guild
histories and sessions, conversation ledgers and contexts move under `user/.archive/living-cast/`;
a ledger's image keys are folded into `images.json` first), `living-cast-dm-state-v1`,
`living-cast-server-fields-v1` and `living-cast-app-config-v1`. Retired data shapes the migrations
still read live in `migrationSteps/legacySchemas.ts`; nothing else imports it. Legacy-step tests
run `MIGRATION_STEPS` minus the L2 ids; `tests/livingCastMigrations.test.ts` covers the L2 steps on
a realistic main-era root. Phase 4 must ship as a minor release (2.112.0): its
memory migrations cannot be read by 2.111.x, and downgrade is unsupported. Never
change a shipped step's id or meaning: add a new step with a new id, keep the removed steps' ids
in the history comment, and register it before the schema-version stamp, which stays last.
`promptLayout` may appear under `src/` only in the layout-removal migration and the one-release
PUT shim in `src/api/server.ts`.

**Discord features (Phase 5, spec 9):**
- *Conversation cache and guild directory* (`src/discord/conversationCache.ts`,
  `guildDirectory.ts`, `gatewayFeed.ts`): `ConversationMessageCache` is the life's message source
  (`readPage` serves `read_messages`). It keeps recent raw messages per conversation, fed by REST pages, gateway events
  (messages, edits, deletes, reactions) and our own sends (published before
  `sendWaifuMessage`/`sendDirectMessage` return). A conversation is trusted after a REST sync while
  its gateway scope (`guild`, or `dm:<waifuId>` per DM bot) stays connected; trusted reads make no
  REST call, so a pass usually costs 0 fetches. Reactions are event-fed summaries (never
  `users.fetch`) and reach the tail only. `GuildDirectory` keeps roles, emojis, channels and members
  current from gateway events (members by message authors, single fetches for unknown mentions and a
  periodic list refresh; the privileged GuildMembers intent is opt-in via
  `discord.guildMembersIntent`).
- *Server/channel flags*: server/channel `enabled` flags are gone: a channel is live when it has an
  enabled waifu, server `paused` is the kill switch.
- *Threads*: threads/forum posts are their own conversations that inherit the parent's cast
  unless the channel's `threads` is `"off"` (`stores/threads.ts`, `threads.json`).
- *Debounce* (`src/orchestration/debounce.ts`, `discord.debounce.*`): the keyed debouncer behind
  the intake's DM quiet timer (`dmMs` 30 s, `dmMaxWaitMs` 180 s).
- *DMs* (`src/orchestration/dm/`): eligibility (`computeDmEligibility`: enabled waifu with a model,
  the only enabled waifu on an enabled waifu bot) decides which bots log in with
  `[Guilds, DirectMessages, DirectMessageReactions]`; a waifu write calls `reconcileDmIntents()`,
  which re-logs only bots whose intents changed. DM state lives in `user/dms/<userId>/<waifuId>.json`,
  rate-limit counters in `user/dms/<userId>/limits/<waifuId>.json` (pure math in `rateLimit.ts`).
  Every forget writes a floor message id (`floorMessageId`) so `ConversationMessageCache.setFloor`
  keeps older messages out for good. Routes: `GET /api/dms`, `GET /api/dms/:waifuId/:userId`,
  `POST /api/dms/:waifuId/:userId/forget` (`src/api/dms.ts`) and the owner's
  `POST /api/people/:userId/forget` (the DM part in `dm/forgetUser.ts`, then the life scrub of
  every waifu with a life or notes, `src/life/forget.ts`). DM bots register a BotDM-only `/forget`.
  Forget records (`dm/forgotten.ts`): the owner's forget-user adds `{userId, at}` to
  `user/people/forgotten.json` (spec §7.5) and queues an `owner_forget` entry in each life's
  `pending-scrubs.json` before scrubbing, cleared once the scrub ran; without a running runtime
  (Discord offline) the entries stay queued and run when that life next starts. A DM
  `/forget everything` inside the 6-hour window queues a `dm_forget_everything` entry for nightly
  maintenance (spec §7.3). Only a missing record file reads as empty; an unreadable one is moved
  aside to `<name>.corrupt-<ts>` with a warning on update and stops readers that must not guess
  (`ForgetRecordCorruptError`). Images a
  conversation showed are indexed durably in `user/conversations/<key>/images.json` (+ an
  append-only overflow past 5,000 keys; `src/discord/imageIndex.ts`), so a forget purges cached
  bytes and OCR text with or without the runtime (a legacy `ledger.json`'s image refs are read
  too). The fetcher and OCR record only refs that carry `conversationKey`; the life's image path
  renders with `renderDiscordMessage(..., { conversationKey })`, so a forget also purges images and
  OCR text a life fetched (`tests/lifeImages.test.ts`). Index
  writes and the directory's removal share one per-conversation queue
  (`forgetConversationImageIndex`), and a write never recreates a missing conversation directory.

**Storage** (`src/storage/storageService.ts`, `src/shared/schemas/domain.ts`): everything user-owned is a revisioned JSON file under `~/.dc-waifus/user/` (providers, discord-bots, waifus, the assistant config, servers incl. `threads.json`, `dms/<userId>/` DM state and rate-limit counters), except `user/usage/YYYY-MM-DD.jsonl`, the append-only usage ledger. Writes use atomic temp-file swap with per-resource locks. Zod schemas in `src/shared/schemas/` are the authority for both on-disk format and API I/O — change them and the migrations together. `resolveDataPath` throws if the joined path escapes the data root, but that is a backstop — any route that builds a path from a request id must still validate it first (`src/api/ids.ts`: `assertSafeId` rejects dot-only ids; guild/channel/user ids must be Discord snowflakes via `assertSnowflakeId`).

**API conventions** (`src/api/server.ts`, `src/api/errors.ts`): errors carry a machine-readable `code` (`BadRequest`/`NotFound`/`Conflict`/`PreconditionRequired`) via `ApiError`. Revision enforcement is deliberately split: waifu writes require `expectedRevision` (missing → 428, mismatch → 409); other resources accept it optionally and are last-writer-wins otherwise. A waifu's or the assistant's `model` is replaced whole when sent (`null` unsets it, omission keeps it) and must be a route `GET /api/models` offers with an effort that route lists (400 `model_not_available` / `unsupported_effort`). `waifu.botId` uses the same null-to-unset pattern.

**Frontend** (`src/frontend/`): React 19 SPA. `screens/` mirrors top-level navigation (`nav.ts`); shared client state lives in `state/` (`runtimeStore.ts` exists but is not wired into any screen yet — Phase 7 uses it for live status). API types are mirrored in `src/frontend/api/types.ts` — these must stay in sync with `src/shared/schemas/domain.ts` manually (no codegen). Every model choice (Cast, Onboarding, Settings → Assistant) uses `components/ModelPicker.tsx` over `GET /api/models` (route + effort); the Direction and Memory screens are gone.

**Dashboard assistant** (`src/api/assistant/`): a built-in agent reachable from the dashboard chat. `routes.ts` exposes conversations under `/api/assistant/*` with SSE streaming; `service.ts` runs the tool loop over `ModelClient.stream` (model from `PUT /api/assistant/config`, else an enabled waifu's model that is offered, keyed and not a contributor variant; text deltas stream as `text_delta` events); `tools.ts` defines self-REST tools that mutate app state by dispatching to the app's own HTTP routes via `app.inject` (with revision-conflict retry). Its knowledge base is `docs/assistant-kb/*.md`, served read-only at `/api/docs` — update those docs when endpoint semantics change.

**Remote management** (`src/remote/`, `src/backend/remoteAccess/`): the host and remote gateway both
use the same signed `ts-connect` helper package resolver and authenticated WIPC supervisor. The
helper owns installation/pair keys in the native OS vault, performs bounded coordination through
the compiled `pair.waifucave.com` profile, and carries dashboard/API traffic only over an
authenticated direct peer path. Fastify is never exposed as a network listener. The remote browser
normally opens its remembered host's dashboard without a visible connection screen/banner;
`waifus remote --setup` opens the isolated setup UI in `src/frontend/remote-shell/`. After pairing and direct
authentication, the gateway downloads, hashes, and serves the host's exact bundled dashboard from
its verified manifest. Browser origin/session/CSRF checks and the route policy remain enforced at
the gateway and host bridge. There is deliberately no DERP, TURN, peer-relay, or arbitrary
coordination-origin fallback.

**Remote contracts** (`contracts/remote/v1/`, `scripts/remote-contracts/`): the cross-repo JSON
schemas/fixtures are generated by `scripts/generate-remote-contracts.ts` (`npm run
contracts:remote:check` / `:generate`). Fixture builders and the TypeScript reference
implementations that only produce or cross-check vectors (control auth, endpoint envelopes, pair
control/confirmation, remote service crypto) live in `scripts/remote-contracts/` — dev-only,
typechecked by `scripts/remote-contracts/tsconfig.json`, never compiled into `dist/` or shipped.
Runtime code must not import from there; the shipped schemas stay in `src/shared/schemas/`.

**Pairing and operations:** activate each installation, create a host invitation, compare the
safety phrase/identity on both devices, and approve on the host before connecting. Saved pairing
is scoped to the data root and reused on subsequent connections. Ordinary host and remote gateway
processes can coexist. `src/api/remoteAccess.ts` exposes lifecycle/status under
`/api/remote-access`, including `POST /api/remote-access/reconnect` and
`GET /api/remote-access/diagnostics`; assistant tools dispatch through the same API and policy.
Identity reset is local-only. Remote management cannot stop/restart the host OS process.
Coordinator or direct-path failures require diagnosis/retry, not automatic trust deletion or
re-pairing. After ten helper failures in five minutes the supervisor stops fast restarts but keeps
one slow recovery attempt pending (10 minutes, then every 15, ±10% jitter) until a launch
authenticates or reconnect/stop/reset/close clears the circuit (`HELPER_CIRCUIT_RECOVERY_DELAYS_MS`). On macOS, a locked login keychain can block helper startup; unlock interactively
and consult the README for SSH-assisted setup without exposing credentials.

**Browser session lifetime** (`src/remote/gateway/session.ts`, `browserPersistence.ts`): sessions
have no idle timeout or eight-hour cutoff. The in-memory cap (1,024 per gateway launch) evicts the
least-recently-used session (recency = authenticated use) so CLI reopens/resumes can never be
locked out; an evicted browser recovers through key proof or a fresh CLI bootstrap. Owner-only files store only public browser reconnect
keys for the exact host/trust/origin binding. The trusted frame stores a non-exportable P-256
WebCrypto key in IndexedDB; bounded 30-second single-use challenges prove ownership and obtain
fresh cookies/CSRF and gateway/helper launch authority. Old cookies are rejected after restart;
private keys, cookies, CSRF, helper launches and bootstrap links are never saved by the gateway.
Recovery requires WebCrypto and IndexedDB. The numeric wire deadlines use
`REMOTE_SESSION_LIFETIME_SENTINEL_MS`, not a periodic renewal. The cookie is HttpOnly,
SameSite=Strict, Path=/ with no Max-Age/Expires. Disconnect/forget invalidates saved browser
authority; trust/origin changes never migrate it. Browser-key loss needs a fresh CLI bootstrap.
Re-running `waifus remote` reopens the window without a daemon restart through an owner-private
launcher; browser-origin requests cannot use that capability. Saved device
pairing persists independently, and revocation/origin/CSRF checks remain enforced. Bootstrap
tokens are still single-use and expire after five minutes. The invisible frame remains a security
boundary against host-controlled top-level navigation. Its stable private endpoint and local
passive health check restore the child after restart without another connection window. No
recovery polling renews activation through the coordinator or resets the update quiet window.

Production helper launch is fail-closed: `src/remote/helperReleaseTrust.ts` contains only reviewed
Ed25519 release public keys, `remote-compatibility.json` binds the exact app/helper/protocol window,
and `src/remote/helperBinary.ts` verifies package inventory, manifest signatures, binary/notices
hashes, target metadata, and embedded build info before execution. The five V1 targets are macOS
ARM64, Windows x64/ARM64, and Linux x64/ARM64. Intel macOS and Linux ARMv7 are later follow-ups
and must never fall back to the ARM64 helper. ARMv7 was explicitly deferred on 2026-10-02 because
real-device validation hardware was unavailable; no ARMv7 package ships in this initial set.
For the initial remote beta, the user approved five-platform native installed-package CI plus
two-Mac live-network validation (2026-10-10). Windows/Linux networking and roaming remain
explicitly untested follow-ups and must be disclosed in release notes. This does not waive
signature checks, direct-only enforcement, two-Mac acceptance, or independent npm download
verification. On 2026-10-11 the user explicitly removed the 24-hour production soak as a
release prerequisite, accepting initial-beta risk with privacy-safe failure diagnostics.
No completed 24-hour soak may be claimed. The user also approved npm's automatic initial
`latest` tag for helper 0.1.12 only; both `next` and `latest` must resolve to those exact
reviewed bytes. This exception does not relax native checks, signatures or compatibility.
The helper child receives only a validated local Unix D-Bus session address on Linux, so native
Secret Service works without inheriting the parent's credential environment. The existing
protected-file fallback remains available when no usable native session bus exists.
Host selection prepares the isolated gateway and sends a bounded, read-only `/api/health` request
over the helper's authenticated direct path; waiting for direct status before the first request
would deadlock startup. Its readiness monitor refreshes live helper status, re-registers the same
unexpired gateway launch after helper restart, and is cancelled before switching hosts or closing.
The browser still cannot open the selected dashboard until the helper confirms a direct path.
On Windows, Node-created installation/trust metadata gets a verified private current-user plus
LocalSystem DACL through built-in Windows PowerShell before any content is written. Unix mode
bits alone do not provide this guarantee. Existing metadata is not silently re-permissioned.
After a remote helper restart, a remembered selection may already be revoked. An authenticated
`helper_unavailable` rejection while restoring that selection is a connection failure, not a
helper launch failure: a validated inactive runtime stop keeps the helper available for pairing
and explicit retry. Invalid protocol/status, failed cleanup, transport errors and host-role
startup failures still fail closed. This does not restore or erase any revoked trust.
`src/remote/diagnosticLog.ts` records best-effort local helper lifecycle changes and failures
under `app/logs/remote-diagnostics/{host,remote}.jsonl`. Only closed enum fields and timestamps
are accepted, with 64 KiB plus one rotated copy per role, a bounded queue and duplicate suppression.
Files use the private metadata writer (including Windows ACLs). Logging never uploads, stores
request contents/identifiers, changes authority, or turns a failed operation into success.
A storage failure disables that writer until the next process start; absence of entries is not
evidence of uninterrupted health.

## Conventions

App versions use major.feature.bugfix numbering from `2.111.1`: bugfixes increment the third
segment, feature releases increment the middle segment and reset bugfix to zero, and major
releases increment the first segment. Store canonical npm SemVer without leading zeroes and
use matching `v<version>` GitHub tags. The `#.###.#` notation describes the counters, not padded
wire versions. Upgrading from historical 1.x to 2.x is manual; subsequent idle updates only
accept bugfixes in the same major/feature series. Helper and winter package versions are independent.

**Idle updates** (`src/backend/updates/`): opt-in `[updates]` config, hourly npm-latest checks and
five-minute quiet default. Only plain newer patch releases within the current major/minor are
eligible. Global npm runtimes register private capability-authenticated loopback control servers;
one installation-wide worker stages exact candidate/rollback packages, verifies helper signatures
and compatibility, prepares all opted-in roles, then installs/restarts. Helper pins/signatures/
compatibility are verified strictly whenever a registered remote gateway or Remote-Access-enabled
host (unreadable config counts as enabled) runs on a supported helper platform; otherwise only the
app package is verified, so absent optional helpers never block bot fixes (`helperVerificationRequired`). Admission is synchronous
in API/background work; passive polls/streams alone do not prevent maintenance. Locks serialize
manual and automatic installations and block new registrations during replacement. Never signal
an uncooperative/busy/unknown sibling or clear user data/trust to force progress. The macOS JXA
Security-framework status probe only checks keychain lock state, never reads secrets or unlocks.
`GET /api/updates` is sanitized; changing automatic-update config is local-only. Status/history
contain closed enums/version/timestamps, not tokens, paths or installer output. Journal recovery
can restore package/processes but not reverse migrations; an unusable CLI needs manual reinstall.
Fixture coverage is separate from native Windows/Linux updater-cycle validation.

- ESM with `moduleResolution: NodeNext`. Local imports in `.ts` files must use `.js` extensions (e.g., `import { foo } from "./bar.js"`). This is enforced by the compiler.
- `dist/` and `dist-frontend/` are generated artifacts; never edit them. After backend changes, rerun `npm run build:backend` if you need the shipped CLI to use new code (otherwise `bin/waifus.mjs` falls back to `tsx` against `src/`).
- Backend tsconfig excludes `tests/` and `src/frontend/`; frontend has its own `src/frontend/tsconfig.json`.
- Tests prefer real on-disk behavior with temp roots over mocks (especially for storage/config concurrency).

## Model dependency (winter)

- The app pins `@yanlinglabs/winter-provider-runtime`, `@yanlinglabs/winter-provider-catalog` and
  `@yanlinglabs/winter-web` **exactly**, all to the same version (currently 0.0.58; winter's READMEs
  make that the supported rule). winter-web (page fetch with its SSRF guard, HTML conversion, Exa
  search, the digest prompt) sits behind the thin adapter in `src/life/web/`. Edit only those lines in `package.json` and the lockfile when bumping. The
  `@waifucave/gateway` dependency, its `/api/llm/*` mount and `npm run gateway:local` are gone; the
  gateway repo is no longer used by this app. Read winter's CHANGELOG ("Breaking for
  provider-package hosts") before a bump.
- winter is the source of truth for model facts (context window, output cap, image input, reasoning
  efforts, continuation, prices). There is no in-app model table: `src/models/catalog.ts` only
  filters the installed catalog through the curated allow list (`[models] allowed`), the price cap
  (`[models] maxOutputUsdPerMTok`, at most $10 per million output tokens, D6) and feature checks.
  Routes the installed catalog lacks are hidden. An OpenRouter route is hidden only when its family
  keeps reasoning state (the vendor's own route has a `continuation`) and the OpenRouter row still
  says `none` (winter W7); a family with nothing to replay (Muse Spark) is offered either way.
  Priced-ness is decided once (`isPricedRoute`: official-doc prices) for `/api/models`, the price
  cap, ledger costs and the `model_unpriced` notice.
- Meta Muse Spark contributor variants enable training and must remain an explicit user choice; the
  picker labels them and the assistant only picks one when asked.
- `src/models/assemble.ts` uses winter's own assembler (`foldProviderStream` + `assembledToMessage`;
  failures throw winter's `ProviderStreamError` with `error` and `committed`). A plain-text turn
  keeps string content. The app adds a tap in front of the fold: it drives the app sink (text, tool
  call start/end, readable reasoning, retries; a throwing app sink is dropped, never ends a turn)
  and keeps the last usage, the subscription-quota flag and `contentArrived` (the app's one meaning
  of committed) in a `StreamObservation`, because a failed fold returns no usage. `tests/modelFakes.ts` plays scripted turns through winter's
  `createFakeProviderAdapter` (`.../testing`) behind a thin wrapper with the shipped adapter's
  capabilities.
- Usage convention: `inputTokens` is the non-cached prompt; cache reads and cache writes are
  disjoint from it (since 0.0.56 also on OpenRouter, whose `cache_write_tokens` became
  `cacheWriteTokens`). The whole prompt is `promptTokensOf(usage)` in `usageLedger.ts`; never add
  `cacheWrite1hTokens` (a part of `cacheWriteTokens`).
- The provider identity on the wire is `discord-waifus/<app version>` (`installWinterIdentity` in
  `src/models/winter.ts`); winter refuses a bad token with `TypeError` (the codex originator is a
  lowercase hyphenated token).
- Provider keys are read live per call from `user/providers.json` and passed inline; never log or
  echo them. `/api/providers` serves credential status (redacted key hints) for the curated
  providers, the detector's providers and any provider with a stored key.
- The addressee detector's native-choice catalog (`src/life/detector/`, `GET /api/detector/models`,
  renamed from `/api/orchestrator/one-shot/models`) is a separate decision-only catalog, never
  offered as waifu models. Local Laya uses optional host-only Python configuration and the packaged
  `assets/laya/worker.py`; never accept executable paths through the API. Native choices only; no
  yes/no ranking workarounds. Private benchmarks stay ignored; their results are not guarantees of
  real-room routing.
- `benchmark:decisions -- --suite=loops` separately measures blind semantic repetition/scene
  stagnation against healthy progression. Its wire names are not production semantics.
